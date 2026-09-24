import { detectDocument } from './formats';
import type { DocumentFormat, OfficeFormat } from './formats';
import { hashSource } from './files';
import { OFFICE_ENGINES } from './officeTypes';
import type { OfficeRecord, OfficeRecordSummary, OfficeRetainedSummary } from './officeTypes';

class InvalidOfficeRecordError extends Error {}

const blobFormats = new WeakMap<Blob, DocumentFormat>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function recordShape(value: unknown): OfficeRecord {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || !value.id || typeof value.format !== 'string' || !Object.hasOwn(OFFICE_ENGINES, value.format)) throw new InvalidOfficeRecordError('지원하지 않거나 잘못된 Office 기록입니다.');
  if (typeof value.fileName !== 'string' || typeof value.sourceName !== 'string' || !(value.source instanceof Blob) || !value.source.size || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)) throw new InvalidOfficeRecordError('보존 원본 정보가 올바르지 않습니다.');
  const engine = OFFICE_ENGINES[value.format as OfficeFormat];
  if (!object(value.engine) || value.engine.id !== engine.id || value.engine.version !== engine.version) throw new InvalidOfficeRecordError('저장된 엔진 버전과 현재 엔진이 다릅니다. 원본과 이전 기록을 백업에 보존합니다.');
  if (!counter(value.checkpointSequence) || !counter(value.revision) || !positive(value.zoom) || !counter(value.savedAt) || typeof value.modified !== 'boolean' || typeof value.pptxConversionAccepted !== 'boolean') throw new InvalidOfficeRecordError('저장된 문서 상태가 올바르지 않습니다.');
  if (value.format === 'pptx' && !value.pptxConversionAccepted) throw new InvalidOfficeRecordError('PPTX 변환 편집 동의가 없는 기록입니다.');
  if (!value.modified && value.revision !== 0) throw new InvalidOfficeRecordError('수정 상태와 문서 revision이 일치하지 않습니다.');
  const checkpoint = value.checkpoint;
  if (checkpoint === null) {
    if (value.modified) throw new InvalidOfficeRecordError('수정된 문서의 체크포인트가 없습니다.');
  } else if (!object(checkpoint)) throw new InvalidOfficeRecordError('체크포인트가 올바르지 않습니다.');
  else if (value.format !== 'pptx') {
    if (checkpoint.kind !== 'native' || checkpoint.format !== value.format || !(checkpoint.bytes instanceof Blob) || !checkpoint.bytes.size || !strings(checkpoint.warnings)) throw new InvalidOfficeRecordError('원본 형식과 체크포인트 형식이 일치하지 않습니다.');
  } else {
    if (checkpoint.kind !== 'pptist' || !object(checkpoint.payload) || !Array.isArray(checkpoint.assets)) throw new InvalidOfficeRecordError('PPTX 내부 체크포인트가 올바르지 않습니다.');
    const payload = checkpoint.payload;
    if (typeof payload.title !== 'string' || !positive(payload.width) || !positive(payload.height) || !object(payload.theme) || !Array.isArray(payload.slides) || !payload.slides.length) throw new InvalidOfficeRecordError('슬라이드 체크포인트가 올바르지 않습니다.');
    const assets = new Set<string>();
    for (const asset of checkpoint.assets) {
      if (!object(asset) || typeof asset.id !== 'string' || !asset.id || assets.has(asset.id) || !(asset.blob instanceof Blob) || !asset.blob.size) throw new InvalidOfficeRecordError('슬라이드 자산이 손상되었거나 중복되었습니다.');
      assets.add(asset.id);
    }
    const checkSource = (source: unknown) => {
      if (typeof source !== 'string') return;
      if (source.startsWith('blob:')) throw new InvalidOfficeRecordError('복구할 수 없는 임시 자산 URL이 체크포인트에 남아 있습니다.');
      if (source.startsWith('pdfe-asset:') && !assets.has(source.slice('pdfe-asset:'.length))) throw new InvalidOfficeRecordError('체크포인트에 필요한 슬라이드 자산이 없습니다.');
    };
    const slideIds = new Set<string>();
    for (const slide of payload.slides) {
      if (!object(slide) || typeof slide.id !== 'string' || !slide.id || slideIds.has(slide.id) || !Array.isArray(slide.elements)) throw new InvalidOfficeRecordError('슬라이드 목록이 올바르지 않습니다.');
      slideIds.add(slide.id);
      if (object(slide.background) && object(slide.background.image)) checkSource(slide.background.image.src);
      for (const element of slide.elements) {
        if (!object(element) || typeof element.id !== 'string' || typeof element.type !== 'string') throw new InvalidOfficeRecordError('슬라이드 요소가 올바르지 않습니다.');
        if (element.type === 'image' || element.type === 'video' || element.type === 'audio') checkSource(element.src);
        if (element.type === 'video') checkSource(element.poster);
        if (element.type === 'shape') checkSource(element.pattern);
      }
    }
  }
  return value as unknown as OfficeRecord;
}

