import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { documentReducer, initialDocumentState } from '../src/hooks/useDocumentReducer';
import type { BlankPage, DocumentState, DownloadedFontAsset, Page, PdfPage, TextContent, Workspace } from '../src/types/pdfEditor';
import { getCatalogFace } from '../src/pdf/fontCatalog';
import { normalizePdfDraft, validateWorkspace } from '../src/utils/db';

function content(text: string): TextContent {
  return { align: 'left', runs: [{ text, style: { font: { kind: 'bundled', family: 'Courier', bold: false }, sizePt: 12, color: [0, 0, 0] } }] };
}
function page(id: string, sourcePageIndex = 0): PdfPage {
  return { id, label: id, kind: 'pdf', sourcePageIndex, originalInstance: true, rotation: 0, textEdits: [] };
}
function load(pages: Page[] = [page('first')]): DocumentState {
  const workspace: Workspace = { id: 'document-A', fileName: 'original.pdf', source: new Blob(['immutable source']), sourceHash: 'fixture', pages, activePageId: pages[0].id };
  return documentReducer(initialDocumentState, { type: 'LOAD_DOCUMENT', workspace });
}
function active(state: DocumentState): Page {
  assert.ok(state.workspace);
  const found = state.workspace.pages.find(p => p.id === state.workspace!.activePageId);
  assert.ok(found);
  return found;
}

test('add/edit/undo twice restores the active page before the next edit', () => {
  let state = load();
  const blank: BlankPage = { id: 'blank', label: 'blank', kind: 'blank', rotation: 0, widthPt: 612, heightPt: 792 };
  state = documentReducer(state, { type: 'ADD_PAGE', page: blank });
  assert.equal(active(state).id, 'blank');
  state = documentReducer(state, { type: 'ROTATE_PAGE', id: active(state).id, delta: 90 });
  state = documentReducer(state, { type: 'UNDO' });
  assert.equal(active(state).id, 'blank');
  assert.equal(active(state).rotation, 0);
  state = documentReducer(state, { type: 'UNDO' });
  assert.equal(active(state).id, 'first');
  state = documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: active(state).id, edit: { lineIds: ['line'], widthPt: 100, content: content('next edit') } });
  assert.deepEqual((active(state) as PdfPage).textEdits[0].content, content('next edit'));
  assert.equal(state.history.redo.length, 0);
});

test('deletion selects the next or previous neighbor and undo restores selection', () => {
  let state = load([page('first'), page('middle', 1), page('last', 2)]);
  state = documentReducer(state, { type: 'SET_ACTIVE_PAGE', id: 'middle' });
  state = documentReducer(state, { type: 'DELETE_PAGE', id: 'middle' });
  assert.equal(active(state).id, 'last');
  state = documentReducer(state, { type: 'UNDO' });
  assert.equal(active(state).id, 'middle');
  assert.deepEqual(state.workspace!.pages.map(p => p.id), ['first', 'middle', 'last']);
  state = documentReducer(state, { type: 'SET_ACTIVE_PAGE', id: 'last' });
  state = documentReducer(state, { type: 'DELETE_PAGE', id: 'last' });
  assert.equal(active(state).id, 'middle');
  state = documentReducer(state, { type: 'DELETE_PAGE', id: 'first' });
  assert.equal(documentReducer(state, { type: 'DELETE_PAGE', id: 'middle' }), state);
});

test('selection and equivalent edits do not create undo entries or discard redo', () => {
  let state = load([page('first'), page('second', 1)]);
  state = documentReducer(state, { type: 'ROTATE_PAGE', id: 'first', delta: 90 });
  state = documentReducer(state, { type: 'UNDO' });
  const redo = state.history.redo;
  state = documentReducer(state, { type: 'SET_ACTIVE_PAGE', id: 'second' });
  assert.equal(state.history.undo.length, 0);
  assert.equal(state.history.redo, redo);
  for (const action of [
    { type: 'SET_ACTIVE_PAGE', id: 'second' }, { type: 'SET_ACTIVE_PAGE', id: 'missing' },
    { type: 'ROTATE_PAGE', id: 'second', delta: 360 },
    { type: 'REMOVE_TEXT_EDIT', pageId: 'second', lineId: 'missing' },
    { type: 'REORDER_PAGES', fromId: 'second', toId: 'second' },
  ] as const) assert.equal(documentReducer(state, action), state);
  state = documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'second', edit: { lineIds: ['line'], widthPt: 120, content: content('replacement') } });
  assert.equal(documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'second', edit: { lineIds: ['line'], widthPt: 120, content: content('replacement') } }), state);
  state = documentReducer(state, { type: 'REMOVE_TEXT_EDIT', pageId: 'second', lineId: 'line' });
  assert.deepEqual((active(state) as PdfPage).textEdits, []);
});

