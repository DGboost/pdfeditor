import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativePdfApi } from '../src/pdf/nativeDocument';
import { collectSourceFonts } from '../src/pdf/sourceFonts';
import { getCatalogFace } from '../src/pdf/fontCatalog';
import { bundledFont, extractedText, loadFont, mupdf, pdfPage, workspace } from './fixtures';
import type { FontChoice } from '../src/types/pdfEditor';
import { validateFontAssets } from '../src/utils/db';
import { createHash } from 'node:crypto';

function declaredFixture(name: string, descriptor?: Record<string, unknown>): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const ref = pdf.addPage([0, 0, 400, 200], 0, { Font: { F0: { Type: 'Font', Subtype: 'TrueType', BaseFont: name, ...(descriptor ? { FontDescriptor: descriptor } : {}) } } }, 'BT /F0 16 Tf 30 140 Td (ABC 123) Tj ET');
    try { pdf.insertPage(-1, ref); } finally { ref.destroy(); }
    const buffer = pdf.saveToBuffer();
    try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); }
  } finally { pdf.destroy(); }
}
async function embeddedSubset(): Promise<Uint8Array> {
  const pdf = new mupdf.PDFDocument();
  const font = new mupdf.Font('NanumGothic', await loadFont(bundledFont));
  try {
    const fontRef = pdf.addFont(font);
    try {
      const cmap = pdf.addStream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /FontDownloadFixture def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
7 beginbfchar
${[...'ABC 123'].map(char => `<${font.encodeCharacter(char).toString(16).padStart(4, '0')}> <${char.codePointAt(0)!.toString(16).padStart(4, '0')}>`).join('\n')}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`, {});
      try { fontRef.put('ToUnicode', cmap); } finally { cmap.destroy(); }
      const glyphs = [...'ABC 123'].map(char => font.encodeCharacter(char).toString(16).padStart(4, '0')).join('');
      const ref = pdf.addPage([0, 0, 400, 200], 0, { Font: { F0: fontRef } }, `BT /F0 16 Tf 30 140 Td <${glyphs}> Tj ET`);
      try { pdf.insertPage(-1, ref); } finally { ref.destroy(); }
    } finally { fontRef.destroy(); }
    pdf.subsetFonts();
    const buffer = pdf.saveToBuffer();
    try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); }
  } finally { font.destroy(); pdf.destroy(); }
}

test('nonembedded catalog font stays selectable but cannot export a fallback as the source face', async () => {
  const bytes = declaredFixture('NanumGothic');
  const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([bytes]));
    const source = await api.text(0), line = source.lines[0];
    assert.equal(line.editable, true);
    assert.equal(source.fonts?.[0].usable, false);
    assert.equal(source.fonts?.[0].catalogId, 'nanumgothic-regular');
    const page = pdfPage(0);
    page.textEdits = [{ lineIds: [line.lineId], content: line.content, widthPt: 300 }];
    const before = await api.validate(page);
    assert.equal(before.ok, false);
    if (before.ok) assert.fail();
    assert.equal(before.proposedFont, undefined, 'a downloadable catalog font must not be offered a substitute');
    await assert.rejects(api.export(workspace(bytes, [page])), { code: 'FONT_SUBSTITUTION_REQUIRED' });
    const choice = line.content.runs[0].style.font;
    assert.equal(choice.kind, 'source');
    const asset = await api.downloadFont(choice as Extract<FontChoice, {kind:'source'}>);
    await assert.rejects(api.importFont(choice as Extract<FontChoice, {kind:'source'}>, new Blob([await loadFont(bundledFont)]), 'NanumGothic.ttf'), { code: 'FONT_IMPORT_UNAVAILABLE' }, 'catalog fonts use the pinned download');
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes, 'acquiring a font does not edit the document');
    page.textEdits[0].content = { ...line.content, runs: line.content.runs.map(run => ({ ...run, text: 'ABC 456 한글', style: { ...run.style, font: { kind: 'downloaded', assetId: asset.id } } })) };
    assert.deepEqual(await api.validate(page), { ok: true });
    const saved = { ...workspace(bytes, [page]), fontAssets: [asset] };
    const out = await api.export(saved);
    assert.ok(extractedText(out).includes('ABC 456 한글'));
    const reopened = createNativePdfApi(() => { throw new Error('No asset reload/network allowed'); }, () => {});
    try {
      await reopened.open(new Blob([bytes]));
      assert.deepEqual(await reopened.export(saved), out, 'restored workspace carries complete font bytes');
      await assert.rejects(reopened.registerFonts([{ ...asset, bytes: new Blob(['corrupt']) }]), /무결성/);
      assert.deepEqual(await reopened.export(saved), out, 'failed registration cannot poison cached face');
    } finally { reopened.close(); }
  } finally { api.close(); }
});

function withFsType(font: Uint8Array, fsType: number): Uint8Array {
  const copy = font.slice(), view = new DataView(copy.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    if (String.fromCharCode(...copy.subarray(record, record + 4)) === 'OS/2') { view.setUint16(view.getUint32(record + 8) + 8, fsType); return copy; }
  }
  throw new Error('fixture font has no OS/2 table');
}

test('non-catalog font accepts only a matching, embeddable user font file and survives restore', async () => {
  const bytes = declaredFixture('NanumGothic,Bold');
  const regular = await loadFont(bundledFont), bold = await loadFont({ ...bundledFont, bold: true });
  const restricted = withFsType(bold, 0x0002);
  const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([bytes]));
    const source = await api.text(0), line = source.lines[0];
    assert.equal(source.fonts?.[0].catalogId, undefined);
    assert.equal(source.fonts?.[0].embedded, false);
    const choice = line.content.runs[0].style.font as Extract<FontChoice, {kind:'source'}>;
    const page = pdfPage(0);
    page.textEdits = [{ lineIds: [line.lineId], content: line.content, widthPt: 300 }];
    const before = await api.validate(page);
    if (before.ok) assert.fail();
    assert.equal(before.proposedFont?.kind, 'bundled', 'fonts the editor cannot fetch keep the substitute fallback');
    await assert.rejects(api.importFont(choice, new Blob([regular]), 'NanumGothic-Regular.ttf'), { code: 'FONT_FILE_MISMATCH' }, 'a Regular face cannot stand in for "Family,Bold"');
    await assert.rejects(api.importFont(choice, new Blob([restricted]), 'restricted.ttf'), { code: 'FONT_EMBEDDING_RESTRICTED' });
    await assert.rejects(api.importFont(choice, new Blob(['not a font']), 'notes.txt'), { code: 'INVALID_FONT_FILE' });
    const asset = await api.importFont(choice, new Blob([bold]), 'NanumGothic-Bold.ttf');
    assert.equal(asset.postScriptName, 'NanumGothicBold');
    assert.equal(asset.weight, 700);
    assert.ok(validateFontAssets([asset]).has(asset.id), 'imported assets persist with the draft');
    page.textEdits[0].content = { ...line.content, runs: line.content.runs.map(run => ({ ...run, text: 'ABC 456 한글', style: { ...run.style, font: { kind: 'downloaded', assetId: asset.id } } })) };
    assert.deepEqual(await api.validate(page), { ok: true });
    const saved = { ...workspace(bytes, [page]), fontAssets: [asset] };
    const out = await api.export(saved);
    assert.ok(extractedText(out).includes('ABC 456 한글'));
    const reopened = createNativePdfApi(() => { throw new Error('No asset reload/network allowed'); }, () => {});
    try {
      await reopened.open(new Blob([bytes]));
      assert.deepEqual(await reopened.export(saved), out, 'restored workspace carries the user font bytes');
      const fresh = createNativePdfApi(loadFont, () => {});
      try {
        await fresh.open(new Blob([bytes]));
        await assert.rejects(fresh.registerFonts([{ ...asset, bytes: new Blob([bold]), postScriptName: 'Impostor' }]), /무결성/);
        await assert.rejects(fresh.registerFonts([{ ...asset, id: `${createHash('sha256').update(restricted).digest('hex')}:0`, bytes: new Blob([restricted]) }]), /무결성/, 'stored assets are re-checked for embedding permission');
      } finally { fresh.close(); }
    } finally { reopened.close(); }
  } finally { api.close(); }
});

// Hangul-style producers write raw EUC-KR bytes in font names; the fixture is authored byte-for-byte.
function legacyNamedFixture(names: string[]): Uint8Array {
  const content = names.map((_, i) => `BT /F${i} 16 Tf 30 ${150 - i * 40} Td (ABC ${i}) Tj ET`).join('\n');
  const fonts = names.map((_, i) => `/F${i} ${5 + i} 0 R`).join(' ');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << ${fonts} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...names.map(name => `<< /Type /Font /Subtype /TrueType /BaseFont /${name} >>`)];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
const NANUM_GOTHIC_EUC_KR = '#B3#AA#B4#AE#B0#ED#B5#F1', NANUM_MYEONGJO_EUC_KR = '#B3#AA#B4#AE#B8#ED#C1#B6';

test('EUC-KR font names are decoded for matching, and colliding lossy names never share an identity', async () => {
  const single = createNativePdfApi(loadFont, () => {});
  try {
    await single.open(new Blob([legacyNamedFixture([NANUM_GOTHIC_EUC_KR])]));
    const source = await single.text(0);
    assert.equal(source.fonts?.[0].declaredName, '나눔고딕');
    const asset = await single.importFont(source.lines[0].content.runs[0].style.font as Extract<FontChoice, {kind:'source'}>, new Blob([await loadFont(bundledFont)]), 'NanumGothic-Regular.ttf');
    assert.equal(asset.postScriptName, 'NanumGothic', 'the Korean family name in the file matches the decoded PDF name');
  } finally { single.close(); }
  const pair = createNativePdfApi(loadFont, () => {});
  try {
    await pair.open(new Blob([legacyNamedFixture([NANUM_GOTHIC_EUC_KR, NANUM_MYEONGJO_EUC_KR])]));
    const source = await pair.text(0);
    assert.ok(source.fonts?.length && source.fonts.every(font => font.embedded === 'unknown'), 'same-length EUC-KR names collide after UTF-8 decoding');
    await assert.rejects(pair.importFont(source.lines[0].content.runs[0].style.font as Extract<FontChoice, {kind:'source'}>, new Blob([await loadFont(bundledFont)]), 'NanumGothic-Regular.ttf'), { code: 'FONT_IMPORT_UNAVAILABLE' });
  } finally { pair.close(); }
});

test('embedded subset remains usable offline until a new glyph needs the full exact face', async () => {
  const bytes = await embeddedSubset();
  let loads = 0;
  const api = createNativePdfApi(font => { loads++; return loadFont(font); }, () => {});
  try {
    await api.open(new Blob([bytes]));
    const source = await api.text(0), line = source.lines[0];
    assert.equal(source.fonts?.[0].embedded, true);
    assert.equal(source.fonts?.[0].usable, true);
    const page = pdfPage(0);
    page.textEdits = [{ lineIds: [line.lineId], content: line.content, widthPt: 300 }];
    page.textEdits[0].content = { ...line.content, runs: line.content.runs.map(run => ({ ...run, text: run.text.replace('123', '321') })) };
    assert.deepEqual(await api.validate(page), { ok: true });
    assert.ok(extractedText(await api.export(workspace(bytes, [page]))).includes('ABC 321'));
    assert.equal(loads, 0);
    page.textEdits[0].content = { ...line.content, runs: line.content.runs.map(run => ({ ...run, text: '새로운 글자' })) };
    const result = await api.validate(page);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail();
    assert.equal(result.code, 'FONT_SUBSTITUTION_REQUIRED');
    assert.equal(result.proposedFont, undefined, 'a missing glyph in a catalog subset must point to download, not substitution');
    const asset = await api.downloadFont(line.content.runs[0].style.font as Extract<FontChoice, {kind:'source'}>);
    assert.equal(asset.postScriptName, 'NanumGothic');
    assert.equal(loads, 1);
  } finally { api.close(); }
});

test('unknown, conflicting and ambiguous PDF declarations never acquire an alleged exact face', async () => {
  for (const [name, descriptor] of [
    ['CommercialUnknown-Regular', undefined],
    ['NanumGothic', { FontName: 'NanumGothicBold' }],
    ['NanumGothic', { FontName: 'NanumGothic', FontWeight: 700 }],
  ] as const) {
    const bytes = declaredFixture(name, descriptor);
    const api = createNativePdfApi(loadFont, () => {});
    try {
      await api.open(new Blob([bytes]));
      const source = await api.text(0);
      assert.equal(source.fonts?.[0].catalogId, undefined);
      assert.equal(source.fonts?.[0].usable, false);
      await assert.rejects(api.downloadFont(source.lines[0].content.runs[0].style.font as Extract<FontChoice, {kind:'source'}>), { code: 'FONT_DOWNLOAD_UNAVAILABLE' });
    } finally { api.close(); }
  }
  const pdf = new mupdf.PDFDocument();
  try {
    const ref = pdf.addPage([0,0,100,100], 0, { Font: {
      F0: { Type:'Font', Subtype:'TrueType', BaseFont:'ABeeZee-Regular', FontDescriptor:{FontName:'ABeeZee-Regular',ItalicAngle:0} },
      F1: { Type:'Font', Subtype:'TrueType', BaseFont:'ABeeZee-Regular', FontDescriptor:{FontName:'ABeeZee-Regular',ItalicAngle:-12} },
    } }, '');
    try { pdf.insertPage(-1, ref); } finally { ref.destroy(); }
    const info = collectSourceFonts(pdf,0)('0:ABeeZee-Regular','ABeeZee-Regular');
    assert.equal(info.embedded, 'unknown'); assert.equal(info.catalogId, undefined); assert.equal(info.usable, false);
    const corrupt = pdf.addStream('not a font', {});
    try {
      const page = pdf.findPage(0);
      try { page.put('Resources', {Font:{F0:{Type:'Font',Subtype:'TrueType',BaseFont:'ABeeZee-Regular',FontDescriptor:{FontName:'ABeeZee-Regular',FontFile2:corrupt}}}}); }
      finally { page.destroy(); }
      const info = collectSourceFonts(pdf,0)('0:ABeeZee-Regular','ABeeZee-Regular');
      assert.equal(info.usable, false); assert.equal(info.catalogId, undefined);
    } finally { corrupt.destroy(); }
  } finally { pdf.destroy(); }
  assert.equal(getCatalogFace('unknown'), undefined);
});

test('exact intermediate catalog weights are not rounded to regular or bold', () => {
  const pdf = new mupdf.PDFDocument(declaredFixture('NotoSansCJKkr-DemiLight', { FontName: 'NotoSansCJKkr-DemiLight', FontWeight: 350, ItalicAngle: 0 }));
  try {
    const info = collectSourceFonts(pdf, 0)('0:NotoSansCJKkr-DemiLight', 'NotoSansCJKkr-DemiLight');
    assert.equal(info.catalogId, 'noto-sans-cjk-kr-demilight');
    assert.equal(info.weight, 350);
    assert.equal(info.usable, false, 'exact identification does not make a nonembedded face available');
  } finally { pdf.destroy(); }
});
