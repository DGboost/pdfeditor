import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { assertOfficeRecordUpdate, validateOfficeRecord } from '../src/documents/officeDb';
import { OFFICE_ENGINES } from '../src/documents/officeTypes';
import type { OfficeRecord } from '../src/documents/officeTypes';

function officeBlob(format: 'docx' | 'pptx', text = 'Original'): Blob {
  const word = format === 'docx';
  const part = word ? 'word/document.xml' : 'ppt/presentation.xml';
  const mainType = word
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
  const document = word
    ? `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    : '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/><p:sldSz cx="9144000" cy="6858000"/></p:presentation>';
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${part}" ContentType="${mainType}"/></Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${part}"/></Relationships>`),
    [part]: strToU8(document),
  });
  return new Blob([bytes]);
}

async function sourceHash(blob: Blob): Promise<string> {
  return createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
}

async function record(format: 'docx' | 'pptx' = 'docx'): Promise<OfficeRecord> {
  const source = officeBlob(format);
  return {
    version: 1, id: 'document-a', format, fileName: `working.${format}`,
    sourceName: `original.${format}`, source, sourceHash: await sourceHash(source),
    engine: OFFICE_ENGINES[format], checkpoint: null, checkpointSequence: 0,
    revision: 0, modified: false, zoom: 1, savedAt: 1,
    pptxConversionAccepted: format === 'pptx',
  };
}

function nativeRecord(original: OfficeRecord): OfficeRecord {
  return {
    ...original, modified: true, revision: 2, checkpointSequence: 3,
    checkpoint: { kind: 'native', format: 'docx', bytes: officeBlob('docx', 'Edited'), warnings: [] },
  };
}

function presentationRecord(original: OfficeRecord, slide: Record<string, unknown>, assets: { id: string; blob: Blob }[] = []): OfficeRecord {
  return {
    ...original, modified: true, revision: 1, checkpointSequence: 1,
    checkpoint: {
      kind: 'pptist',
      payload: { title: 'Edited presentation', width: 960, height: 540, theme: {}, slides: [{ id: 'slide-a', elements: [], ...slide }] },
      assets,
    },
  };
}

// A real one-pixel PNG; its MIME is deliberately not trusted by the validator.
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });

