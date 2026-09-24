import * as mupdf from 'mupdf';
import type { DownloadedFontAsset, FontChoice, Point, Quad, Rect, RGB, SourceTextLayout, TextContent, TextStyle } from '../types/pdfEditor';
import type { SourceCharacter, SourceFontInfo, SourceTextLine, SourceTextPage } from './engineTypes';
import { collectSourceFonts } from './sourceFonts';
import { downloadCatalogFont, getCatalogFace, matchesCatalogAsset, verifyFontAsset } from './fontCatalog';

export class NativeEditError extends Error {
  constructor(public code: string, message: string, public proposedFont?: FontChoice) { super(message); }
}
export const plain = (content: TextContent) => content.runs.map(run => run.text).join('');
export const quadBounds = (q: number[]): Rect => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];
export const intersects = (a: Rect, b: Rect) => a[0] < b[2] - .01 && a[2] > b[0] + .01 && a[1] < b[3] - .01 && a[3] > b[1] + .01;
export const inside = (a: Rect, b: Rect) => a[0] >= b[0] - .01 && a[1] >= b[1] - .01 && a[2] <= b[2] + .01 && a[3] <= b[3] + .01;
export function contentsList(page: mupdf.PDFPage): mupdf.DisplayList {
  const list = new mupdf.DisplayList(page.getBounds('CropBox'));
  const device = new mupdf.DisplayListDevice(list);
  try { page.runPageContents(device, mupdf.Matrix.identity); device.close(); return list; }
  catch (error) { list.destroy(); throw error; }
  finally { device.destroy(); }
}

