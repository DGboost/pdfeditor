import { useMemo, useReducer } from 'react';
import type {
  Page, Signatures, DocumentSnapshot, SigModalTarget, PartyWhich, DragKind,
} from '../types/pdfEditor';

export type EditableBlockField = 'text' | 'label' | 'name';

interface HistoryState { undo: DocumentSnapshot[]; redo: DocumentSnapshot[] }

export interface DocumentState {
  pages: Page[];
  signatures: Signatures;
  globalFontFamily: string | null;
  globalFontSize: number | null;
  history: HistoryState;
}

export const initialSignatures: Signatures = {
  gap: { signed: false, dataUrl: null },
  eul: { signed: false, dataUrl: null },
};

function makeInitialState(pages: Page[]): DocumentState {
  return {
    pages,
    signatures: initialSignatures,
    globalFontFamily: null,
    globalFontSize: null,
    history: { undo: [], redo: [] },
  };
}

type Action =
  | { type: 'LOAD_DOCUMENT'; pages: Page[] }
  | { type: 'PATCH_PAGE'; pageId: string; patch: Partial<Page> }
  | { type: 'REPLACE_PAGE'; pageId: string; page: Page }
  | { type: 'ADD_IMAGE'; pageId: string; id: string; x: number; y: number }
  | { type: 'DELETE_IMAGE'; pageId: string; id: string }
  | { type: 'ADD_SIG_FIELD'; pageId: string; id: string; x: number; y: number }
  | { type: 'DELETE_SIG_FIELD'; pageId: string; id: string }
  | { type: 'SAVE_SIGNATURE'; target: SigModalTarget; dataUrl: string }
  | { type: 'ADD_TEXTBOX'; pageId: string; id: string; x: number; y: number }
  | { type: 'DELETE_TEXTBOX'; pageId: string; id: string }
  | { type: 'ADD_SHAPE'; pageId: string; id: string; x: number; y: number }
  | { type: 'DELETE_SHAPE'; pageId: string; id: string }
  | { type: 'MOVE_ITEM'; pageId: string; kind: DragKind; id: string; dx: number; dy: number }
  | { type: 'DUPLICATE_PAGE'; id: string; newId: string }
  | { type: 'ROTATE_PAGE'; id: string; delta: number }
  | { type: 'DELETE_PAGE'; id: string }
  | { type: 'ADD_PAGE'; id: string }
  | { type: 'REORDER_PAGES'; fromId: string; toId: string }
  | { type: 'APPLY_GLOBAL_FONT'; family: string; size: number }
  | { type: 'RESET_GLOBAL_FONT' }
  | { type: 'UPDATE_TEXT_ITEM'; pageId: string; itemId: string; html: string }
  | { type: 'UPDATE_BLOCK'; pageId: string; blockId: string; field: EditableBlockField; html: string }
  | { type: 'UPDATE_TEXT_BOX_TEXT'; pageId: string; id: string; html: string }
  | { type: 'PUSH_HISTORY' }
  | { type: 'RESTORE_STATE'; state: any }
  | { type: 'UNDO' }
  | { type: 'REDO' };

// MOVE_ITEM is intentionally excluded: a drag fires it continuously (once per mousemove tick),
// so history is pushed once up front via an explicit PUSH_HISTORY at drag-start instead — matching
// the original prototype's startDrag()-calls-pushHistory-once-then-setState-repeatedly behavior.
const HISTORY_TRACKED = new Set<Action['type']>([
  'ADD_IMAGE', 'DELETE_IMAGE', 'ADD_SIG_FIELD', 'DELETE_SIG_FIELD', 'SAVE_SIGNATURE',
  'ADD_TEXTBOX', 'DELETE_TEXTBOX', 'ADD_SHAPE', 'DELETE_SHAPE',
  'DUPLICATE_PAGE', 'ROTATE_PAGE', 'DELETE_PAGE',
  'ADD_PAGE', 'REORDER_PAGES', 'APPLY_GLOBAL_FONT', 'RESET_GLOBAL_FONT',
]);

function snapshotOf(state: DocumentState): DocumentSnapshot {
  return { pages: state.pages, signatures: state.signatures, globalFontFamily: state.globalFontFamily, globalFontSize: state.globalFontSize };
}

