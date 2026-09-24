import { unzipSync } from 'fflate';
import * as CFB from 'cfb';
import type { Detection, DocumentFormat } from './formats';

const WORD_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const PRESENTATION_MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OPF_NS = 'http://www.idpf.org/2007/opf/';
const XML_LIMIT = 4 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
function invalid(): never { throw new Error('손상되었거나 올바르지 않은 문서 파일입니다.'); }
const reject = (message: string): Detection => ({ kind: 'rejected', message });

interface ZipEntry { size: number; crc: number }

/** Validate directory/local metadata before fflate's selective decompression.
 * fflate intentionally does not validate signatures, CRCs or duplicate entries.
 */
function zipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => {
    const n = view.getBigUint64(at, true);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(n);
  };
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  }
  if (end < 0 || end < bytes.length - 65557 || u16(end + 4) || u16(end + 6)) invalid();
  let count = u16(end + 10), size = u32(end + 12), offset = u32(end + 16);
  let directoryEnd = end;
  if (count !== u16(end + 8)) invalid();
  if (end >= 20 && u32(end - 20) === 0x07064b50) {
    if (u32(end - 16) || u32(end - 4) !== 1) invalid();
    const zip64 = u64(end - 12);
    if (u32(zip64) !== 0x06064b50 || u64(zip64 + 4) < 44 || zip64 + 12 + u64(zip64 + 4) !== end - 20) invalid();
    if (u32(zip64 + 16) || u32(zip64 + 20) || u64(zip64 + 24) !== u64(zip64 + 32)) invalid();
    count = u64(zip64 + 32); size = u64(zip64 + 40); offset = u64(zip64 + 48);
    directoryEnd = zip64;
  }
  if (offset + size !== directoryEnd || count > size / 46) invalid();
  const entries = new Map<string, ZipEntry>();
  const names = new Set<string>();
  const ranges: [number, number][] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directoryEnd || u32(at) !== 0x02014b50) invalid();
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16);
    let compressed = u32(at + 20), original = u32(at + 24), local = u32(at + 42);
    const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || u16(at + 34)) invalid();
    if (flags & 0x41) throw new Error('암호화된 문서는 지원하지 않습니다. 암호를 해제한 파일을 열어 주세요.');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    // Target part names are ASCII; non-UTF8 ZIP names are irrelevant to classification.
    const name = flags & 0x800 ? decoder.decode(nameBytes) : Array.from(nameBytes, c => String.fromCharCode(c)).join('');
    if (!name || name.includes('\0') || names.has(name.toLowerCase())) invalid();
    names.add(name.toLowerCase());
    let hasZip64 = false;
    for (let extra = at + 46 + nameLength; extra < at + 46 + nameLength + extraLength;) {
      const length = u16(extra + 2), stop = extra + 4 + length;
      if (stop > at + 46 + nameLength + extraLength) invalid();
      if (u16(extra) === 1) {
        if (hasZip64) invalid();
        hasZip64 = true;
        let field = extra + 4;
        const value = () => { if (field + 8 > stop) invalid(); const n = u64(field); field += 8; return n; };
        if (original === 0xffffffff) original = value();
        if (compressed === 0xffffffff) compressed = value();
        if (local === 0xffffffff) local = value();
      }
      extra = stop;
    }
    if (compressed === 0xffffffff || original === 0xffffffff || local === 0xffffffff) invalid();
    if (local + 30 > offset || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) invalid();
    const localNameLength = u16(local + 26), data = local + 30 + localNameLength + u16(local + 28);
    if (localNameLength !== nameLength || data + compressed > offset) invalid();
    for (let n = 0; n < nameLength; n++) if (bytes[local + 30 + n] !== nameBytes[n]) invalid();
    if (!(flags & 8) && (u32(local + 14) !== crc || (u32(local + 18) !== compressed && u32(local + 18) !== 0xffffffff) || (u32(local + 22) !== original && u32(local + 22) !== 0xffffffff))) invalid();
    if (method === 0 && compressed !== original) invalid();
    ranges.push([local, data + compressed]);
    entries.set(name, { size: original, crc });
    at = next;
  }
  if (at !== directoryEnd) invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let n = 1; n < ranges.length; n++) if (ranges[n][0] < ranges[n - 1][1]) invalid();
  return entries;
}

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

interface XmlElement { local: string; namespace: string; attributes: Map<string, string>; parent: XmlElement | null }

/** Metadata-only XML reader: no DTD/entity expansion, external resources or DOM.
 * Checks the complete bounded XML, including closing tags and namespace bindings.
 */
