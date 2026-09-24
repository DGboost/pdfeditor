import { OFFICE_COMMAND_TYPES } from './officeTypes';
import type { CommandResult, OfficeCheckpoint, OfficeCommand, OfficeFrameOpen, OfficePageCommand, OfficeSession, OfficeSessionOptions, OfficeState } from './officeTypes';

const CHANNEL = 'pdfeditor-engine';
const VERSION = 1;
const methods = ['open', 'execute', 'pageExecute', 'pageThumbnail', 'flush', 'captureCheckpoint', 'serialize', 'dispose'] as const;
type Method = typeof methods[number];
type Envelope = { channel: typeof CHANNEL; version: typeof VERSION; sessionId: string; requestId: number; type: string; payload: unknown };
type Pending = { resolve(value: unknown): void; reject(reason: unknown): void; type: Method };

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Office bridge: ${message}`);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function blob(value: unknown): value is Blob {
  return value instanceof Blob && value.size > 0;
}
function color(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function formatValue(value: unknown, check: (value: unknown) => boolean): boolean {
  if (!object(value)) return false;
  if (value.kind === 'uniform') return exactKeys(value, ['kind', 'value']) && check(value.value);
  if (value.kind === 'mixed') return exactKeys(value, ['kind']);
  return value.kind === 'unavailable' && exactKeys(value, ['kind', 'reason']) && text(value.reason);
}

export function assertOfficeState(value: unknown, sessionId: string, previous?: OfficeState): OfficeState {
  requireValue(object(value) && value.sessionId === sessionId, 'invalid state session');
  requireValue(integer(value.revision) && integer(value.selectionRevision), 'invalid state revision');
  if (previous) requireValue(value.revision >= previous.revision && value.selectionRevision >= previous.selectionRevision, 'state revisions moved backwards');
  for (const key of ['ready', 'busy', 'composing', 'canUndo', 'canRedo', 'canSaveModified']) requireValue(typeof value[key] === 'boolean', `invalid state ${key}`);
  requireValue(positive(value.zoom), 'invalid zoom');
  if (value.pageView !== undefined) {
    const view = value.pageView;
    requireValue(object(view) && exactKeys(view, ['pageCount', 'currentPage', 'twoPage', 'renderRevision'])
      && integer(view.pageCount) && integer(view.currentPage)
      && (view.pageCount === 0 ? view.currentPage === 0 : view.currentPage < view.pageCount)
      && typeof view.twoPage === 'boolean' && integer(view.renderRevision), 'invalid page view');
    if (previous?.pageView) requireValue(view.renderRevision >= previous.pageView.renderRevision, 'page render revision moved backwards');
  }
  if (value.interaction !== undefined) {
    const interaction = value.interaction;
    requireValue(object(interaction) && exactKeys(interaction, ['tool', 'multiSelect', 'hasSelection', 'copyDisabledReason'])
      && (interaction.tool === 'pan' || interaction.tool === 'select')
      && typeof interaction.multiSelect === 'boolean' && typeof interaction.hasSelection === 'boolean'
      && typeof interaction.copyDisabledReason === 'string', 'invalid interaction state');
  }
  requireValue(object(value.enabled) && exactKeys(value.enabled, OFFICE_COMMAND_TYPES) && Object.values(value.enabled).every(item => typeof item === 'boolean'), 'invalid command capabilities');
  requireValue(object(value.formatting) && exactKeys(value.formatting, ['bold', 'italic', 'underline', 'fontFamily', 'fontSize', 'color']), 'invalid formatting');
  for (const key of ['bold', 'italic', 'underline']) requireValue(formatValue(value.formatting[key], item => typeof item === 'boolean'), `invalid ${key} formatting`);
  requireValue(formatValue(value.formatting.fontFamily, text) && formatValue(value.formatting.fontSize, positive) && formatValue(value.formatting.color, color), 'invalid character formatting');
  requireValue(Array.isArray(value.fonts) && value.fonts.every(item => object(item) && text(item.value) && text(item.label)), 'invalid fonts');
  requireValue(strings(value.warnings), 'invalid warnings');
  return value as unknown as OfficeState;
}

function assertCommand(value: unknown): asserts value is OfficeCommand {
  requireValue(object(value) && OFFICE_COMMAND_TYPES.includes(value.type as OfficeCommand['type']), 'invalid command');
  const hasValue = ['fontFamily', 'fontSize', 'color', 'zoom'].includes(value.type as string);
  requireValue(exactKeys(value, hasValue ? ['type', 'value'] : ['type']), 'invalid command payload');
  if (value.type === 'fontFamily') requireValue(text(value.value), 'invalid font family');
  if (value.type === 'fontSize' || value.type === 'zoom') requireValue(positive(value.value), 'invalid numeric command');
  if (value.type === 'color') requireValue(color(value.value), 'invalid color command');
}
function assertPageCommand(value: unknown): asserts value is OfficePageCommand {
  requireValue(object(value), 'invalid page command');
  if (value.type === 'goToPage') requireValue(exactKeys(value, ['type', 'page']) && integer(value.page), 'invalid page number');
  else if (value.type === 'twoPage') requireValue(exactKeys(value, ['type', 'value']) && typeof value.value === 'boolean', 'invalid page layout');
  else requireValue(value.type === 'fitWidth' && exactKeys(value, ['type']), 'invalid page command');
}
function assertThumbnail(value: unknown): asserts value is Blob {
  requireValue(blob(value) && ['image/svg+xml', 'image/png'].includes((value as Blob).type), 'invalid page thumbnail');
}
function assertPageRevision(state: OfficeState | undefined, page: number, renderRevision: number): void {
  requireValue(integer(page) && integer(renderRevision), 'invalid thumbnail request');
  if (state?.pageView?.renderRevision !== renderRevision) throw new DOMException('페이지가 변경되었습니다.', 'AbortError');
  requireValue(page < state.pageView.pageCount, 'page out of range');
}
function assertCheckpoint(value: unknown, format: OfficeFrameOpen['format']): asserts value is OfficeCheckpoint {
  requireValue(object(value), 'invalid checkpoint');
  if (format === 'pptx') {
    requireValue(value.kind === 'pptist' && object(value.payload) && Array.isArray(value.assets), 'invalid PPTist checkpoint');
    const ids = new Set<string>();
    for (const asset of value.assets) {
      requireValue(object(asset) && text(asset.id) && blob(asset.blob) && !ids.has(asset.id), 'invalid checkpoint asset');
      ids.add(asset.id);
    }
  } else requireValue(value.kind === 'native' && value.format === format && blob(value.bytes) && strings(value.warnings), 'invalid native checkpoint');
}
function assertOpen(value: unknown): asserts value is OfficeFrameOpen {
  requireValue(object(value) && ['docx', 'pptx'].includes(value.format as string), 'unsupported frame format');
  requireValue(blob(value.source) && text(value.fileName) && integer(value.initialRevision), 'invalid open payload');
  if (value.checkpoint !== undefined) assertCheckpoint(value.checkpoint, value.format as OfficeFrameOpen['format']);
}
function assertCapture(value: unknown, format: OfficeFrameOpen['format'], floor: number, native: boolean): void {
  requireValue(object(value) && integer(value.revision) && value.revision >= floor, 'invalid captured revision');
  if (native) requireValue(blob(value.bytes) && strings(value.warnings), 'invalid serialized document');
  else assertCheckpoint(value.checkpoint, format);
}
function envelope(sessionId: string, requestId: number, type: string, payload: unknown): Envelope {
  return { channel: CHANNEL, version: VERSION, sessionId, requestId, type, payload };
}
function assertEnvelope(value: unknown, sessionId: string): asserts value is Envelope {
  requireValue(object(value) && value.channel === CHANNEL && value.version === VERSION && value.sessionId === sessionId && integer(value.requestId) && text(value.type) && Object.prototype.hasOwnProperty.call(value, 'payload'), 'invalid protocol envelope');
}
function errorPayload(reason: unknown): { name: string; message: string; stack?: string } {
  return reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : { name: 'Error', message: String(reason) };
}
function remoteError(value: unknown): Error {
  requireValue(object(value) && typeof value.name === 'string' && typeof value.message === 'string' && (value.stack === undefined || typeof value.stack === 'string'), 'invalid error response');
  const error = new Error(value.message);
  error.name = value.name;
  if (typeof value.stack === 'string') error.stack = value.stack;
  return error;
}
function abortError(): DOMException { return new DOMException('Office session aborted', 'AbortError'); }

export async function createFrameSession(options: OfficeSessionOptions, relativePath: string): Promise<OfficeSession> {
  if (options.signal.aborted) throw abortError();
  requireValue(text(options.sessionId), 'missing session id');
  const request: OfficeFrameOpen = { format: options.format, source: options.source, fileName: options.fileName, initialRevision: options.initialRevision ?? 0, ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }) };
  assertOpen(request);
  const url = new URL(relativePath, new URL(import.meta.env.BASE_URL, window.location.href));
  requireValue(url.origin === window.location.origin, 'engine must be same-origin');
  const frame = document.createElement('iframe');
  frame.title = `${options.format.toUpperCase()} 편집기`;
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
  const channel = new MessageChannel();
  const port = channel.port1;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(state: OfficeState) => void>();
  let state: OfficeState | undefined;
  let sequence = 0;
  let disposed = false;
  let connected = false;
  // ES2022 is the supported compiler/runtime baseline (no Promise.withResolvers).
  let resolveConnected!: () => void;
  let rejectConnected!: (reason: unknown) => void;
  const connection = new Promise<void>((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
  // Observe setup failures too, before execution reaches the connection await.
  void connection.catch(() => {});
  function cleanup(reason: unknown): void {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener('abort', onAbort);
    frame.removeEventListener('load', onLoad);
    frame.removeEventListener('error', onLoadError);
    port.onmessage = null;
    port.onmessageerror = null;
    port.close();
    channel.port2.close();
    frame.remove();
    rejectConnected(reason);
    for (const call of pending.values()) call.reject(reason);
    pending.clear();
    if (state) {
      state = { ...state, ready: false, busy: false };
      for (const listener of listeners) listener(state);
    }
    listeners.clear();
    if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
      options.mount.dispatchEvent(new CustomEvent('office-error', { detail: errorPayload(reason).message }));
    }
  }
  function onAbort(): void { cleanup(abortError()); }
  function onLoadError(): void { cleanup(new Error('Office engine failed to load')); }
  function onLoad(): void {
    try {
      requireValue(!connected && frame.contentWindow, 'engine navigated unexpectedly');
      frame.contentWindow.postMessage(envelope(options.sessionId, 0, 'connect', null), url.origin, [channel.port2]);
    } catch (error) { cleanup(error); }
  }
  function rpc(type: Method, payload: unknown): Promise<unknown> {
    if (disposed) return Promise.reject(abortError());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, type });
      try { port.postMessage(envelope(options.sessionId, id, type, payload)); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  function acceptState(value: unknown): void {
    const next = assertOfficeState(value, options.sessionId, state);
    requireValue(next.revision >= request.initialRevision, 'state predates restored document');
    state = next;
    for (const listener of listeners) listener(next);
  }
  port.onmessage = event => {
    if (disposed) return;
    try {
      const message: unknown = event.data;
      assertEnvelope(message, options.sessionId);
      if (message.requestId > 0) {
        const call = pending.get(message.requestId);
        requireValue(call && (message.type === `${call.type}:result` || message.type === `${call.type}:error`), 'unknown RPC response');
        const failure = message.type.endsWith(':error') ? remoteError(message.payload) : undefined;
        pending.delete(message.requestId);
        if (failure) call.reject(failure);
        else call.resolve(message.payload);
        return;
      }
      if (message.type === 'connected') {
        requireValue(!connected && message.payload === null, 'duplicate connection');
        connected = true;
        resolveConnected();
      } else {
        requireValue(connected, 'notification before connection');
        if (message.type === 'state') acceptState(message.payload);
        else if (message.type === 'save-intent') {
          requireValue(message.payload === null, 'invalid save intent');
          options.mount.dispatchEvent(new CustomEvent('office-save-intent'));
        } else if (message.type === 'open-request') {
          requireValue(message.payload instanceof File && message.payload.size > 0, 'invalid open request');
          options.mount.dispatchEvent(new CustomEvent('office-open-request', { detail: message.payload }));
        } else if (message.type === 'session-closed') {
          requireValue(message.payload === null, 'invalid session closure');
          cleanup(new Error('문서 엔진이 종료되었습니다. 보존 원본 또는 마지막 저장 작업에서 복구해 주세요.'));
        } else if (message.type === 'error') {
          requireValue(text(message.payload), 'invalid error notification');
          options.mount.dispatchEvent(new CustomEvent('office-error', { detail: message.payload }));
        } else throw new Error('Office bridge: unknown notification');
      }
    } catch (error) { cleanup(error); }
  };
  port.onmessageerror = () => cleanup(new Error('Office bridge message could not be decoded'));
  options.signal.addEventListener('abort', onAbort, { once: true });
  frame.addEventListener('load', onLoad);
  frame.addEventListener('error', onLoadError);
  try {
    frame.src = url.href;
    options.mount.appendChild(frame);
    await connection;
    const ready = await rpc('open', request);
    acceptState(ready);
    requireValue(state?.ready, 'engine opened without rendering a ready document');
    return {
      ...(state.pageView ? { pageView: {
        async execute(command: OfficePageCommand) {
          assertPageCommand(command);
          const result = await rpc('pageExecute', command);
          requireValue(object(result) && (result.ok === true || (result.ok === false && text(result.reason))), 'invalid page command result');
          return result as CommandResult;
        },
        async thumbnail(page: number, renderRevision: number) {
          if (disposed) throw abortError();
          assertPageRevision(state, page, renderRevision);
          const result = await rpc('pageThumbnail', { page, renderRevision });
          if (disposed) throw abortError();
          assertPageRevision(state, page, renderRevision);
          assertThumbnail(result);
          return result;
        },
      } } : {}),
      getState() { requireValue(state, 'state unavailable'); return state; },
      subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
      async execute(command) {
        assertCommand(command);
        requireValue(state, 'state unavailable');
        const result = await rpc('execute', { command, selectionRevision: state.selectionRevision });
        requireValue(object(result) && (result.ok === true || (result.ok === false && text(result.reason))), 'invalid command result');
        return result as CommandResult;
      },
      async flush() { const result = await rpc('flush', null); requireValue(typeof result === 'boolean', 'invalid flush result'); return result; },
      async captureCheckpoint() {
        const floor = state!.revision;
        const result = await rpc('captureCheckpoint', null);
        assertCapture(result, request.format, floor, false);
        return result as { revision: number; checkpoint: OfficeCheckpoint };
      },
      async serialize() {
        const floor = state!.revision;
        const result = await rpc('serialize', null);
        assertCapture(result, request.format, floor, true);
        return result as { revision: number; bytes: Blob; warnings: string[] };
      },
      dispose() {
        if (disposed) return;
        try { port.postMessage(envelope(options.sessionId, ++sequence, 'dispose', null)); }
        finally { cleanup(abortError()); }
      },
    };
  } catch (error) { cleanup(error); throw error; }
}

export function serveOfficeFrame(open: (request: OfficeFrameOpen, sessionId: string) => Promise<OfficeSession>): {
  requestSave(): void; requestOpen(file: File): void; reportError(message: string): void; dispose(): void;
} {
  let port: MessagePort | undefined;
  let sessionId = '';
  let session: OfficeSession | undefined;
  let state: OfficeState | undefined;
  let format: OfficeFrameOpen['format'] | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  let opened = false;
  let lastRequestId = 0;
  let operationActive = false;
  function send(requestId: number, type: string, payload: unknown): void {
    if (!disposed && port) port.postMessage(envelope(sessionId, requestId, type, payload));
  }
  function dispose(): void {
    if (disposed) return;
    try { send(0, 'session-closed', null); } catch { /* The peer may already be gone. */ }
    disposed = true;
    window.removeEventListener('message', connect);
    window.removeEventListener('pagehide', dispose);
    if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); }
    try { unsubscribe?.(); } finally { session?.dispose(); }
    session = undefined;
  }
  function publish(value: OfficeState): void {
    state = assertOfficeState(value, sessionId, state);
    send(0, 'state', state);
  }
  async function handle(message: Envelope): Promise<void> {
    if (message.type === 'dispose') {
      try {
        requireValue(message.payload === null, 'invalid dispose payload');
        send(message.requestId, 'dispose:result', null);
      } catch (error) { send(message.requestId, 'dispose:error', errorPayload(error)); }
      finally { dispose(); }
      return;
    }
    if (operationActive) {
      send(message.requestId, `${message.type}:error`, errorPayload(new Error('Office engine is busy with another operation')));
      return;
    }
    // Read-only previews must not block editing or saving while an image is rendered.
    const exclusive = message.type !== 'pageThumbnail';
    if (exclusive) operationActive = true;
    try {
      let result: unknown;
      if (message.type === 'open') {
        requireValue(!opened, 'document already opened');
        opened = true;
        assertOpen(message.payload);
        const request = message.payload;
        const candidate = await open(request, sessionId);
        if (disposed) { candidate.dispose(); return; }
        session = candidate;
        format = request.format;
        const initial = assertOfficeState(candidate.getState(), sessionId);
        requireValue(initial.ready && initial.revision >= request.initialRevision, 'engine not ready after open');
        requireValue(!!candidate.pageView === !!initial.pageView, 'inconsistent page capability');
        state = initial;
        unsubscribe = candidate.subscribe(value => {
          try { publish(value); }
          catch (error) { send(0, 'error', errorPayload(error).message); dispose(); }
        });
        publish(candidate.getState());
        result = state;
      } else {
        requireValue(session && state && format, 'document not opened');
        if (message.type === 'execute') {
          requireValue(object(message.payload) && exactKeys(message.payload, ['command', 'selectionRevision']) && integer(message.payload.selectionRevision), 'invalid execute payload');
          assertCommand(message.payload.command);
          const current = assertOfficeState(session.getState(), sessionId, state);
          state = current;
          if (message.payload.command.type !== 'zoom' && message.payload.selectionRevision !== current.selectionRevision) result = { ok: false, reason: '선택이 변경되었습니다. 다시 선택해 주세요.' };
          else if (current.busy || current.composing || !current.ready || !current.enabled[message.payload.command.type]) result = { ok: false, reason: '현재 문맥에서는 이 명령을 사용할 수 없습니다.' };
          else result = await session.execute(message.payload.command);
          requireValue(object(result) && (result.ok === true || (result.ok === false && text(result.reason))), 'invalid command result');
        } else if (message.type === 'pageExecute') {
          assertPageCommand(message.payload);
          const current = assertOfficeState(session.getState(), sessionId, state);
          state = current;
          requireValue(session.pageView && current.pageView, 'page view unavailable');
          if (current.busy || current.composing || !current.ready) result = { ok: false, reason: '현재 문맥에서는 이 명령을 사용할 수 없습니다.' };
          else if (message.payload.type === 'goToPage' && message.payload.page >= current.pageView.pageCount) result = { ok: false, reason: '페이지 범위를 벗어났습니다.' };
          else result = await session.pageView.execute(message.payload);
          if (disposed) return;
          requireValue(object(result) && (result.ok === true || (result.ok === false && text(result.reason))), 'invalid page command result');
          publish(session.getState());
        } else if (message.type === 'pageThumbnail') {
          const payload = message.payload;
          requireValue(object(payload) && exactKeys(payload, ['page', 'renderRevision']) && integer(payload.page) && integer(payload.renderRevision), 'invalid thumbnail payload');
          const page = payload.page as number, renderRevision = payload.renderRevision as number;
          const current = assertOfficeState(session.getState(), sessionId, state);
          state = current;
          requireValue(session.pageView && current.pageView, 'page view unavailable');
          assertPageRevision(current, page, renderRevision);
          requireValue(current.ready && !current.busy && !current.composing, 'page thumbnail unavailable');
          result = await session.pageView.thumbnail(page, renderRevision);
          if (disposed) return;
          publish(session.getState());
          assertPageRevision(state, page, renderRevision);
          assertThumbnail(result);
        } else {
          requireValue(message.payload === null, 'invalid RPC payload');
          if (message.type === 'flush') {
            result = await session.flush();
            requireValue(typeof result === 'boolean', 'invalid flush result');
          } else {
            const floor = assertOfficeState(session.getState(), sessionId, state).revision;
            if (message.type === 'captureCheckpoint') result = await session.captureCheckpoint();
            else if (message.type === 'serialize') result = await session.serialize();
            else throw new Error('Office bridge: unknown RPC');
            assertCapture(result, format, floor, message.type === 'serialize');
          }
        }
      }
      send(message.requestId, `${message.type}:result`, result);
    } catch (error) {
      send(message.requestId, `${message.type}:error`, errorPayload(error));
      if (message.type === 'open') dispose();
    } finally { if (exclusive) operationActive = false; }
  }
  function connect(event: MessageEvent): void {
    if (disposed || port || window.parent === window || event.source !== window.parent || event.origin !== window.location.origin) return;
    try {
      requireValue(object(event.data) && text(event.data.sessionId), 'invalid connection');
      assertEnvelope(event.data, event.data.sessionId);
      requireValue(event.data.type === 'connect' && event.data.requestId === 0 && event.data.payload === null && event.ports.length === 1, 'invalid connection payload');
      sessionId = event.data.sessionId;
      port = event.ports[0];
      window.removeEventListener('message', connect);
      port.onmessage = incoming => {
        if (disposed) return;
        try {
          const message: unknown = incoming.data;
          assertEnvelope(message, sessionId);
          requireValue(message.requestId > lastRequestId && methods.includes(message.type as Method), 'invalid RPC request');
          lastRequestId = message.requestId;
          void handle(message);
        } catch (error) { send(0, 'error', errorPayload(error).message); dispose(); }
      };
      port.onmessageerror = () => dispose();
      port.start();
      send(0, 'connected', null);
    } catch (error) {
      for (const incoming of event.ports) incoming.close();
      throw error;
    }
  }
  window.addEventListener('message', connect);
  window.addEventListener('pagehide', dispose);
  return {
    requestSave() { if (session) send(0, 'save-intent', null); },
    requestOpen(file) { requireValue(file instanceof File && file.size > 0, 'invalid open request'); if (session) send(0, 'open-request', file); },
    reportError(message) { requireValue(text(message), 'invalid error message'); send(0, 'error', message); },
    dispose,
  };
}