function mapPage(pages: Page[], pageId: string, fn: (p: Page) => Page): Page[] {
  return pages.map((p) => (p.id === pageId ? fn(p) : p));
}

// These three return the SAME `pages` reference when nothing actually changed, so callers can
// tell a no-op edit (e.g. a contentEditable field blurring without being touched) apart from a
// real one and skip pushing a wasted undo-history entry for it.
function updateTextItemHtml(pages: Page[], pageId: string, itemId: string, html: string): Page[] {
  const pageIdx = pages.findIndex((p) => p.id === pageId);
  if (pageIdx === -1) return pages;
  const page = pages[pageIdx];
  if (page.kind !== 'pdf') return pages;
  const itemIdx = page.textItems.findIndex((ti) => ti.id === itemId);
  if (itemIdx === -1 || page.textItems[itemIdx].text === html) return pages;
  const textItems = page.textItems.slice();
  textItems[itemIdx] = { ...textItems[itemIdx], text: html };
  const nextPages = pages.slice();
  nextPages[pageIdx] = { ...page, textItems };
  return nextPages;
}

function updateBlockField(pages: Page[], pageId: string, blockId: string, field: EditableBlockField, html: string): Page[] {
  const pageIdx = pages.findIndex((p) => p.id === pageId);
  if (pageIdx === -1) return pages;
  const page = pages[pageIdx];
  const blockIdx = page.blocks.findIndex((b) => b.id === blockId);
  if (blockIdx === -1) return pages;
  const block = page.blocks[blockIdx] as unknown as Record<string, unknown>;
  if (!(field in block) || block[field] === html) return pages;
  const blocks = page.blocks.slice();
  blocks[blockIdx] = { ...block, [field]: html } as unknown as typeof page.blocks[number];
  const nextPages = pages.slice();
  nextPages[pageIdx] = { ...page, blocks };
  return nextPages;
}

function updateTextBoxHtml(pages: Page[], pageId: string, id: string, html: string): Page[] {
  const pageIdx = pages.findIndex((p) => p.id === pageId);
  if (pageIdx === -1) return pages;
  const page = pages[pageIdx];
  const idx = page.textBoxes.findIndex((tb) => tb.id === id);
  if (idx === -1 || page.textBoxes[idx].text === html) return pages;
  const textBoxes = page.textBoxes.slice();
  textBoxes[idx] = { ...textBoxes[idx], text: html };
  const nextPages = pages.slice();
  nextPages[pageIdx] = { ...page, textBoxes };
  return nextPages;
}