export function redactionQuads(selected: SourceTextLine[], protectedLines: SourceTextLine[]): Quad[] {
  return selected.flatMap(line => line.chars.map(char => {
    const box=quadBounds(char.quad),dx=(box[2]-box[0])*.1,dy=(box[3]-box[1])*.1;
    let cells:Rect[]=[[box[0]+dx,box[1]+dy,box[2]-dx,box[3]-dy]];
    for(const other of protectedLines)for(const neighbor of other.chars) {
      const b=quadBounds(neighbor.quad);
      cells=cells.flatMap(a=>{
        if(a[0]>=b[2]||a[2]<=b[0]||a[1]>=b[3]||a[3]<=b[1])return [a];
        return [[a[0],a[1],Math.min(a[2],b[0]),a[3]],[Math.max(a[0],b[2]),a[1],a[2],a[3]],[Math.max(a[0],b[0]),a[1],Math.min(a[2],b[2]),Math.min(a[3],b[1])],[Math.max(a[0],b[0]),Math.max(a[1],b[3]),Math.min(a[2],b[2]),a[3]]].filter(r=>r[2]>r[0]&&r[3]>r[1]) as Rect[];
      });
    }
    cells.sort((a,b)=>(b[2]-b[0])*(b[3]-b[1])-(a[2]-a[0])*(a[3]-a[1]));
    const cell=cells[0];
    if(!cell || cell[2]<=cell[0] || cell[3]<=cell[1])throw new NativeEditError('UNSAFE_REDACTION','선택한 글자만 안전하게 제거할 영역이 없습니다.');
    const x=(cell[2]-cell[0])/4,y=(cell[3]-cell[1])/4;
    return [cell[0]+x,cell[1]+y,cell[2]-x,cell[1]+y,cell[0]+x,cell[3]-y,cell[2]-x,cell[3]-y] as Quad;
  }));
}
export class NativeTextStore {
  private pages = new Map<number, SourceTextPage>();
  private fonts = new Map<string, mupdf.Font>();
  private bundled = new Map<string, Promise<mupdf.Font>>();
  private downloaded = new Map<string, { font: mupdf.Font; asset: DownloadedFontAsset }>();
  private sourceFonts = new Map<string, SourceFontInfo>();
  private sourceGlyphs = new Map<string, Map<number, number>>();
  constructor(private loadFont: (font: Extract<FontChoice, {kind:'bundled'}>) => Promise<Uint8Array>) {}
  close() {
    for (const font of this.fonts.values()) font.destroy();
    this.fonts.clear(); this.pages.clear(); this.sourceFonts.clear();
    this.sourceGlyphs.clear();
    for (const font of this.bundled.values()) void font.then(value => value.destroy(), () => {});
    this.bundled.clear();
    for (const entry of this.downloaded.values()) entry.font.destroy();
    this.downloaded.clear();
  }
  extract(pdf: mupdf.PDFDocument, index: number): SourceTextPage {
    const cached = this.pages.get(index); if (cached) return cached;
    const identify = collectSourceFonts(pdf, index);
    const sourceFonts: SourceFontInfo[] = [];
    const page = pdf.loadPage(index); const list = contentsList(page); page.destroy();
    const structured = list.toStructuredText('preserve-spans,preserve-whitespace,preserve-ligatures,inhibit-spaces,ignore-actualtext');
    const semantic = list.toStructuredText('preserve-spans,preserve-whitespace,preserve-ligatures,inhibit-spaces');
    const presentation = list.toStructuredText('preserve-spans,preserve-whitespace,preserve-ligatures');
    try {
      const nativeLines: string[] = [];
      const json: unknown = JSON.parse(structured.asJSON(1));
      function collect(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(collect); return; }
        const item = value as Record<string, unknown>;
        if (Array.isArray(item.lines)) for (const line of item.lines) {
          if (line && typeof line === 'object' && typeof (line as Record<string, unknown>).text === 'string') nativeLines.push((line as {text:string}).text);
        }
        else for (const child of Object.values(item)) collect(child);
      }
      collect(json);
      const safe: Array<{origin:Point;bounds:Rect;clip?:Rect}> = [];
      // One painted-glyph lookup per character over every painted glyph is O(chars²).
      // Bucket origins on a .02pt grid: a match within .02 is always in the 3x3 neighbourhood.
      const safeCells = new Map<string, number[]>();
      const findSafe = (origin: Point) => {
        const cx = Math.floor(origin[0] / .02), cy = Math.floor(origin[1] / .02);
        let at = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
          for (const index of safeCells.get(`${cx + dx}:${cy + dy}`) ?? [])
            if (index < at && Math.hypot(safe[index].origin[0] - origin[0], safe[index].origin[1] - origin[1]) < .02) at = index;
        return at === Infinity ? undefined : safe[at];
      };
      const unsafeCells = new Map<string, Point[]>();
      const nearUnsafe = (origin: Point) => {
        // Ordinary opaque pages have no unsafe glyph at all; skip the 9-cell probe.
        if (!unsafeCells.size) return false;
        const cx = Math.floor(origin[0] / .02), cy = Math.floor(origin[1] / .02);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
          for (const point of unsafeCells.get(`${cx + dx}:${cy + dy}`) ?? [])
            if (Math.hypot(point[0] - origin[0], point[1] - origin[1]) < .02) return true;
        return false;
      };
      const clips:Array<Rect|false>=[]; let maskDepth=0; const groups:boolean[]=[];
      const imageBounds:Rect[]=[];
      const rulingLines:Array<[Point,Point]>=[];
      const observedGlyphs = new Map<number, Map<number, number>>();
      const inspect = (text: mupdf.Text, matrix: mupdf.Matrix, allowed: boolean) => {
        try { text.walk({ showGlyph: (font, trm, gid, cp, wmode, bidi) => {
          try {
            if (cp >= 0 && gid > 0) {
              let mapping = observedGlyphs.get(font.pointer);
              if (!mapping) { mapping = new Map(); observedGlyphs.set(font.pointer, mapping); }
              const previous = mapping.get(cp);
              mapping.set(cp, previous === undefined || previous === gid ? gid : 0);
            }
            const m = mupdf.Matrix.concat(trm, matrix);
            const glyph=new mupdf.Text();let bounds:Rect;
            try {
              glyph.showGlyph(font,m,gid,cp,wmode);
              const getBounds=glyph.getBounds as (stroke:mupdf.StrokeState|null,transform:mupdf.Matrix)=>Rect;
              bounds=getBounds.call(glyph,null,mupdf.Matrix.identity);
              if(bounds[0]<bounds[2]&&bounds[1]<bounds[3])bounds=[bounds[0]+1,bounds[1]+1,bounds[2]-1,bounds[3]-1];
            }finally{glyph.destroy();}
            let clip:Rect|undefined;
            for(const area of clips)if(area)clip=clip?[Math.max(clip[0],area[0]),Math.max(clip[1],area[1]),Math.min(clip[2],area[2]),Math.min(clip[3],area[3])]:area;
            const empty=bounds[0]>=bounds[2]||bounds[1]>=bounds[3];
            if(allowed && !clips.includes(false) && (!clip||empty||inside(bounds,clip)) && maskDepth===0 && !groups.some(Boolean) && !wmode && !bidi && cp >= 0)
            {
              const at = safe.push({origin:[m[4],m[5]],bounds,clip}) - 1;
              const key = `${Math.floor(m[4] / .02)}:${Math.floor(m[5] / .02)}`;
              const bucket = safeCells.get(key); if (bucket) bucket.push(at); else safeCells.set(key, [at]);
            }
            else {
              const key = `${Math.floor(m[4] / .02)}:${Math.floor(m[5] / .02)}`;
              const bucket = unsafeCells.get(key); if (bucket) bucket.push([m[4],m[5]]); else unsafeCells.set(key, [[m[4],m[5]]]);
            }
          } finally { font.destroy(); }
        }}); } finally { text.destroy(); }
      };
      const device = new mupdf.Device({
        strokePath: (path, stroke, ctm, space, _color, alpha) => {
          let current:Point|undefined;let first:Point|undefined;
          const transformed=(x:number,y:number):Point=>[x*ctm[0]+y*ctm[2]+ctm[4],x*ctm[1]+y*ctm[3]+ctm[5]];
          try {
            if(alpha>0)path.walk({
              moveTo:(x,y)=>{current=transformed(x,y);first=current;},
              lineTo:(x,y)=>{const next=transformed(x,y);if(current)rulingLines.push([current,next]);current=next;},
              curveTo:(_x1,_y1,_x2,_y2,x,y)=>{current=transformed(x,y);},
              closePath:()=>{if(current&&first)rulingLines.push([current,first]);current=first;},
            });
          }finally{path.destroy();stroke.destroy();space.destroy();}
        },
        fillImage: (image, ctm) => { imageBounds.push(mupdf.Rect.transform([0,0,1,1],ctm)); image.destroy(); },
        fillImageMask: (image, ctm, space) => { imageBounds.push(mupdf.Rect.transform([0,0,1,1],ctm)); image.destroy(); space.destroy(); },
        fillText: (text, ctm, space, _color, alpha) => { inspect(text, ctm, alpha === 1); space.destroy(); },
        strokeText: (text, stroke, ctm, space) => { inspect(text, ctm, false); stroke.destroy(); space.destroy(); },
        clipText: (text, ctm) => { inspect(text, ctm, false); clips.push(false); },
        clipStrokeText: (text, stroke, ctm) => { inspect(text, ctm, false); stroke.destroy(); clips.push(false); },
        ignoreText: (text, ctm) => inspect(text, ctm, false),
        clipPath: (path,_evenOdd,ctm) => {
          const vertices:Point[]=[];let complex=false;let subpaths=0;
          const point=(x:number,y:number):void=>{vertices.push([x*ctm[0]+y*ctm[2]+ctm[4],x*ctm[1]+y*ctm[3]+ctm[5]]);};
          try{
            path.walk({moveTo:(x,y)=>{subpaths++;point(x,y);},lineTo:point,curveTo:()=>{complex=true;}});
            if(vertices.length===5&&Math.hypot(vertices[0][0]-vertices[4][0],vertices[0][1]-vertices[4][1])<.001)vertices.pop();
            const rectangle:Rect=[Math.min(...vertices.map(p=>p[0])),Math.min(...vertices.map(p=>p[1])),Math.max(...vertices.map(p=>p[0])),Math.max(...vertices.map(p=>p[1]))];
            const rectangular=!complex&&subpaths===1&&vertices.length===4&&vertices.every((p,i)=>{
              const next=vertices[(i+1)%4];
              return (Math.abs(p[0]-next[0])<.001)!==(Math.abs(p[1]-next[1])<.001);
            });
            clips.push(rectangular?rectangle:false);
          }finally{path.destroy();}
        },
        clipStrokePath: (path,stroke) => { clips.push(false); path.destroy(); stroke.destroy(); },
        clipImageMask: image => { clips.push(false); image.destroy(); },
        popClip: () => { clips.pop(); },
        beginMask: (_area,_luminosity,space) => { maskDepth++; space?.destroy(); },
        endMask: () => { maskDepth=Math.max(0,maskDepth-1); clips.push(false); },
        beginGroup: (_area,space,_isolated,knockout,blendmode,alpha) => { groups.push(alpha!==1 || blendmode!=='Normal' || knockout); space?.destroy(); },
        endGroup: () => { groups.pop(); },
      });
      try { list.run(device, mupdf.Matrix.identity); device.close(); } finally { device.destroy(); }
      const pointers = new Map<number, string>(); let block = -1; let lineIndex = 0; let line: SourceTextLine;
      const lines: SourceTextLine[] = [];
      structured.walk({
        beginTextBlock: () => { block++; lineIndex = 0; },
        beginLine: (bounds, writingMode, direction) => {
          line = {lineId: `${block}:${lineIndex++}`, text:'', bounds, origin:[bounds[0],bounds[3]], direction, writingMode, chars:[], content:{runs:[],align:'left'}, widthPt:bounds[2]-bounds[0], editable:true};
          lines.push(line);
        },
        onChar: (text, origin, font, sizePt, quad, nativeColor) => {
          let fontKey = pointers.get(font.pointer);
          if (!fontKey) {
            fontKey = `${pointers.size}:${font.getName()}`;
            pointers.set(font.pointer, fontKey); this.fonts.set(`${index}/${fontKey}`, font);
            const metadata = identify(fontKey, font.getName());
            sourceFonts.push(metadata); this.sourceFonts.set(`${index}/${fontKey}`, metadata);
            const glyphs = observedGlyphs.get(font.pointer);
            if (glyphs) this.sourceGlyphs.set(`${index}/${fontKey}`, glyphs);
          } else font.destroy();
          const color: RGB = nativeColor.length === 3 ? [nativeColor[0],nativeColor[1],nativeColor[2]] : [nativeColor[0],nativeColor[0],nativeColor[0]];
          const geometry=findSafe(origin);
          const char:SourceCharacter = {text,origin,fontKey,sizePt,quad,color,paintBounds:geometry?.bounds,clipBounds:geometry?.clip}; line.chars.push(char); line.text += text;
          const style: TextStyle = {font:{kind:'source',sourcePageIndex:index,fontKey},sizePt,color};
          const previous = line.content.runs[line.content.runs.length-1];
          if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) previous.text += text;
          else line.content.runs.push({text,style});
        },
        endLine: () => {
          if (line.chars[0]) line.origin = line.chars[0].origin;
          const projections=line.chars.flatMap(char => [0,2,4,6].map(i => char.quad[i]*line.direction[0]+char.quad[i+1]*line.direction[1]));
          if(projections.length)line.widthPt=Math.max(...projections)-Math.min(...projections);
        },
      });
      const semanticLines: string[] = [];
      const semanticJson: unknown = JSON.parse(semantic.asJSON(1));
      const before = nativeLines.length; collect(semanticJson); semanticLines.push(...nativeLines.splice(before));
      const semanticGeometry:Array<{origin:Point;direction:Point}>=[];
      semantic.walk({beginLine:(_bounds,_mode,direction)=>{semanticGeometry.push({origin:[Infinity,Infinity],direction});},onChar:(_text,origin,font)=>{const current=semanticGeometry[semanticGeometry.length-1];if(!Number.isFinite(current.origin[0]))current.origin=origin;font.destroy();}});
      const sameBaseline=(target:SourceTextLine,geometry:{origin:Point;direction:Point})=>
        Math.hypot(target.direction[0]-geometry.direction[0],target.direction[1]-geometry.direction[1])<.001 &&
        Math.abs((geometry.origin[0]-target.origin[0])*target.direction[1]-(geometry.origin[1]-target.origin[1])*target.direction[0])<.02;
      // Metric line bounds can exclude painted glyphs; prune only by their actual union.
      const paintGeometry = lines.map(line => {
        const boxes = line.chars.map(char => char.paintBounds ?? quadBounds(char.quad));
        const bounds:Rect = [Infinity,Infinity,-Infinity,-Infinity];
        for(const box of boxes) {
          bounds[0]=Math.min(bounds[0],box[0]);bounds[1]=Math.min(bounds[1],box[1]);
          bounds[2]=Math.max(bounds[2],box[2]);bounds[3]=Math.max(bounds[3],box[3]);
        }
        return {boxes,bounds};
      });
      for (const [i, target] of lines.entries()) {
        let reason: string | undefined;
        const mappedSemantic=semanticLines.filter((_text,j)=>semanticGeometry[j]&&sameBaseline(target,semanticGeometry[j])&&target.chars.some(c=>Math.hypot(c.origin[0]-semanticGeometry[j].origin[0],c.origin[1]-semanticGeometry[j].origin[1])<.02)).join('');
        if (nativeLines[i] !== target.text || mappedSemantic !== target.text) reason = '원본 문자와 Unicode 매핑이 달라 안전하게 교체할 수 없습니다.';
        else if (target.writingMode || Math.abs(Math.hypot(...target.direction)-1) > .001) reason = '세로쓰기 또는 유효하지 않은 본문 방향은 교체할 수 없습니다.';
        else if (/[\u0590-\u08ff\u0900-\u0dff\u200d\u0300-\u036f]/u.test(target.text)) reason = '복잡한 문자 조합은 안전하게 교체할 수 없습니다.';
        else if (target.chars.some(c => nearUnsafe(c.origin) || !c.paintBounds)) reason = '불투명한 일반 본문이 아닌 글자는 교체할 수 없습니다.';
        else if (target.chars.some((c,j) => target.chars.some((other,k) => k !== j && Math.hypot(c.origin[0]-other.origin[0],c.origin[1]-other.origin[1]) < .01))) reason = '겹친 글자 또는 부분 합자는 교체할 수 없습니다.';
        else if (paintGeometry.some((other,j)=>j!==i&&intersects(paintGeometry[i].bounds,other.bounds)&&paintGeometry[i].boxes.some(box=>other.boxes.some(neighbor=>intersects(box,neighbor))))) reason = '다른 본문 줄의 글자와 겹쳐 안전하게 교체할 수 없습니다.';
        if(!reason)for(const char of target.chars) {
          // Derive exclusive selectors from protected metric geometry. MuPDF removes
          // whole native glyphs; selectors must not touch a protected glyph box.
          const box=quadBounds(char.quad),dx=(box[2]-box[0])*.1,dy=(box[3]-box[1])*.1;
          let cells:Rect[]=[[box[0]+dx,box[1]+dy,box[2]-dx,box[3]-dy]];
          for(const other of lines)if(other!==target && box[0]<other.bounds[2] && box[2]>other.bounds[0] && box[1]<other.bounds[3] && box[3]>other.bounds[1])for(const neighbor of other.chars) {
            const b=quadBounds(neighbor.quad);
            if(box[0]>=b[2]||box[2]<=b[0]||box[1]>=b[3]||box[3]<=b[1])continue;
            if(!cells.some(a=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1]))continue;
            cells=cells.flatMap(a=>{
              if(a[0]>=b[2]||a[2]<=b[0]||a[1]>=b[3]||a[3]<=b[1])return [a];
              return [[a[0],a[1],Math.min(a[2],b[0]),a[3]],[Math.max(a[0],b[2]),a[1],a[2],a[3]],[Math.max(a[0],b[0]),a[1],Math.min(a[2],b[2]),Math.min(a[3],b[1])],[Math.max(a[0],b[0]),Math.max(a[1],b[3]),Math.min(a[2],b[2]),a[3]]].filter(r=>r[2]>r[0]&&r[3]>r[1]) as Rect[];
            });
          }
          cells=cells.filter(cell=>cell[2]>cell[0]&&cell[3]>cell[1]);
          cells.sort((a,b)=>(b[2]-b[0])*(b[3]-b[1])-(a[2]-a[0])*(a[3]-a[1]));
          const cell=cells[0];
          if(!cell){reason='선택한 글자만 안전하게 제거할 영역이 없습니다.';break;}
          const x=(cell[2]-cell[0])/4,y=(cell[3]-cell[1])/4;
          char.redactionQuad=[cell[0]+x,cell[1]+y,cell[2]-x,cell[1]+y,cell[0]+x,cell[3]-y,cell[2]-x,cell[3]-y];
        }
        if (reason) { target.editable=false; target.reason=reason; }
      }
      // Inferred spaces are presentation text, never physical audit identities.
      let presentationDirection:Point=[1,0];let presentationChars:Array<{text:string;origin:Point}>=[];
      presentation.walk({
        beginLine:(_bounds,_mode,direction)=>{presentationDirection=direction;presentationChars=[];},
        onChar:(text,origin,font)=>{presentationChars.push({text,origin});font.destroy();},
        endLine:()=>{
          const first=presentationChars[0];if(!first)return;
          const target=lines.find(value=>value.editable&&sameBaseline(value,{origin:first.origin,direction:presentationDirection})&&Math.hypot(value.origin[0]-first.origin[0],value.origin[1]-first.origin[1])<.02);
          if(!target)return;
          let physical=0;const runs:TextContent['runs']=[];
          for(const item of presentationChars) {
            const char=target.chars[physical];
            const matched=char&&item.text===char.text&&Math.hypot(item.origin[0]-char.origin[0],item.origin[1]-char.origin[1])<.02;
            if(!matched&&item.text!==' ')return;
            const source=char??target.chars[target.chars.length-1];
            const style:TextStyle={font:{kind:'source',sourcePageIndex:index,fontKey:source.fontKey},sizePt:source.sizePt,color:source.color};
            const previous=runs[runs.length-1];
            if(previous&&JSON.stringify(previous.style)===JSON.stringify(style))previous.text+=item.text;else runs.push({text:item.text,style});
            if(matched)physical++;
          }
          if(physical===target.chars.length){target.content={runs,align:'left'};target.presentationOrigins=presentationChars.map(char=>char.origin);}
        },
      });
      const result = {sourcePageIndex:index, lines, fonts:sourceFonts, imageBounds, rulingLines}; this.pages.set(index,result); return result;
    } finally { structured.destroy(); semantic.destroy(); presentation.destroy(); list.destroy(); }
  }
  async registerFonts(assets: DownloadedFontAsset[]): Promise<void> {
    for (const asset of assets) {
      if (!matchesCatalogAsset(asset)) throw new NativeEditError('INVALID_FONT_ASSET','지원 목록과 일치하지 않는 글꼴 데이터입니다.');
      const existing = this.downloaded.get(asset.id);
      if (existing?.asset.bytes === asset.bytes) continue;
      const bytes = await verifyFontAsset(asset);
      if (!existing) {
        const font = new mupdf.Font(asset.postScriptName, bytes);
        this.downloaded.set(asset.id, {font, asset});
      }
    }
  }
  async downloadFont(choice: Extract<FontChoice, {kind:'source'}>): Promise<DownloadedFontAsset> {
    const metadata = this.sourceFonts.get(`${choice.sourcePageIndex}/${choice.fontKey}`);
    const face = metadata?.catalogId ? getCatalogFace(metadata.catalogId) : undefined;
    if (!face) throw new NativeEditError('FONT_DOWNLOAD_UNAVAILABLE', metadata?.unavailableReason ?? '원본과 정확히 일치하는 공개 글꼴을 찾을 수 없습니다.');
    const cached = this.downloaded.get(face.sha256);
    if (cached) return cached.asset;
    const asset = await downloadCatalogFont(face, this.loadFont);
    await this.registerFonts([asset]);
    return asset;
  }
  async font(choice: FontChoice): Promise<mupdf.Font> {
    if (choice.kind === 'source') {
      const font = this.fonts.get(`${choice.sourcePageIndex}/${choice.fontKey}`);
      if (!font) throw new NativeEditError('FONT_UNAVAILABLE','원본 글꼴을 찾을 수 없습니다.');
      const metadata = this.sourceFonts.get(`${choice.sourcePageIndex}/${choice.fontKey}`);
      if (!metadata?.usable) throw new NativeEditError('FONT_SUBSTITUTION_REQUIRED', metadata?.catalogId
        ? '원본 글꼴이 PDF에 포함되지 않았습니다. 원본 이름과 스타일에 맞는 공개 글꼴을 내려받아 적용해 주세요.'
        : metadata?.unavailableReason ?? '원본 글꼴의 실제 포함 여부를 확인할 수 없습니다.', {kind:'bundled',family:'NanumGothic',bold:font.isBold()});
      return font;
    }
    if (choice.kind === 'downloaded') {
      const entry = this.downloaded.get(choice.assetId);
      if (!entry) throw new NativeEditError('FONT_UNAVAILABLE','저장된 다운로드 글꼴을 찾을 수 없습니다.');
      return entry.font;
    }
    const key = `${choice.family}/${choice.bold}`;
    let pending = this.bundled.get(key);
    if (!pending) {
      pending = choice.family === 'Courier' ? Promise.resolve(new mupdf.Font(choice.bold ? 'Courier-Bold':'Courier')) : this.loadFont(choice).then(bytes => new mupdf.Font(`${choice.family}${choice.bold ? '-Bold':''}`,bytes));
      this.bundled.set(key,pending);
    }
    return pending;
  }
  encodeCharacter(choice: FontChoice, font: mupdf.Font, codePoint: number): number {
    // Subsetting may remove the font cmap. Reuse only unambiguous glyphs actually
    // observed for this Unicode value in this exact source font.
    if (choice.kind === 'source') {
      const known = this.sourceGlyphs.get(`${choice.sourcePageIndex}/${choice.fontKey}`)?.get(codePoint);
      if (known !== undefined) return known;
    }
    return font.encodeCharacter(codePoint);
  }
}

