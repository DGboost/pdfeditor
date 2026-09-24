import { detectDocumentContent } from './detectContent';
import type { DetectionWorkerResponse } from './formats';

globalThis.onmessage = async (event: MessageEvent<File>) => {
  let response: DetectionWorkerResponse;
  try {
    const file = event.data;
    response = { ok: true, detection: detectDocumentContent(new Uint8Array(await file.arrayBuffer()), file.name) };
  } catch {
    response = { ok: false, error: '파일을 읽지 못했습니다. 다시 시도해 주세요.' };
  }
  globalThis.postMessage(response);
};