function applyMutation(state: DocumentState, action: Action): DocumentState {
  switch (action.type) {
    case 'ADD_IMAGE':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, images: [...p.images, { id: action.id, x: Math.max(0, action.x - 70), y: Math.max(0, action.y - 50), w: 140, h: 100 }] })) };
    case 'DELETE_IMAGE':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, images: p.images.filter((i) => i.id !== action.id) })) };
    case 'ADD_SIG_FIELD':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, signatureFields: [...p.signatureFields, { id: action.id, x: Math.max(0, action.x - 85), y: Math.max(0, action.y - 28), w: 170, h: 56, signed: false, dataUrl: null }] })) };
    case 'DELETE_SIG_FIELD':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, signatureFields: p.signatureFields.filter((f) => f.id !== action.id) })) };
    case 'SAVE_SIGNATURE': {
      const { target, dataUrl } = action;
      if (target.kind === 'fixed') {
        return { ...state, signatures: { ...state.signatures, [target.which]: { signed: true, dataUrl } } };
      }
      return { ...state, pages: mapPage(state.pages, target.pageId, (p) => ({ ...p, signatureFields: p.signatureFields.map((f) => (f.id === target.id ? { ...f, signed: true, dataUrl } : f)) })) };
    }
    case 'ADD_TEXTBOX':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, textBoxes: [...p.textBoxes, { id: action.id, x: Math.max(0, action.x - 90), y: Math.max(0, action.y - 17), w: 180, h: 34, text: '텍스트를 입력하세요' }] })) };
    case 'DELETE_TEXTBOX':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, textBoxes: p.textBoxes.filter((t) => t.id !== action.id) })) };
    case 'ADD_SHAPE':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, shapes: [...p.shapes, { id: action.id, x: Math.max(0, action.x - 60), y: Math.max(0, action.y - 40), w: 120, h: 80 }] })) };
    case 'DELETE_SHAPE':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, shapes: p.shapes.filter((sh) => sh.id !== action.id) })) };
    case 'MOVE_ITEM':
      return {
        ...state,
        pages: mapPage(state.pages, action.pageId, (p) => {
          const arr = (p as any)[action.kind] as Array<{ id: string; x: number; y: number }>;
          return { ...p, [action.kind]: arr.map((item) => (item.id === action.id ? { ...item, x: Math.max(0, item.x + action.dx), y: Math.max(0, item.y + action.dy) } : item)) } as Page;
        }),
      };
    case 'DUPLICATE_PAGE': {
      const idx = state.pages.findIndex((p) => p.id === action.id);
      if (idx === -1) return state;
      const clone: Page = { ...JSON.parse(JSON.stringify(state.pages[idx])), id: action.newId };
      const pages = [...state.pages];
      pages.splice(idx + 1, 0, clone);
      return { ...state, pages };
    }
    case 'ROTATE_PAGE':
      return { ...state, pages: mapPage(state.pages, action.id, (p) => (p.kind === 'pdf' ? { ...p, rotation: ((p.rotation || 0) + action.delta + 360) % 360 } : p)) };
    case 'DELETE_PAGE':
      if (state.pages.length <= 1) return state;
      return { ...state, pages: state.pages.filter((p) => p.id !== action.id) };
    case 'ADD_PAGE':
      return {
        ...state,
        pages: [...state.pages, {
          id: action.id, label: '새 페이지', kind: 'doc', images: [], signatureFields: [], textBoxes: [], shapes: [], rotation: 0,
          blocks: [{ id: action.id + '-b1', type: 'text', text: '새 페이지 내용을 입력하세요.' }],
        }],
      };
    case 'REORDER_PAGES': {
      if (action.fromId === action.toId) return state;
      const pages = [...state.pages];
      const fromIdx = pages.findIndex((p) => p.id === action.fromId);
      const toIdx = pages.findIndex((p) => p.id === action.toId);
      if (fromIdx === -1 || toIdx === -1) return state;
      const [moved] = pages.splice(fromIdx, 1);
      pages.splice(toIdx, 0, moved);
      return { ...state, pages };
    }
    case 'APPLY_GLOBAL_FONT':
      return { ...state, globalFontFamily: action.family, globalFontSize: action.size };
    case 'RESET_GLOBAL_FONT':
      return { ...state, globalFontFamily: null, globalFontSize: null };
    default:
      return state;
  }
}

function reducer(state: DocumentState, action: Action): DocumentState {
  switch (action.type) {
    case 'LOAD_DOCUMENT':
      return { ...state, pages: action.pages, history: { undo: [], redo: [] } };
    case 'RESTORE_STATE':
      return { ...action.state };
    case 'PATCH_PAGE':
      return { ...state, pages: mapPage(state.pages, action.pageId, (p) => ({ ...p, ...action.patch }) as Page) };
    case 'REPLACE_PAGE':
      return { ...state, pages: mapPage(state.pages, action.pageId, () => action.page) };
    case 'PUSH_HISTORY':
      return { ...state, history: { undo: [...state.history.undo.slice(-19), snapshotOf(state)], redo: [] } };
    case 'UPDATE_TEXT_ITEM': {
      const pages = updateTextItemHtml(state.pages, action.pageId, action.itemId, action.html);
      if (pages === state.pages) return state;
      return { ...state, pages, history: { undo: [...state.history.undo.slice(-19), snapshotOf(state)], redo: [] } };
    }
    case 'UPDATE_BLOCK': {
      const pages = updateBlockField(state.pages, action.pageId, action.blockId, action.field, action.html);
      if (pages === state.pages) return state;
      return { ...state, pages, history: { undo: [...state.history.undo.slice(-19), snapshotOf(state)], redo: [] } };
    }
    case 'UPDATE_TEXT_BOX_TEXT': {
      const pages = updateTextBoxHtml(state.pages, action.pageId, action.id, action.html);
      if (pages === state.pages) return state;
      return { ...state, pages, history: { undo: [...state.history.undo.slice(-19), snapshotOf(state)], redo: [] } };
    }
    case 'UNDO': {
      const { undo, redo } = state.history;
      if (!undo.length) return state;
      const prev = undo[undo.length - 1];
      return { ...state, ...prev, history: { undo: undo.slice(0, -1), redo: [...redo, snapshotOf(state)] } };
    }
    case 'REDO': {
      const { undo, redo } = state.history;
      if (!redo.length) return state;
      const next = redo[redo.length - 1];
      return { ...state, ...next, history: { undo: [...undo, snapshotOf(state)], redo: redo.slice(0, -1) } };
    }
    default: {
      if (!HISTORY_TRACKED.has(action.type)) return applyMutation(state, action);
      const withHistory: DocumentState = {
        ...state,
        history: { undo: [...state.history.undo.slice(-19), snapshotOf(state)], redo: [] },
      };
      return applyMutation(withHistory, action);
    }
  }
}