function xmlElements(bytes: Uint8Array): XmlElement[] {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  else text = decoder.decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) invalid();
  const decode = (value: string) => value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);|&/g, (entity, name: string | undefined) => {
    if (!name) return invalid();
    if (!name.startsWith('#')) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name];
    const n = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!(n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff))) return invalid();
    return String.fromCodePoint(n);
  });
  const elements: XmlElement[] = [];
  const stack: { name: string; element: XmlElement; namespaces: Map<string, string> }[] = [];
  const namePattern = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
  const opening = new RegExp(`^(${namePattern})`);
  const attribute = new RegExp(`^\\s+(${namePattern})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`);
  let at = 0, rootClosed = false;
  while (at < text.length) {
    if (text[at] !== '<') {
      const next = text.indexOf('<', at), stop = next < 0 ? text.length : next;
      const value = text.slice(at, stop);
      if ((!stack.length && value.trim()) || value.includes(']]>')) invalid();
      decode(value); at = stop; continue;
    }
    if (text.startsWith('<!--', at)) {
      const stop = text.indexOf('-->', at + 4);
      if (stop < 0 || text.slice(at + 4, stop).includes('--')) invalid();
      at = stop + 3; continue;
    }
    if (text.startsWith('<?', at)) {
      const stop = text.indexOf('?>', at + 2);
      if (stop < 0 || !opening.test(text.slice(at + 2, stop))) invalid();
      at = stop + 2; continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      const stop = text.indexOf(']]>', at + 9);
      if (stop < 0 || !stack.length) invalid();
      at = stop + 3; continue;
    }
    if (text.startsWith('</', at)) {
      const match = new RegExp(`^</(${namePattern})\\s*>`).exec(text.slice(at));
      if (!match || stack.pop()?.name !== match[1]) invalid();
      at += match![0].length;
      if (!stack.length) rootClosed = true;
      continue;
    }
    const match = opening.exec(text.slice(at + 1));
    if (!match || rootClosed) invalid();
    const name = match![1]; at += 1 + name.length;
    const attributes = new Map<string, string>();
    while (at < text.length) {
      const attr = attribute.exec(text.slice(at));
      if (!attr) break;
      if (attributes.has(attr[1])) invalid();
      attributes.set(attr[1], decode(attr[2] ?? attr[3])); at += attr[0].length;
    }
    const close = /^\s*(\/?)>/.exec(text.slice(at));
    if (!close) invalid();
    at += close![0].length;
    const namespaces = new Map(stack.at(-1)?.namespaces ?? [['xml', 'http://www.w3.org/XML/1998/namespace']]);
    for (const [key, value] of attributes) {
      if (key === 'xmlns') namespaces.set('', value);
      else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), value);
    }
    const expanded = new Set<string>();
    for (const key of attributes.keys()) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const parts = key.split(':');
      if (parts.length === 2 && !namespaces.get(parts[0])) invalid();
      const resolved = `${parts.length === 2 ? namespaces.get(parts[0]) : ''}|${parts.at(-1)}`;
      if (expanded.has(resolved)) invalid();
      expanded.add(resolved);
    }
    const parts = name.split(':');
    if (parts.length === 2 && !namespaces.get(parts[0])) invalid();
    const element: XmlElement = { local: parts.at(-1)!, namespace: namespaces.get(parts.length === 2 ? parts[0] : '') ?? '', attributes, parent: stack.at(-1)?.element ?? null };
    elements.push(element);
    if (!close![1]) stack.push({ name, element, namespaces });
    else if (!stack.length) rootClosed = true;
  }
  if (stack.length || !rootClosed || !elements.length) invalid();
  return elements;
}

