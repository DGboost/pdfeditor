import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RegionConfig, RegionMapping } from '../src/documents/regionTypes';
import { documentReducer, initialDocumentState } from '../src/hooks/useDocumentReducer';
import type { DocumentState, PdfPage, SourceTextEdit, Workspace } from '../src/types/pdfEditor';
import { normalizePdfDraft, validateWorkspace } from '../src/utils/db';

const sourceBytes = Uint8Array.from(readFileSync(new URL('../test.pdf', import.meta.url)));
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
const page = (id: string, originalInstance: boolean): PdfPage => ({
  kind: 'pdf', id, label: id, sourcePageIndex: 0, originalInstance, rotation: 0, textEdits: [],
});
const mapping = (id: string, pageId: string, role: RegionMapping['role'], lineIds: string[]): RegionMapping => ({
  id, role, anchor: { kind: 'pdf', pageId, sourcePageIndex: 0, lineIds, originalText: '원본' }, currentText: '원본',
});
const edit = (text: string, lineIds = ['shared']): SourceTextEdit => ({
  lineIds, widthPt: 120, content: { align: 'left', runs: [{ text, style: {
    font: { kind: 'bundled', family: 'NanumGothic', bold: false }, sizePt: 12, color: [0, 0, 0],
  } }] },
});
function load(mappings: RegionMapping[], selectedIds: string[]): DocumentState {
  const region: RegionConfig = { mappings, selectedIds, reviewed: true };
  const workspace: Workspace = {
    id: 'region-workspace', fileName: 'student.pdf', source: new Blob([sourceBytes]), sourceHash,
    pages: [page('original', true), page('copy', false)], activePageId: 'original', region,
  };
  validateWorkspace(workspace);
  return documentReducer(initialDocumentState, { type: 'LOAD_DOCUMENT', workspace });
}
function pageEdits(state: DocumentState, pageId: string): SourceTextEdit[] {
  const page = state.workspace!.pages.find(item => item.id === pageId);
  assert.ok(page && page.kind === 'pdf');
  return page.textEdits;
}
function current(state: DocumentState, id: string): string {
  const found = state.workspace!.region!.mappings.find(item => item.id === id);
  assert.ok(found);
  return found.currentText;
}

test('releasing a card keeps its mapping and edit through draft restore, while undo cannot silently re-authorize protected editing', async () => {
  const original = mapping('student', 'original', 'studentName', ['shared']);
  let state = load([original], ['student']);
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'student', edit: edit('이하늘') });
  assert.deepEqual(pageEdits(state, 'original'), [edit('이하늘')]);
  assert.equal(current(state, 'student'), '이하늘');

  state = documentReducer(state, { type: 'SET_REGION', region: { ...state.workspace!.region!, selectedIds: [] } });
  assert.deepEqual(state.workspace!.region!.selectedIds, []);
  assert.equal(state.workspace!.region!.mappings[0].role, 'studentName');
  assert.equal(current(state, 'student'), '이하늘');
  assert.deepEqual(pageEdits(state, 'original'), [edit('이하늘')]);
  const reopened = normalizePdfDraft({ version: 5, workspace: state.workspace, zoom: 1, revision: state.revision, savedAt: 1 });
  assert.deepEqual(new Uint8Array(await reopened.workspace.source.arrayBuffer()), sourceBytes);
  const restored = documentReducer(initialDocumentState, { type: 'RESTORE_STATE', workspace: reopened.workspace, restoredRevision: state.revision });
  assert.deepEqual(pageEdits(restored, 'original'), [edit('이하늘')]);
  assert.equal(reopened.workspace.region!.mappings[0].currentText, '이하늘');
  assert.deepEqual(reopened.workspace.region!.selectedIds, []);

  state = documentReducer(state, { type: 'UNDO' });
  assert.deepEqual(pageEdits(state, 'original'), []);
  assert.equal(current(state, 'student'), '원본');
  assert.equal(state.workspace!.region!.reviewed, false);
  assert.deepEqual(state.workspace!.region!.selectedIds, []);
  state = documentReducer(state, { type: 'REDO' });
  assert.deepEqual(pageEdits(state, 'original'), [edit('이하늘')]);
  assert.equal(current(state, 'student'), '이하늘');
  assert.equal(state.workspace!.region!.reviewed, false);
  assert.deepEqual(state.workspace!.region!.selectedIds, []);
});

test('unknown, explicitly locked, and overlapping protected line targets cannot change document values', () => {
  const student = mapping('student', 'original', 'studentName', ['shared']);
  const teacher = mapping('teacher', 'original', 'locked', ['teacher']);
  let state = load([student, teacher], ['student']);
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'missing', edit: edit('무단 변경') });
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'teacher', edit: edit('무단 변경', ['teacher']) });
  assert.deepEqual(pageEdits(state, 'original'), []);
  assert.equal(current(state, 'student'), '원본');
  assert.equal(current(state, 'teacher'), '원본');

  const overlappingLock = mapping('overlap', 'original', 'locked', ['shared', 'teacher']);
  const invalidWorkspace: Workspace = { ...state.workspace!, region: {
    ...state.workspace!.region!, mappings: [...state.workspace!.region!.mappings, overlappingLock],
  } };
  assert.throws(() => validateWorkspace(invalidWorkspace));
  const tampered = documentReducer({ ...state, workspace: invalidWorkspace }, {
    type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'student', edit: edit('무단 변경'),
  });
  assert.deepEqual(pageEdits(tampered, 'original'), []);
  assert.equal(current(tampered, 'student'), '원본');
});

test('same source page and line IDs remain isolated by PDF page instance', () => {
  const original = mapping('original-student', 'original', 'studentName', ['shared']);
  const copy = mapping('copy-student', 'copy', 'studentId', ['shared']);
  let state = load([original, copy], ['original-student', 'copy-student']);
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'copy-student', edit: edit('잘못된 인스턴스') });
  assert.deepEqual(pageEdits(state, 'original'), []);
  assert.deepEqual(pageEdits(state, 'copy'), []);
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'copy', mappingId: 'copy-student', edit: edit('2026999') });
  assert.deepEqual(pageEdits(state, 'original'), []);
  assert.deepEqual(pageEdits(state, 'copy'), [edit('2026999')]);
  assert.equal(current(state, 'original-student'), '원본');
  assert.equal(current(state, 'copy-student'), '2026999');
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'original-student', edit: edit('김하늘') });
  assert.deepEqual(pageEdits(state, 'original'), [edit('김하늘')]);
  assert.deepEqual(pageEdits(state, 'copy'), [edit('2026999')]);
  assert.equal(current(state, 'original-student'), '김하늘');
  assert.equal(current(state, 'copy-student'), '2026999');
});

test('ordinary PDF edits revoke protected review before another mapped value can be applied', () => {
  let state = load([mapping('student', 'original', 'studentName', ['shared'])], ['student']);
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'student', edit: edit('이하늘') });
  state = documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'original', edit: edit('일반 편집', ['neighbor']) });
  assert.deepEqual(state.workspace!.region!.selectedIds, []);
  assert.equal(state.workspace!.region!.reviewed, false);
  assert.equal(current(state, 'student'), '이하늘');
  state = documentReducer(state, { type: 'UPSERT_REGION_TEXT', pageId: 'original', mappingId: 'student', edit: edit('잘못된 추가 편집') });
  assert.deepEqual(pageEdits(state, 'original'), [edit('이하늘'), edit('일반 편집', ['neighbor'])]);
  assert.equal(current(state, 'student'), '이하늘');
});
