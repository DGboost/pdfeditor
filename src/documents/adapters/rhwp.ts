import { createStudio, type RhwpEditor } from '../../../vendor/rhwp/npm/editor/index.js';
import { assertOfficeState } from '../frameBridge';
import type { OfficeSession, OfficeSessionOptions, OfficeState } from '../officeTypes';
import { parseContentLossReport } from '../../../vendor/rhwp/rhwp-studio/src/core/export-content-loss';

export async function createRhwpSession(options: OfficeSessionOptions): Promise<OfficeSession> {
  if (options.format !== 'hwp' && options.format !== 'hwpx') throw new Error('잘못된 한글 문서 형식입니다.');
  const format = options.format;
  const checkpoint = options.checkpoint;
  if (checkpoint && (checkpoint.kind !== 'native' || checkpoint.format !== format)) throw new Error('초안 형식이 원본과 다릅니다.');
  options.signal.throwIfAborted();
  let editor: RhwpEditor | undefined;
  let disposed = false;
  let state: OfficeState;
  const listeners = new Set<(state: OfficeState) => void>();
  const cleanup: (() => void)[] = [];
  const dispatch = (type: string, detail?: unknown) => options.mount.dispatchEvent(new CustomEvent(type, { detail }));
  const dispose = () => {
    if (disposed) { editor?.destroy(); return; }
    disposed = true;
    options.signal.removeEventListener('abort', dispose);
    for (const off of cleanup) off();
    listeners.clear();
    editor?.destroy();
  };
  options.signal.addEventListener('abort', dispose, { once: true });
  const requireLive = () => {
    options.signal.throwIfAborted();
    if (disposed) throw new Error('문서 세션이 종료되었습니다.');
  };
  const accept = (value: unknown) => {
    if (disposed) return;
    state = assertOfficeState(value, options.sessionId, state);
    for (const listener of listeners) listener(state);
  };
  try {
    const url = new URL(`${import.meta.env.BASE_URL}engines/rhwp/index.html`, location.origin);
    url.searchParams.set('chrome', 'embed');
    editor = await createStudio(options.mount, {
      studioUrl: url.href, renderer: 'canvas2d', signal: options.signal,
      sessionId: options.sessionId, requireHost: true,
      chrome: { menu: false, toolbar: false, statusbar: false },
    });
    requireLive();
    const host = editor.host;
    cleanup.push(host.onState(value => {
      try { accept(value); } catch (error) { dispatch('office-error', error instanceof Error ? error.message : String(error)); }
    }));
    cleanup.push(host.onSaveIntent(() => dispatch('office-save-intent')));
    cleanup.push(host.onOpenRequest(file => { if (file instanceof File) dispatch('office-open-request', file); }));
    cleanup.push(host.onError(message => dispatch('office-error', String(message))));
    const bytes = checkpoint?.kind === 'native' ? checkpoint.bytes : options.source;
    await editor.loadFile(await bytes.arrayBuffer(), `document.${format}`, { skipUnsavedGuard: true, suppressDialogs: true });
    requireLive();
    accept(await host.getState({ initialRevision: options.initialRevision ?? 0 }));
    if (!state!.ready) throw new Error('한글 문서의 첫 화면이 준비되지 않았습니다.');
    async function serialize() {
      requireLive();
      const value = await host.exportReported();
      requireLive();
      if (!value || typeof value !== 'object') throw new Error('잘못된 내보내기 응답입니다.');
      const artifact = value as { revision: number; format: unknown; bytes: unknown; contentLoss: unknown };
      if (!Number.isSafeInteger(artifact.revision) || artifact.revision < 0 || artifact.format !== format
        || !(artifact.bytes instanceof Uint8Array) || !artifact.bytes.byteLength) throw new Error('잘못된 내보내기 응답입니다.');
      const report = parseContentLossReport(artifact.contentLoss);
      if (report.outputFormat !== format) throw new Error('손실 보고서와 내보내기 형식이 다릅니다.');
      return {
        revision: artifact.revision,
        bytes: new Blob([artifact.bytes.slice().buffer], { type: format === 'hwp' ? 'application/x-hwp' : 'application/hwp+zip' }),
        warnings: report.losses.map(loss => `${loss.path}: ${loss.code} (${loss.reason})`),
      };
    }
    return {
      getState() { return state; },
      subscribe(listener) { requireLive(); listeners.add(listener); return () => listeners.delete(listener); },
      interaction: {
        async execute(command) {
          requireLive();
          const result = await host.applyInteraction(command);
          requireLive();
          accept(await host.getState());
          return result;
        },
        async selectedText() {
          requireLive();
          const text = await host.selectedText();
          requireLive();
          if (typeof text !== 'string') throw new Error('잘못된 선택 텍스트입니다.');
          return text;
        },
      },
      pageView: {
        async execute(command) {
          requireLive();
          const result = await host.applyPageView(command);
          requireLive();
          accept(await host.getState());
          return result;
        },
        async thumbnail(page, renderRevision) {
          requireLive();
          if (state.pageView?.renderRevision !== renderRevision) throw new DOMException('페이지가 변경되었습니다.', 'AbortError');
          const image = await host.getPageThumbnail(page, renderRevision);
          requireLive();
          if (state.pageView?.renderRevision !== renderRevision) throw new DOMException('페이지가 변경되었습니다.', 'AbortError');
          if (!(image instanceof Blob) || !image.size || !['image/svg+xml', 'image/png'].includes(image.type)) throw new Error('잘못된 페이지 미리보기입니다.');
          return image;
        },
      },
      async execute(command) {
        requireLive();
        const result = await host.applyCharProperties(command, state.selectionRevision);
        requireLive();
        accept(await host.getState());
        return result;
      },
      async flush() { requireLive(); const result = await host.flush(); requireLive(); return result; },
      async captureCheckpoint() {
        const captured = await serialize();
        if (captured.warnings.length) throw new Error(`자동 저장에 손실 위험이 있습니다. 수정본을 확인하여 다운로드하세요.\n${captured.warnings.join('\n')}`);
        return { revision: captured.revision, checkpoint: { kind: 'native', format, bytes: captured.bytes, warnings: [] } };
      },
      serialize,
      dispose,
    };
  } catch (error) {
    dispose();
    if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw error;
  }
}