async function checkBlob(blob: Blob, format: OfficeFormat): Promise<void> {
  let actual = blobFormats.get(blob);
  if (!actual) {
    // Node-only parser loading: a static import would eagerly ship ZIP/CFB parsing
    // into the browser parent instead of keeping browser reads in the worker.
    const detected = typeof Worker === 'undefined'
      ? (await import('./detectContent')).detectDocumentContent(new Uint8Array(await blob.arrayBuffer()), `document.${format}`)
      : await detectDocument(new File([blob], `document.${format}`));
    if (detected.kind !== 'supported') throw new InvalidOfficeRecordError(detected.kind === 'rejected' ? detected.message : '구형 Office 기록은 복원할 수 없습니다.');
    actual = detected.format;
    blobFormats.set(blob, actual);
  }
  if (actual !== format) throw new InvalidOfficeRecordError('저장된 바이트가 문서 형식과 일치하지 않습니다.');
}

export async function validateOfficeRecord(value: unknown): Promise<OfficeRecord> {
  const record = recordShape(value);
  await checkBlob(record.source, record.format);
  if (await hashSource(record.source) !== record.sourceHash) throw new InvalidOfficeRecordError('보존 원본의 해시가 일치하지 않습니다.');
  if (record.checkpoint?.kind === 'native') await checkBlob(record.checkpoint.bytes, record.format);
  return record;
}

export function assertOfficeRecordUpdate(previous: OfficeRecord, next: OfficeRecord): void {
  if (previous.id !== next.id || previous.format !== next.format || previous.sourceHash !== next.sourceHash || previous.sourceName !== next.sourceName) throw new InvalidOfficeRecordError('다른 문서의 원본을 기존 기록에 덮어쓸 수 없습니다.');
  if (next.checkpointSequence <= previous.checkpointSequence || next.revision < previous.revision) throw new InvalidOfficeRecordError('더 최신 체크포인트가 이미 저장되어 있습니다. 이전 저장을 적용하지 않았습니다.');
  if (previous.modified && !next.modified) throw new InvalidOfficeRecordError('수정된 문서를 원본 상태로 표시할 수 없습니다.');
}

function openOfficeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pdfe-office-db', 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['drafts', 'archives']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('retained')) db.createObjectStore('retained', { keyPath: 'id', autoIncrement: true });
    };
    request.onblocked = () => { blocked = true; reject(new Error('Office 저장소를 사용하는 다른 탭을 닫고 다시 시도해 주세요.')); };
    request.onerror = () => reject(request.error ?? new Error('Office 저장소를 열 수 없습니다.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close(); else resolve(db);
    };
  });
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const db = await openOfficeDb();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(stores, mode); } catch (error) { db.close(); reject(error); return; }
    let value: T;
    let failure: unknown;
    const fail = (error: unknown) => { failure = error; tx.abort(); };
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Office 저장이 취소되었습니다.')); };
    try { operation(tx, result => { value = result; }, fail); } catch (error) { fail(error); }
  });
}

function retain(tx: IDBTransaction, store: string, id: IDBValidKey, raw: unknown, reason: string): void {
  tx.objectStore('retained').add({ raw, reason, savedAt: Date.now() });
  tx.objectStore(store).delete(id);
}

