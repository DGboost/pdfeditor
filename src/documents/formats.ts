export type DocumentFormat = 'pdf' | 'docx' | 'hwp' | 'hwpx' | 'pptx';
export type OfficeFormat = Exclude<DocumentFormat, 'pdf'>;

export type Detection =
  | { kind: 'supported'; format: DocumentFormat; extensionMismatch: boolean }
  | { kind: 'legacy'; format: 'doc' | 'ppt' }
  | { kind: 'rejected'; message: string };

export type DetectionWorkerResponse =
  | { ok: true; detection: Detection }
  | { ok: false; error: string };

export const LEGACY_DOCUMENT_MESSAGE = 'DOC/PPT는 직접 편집하지 않습니다. DOCX/PPTX로 변환한 파일을 열어 주세요.';

/** Each request owns its worker; even failed reads release all worker resources. */
export function detectDocument(file: File): Promise<Detection> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    const release = () => {
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    };
    const fail = () => {
      release();
      reject(new Error('파일 형식 검사기를 실행하지 못했습니다. 다시 시도해 주세요.'));
    };
    const finish = (result: Detection) => { release(); resolve(result); };
    try {
      worker = new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<DetectionWorkerResponse>) => {
        if (event.data.ok) finish(event.data.detection);
        else {
          release();
          reject(new Error(event.data.error));
        }
      };
      worker.onerror = event => { event.preventDefault(); fail(); };
      worker.onmessageerror = fail;
      worker.postMessage(file);
    } catch {
      fail();
    }
  });
}
