import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  BlankPage, DocumentSnapshot, DocumentState, DownloadedFontAsset, Page, QuarterTurn,
  SourceTextEdit, Workspace,
} from '../types/pdfEditor';
import { validateFontAssets } from '../utils/db';

export const initialDocumentState: DocumentState = {
  workspace: null, revision: 0, history: { undo: [], redo: [] },
};

export type DocumentAction =
  | { type: 'LOAD_DOCUMENT'; workspace: Workspace }
  | { type: 'RESTORE_STATE'; workspace: Workspace; restoredRevision?: number }
  | { type: 'SET_ACTIVE_PAGE'; id: string }
  | { type: 'SET_FILE_NAME'; name: string }
  | { type: 'UPSERT_TEXT_EDIT'; pageId: string; edit: SourceTextEdit; fontAssets?: DownloadedFontAsset[] }
  | { type: 'REMOVE_TEXT_EDIT'; pageId: string; lineId: string }
  | { type: 'DUPLICATE_PAGE'; id: string; newId: string }
  | { type: 'ROTATE_PAGE'; id: string; delta: number }
  | { type: 'DELETE_PAGE'; id: string }
  | { type: 'ADD_PAGE'; page: BlankPage }
  | { type: 'REORDER_PAGES'; fromId: string; toId: string }
  | { type: 'UNDO' }
  | { type: 'REDO' };

// Immutable data may share references, including Blob bytes, across snapshots.
// Value comparison also keeps equivalent panel commits out of document history.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Blob || b instanceof Blob) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => equal(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
}

function snapshot(workspace: Workspace): DocumentSnapshot {
  return { pages: workspace.pages, activePageId: workspace.activePageId, ...('fontAssets' in workspace ? { fontAssets: workspace.fontAssets } : {}) };
}

function mapPage(workspace: Workspace, id: string, update: (page: Page) => Page): Workspace {
  const index = workspace.pages.findIndex((page) => page.id === id);
  if (index < 0) return workspace;
  const page = update(workspace.pages[index]);
  if (equal(page, workspace.pages[index])) return workspace;
  const pages = workspace.pages.slice();
  pages[index] = page;
  return { ...workspace, pages };
}

function mergeReferencedFonts(workspace: Workspace, incoming: DownloadedFontAsset[] = []): Workspace {
  const available = validateFontAssets(workspace.fontAssets ?? []);
  validateFontAssets(incoming);
  const candidates = new Map(incoming.map(asset => [asset.id, asset]));
  const added: DownloadedFontAsset[] = [];
  for (const page of workspace.pages) {
    if (page.kind !== 'pdf') continue;
    for (const { content } of page.textEdits) {
      for (const run of content.runs) {
        const font = run.style.font;
        if (font.kind !== 'downloaded' || available.has(font.assetId)) continue;
        const asset = candidates.get(font.assetId);
        if (!asset) throw new Error('다운로드한 글꼴 데이터가 없습니다.');
        available.add(asset.id);
        added.push(asset);
      }
    }
  }
  return added.length ? { ...workspace, fontAssets: [...(workspace.fontAssets ?? []), ...added] } : workspace;
}

function hasId(workspace: Workspace, id: string): boolean {
  return workspace.pages.some((page) => page.id === id);
}

function changeWorkspace(workspace: Workspace, action: DocumentAction): Workspace {
  switch (action.type) {
    case 'UPSERT_TEXT_EDIT':
      return mapPage(workspace, action.pageId, (p) => {
        if (p.kind !== 'pdf') return p;
        const memberIds = action.edit.lineIds;
        if (!Array.isArray(memberIds) || !memberIds.length || memberIds.some(id => typeof id !== 'string' || !id.length)) return p;
        const members = new Set(memberIds);
        if (members.size !== memberIds.length) return p;
        const intersects = (edit: SourceTextEdit) => edit.lineIds.some(id => members.has(id));
        if (p.textEdits.some(edit => intersects(edit) && edit.lineIds.some(id => !members.has(id)))) return p;
        const first = p.textEdits.findIndex(intersects);
        if (first < 0) return { ...p, textEdits: [...p.textEdits, action.edit] };
        const textEdits = p.textEdits.filter(edit => !intersects(edit));
        textEdits.splice(first, 0, action.edit);
        return { ...p, textEdits };
      });
    case 'REMOVE_TEXT_EDIT':
      return mapPage(workspace, action.pageId, (p) => p.kind === 'pdf' ? { ...p, textEdits: p.textEdits.filter((edit) => !edit.lineIds.includes(action.lineId)) } : p);
    case 'DUPLICATE_PAGE': {
      const index = workspace.pages.findIndex((p) => p.id === action.id);
      if (index < 0 || hasId(workspace, action.newId)) return workspace;
      const source = workspace.pages[index];
      // Nested text data remains immutable and shared; subsequent changes replace it.
      const clone: Page = {
        ...source, id: action.newId,
        ...(source.kind === 'pdf' ? { originalInstance: false, textEdits: source.textEdits.slice() } : {}),
      };
      const pages = workspace.pages.slice();
      pages.splice(index + 1, 0, clone);
      return { ...workspace, pages, activePageId: clone.id };
    }
    case 'ROTATE_PAGE':
      if (!Number.isFinite(action.delta) || action.delta % 90 !== 0) return workspace;
      return mapPage(workspace, action.id, (p) => ({ ...p, rotation: ((p.rotation + action.delta % 360 + 360) % 360) as QuarterTurn }));
    case 'DELETE_PAGE': {
      const index = workspace.pages.findIndex((p) => p.id === action.id);
      if (workspace.pages.length <= 1 || index < 0) return workspace;
      const pages = workspace.pages.filter((p) => p.id !== action.id);
      return { ...workspace, pages, activePageId: workspace.activePageId === action.id ? pages[Math.min(index, pages.length - 1)].id : workspace.activePageId };
    }
    case 'ADD_PAGE':
      return hasId(workspace, action.page.id) ? workspace : { ...workspace, pages: [...workspace.pages, action.page], activePageId: action.page.id };
    case 'REORDER_PAGES': {
      if (action.fromId === action.toId) return workspace;
      const from = workspace.pages.findIndex((p) => p.id === action.fromId);
      const to = workspace.pages.findIndex((p) => p.id === action.toId);
      if (from < 0 || to < 0) return workspace;
      const pages = workspace.pages.slice();
      const [moved] = pages.splice(from, 1);
      pages.splice(to, 0, moved);
      return { ...workspace, pages };
    }
    default:
      return workspace;
  }
}