test('record validation rejects source and native checkpoint bytes that disagree with the declared format', async () => {
  const original = await record();
  const edited = nativeRecord(original);
  await validateOfficeRecord(original);
  await validateOfficeRecord(edited);

  const incompatible = [
    officeBlob('pptx'),
    new Blob(['%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    new Blob([png], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  ];
  for (const bytes of incompatible) {
    // Both record names still end in .docx, and the hash matches the alien bytes.
    await assert.rejects(validateOfficeRecord({ ...original, source: bytes, sourceHash: await sourceHash(bytes) }), Error);
    await assert.rejects(validateOfficeRecord({
      ...edited, checkpoint: { kind: 'native', format: 'docx', bytes, warnings: [] },
    }), Error);
  }
  await assert.rejects(validateOfficeRecord({
    ...edited, checkpoint: { kind: 'native', format: 'hwpx', bytes: officeBlob('docx'), warnings: [] },
  }), Error);
  const pptx = await record('pptx');
  await validateOfficeRecord(presentationRecord(pptx, {}));
  await assert.rejects(validateOfficeRecord({ ...pptx, checkpoint: edited.checkpoint }), Error);
  await assert.rejects(validateOfficeRecord({ ...edited, checkpoint: presentationRecord(pptx, {}).checkpoint }), Error);
});

test('record validation refuses unsupported record versions and incompatible engine contracts', async () => {
  const original = await record();
  await validateOfficeRecord(original);
  await assert.rejects(validateOfficeRecord({ ...original, version: 2 }), Error);
  await assert.rejects(validateOfficeRecord({ ...original, engine: OFFICE_ENGINES.pptx }), Error);
  await assert.rejects(validateOfficeRecord({ ...original, engine: { ...original.engine, version: 'superdoc-1.46.3-pdfe.2' } }), Error);
});

test('record validation verifies original bytes rather than accepting a well-shaped SHA', async () => {
  const original = await record();
  await validateOfficeRecord(original);
  const tampered = officeBlob('docx', 'Replaced original');
  await assert.rejects(validateOfficeRecord({ ...original, source: tampered }), Error);
  await assert.rejects(validateOfficeRecord({ ...original, sourceHash: '0'.repeat(64) }), Error);
});

test('PPT checkpoint validation requires restorable assets in every media field', async () => {
  const original = await record('pptx');
  const mediaSlides: [string, (src: string) => Record<string, unknown>][] = [
    ['image source', src => ({ elements: [{ id: 'image-a', type: 'image', src }] })],
    ['video source', src => ({ elements: [{ id: 'video-a', type: 'video', src }] })],
    ['audio source', src => ({ elements: [{ id: 'audio-a', type: 'audio', src }] })],
    ['video poster', src => ({ elements: [{ id: 'video-a', type: 'video', poster: src }] })],
    ['shape pattern', src => ({ elements: [{ id: 'shape-a', type: 'shape', pattern: src }] })],
    ['slide background', src => ({ background: { type: 'image', image: { src } } })],
  ];
  for (const [field, slide] of mediaSlides) {
    const assets = [{ id: 'media-a', blob: png }];
    await validateOfficeRecord(presentationRecord(original, slide('pdfe-asset:media-a'), assets));
    await assert.rejects(validateOfficeRecord(presentationRecord(original, slide('pdfe-asset:media-a'))), Error, `${field}: missing asset`);
    await assert.rejects(validateOfficeRecord(presentationRecord(original, slide('blob:https://editor.test/dead'), assets)), Error, `${field}: session-local URL`);
  }
});

test('PPT checkpoint validation refuses ambiguous duplicate asset IDs without interpreting ordinary text as media', async () => {
  const original = await record('pptx');
  const slide = { elements: [
    { id: 'text-a', type: 'text', content: 'pdfe-asset:not-an-asset' },
    { id: 'text-b', type: 'text', content: 'blob:ordinary-text' },
    { id: 'image-a', type: 'image', src: 'pdfe-asset:media-a' },
  ] };
  const asset = { id: 'media-a', blob: png };
  await validateOfficeRecord(presentationRecord(original, slide, [asset]));
  await assert.rejects(validateOfficeRecord(presentationRecord(original, slide, [asset, { id: asset.id, blob: new Blob(['different bytes']) }])), Error);
});

test('update guard rejects stale/equal sequences and revision rollback, but permits a newer metadata-only save', async () => {
  const previous = nativeRecord(await record());
  await validateOfficeRecord(previous);
  const next = { ...previous, checkpointSequence: previous.checkpointSequence + 1, fileName: 'renamed.docx', zoom: 1.5 };
  await validateOfficeRecord(next);
  assert.doesNotThrow(() => assertOfficeRecordUpdate(previous, next));
  assert.throws(() => assertOfficeRecordUpdate(previous, { ...next, checkpointSequence: previous.checkpointSequence - 1 }), Error);
  assert.throws(() => assertOfficeRecordUpdate(previous, { ...next, checkpointSequence: previous.checkpointSequence }), Error);
  const rolledBack = { ...next, revision: previous.revision - 1 };
  await validateOfficeRecord(rolledBack);
  assert.throws(() => assertOfficeRecordUpdate(previous, rolledBack), Error);
});

test('update guard refuses original replacement and modified rollback even when each record validates independently', async () => {
  const previous = nativeRecord(await record());
  const next = { ...previous, checkpointSequence: previous.checkpointSequence + 1 };
  await validateOfficeRecord(previous);
  await validateOfficeRecord(next);
  assert.doesNotThrow(() => assertOfficeRecordUpdate(previous, next));

  const source = officeBlob('docx', 'Different original');
  const replaced = { ...next, source, sourceHash: await sourceHash(source) };
  await validateOfficeRecord(replaced);
  assert.throws(() => assertOfficeRecordUpdate(previous, replaced), Error);
  assert.throws(() => assertOfficeRecordUpdate(previous, { ...next, sourceName: 'different.docx' }), Error);
  assert.throws(() => assertOfficeRecordUpdate(previous, { ...next, id: 'document-b' }), Error);

  // Revision zero isolates the sticky modified flag from the revision rollback guard.
  const modifiedAtZero = { ...previous, revision: 0 };
  const markedOriginal = { ...next, revision: 0, modified: false };
  await validateOfficeRecord(modifiedAtZero);
  await validateOfficeRecord(markedOriginal);
  assert.throws(() => assertOfficeRecordUpdate(modifiedAtZero, markedOriginal), Error);
});