function detectZip(bytes: Uint8Array): DocumentFormat | Detection {
  const entries = zipDirectory(bytes);
  const extracted = unzipSync(bytes, { filter: entry => {
    if (entry.name !== '[Content_Types].xml' && entry.name !== 'mimetype' && entry.name !== 'Contents/content.hpf') return false;
    if (entry.originalSize > (entry.name === 'mimetype' ? 256 : XML_LIMIT)) throw new Error('문서 형식 정보가 너무 커서 안전하게 확인할 수 없습니다.');
    return true;
  } });
  for (const [name, content] of Object.entries(extracted)) {
    const entry = entries.get(name);
    if (!entry || content.length !== entry.size || crc32(content) !== entry.crc) invalid();
  }
  const hasPart = (name: string) => (entries.get(name)?.size ?? 0) > 0;
  const candidates = new Set<DocumentFormat>();
  let unsupportedMain = false;
  if (extracted['[Content_Types].xml']) {
    const elements = xmlElements(extracted['[Content_Types].xml']);
    const root = elements[0];
    if (root.local !== 'Types' || root.namespace !== TYPES_NS) invalid();
    const partNames = new Set<string>();
    for (const element of elements.slice(1)) {
      if (element.parent !== root || element.namespace !== TYPES_NS || !['Override', 'Default'].includes(element.local)) invalid();
      const type = element.attributes.get('ContentType');
      if (!type) invalid();
      const part = element.attributes.get(element.local === 'Override' ? 'PartName' : 'Extension');
      if (!part || partNames.has(`${element.local}:${part}`)) invalid();
      partNames.add(`${element.local}:${part}`);
      if (type === WORD_MAIN || type === PRESENTATION_MAIN) {
        const format = type === WORD_MAIN ? 'docx' : 'pptx';
        const expected = format === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml';
        if (element.local !== 'Override' || part !== `/${expected}` || !hasPart(expected)) invalid();
        candidates.add(format);
      } else if (/\.(?:main\+xml|macroEnabled\.main\+xml)$/i.test(type)) {
        unsupportedMain = true;
      }
    }
  }
  if (extracted.mimetype && decoder.decode(extracted.mimetype) === 'application/hwp+zip') {
    if (!extracted['Contents/content.hpf']) invalid();
    const elements = xmlElements(extracted['Contents/content.hpf']);
    const root = elements[0];
    if (root.local !== 'package' || root.namespace !== OPF_NS) invalid();
    const sections = elements.filter(element => element.local === 'item' && element.namespace === OPF_NS && element.parent?.local === 'manifest' && element.parent.namespace === OPF_NS && element.parent.parent === root && /^Contents\/section\d+\.xml$/.test(element.attributes.get('href') ?? ''));
    if (!sections.length || sections.some(section => !hasPart(section.attributes.get('href')!))) invalid();
    candidates.add('hwpx');
  }
  // A conflicting main part is ambiguous even if its manifest was omitted.
  if ((hasPart('word/document.xml') && (candidates.has('pptx') || candidates.has('hwpx'))) || (hasPart('ppt/presentation.xml') && (candidates.has('docx') || candidates.has('hwpx'))) || (hasPart('Contents/content.hpf') && (candidates.has('docx') || candidates.has('pptx'))) || candidates.size > 1) {
    return reject('여러 문서 형식이 함께 들어 있는 모호한 파일입니다.');
  }
  if (unsupportedMain) return reject('매크로 문서·서식 파일 또는 지원하지 않는 문서 형식입니다. 일반 DOCX/PPTX 문서로 저장한 파일을 열어 주세요.');
  return candidates.values().next().value ?? reject('지원되는 문서 형식이 아닌 ZIP 파일입니다.');
}

function detectCfb(bytes: Uint8Array): DocumentFormat | Detection {
  if (bytes.length < 512) invalid();
  const sectorShift = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(30, true);
  if ((sectorShift !== 9 && sectorShift !== 12) || bytes.length % (2 ** sectorShift)) invalid();
  const cfb = CFB.read(bytes, { type: 'array', WTF: true });
  const stream = (name: string) => {
    const entry = CFB.find(cfb, `/${name}`);
    if (!entry || entry.type !== 2) return null;
    if (!entry.content || entry.size !== entry.content.length) invalid();
    return entry.content;
  };
  if (stream('EncryptionInfo') || stream('EncryptedPackage')) return reject('암호화된 Office 문서는 지원하지 않습니다. 암호를 해제한 파일을 열어 주세요.');
  const header = stream('FileHeader');
  const hwp = !!header && header.length >= 32 && Array.from('HWP Document File', c => c.charCodeAt(0)).every((c, i) => header[i] === c) && Array.from(header.slice(17, 32)).every(c => c === 0);
  const doc = !!stream('WordDocument')?.length;
  const ppt = !!stream('PowerPoint Document')?.length;
  if (Number(hwp) + Number(doc) + Number(ppt) > 1) return reject('여러 문서 형식이 함께 들어 있는 모호한 파일입니다.');
  if (hwp) return 'hwp';
  if (doc) return { kind: 'legacy', format: 'doc' };
  if (ppt) return { kind: 'legacy', format: 'ppt' };
  return reject('지원되는 HWP/DOC/PPT 문서가 아닌 복합 파일입니다.');
}

/** Pure classification used by the worker and synthetic-fixture regression tests.
 * PDF classification is provisional: the existing MuPDF open remains the final parse.
 */
export function detectDocumentContent(bytes: Uint8Array, fileName: string): Detection {
  if (!bytes.length) return reject('빈 파일은 열 수 없습니다.');
  try {
    let result: DocumentFormat | Detection;
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) result = 'pdf';
    else if (bytes[0] === 0x50 && bytes[1] === 0x4b) result = detectZip(bytes);
    else if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((c, i) => bytes[i] === c)) result = detectCfb(bytes);
    else return reject('지원하지 않거나 손상된 파일입니다. PDF, DOCX, HWP, HWPX, PPTX 파일을 선택해 주세요.');
    if (typeof result !== 'string') return result;
    const extension = /\.([^.]+)$/.exec(fileName)?.[1].toLowerCase();
    return { kind: 'supported', format: result, extensionMismatch: extension !== result };
  } catch (error) {
    return reject(error instanceof Error && /[가-힣]/.test(error.message) ? error.message : '손상되었거나 올바르지 않은 문서 파일입니다.');
  }
}
