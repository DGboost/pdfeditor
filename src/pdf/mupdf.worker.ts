import type { FontChoice } from '../types/pdfEditor';
import type { NativePdfApi, NativeRequest, NativeResponse } from './engineTypes';

type BundledFont = Extract<FontChoice, { kind: 'bundled' }>;
const fontUrls = {
  NanumGothic: {
    regular: new URL('../assets/fonts/nanumgothic/NanumGothic-Regular.ttf', import.meta.url).href,
    bold: new URL('../assets/fonts/nanumgothic/NanumGothic-Bold.ttf', import.meta.url).href,
  },
  NanumMyeongjo: {
    regular: new URL('../assets/fonts/nanummyeongjo/NanumMyeongjo-Regular.ttf', import.meta.url).href,
    bold: new URL('../assets/fonts/nanummyeongjo/NanumMyeongjo-Bold.ttf', import.meta.url).href,
  },
};
const fontBytes = new Map<string, Promise<Uint8Array>>();
function loadFont(font: BundledFont): Promise<Uint8Array> {
  if (font.family === 'Courier') throw new Error('Courier must use the native built-in font');
  const url = fontUrls[font.family][font.bold ? 'bold' : 'regular'];
  let pending = fontBytes.get(url);
  if (!pending) {
    pending = fetch(url).then(async response => {
      if (!response.ok) throw new Error(`글꼴을 불러오지 못했습니다 (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    });
    fontBytes.set(url, pending);
    void pending.catch(() => fontBytes.delete(url));
  }
  return pending;
}

const scope = globalThis as typeof globalThis & {
  $libmupdf_wasm_Module?: { locateFile: (path: string) => string };
};
scope.$libmupdf_wasm_Module = {
  locateFile: () => new URL('../../node_modules/mupdf/dist/mupdf-wasm.wasm', import.meta.url).href,
};
let api: NativePdfApi | null = null;
let running = false;
let current: NativeRequest | null = null;
const queue: NativeRequest[] = [];
function envelope(request: NativeRequest) {
  return { requestId: request.requestId, sessionId: request.sessionId,
    revision: request.revision, candidateRevision: request.candidateRevision };
}
function send(message: NativeResponse, transfer: Transferable[] = []) {
  globalThis.postMessage(message, { transfer });
}
function reject(request: NativeRequest, error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NATIVE_ERROR';
  send({ ...envelope(request), error: { code, message: error instanceof Error ? error.message : String(error) } });
}
async function execute(request: NativeRequest) {
  const base = envelope(request);
  send({ ...base, event: 'started' });
  if (!api) {
    // Static import would initialize WASM before the same-origin locateFile override.
    const { createNativePdfApi } = await import('./nativeDocument');
    api = createNativePdfApi(loadFont, (currentPage, total) => {
      if (current) send({ ...envelope(current), event: 'progress', current: currentPage, total });
    });
  }
  switch (request.method) {
    case 'open': send({ ...base, method: 'open', result: await api.open(...request.params) }); break;
    case 'text': send({ ...base, method: 'text', result: await api.text(...request.params) }); break;
    case 'downloadFont': send({ ...base, method: 'downloadFont', result: await api.downloadFont(...request.params) }); break;
    case 'importFont': send({ ...base, method: 'importFont', result: await api.importFont(...request.params) }); break;
    case 'registerFonts': send({ ...base, method: 'registerFonts', result: await api.registerFonts(...request.params) }); break;
    case 'copySourceText': send({ ...base, method: 'copySourceText', result: await api.copySourceText(...request.params) }); break;
    case 'validate': send({ ...base, method: 'validate', result: await api.validate(...request.params) }); break;
    case 'render': {
      const result = await api.render(...request.params);
      send({ ...base, method: 'render', result }, [result.rgba.buffer as ArrayBuffer]);
      break;
    }
    case 'export': {
      const result = await api.export(...request.params);
      send({ ...base, method: 'export', result }, [result.buffer as ArrayBuffer]);
      break;
    }
  }
}
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const active = queue.findIndex(request => request.priority !== 'thumbnail');
      const request = queue.splice(active < 0 ? 0 : active, 1)[0];
      current = request;
      try { await execute(request); } catch (error) { reject(request, error); }
      finally { current = null; }
    }
  } finally { running = false; }
}
let highestRequestId = 0;
globalThis.onmessage = (event: MessageEvent<NativeRequest>) => {
  const request = event.data;
  if (request.requestId <= highestRequestId) {
    const queued = queue.find(item => item.requestId === request.requestId);
    if (queued && request.priority === 'active') queued.priority = 'active';
    return;
  }
  highestRequestId = request.requestId;
  if (request.method === 'render' && request.priority !== 'thumbnail') {
    for (let i = queue.length - 1; i >= 0; i--) {
      const old = queue[i];
      if (old.method === 'render' && old.priority !== 'thumbnail' && old.sessionId === request.sessionId &&
          old.params[0].id === request.params[0].id &&
          (old.revision !== request.revision || old.candidateRevision !== request.candidateRevision)) {
        queue.splice(i, 1);
        reject(old, Object.assign(new Error('새 미리 보기 요청으로 대체되었습니다.'), { code: 'ABORTED' }));
      }
    }
  }
  queue.push(request);
  void drain();
};