async function save(storeName: 'drafts' | 'archives', value: OfficeRecord): Promise<void> {
  const record = await validateOfficeRecord(value);
  await transaction<void>([storeName, 'retained'], 'readwrite', (tx, _result, fail) => {
    const store = tx.objectStore(storeName);
    const request = store.get(record.id);
    request.onsuccess = () => {
      try {
        if (request.result !== undefined) {
          let previous: OfficeRecord | undefined;
          try { previous = recordShape(request.result); }
          catch (error) { retain(tx, storeName, record.id, request.result, error instanceof Error ? error.message : '잘못된 Office 기록입니다.'); }
          if (previous) assertOfficeRecordUpdate(previous, record);
        }
        store.put(record);
      } catch (error) { fail(error); }
    };
  });
}

// Every valid writer advances the sequence. Recheck it before quarantining an
// asynchronously validated Blob so an intervening successful save is never removed.
function sameVersion(left: unknown, right: unknown): boolean {
  if (!object(left) || !object(right)) return left === right;
  return ['id', 'version', 'format', 'checkpointSequence', 'revision', 'savedAt', 'sourceHash'].every(key => left[key] === right[key]);
}

async function load(storeName: 'drafts' | 'archives', id: string): Promise<OfficeRecord | null> {
  for (;;) {
    const raw = await transaction<unknown>([storeName], 'readonly', (tx, result) => {
      const request = tx.objectStore(storeName).get(id);
      request.onsuccess = () => result(request.result);
    });
    if (raw === undefined) return null;
    try { return await validateOfficeRecord(raw); }
    catch (error) {
      if (!(error instanceof InvalidOfficeRecordError)) throw error;
      const removed = await transaction<boolean>([storeName, 'retained'], 'readwrite', (tx, result, fail) => {
        const request = tx.objectStore(storeName).get(id);
        request.onsuccess = () => {
          try {
            if (!sameVersion(raw, request.result)) { result(false); return; }
            retain(tx, storeName, id, request.result, error instanceof Error ? error.message : 'Office 기록을 복원할 수 없습니다.');
            result(true);
          } catch (failure) { fail(failure); }
        };
      });
      if (removed) return null;
    }
  }
}

async function list(storeName: 'drafts' | 'archives'): Promise<OfficeRecordSummary[]> {
  return transaction([storeName, 'retained'], 'readwrite', (tx, result, fail) => {
    const summaries: OfficeRecordSummary[] = [];
    const request = tx.objectStore(storeName).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { result(summaries.sort((a, b) => b.savedAt - a.savedAt)); return; }
      try {
        try {
          const record = recordShape(cursor.value);
          summaries.push({ id: record.id, format: record.format, fileName: record.fileName, savedAt: record.savedAt });
        } catch (error) {
          retain(tx, storeName, cursor.primaryKey, cursor.value, error instanceof Error ? error.message : '잘못된 Office 기록입니다.');
        }
        cursor.continue();
      } catch (error) { fail(error); }
    };
  });
}

export function saveOfficeDraft(record: OfficeRecord): Promise<void> { return save('drafts', record); }
export function listOfficeDrafts(): Promise<OfficeRecordSummary[]> { return list('drafts'); }
export function loadOfficeDraft(id: string): Promise<OfficeRecord | null> { return load('drafts', id); }
export function saveOfficeArchive(record: OfficeRecord): Promise<void> { return save('archives', record); }
export function listOfficeArchives(): Promise<OfficeRecordSummary[]> { return list('archives'); }
export function loadOfficeArchive(id: string): Promise<OfficeRecord | null> { return load('archives', id); }
export async function deleteOfficeArchive(id: string): Promise<void> {
  await transaction<void>(['archives'], 'readwrite', tx => { tx.objectStore('archives').delete(id); });
}
export async function listOfficeRetained(): Promise<OfficeRetainedSummary[]> {
  return transaction(['retained'], 'readonly', (tx, result) => {
    const request = tx.objectStore('retained').getAll();
    request.onsuccess = () => result(request.result.map(({ id, reason, savedAt }) => ({ id, reason, savedAt })).sort((a, b) => b.savedAt - a.savedAt));
  });
}
export async function loadOfficeRetained(id: number): Promise<unknown | null> {
  return transaction(['retained'], 'readonly', (tx, result) => {
    const request = tx.objectStore('retained').get(id);
    request.onsuccess = () => result(request.result?.raw ?? null);
  });
}
export async function deleteOfficeRetained(id: number): Promise<void> {
  await transaction<void>(['retained'], 'readwrite', tx => { tx.objectStore('retained').delete(id); });
}