test('duplicated source edits change independently while PDF bytes remain shared', () => {
  const first = page('first');
  first.textEdits = [{ lineIds: ['line'], widthPt: 100, content: content('source edit') }];
  let state = load([first]);
  const source = state.workspace!.source;
  state = documentReducer(state, { type: 'DUPLICATE_PAGE', id: 'first', newId: 'copy' });
  const copy = active(state) as PdfPage;
  assert.equal(copy.id, 'copy'); assert.equal(copy.originalInstance, false); assert.equal(copy.sourcePageIndex, first.sourcePageIndex);
  state = documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'copy', edit: { lineIds: ['line'], widthPt: 140, content: content('changed source') } });
  assert.deepEqual(state.workspace!.pages[0], first);
  assert.deepEqual((active(state) as PdfPage).textEdits[0].content, content('changed source'));
  assert.equal(state.workspace!.source, source);
});

test('revisions increase through undo/redo/restore and document replacement drops old content and history', () => {
  const old = page('first');
  old.textEdits = [{ lineIds: ['line'], widthPt: 100, content: content('old document text') }];
  let state = load([old]);
  let revision = state.revision;
  for (let i = 0; i < 25; i++) {
    state = documentReducer(state, { type: 'ROTATE_PAGE', id: 'first', delta: 90 });
    assert.ok(state.revision > revision); revision = state.revision;
  }
  assert.equal(state.history.undo.length, 20);
  for (const type of ['UNDO', 'REDO', 'UNDO'] as const) {
    state = documentReducer(state, { type }); assert.ok(state.revision > revision); revision = state.revision;
  }
  const next = { ...load([page('new')]).workspace!, id: 'document-B' };
  state = documentReducer(state, { type: 'LOAD_DOCUMENT', workspace: next });
  assert.equal(active(state).id, 'new'); assert.deepEqual(state.history, { undo: [], redo: [] });
  assert.deepEqual((active(state) as PdfPage).textEdits, []);
  assert.ok(state.revision > revision);
  state = documentReducer(state, { type: 'RESTORE_STATE', workspace: next, restoredRevision: 400 });
  assert.ok(state.revision > 400); assert.deepEqual(state.history, { undo: [], redo: [] });
  state = documentReducer(state, { type: 'SET_FILE_NAME', name: 'renamed.pdf' });
  assert.equal(state.workspace!.fileName, 'renamed.pdf'); assert.equal(state.history.undo.length, 0);
});

function downloadedAsset(): DownloadedFontAsset {
  const face = getCatalogFace('nanumgothic-regular')!;
  return {
    id: face.sha256, catalogId: face.id, family: face.family, postScriptName: face.postScriptName,
    weight: face.weight, italic: face.italic, sourceUrl: face.url, licenseText: face.licenseText,
    bytes: new Blob([readFileSync(new URL('../src/assets/fonts/nanumgothic/NanumGothic-Regular.ttf', import.meta.url))]),
  };
}

function downloadedContent(asset: DownloadedFontAsset): TextContent {
  const result = content('downloaded face');
  result.runs[0].style.font = { kind: 'downloaded', assetId: asset.id };
  return result;
}

