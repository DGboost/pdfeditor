import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import * as CFB from 'cfb';
import { detectDocumentContent } from '../src/documents/detectContent';
import { LEGACY_DOCUMENT_MESSAGE } from '../src/documents/formats';

const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const pptType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const namespace = 'http://schemas.openxmlformats.org/package/2006/content-types';

function types(parts: [string, string][]): string {
  return `<?xml version="1.0"?><Types xmlns="${namespace}">${parts.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('')}</Types>`;
}

function archive(parts: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, content]) => [name, typeof content === 'string' ? strToU8(content) : content])));
}

function ooxml(format: 'docx' | 'pptx', contentType = format === 'docx' ? wordType : pptType): Record<string, string> {
  const part = format === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml';
  return { '[Content_Types].xml': types([[part, contentType]]), [part]: '<document/>' };
}

function hwpx(): Record<string, string> {
  return {
    mimetype: 'application/hwp+zip',
    'Contents/content.hpf': '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest></opf:package>',
    'Contents/section0.xml': '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"/>',
  };
}

function compound(streams: Record<string, Uint8Array>): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  for (const [name, bytes] of Object.entries(streams)) CFB.utils.cfb_add(cfb, name, bytes);
  return new Uint8Array(CFB.write(cfb, { type: 'array', fileType: 'cfb' }));
}

function hwpHeader(): Uint8Array {
  const header = new Uint8Array(256);
  header.set(strToU8('HWP Document File'));
  header[32] = 1; header[35] = 5;
  return header;
}

function expectRejected(bytes: Uint8Array, name = 'document.docx'): void {
  const result = detectDocumentContent(bytes, name);
  assert.equal(result.kind, 'rejected', JSON.stringify(result));
  if (result.kind === 'rejected') assert.match(result.message, /[가-힣]/);
}

test('content chooses DOCX/PPTX regardless of extension; missing or wrong suffix is reported', () => {
  for (const format of ['docx', 'pptx'] as const) {
    const bytes = archive(ooxml(format));
    for (const name of [`document.${format}`, `document.${format.toUpperCase()}`]) {
      assert.deepEqual(detectDocumentContent(bytes, name), { kind: 'supported', format, extensionMismatch: false });
    }
    for (const name of ['document', 'document.pdf', 'document.doc', 'document.ppt', `${format}.zip`]) {
      assert.deepEqual(detectDocumentContent(bytes, name), { kind: 'supported', format, extensionMismatch: true });
    }
  }
});

test('PDF header routes to MuPDF without claiming final PDF validity', () => {
  assert.deepEqual(detectDocumentContent(strToU8('%PDF-1.7\n'), 'document.pdf'), { kind: 'supported', format: 'pdf', extensionMismatch: false });
  assert.deepEqual(detectDocumentContent(strToU8('%PDF-1.7\n'), 'document.docx'), { kind: 'supported', format: 'pdf', extensionMismatch: true });
  expectRejected(strToU8('not a PDF'), 'document.pdf');
  expectRejected(strToU8('prefix %PDF-1.7'), 'document.pdf');
});

test('HWP uses its CFB FileHeader signature; Word and PowerPoint streams require conversion', () => {
  const hwp = compound({ FileHeader: hwpHeader(), 'BodyText/Section0': strToU8('body') });
  assert.deepEqual(detectDocumentContent(hwp, 'document.hwp'), { kind: 'supported', format: 'hwp', extensionMismatch: false });
  assert.deepEqual(detectDocumentContent(hwp, 'document.docx'), { kind: 'supported', format: 'hwp', extensionMismatch: true });
  assert.deepEqual(detectDocumentContent(compound({ WordDocument: strToU8('word') }), 'renamed.docx'), { kind: 'legacy', format: 'doc' });
  assert.deepEqual(detectDocumentContent(compound({ 'PowerPoint Document': strToU8('ppt') }), 'renamed.pptx'), { kind: 'legacy', format: 'ppt' });
  expectRejected(compound({ FileHeader: strToU8('not an HWP file header') }), 'document.hwp');
  expectRejected(compound({ 'Nested/WordDocument': strToU8('word') }), 'document.doc');
  expectRejected(compound({ WordDocument: new Uint8Array() }), 'document.doc');
  assert.equal(LEGACY_DOCUMENT_MESSAGE, 'DOC/PPT는 직접 편집하지 않습니다. DOCX/PPTX로 변환한 파일을 열어 주세요.');
});