export interface LayoutGlyph { text:string; gid:number; font:mupdf.Font; style:TextStyle; x:number; y:number; advance:number; bounds:Rect; direction:Point }
export interface NativeLayout { glyphs:LayoutGlyph[]; bounds:Rect; text:string }
export async function layoutText(store: NativeTextStore, content: TextContent, origin: Point, width: number, direction:Point=[1,0], sourceLine?:SourceTextLine, paragraph?:SourceTextLayout): Promise<NativeLayout> {
  if (!Number.isFinite(width) || width <= 0) throw new NativeEditError('INVALID_WIDTH','텍스트 폭은 0보다 커야 합니다.');
  if(paragraph && (!Number.isFinite(paragraph.lineHeightPt)||paragraph.lineHeightPt<=0||!Number.isFinite(paragraph.referenceSizePt)||paragraph.referenceSizePt<=0||[paragraph.firstLineIndentPt,paragraph.restLineIndentPt].some(indent=>!Number.isFinite(indent)||indent<0||indent>=width)))throw new NativeEditError('INVALID_LAYOUT','묶음의 줄 간격 또는 들여쓰기가 유효하지 않습니다.');
  const units: Array<Omit<LayoutGlyph,'x'|'y'|'bounds'|'direction'> & {cluster:number}> = [];
  const Segmenter=(Intl as unknown as {Segmenter:new(locale:string,options:{granularity:'grapheme'})=>{segment:(text:string)=>Iterable<{index:number;segment:string}>}}).Segmenter;
  const boundaries=[...new Segmenter('ko',{granularity:'grapheme'}).segment(plain(content))].map(segment=>segment.index);
  let offset=0;let cluster=0;
  for (const run of content.runs) {
    const {style} = run;
    if (!Number.isFinite(style.sizePt) || style.sizePt < 6 || style.sizePt > 96 || style.color.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new NativeEditError('INVALID_STYLE','글자 크기(6–96pt) 또는 색상이 유효하지 않습니다.');
    const font = await store.font(style.font);
    for (const char of run.text) {
      while(cluster+1<boundaries.length && boundaries[cluster+1]<=offset)cluster++;
      offset+=char.length;
      if (char === '\n') { units.push({text:char,gid:0,font,style,advance:0,cluster}); continue; }
      const cp = char.codePointAt(0)!;
      if (cp === 9 || cp === 13 || (cp >= 0xd800 && cp <= 0xdfff) || /[\u0590-\u08ff\u0900-\u0dff\u200d\u0300-\u036f]/u.test(char)) throw new NativeEditError('UNSUPPORTED_TEXT',`지원하지 않는 문자 조합: U+${cp.toString(16).toUpperCase()}`);
      const gid = store.encodeCharacter(style.font, font, cp);
      if (!gid) {
        if (style.font.kind === 'source') throw new NativeEditError('FONT_SUBSTITUTION_REQUIRED','원본 글꼴에 필요한 문자가 없어 대체 글꼴이 필요합니다',{kind:'bundled',family:'NanumGothic',bold:font.isBold()});
        throw new NativeEditError('MISSING_GLYPH',`선택한 글꼴에 U+${cp.toString(16).toUpperCase()} 문자가 없습니다.`);
      }
      units.push({text:char,gid,font,style,advance:font.advanceGlyph(gid)*style.sizePt,cluster});
    }
  }
  // Preserve source tracking/TJ adjustments for position-corresponding edits.
  // Changed glyphs retain their own advances; measured spacing is not font scaling.
  if(sourceLine?.presentationOrigins?.length===units.length &&
    content.runs.length===sourceLine.content.runs.length && content.runs.every((run,i)=>[...run.text].length===[...sourceLine.content.runs[i].text].length&&run.style.sizePt===sourceLine.content.runs[i].style.sizePt&&JSON.stringify(run.style.font)===JSON.stringify(sourceLine.content.runs[i].style.font))) {
    const origins=sourceLine.presentationOrigins, originalCharacters=[...plain(sourceLine.content)];
    for(let i=0;i<units.length;i++) {
      const next=origins[i+1];
      const measured=next?(next[0]-origins[i][0])*direction[0]+(next[1]-origins[i][1])*direction[1]:
        sourceLine.widthPt-((origins[i][0]-origin[0])*direction[0]+(origins[i][1]-origin[1])*direction[1]);
      const originalGid=store.encodeCharacter(units[i].style.font,units[i].font,originalCharacters[i].codePointAt(0)!);
      units[i].advance+=measured-units[i].font.advanceGlyph(originalGid)*units[i].style.sizePt;
    }
  }
  const rows: typeof units[] = []; let row: typeof units = []; let rowWidth=0;
  const rowLimit=()=>width-(paragraph?(rows.length?paragraph.restLineIndentPt:paragraph.firstLineIndentPt):0);
  for (let start=0;start<units.length;) {
    let end=start+1;while(end<units.length&&units[end].cluster===units[start].cluster)end++;
    const clusterUnits=units.slice(start,end);start=end;
    if (clusterUnits[0].text === '\n') { rows.push(row); row=[]; rowWidth=0; continue; }
    const advance=clusterUnits.reduce((sum,unit)=>sum+unit.advance,0);
    if (advance > rowLimit() + .01) throw new NativeEditError('OVERFLOW','한 글자 조합이 편집 폭보다 큽니다. 폭을 늘려 주세요.');
    if (row.length && rowWidth + advance > rowLimit() + .01) {
      let lastSpace = -1;
      for (let i=row.length-1;i>=0;i--) if (/\s/u.test(row[i].text)) {lastSpace=i;break;}
      if (lastSpace >= 0 && lastSpace < row.length-1) { rows.push(row.slice(0,lastSpace+1)); row=row.slice(lastSpace+1); rowWidth=row.reduce((sum,v)=>sum+v.advance,0); }
      else { rows.push(row); row=[]; rowWidth=0; }
      if(rowWidth>rowLimit()+.01) {
        // Revisit carried clusters at the narrower continuation width.
        start-=row.length+clusterUnits.length;row=[];rowWidth=0;continue;
      }
      if(row.length&&rowWidth+advance>rowLimit()+.01){rows.push(row);row=[];rowWidth=0;}
    }
    if(advance>rowLimit()+.01)throw new NativeEditError('OVERFLOW','한 글자 조합이 편집 폭보다 큽니다. 폭을 늘려 주세요.');
    row.push(...clusterUnits); rowWidth+=advance;
  }
  rows.push(row);
  const glyphs: LayoutGlyph[]=[]; let baseline=origin[1]; let bounds: Rect=[origin[0],origin[1],origin[0],origin[1]];
  const paragraphLeading=paragraph?paragraph.lineHeightPt*Math.max(6,...content.runs.map(run=>run.style.sizePt))/paragraph.referenceSizePt:0;
  for (const [ri, values] of rows.entries()) {
    const height=Math.max(6,...values.map(v=>v.style.sizePt));
    if (ri) baseline+=paragraph?paragraphLeading:Math.max(height,...rows[ri-1].map(v=>v.style.sizePt))*1.35;
    const used=values.reduce((sum,v)=>sum+v.advance,0);
    const indent=paragraph?(ri?paragraph.restLineIndentPt:paragraph.firstLineIndentPt):0;
    const available=width-indent;
    let x=origin[0]+indent+(content.align==='center'?(available-used)/2:content.align==='right'?available-used:0);
    for (const value of values) {
      const text=new mupdf.Text();
      let box:Rect;
      try {
        text.showGlyph(value.font,[value.style.sizePt,0,0,-value.style.sizePt,x,baseline],value.gid,value.text.codePointAt(0)!);
        // MuPDF 1.28.1 accepts null for fill-only bounds; its .d.ts omits null.
        const getBounds=text.getBounds as (stroke:mupdf.StrokeState|null,transform:mupdf.Matrix)=>Rect;
        box=getBounds.call(text,null,mupdf.Matrix.identity);
        // fz_bound_text adds a 1-unit glyph-cache margin, not painted geometry.
        // Remove that margin under the identity matrix, but leave empty glyphs empty.
        if(box[0]<box[2]&&box[1]<box[3])box=[box[0]+1,box[1]+1,box[2]-1,box[3]-1];
      } finally { text.destroy(); }
      if (!Number.isFinite(box[0]) || box[0]>box[2]) box=[x,baseline-height,x+value.advance,baseline];
      glyphs.push({...value,x,y:baseline,bounds:box,direction}); x+=value.advance;
      bounds=[Math.min(bounds[0],box[0]),Math.min(bounds[1],box[1]),Math.max(bounds[2],box[2]),Math.max(bounds[3],box[3])];
    }
  }
  if(direction[0]!==1 || direction[1]!==0) {
    const rotation:mupdf.Matrix=[direction[0],direction[1],-direction[1],direction[0],origin[0]-origin[0]*direction[0]+origin[1]*direction[1],origin[1]-origin[0]*direction[1]-origin[1]*direction[0]];
    for(const glyph of glyphs){const {x,y}=glyph;glyph.x=x*rotation[0]+y*rotation[2]+rotation[4];glyph.y=x*rotation[1]+y*rotation[3]+rotation[5];glyph.bounds=mupdf.Rect.transform(glyph.bounds,rotation);}
    bounds=mupdf.Rect.transform(bounds,rotation);
  }
  return {glyphs,bounds,text:plain(content)};
}
export function characterFingerprint(char: SourceCharacter): string {
  return JSON.stringify([char.text,...char.origin.map(v=>Math.round(v*100)),...char.quad.map(v=>Math.round(v*100)),Math.round(char.sizePt*100),...char.color]);
}
export function utf16hex(text: string): string { let out=''; for(let i=0;i<text.length;i++) out+=text.charCodeAt(i).toString(16).padStart(4,'0'); return out; }
