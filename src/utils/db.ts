const DB_NAME = 'pdfe-draft-db';
const STORE_NAME = 'drafts';
const DRAFT_KEY = 'active-draft';

export interface PdfDraft {
  fileName: string;
  activePageId: string;
  screen: 'upload' | 'editor';
  pageNumInput: string;
  zoom: number;
  docState: any; // Entire state of useDocumentReducer
  timestamp: number;
}

export function openPdfDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePdfDraft(draft: PdfDraft): Promise<void> {
  try {
    const db = await openPdfDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(draft, DRAFT_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to save draft to IndexedDB:', err);
  }
}

export async function loadPdfDraft(): Promise<PdfDraft | null> {
  try {
    const db = await openPdfDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(DRAFT_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to load draft from IndexedDB:', err);
    return null;
  }
}

export async function clearPdfDraft(): Promise<void> {
  try {
    const db = await openPdfDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(DRAFT_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to clear draft from IndexedDB:', err);
  }
}