test('HWPX needs exact mimetype, valid package metadata and a declared existing section', () => {
  assert.deepEqual(detectDocumentContent(archive(hwpx()), 'document.hwpx'), { kind: 'supported', format: 'hwpx', extensionMismatch: false });
  assert.deepEqual(detectDocumentContent(archive(hwpx()), 'document.hwp'), { kind: 'supported', format: 'hwpx', extensionMismatch: true });
  for (const missing of ['mimetype', 'Contents/content.hpf', 'Contents/section0.xml']) {
    const parts = hwpx(); delete parts[missing]; expectRejected(archive(parts), 'document.hwpx');
  }
  expectRejected(archive({ ...hwpx(), mimetype: 'application/hwp+zip\n' }), 'document.hwpx');
  expectRejected(archive({ ...hwpx(), 'Contents/content.hpf': '<package/>' }), 'document.hwpx');
  expectRejected(archive({ ...hwpx(), 'Contents/content.hpf': hwpx()['Contents/content.hpf'].replace('section0.xml', 'section1.xml') }), 'document.hwpx');
});

test('renamed macros and template packages never become editable DOCX/PPTX', () => {
  for (const [format, contentType] of [
    ['docx', 'application/vnd.ms-word.document.macroEnabled.main+xml'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'],
    ['docx', 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml'],
    ['pptx', 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'],
  ] as const) expectRejected(archive(ooxml(format, contentType)), `renamed.${format}`);
});

test('conflicting primary formats are rejected rather than chosen by suffix or entry order', () => {
  const both = { ...ooxml('docx'), ...ooxml('pptx'), '[Content_Types].xml': types([['word/document.xml', wordType], ['ppt/presentation.xml', pptType]]) };
  expectRejected(archive(both));
  expectRejected(archive(Object.fromEntries(Object.entries(both).reverse())), 'document.pptx');
  expectRejected(archive({ ...ooxml('docx'), ...hwpx() }));
  expectRejected(archive({ ...ooxml('pptx'), ...hwpx() }));
  expectRejected(archive({ ...ooxml('docx'), 'ppt/presentation.xml': '<presentation/>' }));
  expectRejected(compound({ FileHeader: hwpHeader(), WordDocument: strToU8('word') }), 'document.hwp');
  expectRejected(compound({ WordDocument: strToU8('word'), 'PowerPoint Document': strToU8('ppt') }), 'document.doc');
});

test('encrypted Office containers cannot be selected as a legacy or supported document', () => {
  for (const streams of [
    { EncryptionInfo: strToU8('encryption'), EncryptedPackage: strToU8('encrypted') },
    { EncryptionInfo: strToU8('encryption'), WordDocument: strToU8('word') },
    { EncryptedPackage: strToU8('encrypted'), FileHeader: hwpHeader() },
  ]) {
    const result = detectDocumentContent(compound(streams), 'document.docx');
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.match(result.message, /암호화/);
  }
});

test('empty, unknown, generic ZIP and damaged containers do not select an engine', () => {
  expectRejected(new Uint8Array());
  expectRejected(strToU8('plain text'), 'document.docx');
  expectRejected(archive({ 'notes.txt': 'hello' }));
  expectRejected(archive({}));
  const zipped = archive(ooxml('docx'));
  expectRejected(zipped.subarray(0, zipped.length - 10));
  const cfb = compound({ FileHeader: hwpHeader() });
  expectRejected(cfb.subarray(0, 40), 'document.hwp');
  expectRejected(cfb.subarray(0, cfb.length - 1), 'document.hwp');
  const damaged = cfb.slice(); damaged[32] = 0;
  expectRejected(damaged, 'document.hwp');
});

test('OOXML requires the exact main type, named nonempty part, and well-formed namespace-aware metadata', () => {
  expectRejected(archive({ 'word/document.xml': '<document/>' }));
  expectRejected(archive({ '[Content_Types].xml': types([['word/document.xml', wordType]]) }));
  expectRejected(archive({ ...ooxml('docx'), 'word/document.xml': '' }));
  expectRejected(archive({ ...ooxml('docx'), '[Content_Types].xml': types([['word/elsewhere.xml', wordType]]) }));
  for (const xml of [
    `<Types xmlns="${namespace}"><Override PartName="/word/document.xml" ContentType="${wordType}"></Types>`,
    `<Types xmlns="${namespace}"><Override PartName="/word/document.xml" ContentType="${wordType}" ContentType="${wordType}"/></Types>`,
    types([['word/document.xml', wordType], ['word/document.xml', wordType]]),
    types([['word/document.xml', wordType]]).replace(namespace, 'urn:wrong'),
    types([['word/document.xml', wordType]]).replace('</Types>', '</Types><other/>'),
    types([['word/document.xml', wordType]]).replace('ContentType=', 'unknown:ContentType='),
    `<!DOCTYPE Types [<!ENTITY type "${wordType}">]><Types xmlns="${namespace}"><Override PartName="/word/document.xml" ContentType="&type;"/></Types>`,
    types([['word/document.xml', wordType]]).replace('document.main', 'document&bogus;.main'),
  ]) expectRejected(archive({ ...ooxml('docx'), '[Content_Types].xml': xml }));
  const prefixed = `<ct:Types xmlns:ct="${namespace}"><ct:Override ContentType="${wordType}" PartName="/word/document.xml"/></ct:Types>`;
  assert.equal(detectDocumentContent(archive({ ...ooxml('docx'), '[Content_Types].xml': prefixed }), 'document.docx').kind, 'supported');
});

test('oversized metadata is refused without placing a size limit on document body or media', () => {
  expectRejected(archive({ ...ooxml('docx'), '[Content_Types].xml': ' '.repeat(4 * 1024 * 1024 + 1) }));
  expectRejected(archive({ ...hwpx(), 'Contents/content.hpf': ' '.repeat(4 * 1024 * 1024 + 1) }), 'document.hwpx');
  expectRejected(archive({ ...hwpx(), mimetype: ' '.repeat(257) }), 'document.hwpx');
  assert.equal(detectDocumentContent(archive({ ...ooxml('docx'), 'word/document.xml': `<document>${'x'.repeat(5 * 1024 * 1024)}</document>`, 'word/media/image.bin': new Uint8Array(8 * 1024 * 1024) }), 'document.docx').kind, 'supported');
});

test('duplicate ZIP manifest names, damaged directory offsets and metadata CRCs are rejected', () => {
  const first = '[Content_Types].xml', second = '[Content_Types].xmZ';
  const duplicate = zipSync({ ...Object.fromEntries(Object.entries(ooxml('docx')).map(([name, value]) => [name, strToU8(value)])), [second]: strToU8(types([['word/document.xml', wordType]])) }, { level: 0 });
  const marker = strToU8(second);
  for (let at = 0; at <= duplicate.length - marker.length; at++) {
    if (marker.every((value, index) => duplicate[at + index] === value)) duplicate.set(strToU8(first), at);
  }
  expectRejected(duplicate);
  const offset = archive(ooxml('docx'));
  new DataView(offset.buffer, offset.byteOffset).setUint32(offset.length - 6, 0xffffffff, true);
  expectRejected(offset);
  const crc = zipSync(Object.fromEntries(Object.entries(ooxml('docx')).map(([name, value]) => [name, strToU8(value)])), { level: 0 });
  const view = new DataView(crc.buffer, crc.byteOffset);
  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  crc[start] ^= 1;
  expectRejected(crc);
});
