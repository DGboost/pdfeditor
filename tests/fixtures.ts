import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import * as mupdf from 'mupdf';
import type { FontChoice, Page, PdfPage, QuarterTurn, Rect, TextContent, Workspace } from '../src/types/pdfEditor';

export { mupdf };
export const ORIGINAL = '계약금 30,000원';
export const REPLACEMENT = '계약금 45,000원';
export const LITERAL = '<img src=x onerror=globalThis.pdfInjected=1>';
export const bundledFont = { kind: 'bundled', family: 'NanumGothic', bold: false } as const;

export async function loadFont(font: Extract<FontChoice, { kind: 'bundled' }>): Promise<Uint8Array> {
  if (font.family === 'Courier') throw new Error('Courier must use the native builtin font');
  return new Uint8Array(await readFile(new URL(`../src/assets/fonts/${font.family.toLowerCase()}/${font.family}-${font.bold ? 'Bold' : 'Regular'}.ttf`, import.meta.url)));
}

export function textContent(text: string, options: { bold?: boolean; sizePt?: number; color?: [number, number, number] } = {}): TextContent {
  return { align: 'left', runs: [{ text, style: { font: { ...bundledFont, bold: options.bold ?? false }, sizePt: options.sizePt ?? 16, color: options.color ?? [0, 0, 0] } }] };
}

export function pdfPage(index: number, id = `page-${index}`): PdfPage {
  return { id, label: `${index + 1}`, kind: 'pdf', sourcePageIndex: index, originalInstance: true, rotation: 0, textEdits: [] };
}

export function workspace(bytes: Uint8Array, pages: Page[]): Workspace {
  return { id: 'fixture-workspace', fileName: 'fixture.pdf', source: new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }), sourceHash: createHash('sha256').update(bytes).digest('hex'), pages, activePageId: pages[0].id };
}

export function saved(pdf: mupdf.PDFDocument, options = 'garbage=compact,compress=yes'): Uint8Array {
  const buffer = pdf.saveToBuffer(options);
  try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); }
}

export function utf16Hex(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index++) result += text.charCodeAt(index).toString(16).padStart(4, '0');
  return result.toUpperCase();
}