export function useDocumentReducer(initialPages: Page[]) {
  const [state, dispatch] = useReducer(reducer, initialPages, makeInitialState);

  const actions = useMemo(() => ({
    loadDocument: (pages: Page[]) => dispatch({ type: 'LOAD_DOCUMENT', pages }),
    patchPage: (pageId: string, patch: Partial<Page>) => dispatch({ type: 'PATCH_PAGE', pageId, patch }),
    replacePage: (pageId: string, page: Page) => dispatch({ type: 'REPLACE_PAGE', pageId, page }),
    addImage: (pageId: string, id: string, x: number, y: number) => dispatch({ type: 'ADD_IMAGE', pageId, id, x, y }),
    deleteImage: (pageId: string, id: string) => dispatch({ type: 'DELETE_IMAGE', pageId, id }),
    addSigField: (pageId: string, id: string, x: number, y: number) => dispatch({ type: 'ADD_SIG_FIELD', pageId, id, x, y }),
    deleteSigField: (pageId: string, id: string) => dispatch({ type: 'DELETE_SIG_FIELD', pageId, id }),
    saveSignature: (target: SigModalTarget, dataUrl: string) => dispatch({ type: 'SAVE_SIGNATURE', target, dataUrl }),
    addTextBox: (pageId: string, id: string, x: number, y: number) => dispatch({ type: 'ADD_TEXTBOX', pageId, id, x, y }),
    deleteTextBox: (pageId: string, id: string) => dispatch({ type: 'DELETE_TEXTBOX', pageId, id }),
    addShape: (pageId: string, id: string, x: number, y: number) => dispatch({ type: 'ADD_SHAPE', pageId, id, x, y }),
    deleteShape: (pageId: string, id: string) => dispatch({ type: 'DELETE_SHAPE', pageId, id }),
    moveItem: (pageId: string, kind: DragKind, id: string, dx: number, dy: number) => dispatch({ type: 'MOVE_ITEM', pageId, kind, id, dx, dy }),
    duplicatePage: (id: string, newId: string) => dispatch({ type: 'DUPLICATE_PAGE', id, newId }),
    rotatePage: (id: string, delta: number) => dispatch({ type: 'ROTATE_PAGE', id, delta }),
    deletePage: (id: string) => dispatch({ type: 'DELETE_PAGE', id }),
    addPage: (id: string) => dispatch({ type: 'ADD_PAGE', id }),
    reorderPages: (fromId: string, toId: string) => dispatch({ type: 'REORDER_PAGES', fromId, toId }),
    applyGlobalFont: (family: string, size: number) => dispatch({ type: 'APPLY_GLOBAL_FONT', family, size }),
    resetGlobalFont: () => dispatch({ type: 'RESET_GLOBAL_FONT' }),
    updateTextItem: (pageId: string, itemId: string, html: string) => dispatch({ type: 'UPDATE_TEXT_ITEM', pageId, itemId, html }),
    updateBlock: (pageId: string, blockId: string, field: EditableBlockField, html: string) => dispatch({ type: 'UPDATE_BLOCK', pageId, blockId, field, html }),
    updateTextBoxText: (pageId: string, id: string, html: string) => dispatch({ type: 'UPDATE_TEXT_BOX_TEXT', pageId, id, html }),
    restoreState: (state: any) => dispatch({ type: 'RESTORE_STATE', state }),
    pushHistory: () => dispatch({ type: 'PUSH_HISTORY' }),
    undo: () => dispatch({ type: 'UNDO' }),
    redo: () => dispatch({ type: 'REDO' }),
  }), []);

  return { state, actions };
}

export type { PartyWhich };