test('v5 drafts without font assets restore unchanged and reject untrusted stored assets', () => {
  const workspace = { ...load().workspace!, sourceHash: 'a'.repeat(64) };
  const draft = { version: 5, workspace, zoom: 1, revision: 2, savedAt: 1 };
  assert.equal(normalizePdfDraft(draft).workspace, workspace);
  assert.equal('fontAssets' in normalizePdfDraft(draft).workspace, false);
  const asset = downloadedAsset();
  assert.deepEqual(validateWorkspace({ ...workspace, fontAssets: [asset] }).fontAssets, [asset]);
  for (const invalid of [
    { ...asset, catalogId: 'unknown-face' },
    { ...asset, family: 'untrusted-family' },
    { ...asset, sourceUrl: 'https://untrusted.invalid/font.ttf' },
    { ...asset, licenseText: 'untrusted-license' },
    { ...asset, bytes: new Blob([]) },
  ]) assert.throws(() => normalizePdfDraft({ ...draft, workspace: { ...workspace, fontAssets: [invalid] } }));
  assert.throws(() => validateWorkspace({ ...workspace, fontAssets: [asset, asset] }));
  assert.throws(() => validateWorkspace({ ...workspace, pages: [{ ...page('first'), textEdits: [{ lineIds: ['line'], widthPt: 100, content: downloadedContent(asset) }] }] }));
});

test('downloaded source edits and assets commit atomically through undo, redo, and duplication', () => {
  const asset = downloadedAsset();
  const original = load();
  const edit = { lineIds: ['line'], widthPt: 100, content: downloadedContent(asset) };
  assert.throws(() => documentReducer(original, { type: 'UPSERT_TEXT_EDIT', pageId: 'first', edit }));
  assert.throws(() => documentReducer(original, { type: 'UPSERT_TEXT_EDIT', pageId: 'first', edit, fontAssets: [{ ...asset, catalogId: 'unknown-face' }] }));
  assert.deepEqual(original.history, { undo: [], redo: [] });
  assert.deepEqual((active(original) as PdfPage).textEdits, []);
  let state = documentReducer(original, { type: 'UPSERT_TEXT_EDIT', pageId: 'first', edit, fontAssets: [asset] });
  assert.deepEqual((active(state) as PdfPage).textEdits, [edit]);
  assert.deepEqual(state.workspace!.fontAssets, [asset]);
  assert.equal(state.revision, original.revision + 1);
  state = documentReducer(state, { type: 'UNDO' });
  assert.deepEqual(state.workspace, original.workspace);
  assert.equal('fontAssets' in state.workspace!, false);
  state = documentReducer(state, { type: 'REDO' });
  assert.deepEqual((active(state) as PdfPage).textEdits, [edit]);
  assert.equal(state.workspace!.fontAssets![0].bytes, asset.bytes);
  state = documentReducer(state, { type: 'DUPLICATE_PAGE', id: 'first', newId: 'copy' });
  state = documentReducer(state, { type: 'DELETE_PAGE', id: 'first' });
  assert.deepEqual((active(state) as PdfPage).textEdits, [edit]);
  assert.equal(state.workspace!.fontAssets![0].bytes, asset.bytes);
});

test('no-op and unreferenced source edits do not persist pending downloads', () => {
  const asset = downloadedAsset();
  let state = load();
  const edit = { lineIds: ['line'], widthPt: 100, content: content('existing font') };
  assert.equal(documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'missing', edit, fontAssets: [asset] }), state);
  state = documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'first', edit, fontAssets: [asset] });
  assert.equal('fontAssets' in state.workspace!, false);
  assert.equal(documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'first', edit, fontAssets: [asset] }), state);
});

test('replacing a grouped edit updates its downloaded font atomically', () => {
  const asset = downloadedAsset();
  const first = page('first');
  const edit = {
    lineIds: ['line-a', 'line-b'], widthPt: 100, content: content('original'),
    layout: { lineHeightPt: 14, referenceSizePt: 12, firstLineIndentPt: 0, restLineIndentPt: 0 },
  };
  first.textEdits = [edit];
  const original = load([first]);
  const replacement = { ...edit, content: downloadedContent(asset) };
  assert.throws(() => documentReducer(original, { type: 'UPSERT_TEXT_EDIT', pageId: 'first', edit: replacement }));
  const committed = documentReducer(original, { type: 'UPSERT_TEXT_EDIT', pageId: 'first', edit: replacement, fontAssets: [asset] });
  assert.deepEqual((active(committed) as PdfPage).textEdits, [replacement]);
  assert.deepEqual(committed.workspace!.fontAssets, [asset]);
  assert.deepEqual(documentReducer(committed, { type: 'UNDO' }).workspace, original.workspace);
});
