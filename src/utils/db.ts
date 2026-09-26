import type { Workspace } from '../types/pdfEditor';
import { getCatalogFace } from '../pdf/fontCatalog';

const DB_NAME = 'pdfe-draft-db';
const DRAFT_KEY = 'active-draft';
export const PDF_DRAFT_VERSION = 5;
export interface PdfDraft { version: typeof PDF_DRAFT_VERSION; workspace: Workspace; zoom: number; revision: number; savedAt: number }
export interface PdfArchive extends PdfDraft { id: string }
export type SaveStatus = 'dirty' | 'saving' | 'saved' | 'error';
export interface ArchiveSummary { id: string; fileName: string; savedAt: number; pageCount: number }
export interface RetainedDraftSummary { id: number; kind: 'legacy' | 'invalid'; savedAt: number; reason: string }
export type DraftLoadResult = { kind: 'empty' } | { kind: 'ready'; draft: PdfDraft } | { kind: 'legacy'; retainedId: number; raw: unknown } | { kind: 'invalid'; retainedId: number; message: string };

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('잘못된 문서 데이터입니다.');
}
function requireValue(valid: boolean): asserts valid { if (!valid) throw new Error('잘못된 문서 데이터입니다.'); }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const index = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
function rgb(v: unknown) { requireValue(Array.isArray(v) && v.length === 3 && v.every(n => finite(n) && n >= 0 && n <= 1)); }
export function validateFontAssets(value: unknown): Set<string> {
  requireValue(Array.isArray(value));
  const ids = new Set<string>();
  for (const asset of value) {
    record(asset);
    if (asset.origin === 'local') {
      requireValue(index(asset.subfont) && string(asset.id) && asset.id.endsWith(`:${asset.subfont}`) && /^[a-f0-9]{64}:\d+$/.test(asset.id) && !ids.has(asset.id) &&
        string(asset.fileName) && string(asset.family) && string(asset.postScriptName) && Number.isInteger(asset.weight) &&
        Number(asset.weight) >= 1 && Number(asset.weight) <= 1000 && typeof asset.italic === 'boolean');
    } else {
      requireValue(string(asset.id) && /^[a-f0-9]{64}$/.test(asset.id) && !ids.has(asset.id) && string(asset.catalogId));
      const face = getCatalogFace(asset.catalogId);
      requireValue(!!face && asset.id === face.sha256 && asset.family === face.family && asset.postScriptName === face.postScriptName &&
        asset.weight === face.weight && asset.italic === face.italic && asset.sourceUrl === face.url && asset.licenseText === face.licenseText);
    }
    requireValue(asset.bytes instanceof Blob && asset.bytes.size > 0);
    ids.add(asset.id);
  }
  return ids;
}
function textContent(v: unknown, fontIds: Set<string>) {
  record(v);
  requireValue(['left', 'center', 'right'].includes(String(v.align)) && Array.isArray(v.runs));
  for (const run of v.runs) {
    record(run); record(run.style); record(run.style.font);
    requireValue(typeof run.text === 'string' && finite(run.style.sizePt) && run.style.sizePt >= 6 && run.style.sizePt <= 96);
    rgb(run.style.color); requireValue(!('highlight' in run.style));
    const font = run.style.font;
    requireValue(font.kind === 'source' ? index(font.sourcePageIndex) && string(font.fontKey) :
      font.kind === 'downloaded' ? string(font.assetId) && fontIds.has(font.assetId) :
        font.kind === 'bundled' && ['NanumGothic', 'NanumMyeongjo', 'Courier'].includes(String(font.family)) && typeof font.bold === 'boolean');
  }
}
function validateWorkspaceRecord(value: unknown): void {
  record(value);
  requireValue(string(value.id) && string(value.fileName) && value.source instanceof Blob && value.source.size > 0 && typeof value.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(value.sourceHash));
  requireValue(Array.isArray(value.pages) && value.pages.length > 0);
  const fontIds = value.fontAssets === undefined ? new Set<string>() : validateFontAssets(value.fontAssets);
  const ids = new Set<string>();
  const originals = new Set<number>();
  const addId = (id: unknown) => { requireValue(string(id) && !ids.has(id)); ids.add(id); };
  for (const page of value.pages) {
    record(page); addId(page.id);
    requireValue(!('images' in page) && !('signatureFields' in page) && !('textBoxes' in page) && !('shapes' in page));
    requireValue(typeof page.label === 'string' && [0, 90, 180, 270].includes(Number(page.rotation)) && typeof page.rotation === 'number');
    if (page.kind === 'pdf') {
      requireValue(index(page.sourcePageIndex) && typeof page.originalInstance === 'boolean' && Array.isArray(page.textEdits));
      if (page.originalInstance) { requireValue(!originals.has(page.sourcePageIndex)); originals.add(page.sourcePageIndex); }
      const lines = new Set<string>();
      for (const edit of page.textEdits) {
        record(edit); requireValue(positive(edit.widthPt));
        requireValue(!('lineId' in edit) && Array.isArray(edit.lineIds) && edit.lineIds.length > 0);
        for (const lineId of edit.lineIds) {
          requireValue(string(lineId) && !lines.has(lineId));
          lines.add(lineId);
        }
        if (edit.lineIds.length > 1) {
          record(edit.layout);
          requireValue(positive(edit.layout.lineHeightPt) && positive(edit.layout.referenceSizePt));
          requireValue(finite(edit.layout.firstLineIndentPt) && edit.layout.firstLineIndentPt >= 0 && edit.layout.firstLineIndentPt < edit.widthPt);
          requireValue(finite(edit.layout.restLineIndentPt) && edit.layout.restLineIndentPt >= 0 && edit.layout.restLineIndentPt < edit.widthPt);
        } else requireValue(edit.layout === undefined);
        textContent(edit.content, fontIds);
      }
    } else requireValue(page.kind === 'blank' && positive(page.widthPt) && positive(page.heightPt) && !('textEdits' in page));
  }
  requireValue(string(value.activePageId) && value.pages.some(p => p.id === value.activePageId));
}
export function validateWorkspace(value: unknown): Workspace {
  validateWorkspaceRecord(value);
  return value as Workspace;
}
export function normalizePdfDraft(value: unknown): PdfDraft {
  record(value); requireValue((value.version === 2 || value.version === 3 || value.version === 4 || value.version === PDF_DRAFT_VERSION) && positive(value.zoom) && index(value.revision) && finite(value.savedAt) && value.savedAt >= 0);
  if (value.version === PDF_DRAFT_VERSION) {
    validateWorkspace(value.workspace);
    return value as unknown as PdfDraft;
  }
  // Copy only editable records: original PDF and downloaded font Blobs retain their bytes.
  const workspace = value.workspace;
  record(workspace); requireValue(Array.isArray(workspace.pages));
  const removedReason = '텍스트·이미지·서명·사각형 삽입 또는 하이라이트가 포함된 이전 작업은 자동 복원할 수 없어 원본 데이터로 보관했습니다.';
  const pages = workspace.pages.map(page => {
    record(page);
    for (const key of ['images', 'signatureFields', 'textBoxes', 'shapes']) {
      if (!(key in page)) continue;
      requireValue(Array.isArray(page[key]));
      if (page[key].length) throw new Error(removedReason);
    }
    const cleanPage = { ...page };
    delete cleanPage.images; delete cleanPage.signatureFields; delete cleanPage.textBoxes; delete cleanPage.shapes;
    if (page.kind !== 'pdf') return cleanPage;
    requireValue(Array.isArray(page.textEdits));
    cleanPage.textEdits = page.textEdits.map(edit => {
      record(edit); record(edit.content); requireValue(Array.isArray(edit.content.runs));
      const runs = edit.content.runs.map(run => {
        record(run); record(run.style);
        if (run.style.highlight !== undefined && run.style.highlight !== null) throw new Error(removedReason);
        const style = { ...run.style }; delete style.highlight;
        return { ...run, style };
      });
      const cleanEdit = { ...edit, content: { ...edit.content, runs } };
      if (value.version === 2) {
        requireValue(string(edit.lineId) && !('lineIds' in edit));
        const migrated: Record<string, unknown> = { ...cleanEdit, lineIds: [edit.lineId] };
        delete migrated.lineId;
        return migrated;
      }
      return cleanEdit;
    });
    return cleanPage;
  });
  return { ...value, version: PDF_DRAFT_VERSION, workspace: validateWorkspace({ ...workspace, pages }), zoom: value.zoom, revision: value.revision, savedAt: value.savedAt };
}
function validateArchive(value: unknown): PdfArchive {
  const draft = normalizePdfDraft(value); record(value);
  requireValue(value.id === draft.workspace.id);
  return { ...draft, id: draft.workspace.id };
}
function classify(value: unknown): { kind: 'legacy' | 'invalid'; reason: string } | null {
  try { normalizePdfDraft(value); return null; } catch (error) {
    const legacy = !!value && typeof value === 'object' && (!('version' in value) || value.version === 1);
    return { kind: legacy ? 'legacy' : 'invalid', reason: legacy ? '구버전 작업은 원본 PDF가 없어 자동 복원할 수 없습니다' : error instanceof Error ? error.message : '잘못된 초안입니다.' };
  }
}
export function openPdfDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Record format v5 uses the existing stores and key paths; DB schema stays v2.
    const request = indexedDB.open(DB_NAME, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      if (!db.objectStoreNames.contains('archives')) db.createObjectStore('archives', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('retained-drafts')) db.createObjectStore('retained-drafts', { keyPath: 'id', autoIncrement: true });
    };
    request.onblocked = () => { blocked = true; reject(new Error('다른 탭을 닫은 후 저장을 다시 시도해 주세요.')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close(); else resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('저장소를 열 수 없습니다.'));
  });
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openPdfDb();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(stores, mode); } catch (error) { db.close(); reject(error); return; }
    let value: T;
    let failure: unknown;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('저장이 취소되었습니다.')); };
    try { operation(tx, v => { value = v; }); } catch (error) { failure = error; tx.abort(); }
  });
}
function retain(tx: IDBTransaction, raw: unknown, kind: 'legacy' | 'invalid', reason: string, done: (id: number) => void) {
  const request = tx.objectStore('retained-drafts').add({ raw, kind, reason, savedAt: Date.now() });
  request.onsuccess = () => done(Number(request.result));
}
export async function savePdfDraft(draft: PdfDraft): Promise<void> {
  const normalized = normalizePdfDraft(draft);
  return transaction(['drafts', 'retained-drafts'], 'readwrite', tx => {
    const store = tx.objectStore('drafts');
    const request = store.get(DRAFT_KEY);
    request.onsuccess = () => {
      const rejected = request.result === undefined ? null : classify(request.result);
      if (rejected) retain(tx, request.result, rejected.kind, rejected.reason, () => { store.put(normalized, DRAFT_KEY); });
      else store.put(normalized, DRAFT_KEY);
    };
  });
}
export async function loadPdfDraft(): Promise<DraftLoadResult> {
  return transaction(['drafts', 'retained-drafts'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('drafts');
    const request = store.get(DRAFT_KEY);
    request.onsuccess = () => {
      const raw: unknown = request.result;
      if (raw === undefined) { result({ kind: 'empty' }); return; }
      const rejected = classify(raw);
      if (!rejected) {
        const draft = normalizePdfDraft(raw);
        if (draft !== raw) store.put(draft, DRAFT_KEY);
        result({ kind: 'ready', draft });
        return;
      }
      retain(tx, raw, rejected.kind, rejected.reason, retainedId => {
        store.delete(DRAFT_KEY);
        result(rejected.kind === 'legacy' ? { kind: 'legacy', retainedId, raw } : { kind: 'invalid', retainedId, message: rejected.reason });
      });
    };
  });
}
export async function quarantineActiveDraft(kind: 'legacy' | 'invalid', reason: string): Promise<number> {
  return transaction(['drafts', 'retained-drafts'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('drafts'); const request = store.get(DRAFT_KEY);
    request.onsuccess = () => {
      if (request.result === undefined) { tx.abort(); return; }
      retain(tx, request.result, kind, reason, id => { store.delete(DRAFT_KEY); result(id); });
    };
  });
}
export async function clearPdfDraft(): Promise<void> { return transaction(['drafts'], 'readwrite', tx => { tx.objectStore('drafts').delete(DRAFT_KEY); }); }
export async function savePdfArchive(archive: PdfArchive): Promise<void> {
  const normalized = validateArchive(archive);
  return transaction(['archives', 'retained-drafts'], 'readwrite', tx => {
    const store = tx.objectStore('archives');
    const request = store.get(normalized.id);
    request.onsuccess = () => {
      if (request.result !== undefined) {
        try { validateArchive(request.result); } catch (error) {
          retain(tx, request.result, 'invalid', error instanceof Error ? error.message : '잘못된 문서 데이터입니다.', () => { store.put(normalized); });
          return;
        }
      }
      store.put(normalized);
    };
  });
}
async function readStore(store: string, key?: IDBValidKey): Promise<unknown> {
  return transaction([store], 'readonly', (tx, result) => {
    const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
    request.onsuccess = () => result(request.result);
  });
}
export async function listPdfArchives(): Promise<ArchiveSummary[]> {
  return transaction(['archives', 'retained-drafts'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('archives');
    const request = store.openCursor();
    const summaries: ArchiveSummary[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { result(summaries.sort((a, b) => b.savedAt - a.savedAt)); return; }
      let archive: PdfArchive;
      try { archive = validateArchive(cursor.value); } catch (error) {
        const rejected = classify(cursor.value);
        retain(tx, cursor.value, rejected?.kind ?? 'invalid', rejected?.reason ?? (error instanceof Error ? error.message : '잘못된 문서 데이터입니다.'), () => {
          cursor.delete();
          cursor.continue();
        });
        return;
      }
      if (cursor.value.version !== PDF_DRAFT_VERSION) cursor.update(archive);
      summaries.push({ id: archive.id, fileName: archive.workspace.fileName, savedAt: archive.savedAt, pageCount: archive.workspace.pages.length });
      cursor.continue();
    };
  });
}
export async function loadPdfArchive(id: string): Promise<PdfArchive | null> {
  const loaded = await transaction<{ archive: PdfArchive | null; error?: unknown }>(['archives', 'retained-drafts'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('archives');
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result === undefined) { result({ archive: null }); return; }
      try {
        const archive = validateArchive(request.result);
        if (request.result.version !== PDF_DRAFT_VERSION) store.put(archive);
        result({ archive });
      } catch (error) {
        const rejected = classify(request.result);
        retain(tx, request.result, rejected?.kind ?? 'invalid', rejected?.reason ?? (error instanceof Error ? error.message : '잘못된 문서 데이터입니다.'), () => {
          store.delete(id);
          result({ archive: null, error });
        });
      }
    };
  });
  if (loaded.error) throw loaded.error;
  return loaded.archive;
}
export async function deletePdfArchive(id: string): Promise<void> { return transaction(['archives'], 'readwrite', tx => { tx.objectStore('archives').delete(id); }); }
export async function listRetainedDrafts(): Promise<RetainedDraftSummary[]> {
  const values = await readStore('retained-drafts'); requireValue(Array.isArray(values));
  return values.map((v): RetainedDraftSummary => {
    record(v); requireValue(index(v.id) && (v.kind === 'legacy' || v.kind === 'invalid') && finite(v.savedAt) && typeof v.reason === 'string');
    return { id: v.id, kind: v.kind, savedAt: v.savedAt, reason: v.reason };
  }).sort((a, b) => b.savedAt - a.savedAt);
}
export async function loadRetainedDraft(id: number): Promise<unknown | null> {
  const value = await readStore('retained-drafts', id);
  if (value === undefined) return null;
  record(value); return value.raw;
}
export async function deleteRetainedDraft(id: number): Promise<void> { return transaction(['retained-drafts'], 'readwrite', tx => { tx.objectStore('retained-drafts').delete(id); }); }
export async function serializeRetainedBackup(value: unknown): Promise<string> {
  const ancestors = new Set<object>();
  async function encode(v: unknown): Promise<unknown> {
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || finite(v)) return v;
    if (v instanceof Blob) {
      const bytes = new Uint8Array(await v.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return { __pdfeditor_blob__: true, type: v.type, base64: btoa(binary) };
    }
    if (!v || typeof v !== 'object' || ancestors.has(v)) throw new Error('이전 작업에 JSON 백업으로 표현할 수 없는 값이 있습니다. 원본 백업은 유지됩니다.');
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        const items: unknown[] = [];
        for (const child of v) items.push(await encode(child));
        return items;
      }
      record(v);
      const entries: Array<[string, unknown]> = [];
      for (const [key, child] of Object.entries(v)) {
        if (child !== undefined) entries.push([key, await encode(child)]);
      }
      return Object.fromEntries(entries);
    } finally { ancestors.delete(v); }
  }
  return JSON.stringify(await encode(value), null, 2);
}
