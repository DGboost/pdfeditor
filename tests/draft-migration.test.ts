import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogFace } from '../src/pdf/fontCatalog';
import { normalizePdfDraft, serializeRetainedBackup } from '../src/utils/db';

function legacy(version: 2 | 3 | 4) {
  const face = getCatalogFace('nanumgothic-regular')!;
  const fontAsset = {
    id: face.sha256, catalogId: face.id, family: face.family, postScriptName: face.postScriptName,
    weight: face.weight, italic: face.italic, sourceUrl: face.url, licenseText: face.licenseText,
    bytes: new Blob([new Uint8Array([0, 1, 255, 32])]),
  };
  return {
    version, zoom: 1.25, revision: 7, savedAt: 123,
    workspace: {
      id: 'saved', fileName: 'source.pdf', source: new Blob([new Uint8Array([37, 80, 68, 70, 0, 255])]), sourceHash: 'a'.repeat(64),
      activePageId: 'page', fontAssets: [fontAsset],
      pages: [{
        id: 'page', label: 'Page', kind: 'pdf', rotation: 90, sourcePageIndex: 0, originalInstance: true,
        images: [] as unknown[], signatureFields: [] as unknown[], textBoxes: [] as unknown[],
        shapes: [] as unknown[],
        textEdits: [{
          ...(version === 2 ? { lineId: 'line' } : { lineIds: ['line', 'next'], layout: { referenceSizePt: 12, lineHeightPt: 15, firstLineIndentPt: 2, restLineIndentPt: 0 } }),
          widthPt: 100,
          content: { align: 'left', runs: [{ text: 'saved edit', style: { font: { kind: 'downloaded', assetId: face.sha256 }, sizePt: 12, color: [0, 0, 0], highlight: null as unknown } }] },
        }],
      }],
    },
  };
}

test('compatible v2/v3/v4 migration preserves source bytes, downloaded fonts, and source edit layout', async () => {
  for (const version of [2, 3, 4] as const) {
    const raw = legacy(version);
    const before = structuredClone(raw);
    const draft = normalizePdfDraft(raw);
    assert.equal(draft.version, 5);
    assert.deepEqual([draft.zoom, draft.revision, draft.savedAt], [1.25, 7, 123]);
    assert.equal('shapes' in draft.workspace.pages[0], false);
    assert.equal(draft.workspace.sourceHash, raw.workspace.sourceHash);
    assert.deepEqual(await draft.workspace.source.arrayBuffer(), await before.workspace.source.arrayBuffer());
    assert.deepEqual(draft.workspace.fontAssets, raw.workspace.fontAssets);
    assert.deepEqual(await draft.workspace.fontAssets![0].bytes.arrayBuffer(), await before.workspace.fontAssets[0].bytes.arrayBuffer());
    const page = draft.workspace.pages[0];
    assert.equal(page.kind, 'pdf');
    if (page.kind !== 'pdf') throw new Error('Expected PDF page');
    assert.deepEqual(page.textEdits[0].lineIds, version === 2 ? ['line'] : ['line', 'next']);
    assert.deepEqual(page.textEdits[0].layout, raw.workspace.pages[0].textEdits[0].layout);
    assert.equal(page.textEdits[0].content.runs[0].text, 'saved edit');
    assert.equal('images' in page || 'signatureFields' in page || 'textBoxes' in page, false);
    assert.equal('highlight' in page.textEdits[0].content.runs[0].style, false);
    assert.deepEqual(raw, before);
  }
});

test('legacy styles without highlight migrate, while every removed payload is rejected without mutation', () => {
  const absent = legacy(3);
  Reflect.deleteProperty(absent.workspace.pages[0].textEdits[0].content.runs[0].style, 'highlight');
  assert.equal(normalizePdfDraft(absent).workspace.pages[0].kind, 'pdf');
  for (const key of ['images', 'signatureFields', 'textBoxes', 'shapes'] as const) {
    const raw = legacy(3);
    raw.workspace.pages[0][key] = [{ id: 'removed', image: key === 'signatureFields' ? null : new Blob(['payload']) }];
    const before = structuredClone(raw);
    assert.throws(() => normalizePdfDraft(raw));
    assert.deepEqual(raw, before);
  }
  const highlighted = legacy(2);
  highlighted.workspace.pages[0].textEdits[0].content.runs[0].style.highlight = [1, 1, 0];
  const before = structuredClone(highlighted);
  assert.throws(() => normalizePdfDraft(highlighted));
  assert.deepEqual(highlighted, before);
});

