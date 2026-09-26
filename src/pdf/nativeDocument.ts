import * as mupdf from 'mupdf';
import type { FontChoice, Matrix, Page, Point, QuarterTurn, Rect, Workspace } from '../types/pdfEditor';
import type { EditableTextTarget, NativePdfApi, SourceInfo } from './engineTypes';
import { finalizePageInstances, findPageIndex, getDuplicateCapability, hasDocumentSignatures, preparePageInstances } from './nativePages';
import { NativeEditError, NativeTextStore, characterFingerprint, contentsList, inside, intersects, layoutText, quadBounds, redactionQuads, utf16hex, type NativeLayout } from './nativeText';
import { buildSourceTextGroup } from './sourceTextGroups';

function cloneDictionary(pdf: mupdf.PDFDocument, original: mupdf.PDFObject): mupdf.PDFObject {
  const result=pdf.newDictionary();
  if (original.isDictionary()) original.forEach((value,key)=>{ result.put(key,value); value.destroy(); });
  return result;
}
function ownResources(pdf: mupdf.PDFDocument, object: mupdf.PDFObject): mupdf.PDFObject {
  const inherited=object.getInheritable('Resources'); const resources=cloneDictionary(pdf,inherited); inherited.destroy();
  for (const key of ['Font','XObject','ExtGState']) {
    const existing=resources.get(key); const local=cloneDictionary(pdf,existing); existing.destroy(); resources.put(key,local); local.destroy();
  }
  object.put('Resources',resources); return resources;
}
function appendContents(pdf: mupdf.PDFDocument, object: mupdf.PDFObject, commands: string): void {
  const contents=object.get('Contents'); const array=pdf.newArray(); const prefix=pdf.addStream('q\n',{}); const suffix=pdf.addStream(`\nQ\nq\n${commands}\nQ\n`,{});
  try {
    array.push(prefix);
    if (contents.isArray()) contents.forEach(value=>{ array.push(value); value.destroy(); });
    else if (!contents.isNull()) array.push(contents);
    array.push(suffix); object.put('Contents',array);
  } finally { contents.destroy(); array.destroy(); prefix.destroy(); suffix.destroy(); }
}
function putResource(resources: mupdf.PDFObject, kind: string, name: string, value: mupdf.PDFObject): void {
  const dictionary=resources.get(kind); try { dictionary.put(name,value); } finally { dictionary.destroy(); }
}
function uniqueResource(resources: mupdf.PDFObject, kind: string, prefix: string): string {
  const dictionary=resources.get(kind); let index=0;
  try { for (;;) { const key=`${prefix}${index++}`; const existing=dictionary.get(key); const absent=existing.isNull(); existing.destroy(); if(absent) return key; } }
  finally { dictionary.destroy(); }
}
function toUnicode(mapping: Map<number,string>): string {
  const entries=[...mapping].map(([gid,text])=>`<${gid.toString(16).padStart(4,'0')}> <${utf16hex(text)}>`);
  const groups:string[]=[]; for(let i=0;i<entries.length;i+=100) { const group=entries.slice(i,i+100); groups.push(`${group.length} beginbfchar\n${group.join('\n')}\nendbfchar`); }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /EditorUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${groups.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}
function writeLayouts(pdf:mupdf.PDFDocument, resources:mupdf.PDFObject, layouts:NativeLayout[], inverse:Matrix, store:NativeTextStore):string {
  const fontGroups=new Map<mupdf.Font,{name:string;mapping:Map<number,string>;ref:mupdf.PDFObject}>(); const commands:string[]=[];
  try {
    for(const layout of layouts) for(const glyph of layout.glyphs) {
      let entry=fontGroups.get(glyph.font);
      if(!entry) {
        let ref:mupdf.PDFObject;
        try { const embedded=pdf.addFont(glyph.font); try { const local=cloneDictionary(pdf,embedded); try { ref=pdf.addObject(local); } finally {local.destroy();} } finally {embedded.destroy();} }
        catch(error) { if(glyph.style.font.kind==='source') throw store.missingSourceFont(glyph.style.font,'원본 글꼴을 결과 PDF에 안전하게 포함할 수 없습니다.',glyph.font.isBold()); throw error; }
        entry={name:uniqueResource(resources,'Font','PdfEditorFont'),mapping:new Map(),ref}; fontGroups.set(glyph.font,entry); putResource(resources,'Font',entry.name,ref);
      }
      entry.mapping.set(glyph.gid,glyph.text);
      const {style}=glyph;
      const [dx,dy]=glyph.direction;
      const matrix=mupdf.Matrix.concat([style.sizePt*dx,style.sizePt*dy,style.sizePt*dy,-style.sizePt*dx,glyph.x,glyph.y],inverse);
      commands.push(`/Span << /ActualText <FEFF${utf16hex(glyph.text)}> >> BDC`, `BT /${entry.name} 1 Tf 0 Tr 0 Tc 0 Tw 100 Tz 0 Ts ${style.color.join(' ')} rg ${matrix.join(' ')} Tm <${glyph.gid.toString(16).padStart(4,'0')}> Tj ET`, 'EMC');
    }
    for(const entry of fontGroups.values()) { const cmap=pdf.addStream(toUnicode(entry.mapping),{}); try {entry.ref.put('ToUnicode',cmap);} finally {cmap.destroy();} }
    return commands.join('\n');
  } finally {for(const entry of fontGroups.values()) entry.ref.destroy();}
}

function verifyLayoutEmbedding(layout:NativeLayout,bounds:Rect,store:NativeTextStore):void {
  if(!layout.glyphs.length)return;
  const scratch=new mupdf.PDFDocument();let reopened:mupdf.PDFDocument|undefined;
  try {
    const ref=scratch.addPage(bounds,0,{},'');scratch.insertPage(-1,ref);
    try {
      const page=scratch.loadPage(0);const inverse=mupdf.Matrix.invert(page.getTransform());page.destroy();
      const resources=ownResources(scratch,ref);
      try{appendContents(scratch,ref,writeLayouts(scratch,resources,[layout],inverse,store));}finally{resources.destroy();}
    }finally{ref.destroy();}
    const buffer=scratch.saveToBuffer('garbage=compact,compress=yes');
    try{reopened=new mupdf.PDFDocument(buffer.asUint8Array().slice());}finally{buffer.destroy();}
    const page=reopened.loadPage(0);const list=contentsList(page);page.destroy();
    const observed:Array<{gid:number;cp:number}>=[];
    const device=new mupdf.Device({fillText:(text,_ctm,space)=>{
      try{text.walk({showGlyph:(font,_trm,gid,cp)=>{observed.push({gid,cp});font.destroy();}});}
      finally{text.destroy();space.destroy();}
    }});
    try {
      list.run(device,mupdf.Matrix.identity);device.close();
      const mappings=new Map<mupdf.Font,Map<number,number>>();
      for(const glyph of layout.glyphs){let map=mappings.get(glyph.font);if(!map){map=new Map();mappings.set(glyph.font,map);}map.set(glyph.gid,glyph.text.codePointAt(0)!);}
      const expected=layout.glyphs.map(glyph=>({gid:glyph.gid,cp:mappings.get(glyph.font)!.get(glyph.gid)!}));
      if(JSON.stringify(observed)!==JSON.stringify(expected))throw new Error('Embedded GID/ToUnicode round-trip mismatch');
      const semantic=list.toStructuredText('preserve-whitespace,preserve-ligatures,inhibit-spaces');
      try{
        const json:unknown=JSON.parse(semantic.asJSON(1));const lines:string[]=[];
        const collect=(value:unknown):void=>{
          if(!value||typeof value!=='object')return;
          if(Array.isArray(value)){value.forEach(collect);return;}
          const item=value as Record<string,unknown>;
          if(Array.isArray(item.lines)){for(const line of item.lines)if(line&&typeof line==='object'&&typeof (line as {text?:unknown}).text==='string')lines.push((line as {text:string}).text);}
          else Object.values(item).forEach(collect);
        };
        collect(json);
        if(lines.join('')!==layout.glyphs.map(glyph=>glyph.text).join(''))throw new Error('Saved semantic text/space round-trip mismatch');
      }finally{semantic.destroy();}
    }finally{device.destroy();list.destroy();}
  }catch(error){
    if(error instanceof NativeEditError)throw error;
    const sourceGlyph=layout.glyphs.find(glyph=>glyph.style.font.kind==='source');
    if(sourceGlyph?.style.font.kind==='source')throw store.missingSourceFont(sourceGlyph.style.font,'저장 후 다시 읽은 문자가 원본 글꼴 출력과 일치하지 않습니다.',sourceGlyph.font.isBold());
    throw new NativeEditError('FONT_ROUNDTRIP_FAILED',error instanceof Error?error.message:String(error));
  }finally{reopened?.destroy();scratch.destroy();}
}
function hasEdits(page:Page):boolean { return page.kind==='pdf' && page.textEdits.length>0; }

export function createNativePdfApi(loadFont:(font:Extract<FontChoice,{kind:'bundled'}>)=>Promise<Uint8Array>,onProgress:(current:number,total:number)=>void):NativePdfApi {
  let sourceBytes:Uint8Array|null=null; let source:mupdf.PDFDocument|null=null; let sourceInfo:SourceInfo|null=null; let password:string|undefined;
  const textStore=new NativeTextStore(loadFont);
  let candidate:{key:string;pdf:mupdf.PDFDocument;index:number;targets:EditableTextTarget[];bounds:Rect;transform:Matrix}|null=null;
  function requireOpen():{pdf:mupdf.PDFDocument;info:SourceInfo} { if(!source||!sourceInfo) throw new NativeEditError('NOT_OPEN','PDF 문서를 먼저 열어 주세요.'); return {pdf:source,info:sourceInfo}; }
  function independent():mupdf.PDFDocument {
    if(!sourceBytes) throw new NativeEditError('NOT_OPEN','PDF 문서가 없습니다.');
    const opened=mupdf.Document.openDocument(sourceBytes,'application/pdf'); const pdf:mupdf.PDFDocument|null=opened.asPDF();
    if(!pdf) {opened.destroy();throw new NativeEditError('INVALID_PDF','PDF 파일이 아닙니다.');}
    if(pdf.needsPassword() && (!password || !pdf.authenticatePassword(password))) {pdf.destroy();throw new NativeEditError('PASSWORD_REQUIRED','암호가 필요합니다.');}
    pdf.disableJS(); return pdf;
  }
  function checkPage(page:Page):void {
    const {info}=requireOpen();
    if(page.kind==='pdf' && (!Number.isInteger(page.sourcePageIndex)||!info.pages[page.sourcePageIndex])) throw new NativeEditError('INVALID_PAGE','원본 페이지 참조가 유효하지 않습니다.');
    if(hasEdits(page) && !info.canEdit) throw new NativeEditError('EDIT_PERMISSION','이 PDF에는 본문·요소 편집 권한이 없습니다.');
    if((page.kind==='blank'||page.rotation||(page.kind==='pdf'&&!page.originalInstance))&&!info.canAssemble) throw new NativeEditError('ASSEMBLE_PERMISSION','이 PDF에는 페이지 구성 변경 권한이 없습니다.');
    if(page.kind==='pdf'&&!page.originalInstance) {const capability=info.pages[page.sourcePageIndex].duplicate;if(!capability.allowed)throw new NativeEditError(capability.code,capability.reason);}
  }
  async function materializePage(pdf:mupdf.PDFDocument,pageIndex:number,model:Page):Promise<EditableTextTarget[]> {
    checkPage(model);
    const original=model.kind==='pdf'?textStore.extract(requireOpen().pdf,model.sourcePageIndex):null;
    let page=pdf.loadPage(pageIndex); const bounds=page.getBounds('CropBox'); const inverse=mupdf.Matrix.invert(page.getTransform()); const object=page.getObject();
    const targets:EditableTextTarget[]=[]; const layouts:NativeLayout[]=[];
    const edits=model.kind==='pdf'?model.textEdits:[];
    const editedIds=new Set<string>();
    try {
      for(const edit of edits)
        for(const run of edit.content.runs)if(run.style.font.kind==='source')textStore.extract(requireOpen().pdf,run.style.font.sourcePageIndex);
      for(const edit of edits) {
        if(!edit.lineIds.length || new Set(edit.lineIds).size!==edit.lineIds.length || edit.lineIds.some(id=>editedIds.has(id)||!original?.lines.some(line=>line.lineId===id)))throw new NativeEditError('INVALID_TARGET','수정할 원본 줄이 없거나 묶음 소유권이 중복되었습니다.');
        if((edit.lineIds.length>1)!==!!edit.layout)throw new NativeEditError('INVALID_LAYOUT','묶음의 줄 간격 정보가 유효하지 않습니다.');
        for(const id of edit.lineIds)editedIds.add(id);
      }
      for(const line of original?.lines??[]) if(!editedIds.has(line.lineId))targets.push({kind:'source',lineIds:[line.lineId],bounds:line.bounds,quads:line.chars.map(c=>c.quad),content:line.content,widthPt:line.widthPt,editable:line.editable,reason:line.reason});
      for(const edit of edits) {
        const members=original!.lines.filter(line=>edit.lineIds.includes(line.lineId));
        const line=members[0];
        for(const member of members)if(!member.editable)throw new NativeEditError('UNSAFE_TEXT',member.reason??'안전하게 수정할 수 없는 본문입니다.');
        const group=edit.lineIds.length>1&&model.kind==='pdf'?buildSourceTextGroup(model,original!,edit.lineIds):undefined;
        const layout=await layoutText(textStore,edit.content,group?.origin??line.origin,edit.widthPt,group?.direction??line.direction,group?undefined:line,edit.layout); layouts.push(layout);
        if(!inside(layout.bounds,bounds))throw new NativeEditError('OVERFLOW','수정한 텍스트가 페이지 영역을 벗어납니다.');
        for(const member of members)for(const char of member.chars)if(char.clipBounds&&layout.glyphs.some(g=>!inside(g.bounds,char.clipBounds!)))throw new NativeEditError('CLIPPED_TEXT','수정한 텍스트가 원본 클립 영역을 벗어납니다.');
        for(const other of original!.lines) if(!editedIds.has(other.lineId)&&other.chars.some(c=>layout.glyphs.some(g=>intersects(g.bounds,c.paintBounds??quadBounds(c.quad)))))throw new NativeEditError('TEXT_OVERLAP','수정한 텍스트가 선택하지 않은 본문과 겹칩니다.');
        if(group) {
          const obstacles=(original!.imageBounds??[]).filter(rect=>!inside(group.bounds,rect));
          if(obstacles.some(rect=>layout.glyphs.some(g=>intersects(g.bounds,rect))))throw new NativeEditError('TEXT_OVERLAP','묶음 텍스트가 이미지나 다른 요소와 겹칩니다.');
        }
        targets.push({kind:'source',lineIds:group?.lineIds??edit.lineIds,bounds:layout.bounds,quads:[],content:edit.content,widthPt:edit.widthPt,layout:edit.layout,editable:true});
      }
      for(let i=0;i<layouts.length;i++)for(let j=i+1;j<layouts.length;j++)if(layouts[i].glyphs.some(a=>layouts[j].glyphs.some(b=>intersects(a.bounds,b.bounds))))throw new NativeEditError('TEXT_OVERLAP','편집한 텍스트 영역이 서로 겹칩니다.');
      if(!hasEdits(model))return targets;
      let resources=ownResources(pdf,object);
      try {
        if(edits.length && original) {
          const annots=object.get('Annots');const hadAnnots=!annots.isNull();const saved:mupdf.PDFObject[]=[];
          if(annots.isArray())annots.forEach(value=>saved.push(value));annots.destroy();
          const working=pdf.newArray();for(const ref of saved)working.push(ref);object.put('Annots',working);working.destroy();
          const quads=redactionQuads(original.lines.filter(line=>editedIds.has(line.lineId)),original.lines.filter(line=>!editedIds.has(line.lineId)));
          const mark=page.createAnnotation('Redact');
          try {mark.setQuadPoints(quads);mark.applyRedaction(0,mupdf.PDFPage.REDACT_IMAGE_NONE,mupdf.PDFPage.REDACT_LINE_ART_NONE,mupdf.PDFPage.REDACT_TEXT_REMOVE);}
          finally {
            const restored=pdf.newArray();for(const ref of saved){restored.push(ref);ref.destroy();}
            if(hadAnnots)object.put('Annots',restored);else object.delete('Annots');restored.destroy();
            mark.destroy();page.destroy();page=pdf.loadPage(pageIndex);
          }
          resources.destroy(); resources=ownResources(pdf,object);
          const audit=new NativeTextStore(loadFont);
          try {
            const remaining=audit.extract(pdf,pageIndex).lines.flatMap(line=>line.chars).map(characterFingerprint).sort();
            const expected=original.lines.filter(line=>!editedIds.has(line.lineId)).flatMap(line=>line.chars).map(characterFingerprint).sort();
            if(JSON.stringify(remaining)!==JSON.stringify(expected))throw new NativeEditError('UNSAFE_REDACTION','선택하지 않은 글자가 영향을 받아 안전하게 수정할 수 없습니다.');
          }finally{audit.close();}
        }
        appendContents(pdf,object,writeLayouts(pdf,resources,layouts,inverse,textStore));
      }finally{resources.destroy();}
      for(const layout of layouts)verifyLayoutEmbedding(layout,bounds,textStore);
      return targets;
    } finally {object.destroy();page.destroy();}
  }
  async function prepare(model:Page) {
    checkPage(model);const key=JSON.stringify(model);if(candidate?.key===key)return candidate;
    candidate?.pdf.destroy();candidate=null;
    const pdf=independent();
    try {
      let index:number;
      if(model.kind==='pdf') {index=model.sourcePageIndex;}
      else {const ref=pdf.addPage([0,0,model.widthPt,model.heightPt],0,{},'');try{pdf.insertPage(-1,ref);index=pdf.countPages()-1;}finally{ref.destroy();}}
      const initial=pdf.loadPage(index);const bounds=initial.getBounds('CropBox');const transform=initial.getTransform();initial.destroy();
      const targets=await materializePage(pdf,index,model);
      const object=pdf.findPage(index);try{object.put('Rotate',((model.kind==='pdf'?requireOpen().info.pages[model.sourcePageIndex].sourceRotate:0)+model.rotation)%360);}finally{object.destroy();}
      candidate={key,pdf,index,targets,bounds,transform};return candidate;
    }catch(error){pdf.destroy();throw error;}
  }
  return {
    async open(blob,newPassword) {
      const bytes=new Uint8Array(await blob.arrayBuffer()); const opened=mupdf.Document.openDocument(bytes,'application/pdf');const pdf:mupdf.PDFDocument|null=opened.asPDF();
      if(!pdf){opened.destroy();throw new NativeEditError('INVALID_PDF','PDF 파일이 아닙니다.');}
      try {
        if(pdf.needsPassword() && (!newPassword||!pdf.authenticatePassword(newPassword)))throw new NativeEditError(newPassword?'PASSWORD_INCORRECT':'PASSWORD_REQUIRED',newPassword?'암호가 올바르지 않습니다.':'암호가 필요합니다.');
        pdf.disableJS();if(!pdf.countPages())throw new NativeEditError('EMPTY_PDF','페이지가 없는 PDF입니다.');
        const info:SourceInfo={pages:[],canEdit:pdf.hasPermission('edit'),canAssemble:pdf.hasPermission('assemble'),canCopy:pdf.hasPermission('copy'),hasSignatures:hasDocumentSignatures(pdf)};
        for(let i=0;i<pdf.countPages();i++) {
          const page=pdf.loadPage(i);const object=page.getObject();const rotate=object.getInheritable('Rotate');const unit=object.get('UserUnit');
          try{info.pages.push({bounds:page.getBounds('CropBox'),pdfToPage:page.getTransform(),sourceRotate:(((rotate.asNumber()%360)+360)%360) as QuarterTurn,userUnit:unit.isNumber()?unit.asNumber():1,duplicate:getDuplicateCapability(pdf,i)});}
          finally{rotate.destroy();unit.destroy();object.destroy();page.destroy();}
        }
        candidate?.pdf.destroy();candidate=null;textStore.close();source?.destroy();source=pdf;sourceBytes=bytes;sourceInfo=info;password=newPassword;return info;
      }catch(error){pdf.destroy();throw error;}
    },
    async text(index){const {pdf}=requireOpen();return textStore.extract(pdf,index);},
    async downloadFont(choice) {
      textStore.extract(requireOpen().pdf, choice.sourcePageIndex);
      return textStore.downloadFont(choice);
    },
    async importFont(choice, file, fileName) {
      textStore.extract(requireOpen().pdf, choice.sourcePageIndex);
      return textStore.importFont(choice, file, fileName);
    },
    async registerFonts(assets) { requireOpen(); await textStore.registerFonts(assets); },
    async copySourceText(index,start,end){const {pdf,info}=requireOpen();if(!info.canCopy)throw new NativeEditError('COPY_PERMISSION','이 PDF에는 텍스트 복사 권한이 없습니다.');const page=pdf.loadPage(index);const list=contentsList(page);page.destroy();const text=list.toStructuredText('');try{return text.copy(start,end);}finally{text.destroy();list.destroy();}},
    async validate(page){try{await prepare(page);return {ok:true};}catch(error){if(error instanceof NativeEditError)return {ok:false,code:error.code,message:error.message,...(error.proposedFont?{proposedFont:error.proposedFont}:{})};return {ok:false,code:'NATIVE_ERROR',message:error instanceof Error?error.message:String(error)};}},
    async render(model,scale){
      if(!Number.isFinite(scale)||scale<=0)throw new NativeEditError('INVALID_SCALE','렌더 크기가 유효하지 않습니다.');
      const current=await prepare(model);const page=current.pdf.loadPage(current.index);
      try{const raster=mupdf.Matrix.scale(scale,scale);const pageToRaster=mupdf.Matrix.concat(mupdf.Matrix.concat(mupdf.Matrix.invert(current.transform),page.getTransform()),raster);const displayBounds=page.getBounds('CropBox');const pixmap=page.toPixmap(raster,mupdf.ColorSpace.DeviceRGB,false,true,'View','CropBox');
        try{const width=pixmap.getWidth(),height=pixmap.getHeight(),stride=pixmap.getStride(),components=pixmap.getNumberOfComponents();const pixels=pixmap.getPixels();const rgba=new Uint8ClampedArray(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const src=y*stride+x*components,dst=(y*width+x)*4;rgba[dst]=pixels[src];rgba[dst+1]=pixels[src+1];rgba[dst+2]=pixels[src+2];rgba[dst+3]=255;}return {rgba,width,height,pixelOrigin:[pixmap.getX(),pixmap.getY()] as Point,pageToRaster,bounds:current.bounds,displayBounds,textTargets:current.targets};}finally{pixmap.destroy();}
      }finally{page.destroy();}
    },
    async export(workspace:Workspace){
      const {info}=requireOpen();if(!workspace.pages.length)throw new NativeEditError('EMPTY_PDF','페이지가 없는 문서는 출력할 수 없습니다.');
      await textStore.registerFonts(workspace.fontAssets ?? []);
      const originalOrder=workspace.pages.length===info.pages.length&&workspace.pages.every((page,index)=>page.kind==='pdf'&&page.originalInstance&&page.sourcePageIndex===index);
      if(originalOrder&&workspace.pages.every(page=>!page.rotation&&!hasEdits(page)))return sourceBytes!.slice();
      if((!originalOrder||workspace.pages.some(page=>page.rotation))&&!info.canAssemble)throw new NativeEditError('ASSEMBLE_PERMISSION','페이지 구성 변경 권한이 없습니다.');
      workspace.pages.forEach(checkPage);const pdf=independent();
      let instances:{refs:mupdf.PDFObject[];originalRefs:mupdf.PDFObject[]}|undefined;
      try {
        instances=preparePageInstances(pdf,workspace.pages,info);
        for(const [i,model] of workspace.pages.entries()) {
          const index=findPageIndex(pdf,instances.refs[i]);await materializePage(pdf,index,model);
          instances.refs[i].put('Rotate',((model.kind==='pdf'?info.pages[model.sourcePageIndex].sourceRotate:0)+model.rotation)%360);onProgress(i+1,workspace.pages.length);
        }
        finalizePageInstances(pdf,workspace.pages,instances.refs,instances.originalRefs);
        const buffer=pdf.saveToBuffer('garbage=compact,compress=yes');try{return buffer.asUint8Array().slice();}finally{buffer.destroy();}
      }finally{if(instances){for(const ref of new Set([...instances.refs,...instances.originalRefs]))ref.destroy();}pdf.destroy();}
    },
    close(){candidate?.pdf.destroy();candidate=null;textStore.close();source?.destroy();source=null;sourceBytes=null;sourceInfo=null;password=undefined;},
  };
}