export function documentReducer(state: DocumentState, action: DocumentAction): DocumentState {
  if (action.type === 'LOAD_DOCUMENT' || action.type === 'RESTORE_STATE') {
    const restored = action.type === 'RESTORE_STATE' ? action.restoredRevision ?? 0 : 0;
    return { workspace: action.workspace, revision: Math.max(state.revision, restored) + 1, history: { undo: [], redo: [] } };
  }
  const workspace = state.workspace;
  if (!workspace) return state;
  if (action.type === 'SET_ACTIVE_PAGE') {
    if (workspace.activePageId === action.id || !workspace.pages.some((p) => p.id === action.id)) return state;
    return { ...state, workspace: { ...workspace, activePageId: action.id }, revision: state.revision + 1 };
  }
  if (action.type === 'SET_FILE_NAME') {
    if (workspace.fileName === action.name) return state;
    // The file name is not document content: bumping revision would discard a
    // pending text edit and invalidate every page raster.
    return { ...state, workspace: { ...workspace, fileName: action.name } };
  }
  if (action.type === 'UNDO' || action.type === 'REDO') {
    const { undo, redo } = state.history;
    const stack = action.type === 'UNDO' ? undo : redo;
    if (!stack.length) return state;
    const next = stack[stack.length - 1];
    const restored = { ...workspace, ...next };
    if (!('fontAssets' in next)) delete restored.fontAssets;
    return {
      workspace: restored, revision: state.revision + 1,
      history: action.type === 'UNDO'
        ? { undo: undo.slice(0, -1), redo: [...redo.slice(-19), snapshot(workspace)] }
        : { undo: [...undo.slice(-19), snapshot(workspace)], redo: redo.slice(0, -1) },
    };
  }
  let next = changeWorkspace(workspace, action);
  if (next === workspace) return state;
  if (action.type === 'UPSERT_TEXT_EDIT') {
    next = mergeReferencedFonts(next, action.fontAssets);
  }
  return {
    workspace: next, revision: state.revision + 1,
    history: { undo: [...state.history.undo.slice(-19), snapshot(workspace)], redo: [] },
  };
}

export interface DocumentActions {
  loadDocument(workspace: Workspace): void;
  restoreState(workspace: Workspace, restoredRevision?: number): void;
  setActivePage(id: string): void;
  setFileName(name: string): void;
  upsertTextEdit(pageId: string, edit: SourceTextEdit, fontAssets?: DownloadedFontAsset[]): void;
  removeTextEdit(pageId: string, lineId: string): void;
  duplicatePage(id: string, newId: string): void;
  rotatePage(id: string, delta: number): void;
  deletePage(id: string): void;
  addPage(page: BlankPage): void;
  reorderPages(fromId: string, toId: string): void;
  undo(): void;
  redo(): void;
}

export function useDocumentReducer() {
  const [state, setState] = useState(initialDocumentState);
  const current = useRef(state);
  const dispatch = useCallback((action: DocumentAction) => {
    const next = documentReducer(current.current, action);
    if (next === current.current) return;
    current.current = next;
    setState(next);
  }, []);
  const getState = useCallback(() => current.current, []);
  const actions = useMemo<DocumentActions>(() => ({
    loadDocument: (workspace) => dispatch({ type: 'LOAD_DOCUMENT', workspace }),
    restoreState: (workspace, restoredRevision) => dispatch({ type: 'RESTORE_STATE', workspace, restoredRevision }),
    setActivePage: (id) => dispatch({ type: 'SET_ACTIVE_PAGE', id }),
    setFileName: (name) => dispatch({ type: 'SET_FILE_NAME', name }),
    upsertTextEdit: (pageId, edit, fontAssets) => dispatch({ type: 'UPSERT_TEXT_EDIT', pageId, edit, fontAssets }),
    removeTextEdit: (pageId, lineId) => dispatch({ type: 'REMOVE_TEXT_EDIT', pageId, lineId }),
    duplicatePage: (id, newId) => dispatch({ type: 'DUPLICATE_PAGE', id, newId }),
    rotatePage: (id, delta) => dispatch({ type: 'ROTATE_PAGE', id, delta }),
    deletePage: (id) => dispatch({ type: 'DELETE_PAGE', id }),
    addPage: (page) => dispatch({ type: 'ADD_PAGE', page }),
    reorderPages: (fromId, toId) => dispatch({ type: 'REORDER_PAGES', fromId, toId }),
    undo: () => dispatch({ type: 'UNDO' }),
    redo: () => dispatch({ type: 'REDO' }),
  }), [dispatch]);
  return { state, actions, getState };
}