// Fixture encoding is independent of the application writer: one horizontal Tj per line,
// known baselines in PDF user space and an explicitly authored ToUnicode CMap.
function cmap(pairs: Array<[number, string]>): string {
  return `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /FixtureUnicode def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
${pairs.length} beginbfchar
${pairs.map(([gid, value]) => `<${gid.toString(16).padStart(4, '0')}> <${utf16Hex(value)}>`).join('\n')}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
}

function fontResource(pdf: mupdf.PDFDocument, font: mupdf.Font, strings: string[], overrides: Array<[number, string]> = []): mupdf.PDFObject {
  const ref = pdf.addFont(font);
  const values = new Map<number, string>();
  for (const text of strings) for (const char of text) {
    const gid = font.encodeCharacter(char.codePointAt(0)!);
    if (!gid) throw new Error(`Fixture font lacks ${char}`);
    values.set(gid, char);
  }
  for (const pair of overrides) values.set(...pair);
  ref.put('ToUnicode', pdf.addStream(cmap([...values]), {}));
  return ref;
}

function glyphs(font: mupdf.Font, text: string): string {
  return [...text].map(char => font.encodeCharacter(char.codePointAt(0)!).toString(16).padStart(4, '0')).join('');
}

function line(font: mupdf.Font, text: string, x: number, y: number, size = 16, resource = 'F0'): string {
  return `BT /${resource} ${size} Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm <${glyphs(font, text)}> Tj ET\n`;
}

function appearance(pdf: mupdf.PDFDocument, color = '0.15 0.3 0.9'): mupdf.PDFObject {
  return pdf.addStream(`${color} rg 0 0 80 20 re f`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 80, 20], Resources: {} });
}

export function pngBytes(): Uint8Array {
  // A deterministic 2x2 RGB photograph-like texture; no remote assets or image mocks.
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, bytes: Uint8Array) => {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
    const suffix = Buffer.alloc(4); suffix.writeUInt32BE(crc32(payload));
    return Buffer.concat([prefix, payload, suffix]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Uint8Array.from([0, 220, 60, 30, 15, 120, 180, 0, 55, 160, 65, 240, 210, 80]))), chunk('IEND', new Uint8Array())]);
}

export async function fidelityFixture(options: { annotations?: boolean; subset?: boolean; literal?: boolean } = {}): Promise<Uint8Array> {
  const pdf = new mupdf.PDFDocument();
  const font = new mupdf.Font('FixtureNanum', await loadFont(bundledFont));
  const strings = [ORIGINAL, 'Untouched Latin 12345', options.literal ? LITERAL : '독립적인 한글 문장'];
  const image = new mupdf.Image(pngBytes());
  try {
    const fontRef = fontResource(pdf, font, strings);
    const resources = { Font: { F0: fontRef }, XObject: { Photo: pdf.addImage(image) } };
    let content = '0.86 0.93 0.74 rg 0 0 420 420 re f\nq 100 0 0 70 270 290 cm /Photo Do Q\n0.2 0.55 0.65 RG 0.4 w\n';
    for (let i = 0; i <= 420; i += 10) content += `${i} 0 m ${i} 420 l S 0 ${i} m 420 ${i} l S\n`;
    content += line(font, strings[0], 40, 330) + line(font, strings[1], 40, 240) + line(font, strings[2], 40, 170, options.literal ? 10 : 16);
    const ref = pdf.addPage([0, 0, 420, 420], 0, resources, content); pdf.insertPage(-1, ref);
    if (options.annotations) {
      const free = pdf.addObject({ Type: 'Annot', Subtype: 'FreeText', Rect: [40, 310, 170, 348], Contents: pdf.newString('Kept annotation'), DA: pdf.newString('/Helv 10 Tf 0 g'), AP: { N: appearance(pdf) }, P: ref, NM: pdf.newString('original-free') });
      const popup = pdf.addObject({ Type: 'Annot', Subtype: 'Popup', Rect: [220, 100, 320, 180], Parent: free, P: ref, NM: pdf.newString('original-popup') });
      free.put('Popup', popup);
      const link = pdf.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [40, 315, 175, 350], Border: [0, 0, 0], Dest: [ref, 'Fit'], P: ref, NM: pdf.newString('original-link') });
      const redact = pdf.addObject({ Type: 'Annot', Subtype: 'Redact', Rect: [290, 35, 330, 55], QuadPoints: [290, 55, 330, 55, 290, 35, 330, 35], AP: { N: appearance(pdf, '0.8 0.1 0.1') }, P: ref, NM: pdf.newString('original-redact') });
      const reply = pdf.addObject({ Type: 'Annot', Subtype: 'Text', Rect: [350, 70, 370, 90], IRT: free, P: ref, NM: pdf.newString('original-reply') });
      ref.put('Annots', [link, free, popup, redact, reply]);
    }
    if (options.subset) pdf.subsetFonts();
    return saved(pdf);
  } finally { image.destroy(); font.destroy(); pdf.destroy(); }
}

export async function denseParagraphFixture(family: 'Helvetica' | 'NanumGothic'): Promise<Uint8Array> {
  const pdf = new mupdf.PDFDocument();
  const font = family === 'Helvetica' ? new mupdf.Font('Helvetica') : new mupdf.Font('FixtureNanum', await loadFont(bundledFont));
  const strings = family === 'Helvetica'
    ? ['Previous paragraph line 100', 'Payment amount 30,000 won', 'Following paragraph line 200']
    : ['이전 문단의 내용 100', '계약금 30,000원', '다음 문단의 내용 200'];
  try {
    const resources = { Font: { F0: family === 'Helvetica' ? pdf.addSimpleFont(font) : fontResource(pdf, font, strings) } };
    const content = strings.map((text, index) => family === 'Helvetica'
      ? `BT /F0 12 Tf 0 0 0 rg 1 0 0 1 40 ${330 - index * 18} Tm (${text}) Tj ET\n`
      : line(font, text, 40, 330 - index * 18, 12)).join('');
    pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], 0, resources, content));
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}

export async function titleBodyFixture(kind: 'tj' | 'clip' | 'cut' | 'Helvetica14' | 'Nanum12' | 'Nanum14'): Promise<Uint8Array> {
  const pdf = new mupdf.PDFDocument();
  const korean = kind.startsWith('Nanum');
  const font = korean ? new mupdf.Font('FixtureNanum', await loadFont(bundledFont)) : new mupdf.Font('Helvetica');
  const title = 'Document title';
  const dense = kind === 'Helvetica14' || korean;
  const strings = korean
    ? ['이전 문단의 내용 100', ORIGINAL, '다음 문단의 내용 200']
    : ['Previous paragraph line 100', 'Payment amount 30,000 won', 'Following paragraph line 200'];
  try {
    const resources = { Font: { F0: korean ? fontResource(pdf, font, [title, ...strings]) : pdf.addSimpleFont(font) } };
    const draw = (text: string, y: number, size = 12) => korean
      ? line(font, text, 40, y, size)
      : `BT /F0 ${size} Tf 0 0 0 rg 1 0 0 1 40 ${y} Tm (${text}) Tj ET\n`;
    let content = draw(title, 370, 24);
    if (dense) {
      const leading = kind === 'Nanum12' ? 12 : 14;
      content += strings.map((text, index) => draw(text, 300 - index * leading)).join('');
    } else {
      if (kind !== 'tj') content += kind === 'cut' ? 'q 44 260 326 60 re W n\n' : 'q 30 260 340 60 re W n\n';
      content += kind === 'tj'
        ? 'BT /F0 12 Tf 0 0 0 rg 1 0 0 1 40 300 Tm [(Body) -250 (text) -250 (sample)] TJ ET\n'
        : draw('Body text sample', 300);
      if (kind !== 'tj') content += 'Q\n';
      content += draw('Untouched neighbor 200', 240);
    }
    pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], 0, resources, content));
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}

export function adjacentColorSpanFixture(): Uint8Array {
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('Helvetica');
  try {
    const resources = { Font: { F0: pdf.addSimpleFont(font) } };
    pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], 0, resources,
      'BT /F0 12 Tf 0 0 0 rg 1 0 0 1 40 330 Tm (HHHH) Tj 1 0 0 rg (HHHH) Tj ET'));
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}

export type UnsafeKind = 'overlap' | 'ligature' | 'nonBMP' | 'actualText' | 'clipped' | 'vertical';
export async function unsafeFixture(kind: UnsafeKind): Promise<Uint8Array> {
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('FixtureNanum', await loadFont(bundledFont));
  try {
    const safe = '정상 한글 Safe 123';
    const bad = kind === 'overlap' ? 'OVERLAP' : 'A';
    const gid = font.encodeCharacter(65);
    const fontRef = fontResource(pdf, font, [safe, bad], kind === 'nonBMP' ? [[gid, '😀']] : kind === 'ligature' ? [[gid, 'fi']] : []);
    const verticalResource = pdf.newDictionary();
    fontRef.forEach((value, key) => verticalResource.put(key, value));
    verticalResource.put('Encoding', 'Identity-V');
    // Match semantic reading order to visual order so page-corner selection spans both lines.
    let contents = '';
    if (kind === 'overlap') contents += line(font, bad, 40, 320) + line(font, 'OVERLAP', 43, 320);
    else if (kind === 'actualText') contents += `/Span << /ActualText <FEFF${utf16Hex('실제 의미 😀')}> >> BDC\n${line(font, bad, 40, 320)}EMC\n`;
    else if (kind === 'clipped') contents += `q BT /F0 16 Tf 7 Tr 1 0 0 1 40 320 Tm <${glyphs(font, bad)}> Tj ET 0 0 400 400 re f Q\n`;
    else if (kind === 'vertical') contents += line(font, bad, 50, 320, 16, 'FV');
    else contents += line(font, bad, 40, 320);
    contents += line(font, safe, 40, 180);
    pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], 0, { Font: { F0: fontRef, FV: pdf.addObject(verticalResource) } }, contents));
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}

export const GEOMETRIES: Array<{ media: Rect; crop: Rect; rotate: QuarterTurn; unit: number }> = [
  { media: [0, 0, 612, 792], crop: [0, 0, 612, 792], rotate: 0, unit: 1 },
  { media: [0, 0, 595.28, 841.89], crop: [0, 0, 595.28, 841.89], rotate: 0, unit: 1 },
  { media: [0, 0, 792, 612], crop: [0, 0, 792, 612], rotate: 0, unit: 1 },
  { media: [-20, -30, 640, 810], crop: [30, 45, 530, 745], rotate: 90, unit: 1 },
  { media: [0, 0, 360, 460], crop: [20, 30, 320, 430], rotate: 270, unit: 2 },
];

export function geometryFixture(): Uint8Array {
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('Helvetica');
  try {
    const resources = pdf.addObject({ Font: { F0: pdf.addSimpleFont(font) }, XObject: { Shared: pdf.addStream('0.8 0.2 0.2 rg 0 0 60 30 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 60, 30], Resources: {} }) } });
    const contents = pdf.addObject([pdf.addStream('0.94 0.91 0.8 rg -20 -30 900 950 re f 0 0 0 rg BT /F0 16 Tf 1 0 0 1 70 180 Tm (Shared original 123) Tj ET q 1 0 0 1 100 230 cm /Shared Do Q 0 0.6 0 RG 3 w 60 100 m 260 100 l S', {})]);
    for (const geometry of GEOMETRIES) {
      const ref = pdf.addPage(geometry.media, geometry.rotate, resources, '');
      ref.put('CropBox', geometry.crop); ref.put('UserUnit', geometry.unit); ref.put('Contents', contents);
      const annot = pdf.addObject({ Type: 'Annot', Subtype: 'Square', Rect: [80, 260, 160, 280], F: 16, AP: { N: appearance(pdf) }, P: ref, NM: pdf.newString('no-rotate') });
      ref.put('Annots', [annot]); ref.put('StructParents', 7); ref.put('Group', { S: 'Transparency', CS: 'DeviceRGB' });
      pdf.insertPage(-1, ref);
    }
    const inheritedPage = pdf.findPage(3);
    const parent = inheritedPage.get('Parent');
    const branch = pdf.addObject({ Type: 'Pages', Parent: parent, Count: 1, Kids: [inheritedPage] });
    for (const key of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) {
      branch.put(key, inheritedPage.get(key)); inheritedPage.delete(key);
    }
    const siblings = parent.get('Kids');
    siblings.forEach((child, index) => { if (child.asIndirect() === inheritedPage.asIndirect()) siblings.put(index, branch); });
    inheritedPage.put('Parent', branch);
    pdf.getTrailer().get('Root').put('Lang', pdf.newString('ko-KR'));
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}

export function widgetFixture(kind: 'ordinary' | 'signature' | 'xfa' = 'ordinary'): Uint8Array {
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('Helvetica');
  try {
    const resources = { Font: { Helv: pdf.addSimpleFont(font) } };
    const pages = [0, 1, 2].map(index => {
      const ref = pdf.addPage([0, 0, 300, 400], 0, resources, `BT /Helv 16 Tf 1 0 0 1 30 320 Tm (Page ${index + 1}) Tj ET`); pdf.insertPage(-1, ref); return ref;
    });
    const root = pdf.addObject({ FT: kind === 'signature' ? 'Sig' : 'Tx', T: pdf.newString('customer'), DA: pdf.newString('/Helv 12 Tf 0 g') });
    const middle = pdf.addObject({ Parent: root, T: pdf.newString('details'), V: pdf.newString('original-value') });
    const leaf = pdf.addObject({ Parent: middle, T: pdf.newString('shared') });
    const ap = appearance(pdf);
    const widgets = pages.slice(0, 2).map((page, index) => pdf.addObject({ Type: 'Annot', Subtype: 'Widget', Parent: leaf, P: page, Rect: [30, 220, 110, 240], AP: { N: ap }, NM: pdf.newString(`widget-${index}`) }));
    root.put('Kids', [middle]); middle.put('Kids', [leaf]); leaf.put('Kids', widgets);
    pages[0].put('Annots', [widgets[0]]); pages[1].put('Annots', [widgets[1]]);
    const form = pdf.addObject({ Fields: [root], CO: [leaf], DR: resources, NeedAppearances: false });
    if (kind === 'xfa') form.put('XFA', pdf.addStream('<xfa/>', {}));
    pdf.getTrailer().get('Root').put('AcroForm', form);
    const link = pdf.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [30, 280, 120, 300], Dest: [pages[0], 'Fit'], Border: [0, 0, 0], P: pages[2] });
    pages[2].put('Annots', [link]);
    const outline = pdf.addObject({ Title: pdf.newString('First page'), Dest: [pages[0], 'Fit'] });
    const outlines = pdf.addObject({ Type: 'Outlines', First: outline, Last: outline, Count: 1 }); outline.put('Parent', outlines);
    pdf.getTrailer().get('Root').put('Outlines', outlines);
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}

export interface DirectRaster { rgba: Uint8ClampedArray; width: number; height: number; bounds: Rect }

export function directRender(bytes: Uint8Array, index = 0, scale = 1): DirectRaster {
  const pdf = new mupdf.PDFDocument(bytes); const page = pdf.loadPage(index);
  const pixmap = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true, 'View', 'CropBox');
  try {
    const width = pixmap.getWidth(); const height = pixmap.getHeight(); const stride = pixmap.getStride(); const components = pixmap.getNumberOfComponents();
    const pixels = pixmap.getPixels(); const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const src = y * stride + x * components; const dst = (y * width + x) * 4;
      rgba[dst] = pixels[src]; rgba[dst + 1] = pixels[src + 1]; rgba[dst + 2] = pixels[src + 2]; rgba[dst + 3] = 255;
    }
    return { rgba, width, height, bounds: page.getBounds('CropBox') };
  } finally { pixmap.destroy(); page.destroy(); pdf.destroy(); }
}

export function extractedText(bytes: Uint8Array, index = 0): string {
  const pdf = new mupdf.PDFDocument(bytes); const page = pdf.loadPage(index); const text = page.toStructuredText('');
  try { return text.asText(); } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}

export function annotations(pdf: mupdf.PDFDocument, index: number): Map<string, mupdf.PDFObject> {
  const result = new Map<string, mupdf.PDFObject>();
  pdf.findPage(index).get('Annots').forEach(annot => result.set(annot.get('NM').asString(), annot));
  return result;
}

export async function multiPageFixture(count: number): Promise<Uint8Array> {
  if (!Number.isInteger(count) || count < 1) throw new Error('Fixture page count must be positive');
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('FixtureNanum', await loadFont(bundledFont));
  try {
    const fontRef = fontResource(pdf, font, [ORIGINAL, 'Page 0123456789', LITERAL]);
    for (let index = 0; index < count; index++) {
      const contents = '0.94 0.96 0.88 rg 0 0 420 420 re f\n'
        + line(font, ORIGINAL, 40, 330) + line(font, `Page ${index + 1}`, 40, 240)
        + (index === 0 ? line(font, LITERAL, 40, 170, 10) : '');
      pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], 0, { Font: { F0: fontRef } }, contents));
    }
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}

export function mergedWidgetFixture(): Uint8Array {
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('Helvetica');
  try {
    const resources = { Font: { Helv: pdf.addSimpleFont(font) } };
    const page = pdf.addPage([0, 0, 300, 400], 0, resources, ''); pdf.insertPage(-1, page);
    const merged = pdf.addObject({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: pdf.newString('merged'), V: pdf.newString('merged-value'), DA: pdf.newString('/Helv 12 Tf 0 g'), Rect: [30, 220, 110, 240], P: page, AP: { N: appearance(pdf) } });
    page.put('Annots', [merged]);
    pdf.getTrailer().get('Root').put('AcroForm', { Fields: [merged], CO: [merged], DR: resources });
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}