test('v5 rejects obsolete properties even when empty or null and rejects malformed document invariants', () => {
  const draft = normalizePdfDraft(legacy(3));
  for (const key of ['images', 'signatureFields', 'textBoxes', 'shapes']) {
    const malformed = structuredClone(draft);
    Object.assign(malformed.workspace.pages[0], { [key]: [] });
    assert.throws(() => normalizePdfDraft(malformed));
  }
  const highlighted = structuredClone(draft);
  const page = highlighted.workspace.pages[0];
  if (page.kind !== 'pdf') throw new Error('Expected PDF page');
  Object.assign(page.textEdits[0].content.runs[0].style, { highlight: null });
  assert.throws(() => normalizePdfDraft(highlighted));
  for (const workspace of [
    { ...draft.workspace, pages: [] },
    { ...draft.workspace, pages: [draft.workspace.pages[0], draft.workspace.pages[0]] },
    { ...draft.workspace, activePageId: 'missing' },
    { ...draft.workspace, sourceHash: 'invalid' },
  ]) assert.throws(() => normalizePdfDraft({ ...draft, workspace }));
  const overlapping = structuredClone(draft);
  const overlapPage = overlapping.workspace.pages[0];
  if (overlapPage.kind !== 'pdf') throw new Error('Expected PDF page');
  overlapPage.textEdits[0].lineIds = ['line', 'line'];
  assert.throws(() => normalizePdfDraft(overlapping));
});

test('retained JSON backup omits undefined optional layout without losing removed content or Blob bytes', async () => {
  const raw = legacy(3);
  const page = raw.workspace.pages[0];
  Object.assign(page.textEdits[0], { lineIds: ['line'], layout: undefined });
  page.textEdits[0].content.runs[0].style.highlight = [1, 1, 0];
  const image = new Blob([new Uint8Array([137, 80, 78, 71, 0, 255])], { type: 'image/png' });
  page.images = [{ id: 'inserted-image', x: 1, y: 2, w: 30, h: 40, image }];
  page.textBoxes = [{ id: 'inserted-text', x: 3, y: 4, w: 100, h: 20, content: structuredClone(page.textEdits[0].content) }];
  const before = structuredClone(raw);
  const decoded = JSON.parse(await serializeRetainedBackup(raw));
  const savedPage = decoded.workspace.pages[0];
  assert.equal('layout' in savedPage.textEdits[0], false);
  assert.deepEqual(savedPage.textEdits[0].content, page.textEdits[0].content);
  assert.deepEqual(savedPage.textBoxes, page.textBoxes);
  assert.equal(decoded.workspace.sourceHash, raw.workspace.sourceHash);
  assert.equal(decoded.workspace.fontAssets[0].licenseText, raw.workspace.fontAssets[0].licenseText);
  for (const [encoded, original] of [
    [decoded.workspace.source, raw.workspace.source],
    [savedPage.images[0].image, image],
    [decoded.workspace.fontAssets[0].bytes, raw.workspace.fontAssets[0].bytes],
  ] as const) {
    assert.equal(encoded.__pdfeditor_blob__, true);
    assert.equal(encoded.type, original.type);
    assert.deepEqual(Buffer.from(encoded.base64, 'base64'), Buffer.from(await original.arrayBuffer()));
  }
  assert.deepEqual(raw, before);
  assert.equal(Object.hasOwn(page.textEdits[0], 'layout'), true);
});

test('legacy rectangles reject automatic restoration but retain their payload and source bytes in backup', async () => {
  for (const version of [2, 3, 4] as const) {
    const raw = legacy(version);
    const shapes = [{ id: 'rectangle', x: 12, y: 34, w: 56, h: 78 }];
    raw.workspace.pages[0].shapes = shapes;
    const before = structuredClone(raw);
    assert.throws(() => normalizePdfDraft(raw));
    const saved = JSON.parse(await serializeRetainedBackup(raw));
    assert.deepEqual(saved.workspace.pages[0].shapes, shapes);
    assert.deepEqual(Buffer.from(saved.workspace.source.base64, 'base64'), Buffer.from(await raw.workspace.source.arrayBuffer()));
    assert.deepEqual(Buffer.from(saved.workspace.fontAssets[0].bytes.base64, 'base64'), Buffer.from(await raw.workspace.fontAssets[0].bytes.arrayBuffer()));
    assert.deepEqual(raw, before);
  }
});
