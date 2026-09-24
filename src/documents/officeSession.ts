import { createDocxSession } from './adapters/docx';
import { createRhwpSession } from './adapters/rhwp';
import { createPptistSession } from './adapters/pptist';
import type { OfficeSession, OfficeSessionOptions } from './officeTypes';

// These imports are transport adapters only; engine code is loaded by its iframe.
export async function createOfficeSession(options: OfficeSessionOptions): Promise<OfficeSession> {
  options.signal.throwIfAborted();
  const revision = options.initialRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('문서 revision이 올바르지 않습니다.');
  if (!(options.source instanceof Blob) || !options.source.size) throw new Error('보존 원본이 없습니다.');
  if (!options.mount.isConnected || options.mount.clientWidth <= 0 || options.mount.clientHeight <= 0) throw new Error('편집 엔진의 표시 영역을 준비하지 못했습니다.');
  const checkpoint = options.checkpoint;
  if (checkpoint && (options.format === 'pptx'
    ? checkpoint.kind !== 'pptist'
    : checkpoint.kind !== 'native' || checkpoint.format !== options.format)) throw new Error('원본과 체크포인트 형식이 일치하지 않습니다.');
  const prepared = { ...options, initialRevision: revision };
  let opening: Promise<OfficeSession>;
  switch (options.format) {
    case 'docx': opening = createDocxSession(prepared); break;
    case 'hwp':
    case 'hwpx': opening = createRhwpSession(prepared); break;
    case 'pptx': opening = createPptistSession(prepared); break;
  }
  const session = await opening;
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  // ES2022 does not provide Promise.withResolvers.
  let rejectDisposed!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectDisposed = reject; });
  void cancellation.catch(() => {});
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = Promise.race([cancellation, queue.then(() => {
      if (disposed) throw new DOMException('문서 세션이 종료되었습니다.', 'AbortError');
      return operation();
    })]);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const flush = session.flush.bind(session);
  const capture = session.captureCheckpoint.bind(session);
  const serialize = session.serialize.bind(session);
  return {
    getState: session.getState.bind(session),
    subscribe: session.subscribe.bind(session),
    execute: command => serial(() => session.execute(command)),
    ...(session.pageView ? { pageView: {
      execute: (command: Parameters<typeof session.pageView.execute>[0]) => serial(() => session.pageView!.execute(command)),
      thumbnail: (page: number, renderRevision: number) => serial(() => session.pageView!.thumbnail(page, renderRevision)),
    } } : {}),
    ...(session.interaction ? { interaction: {
      execute: (command: Parameters<typeof session.interaction.execute>[0]) => serial(() => session.interaction!.execute(command)),
      selectedText: () => serial(() => session.interaction!.selectedText()),
    } } : {}),
    flush: () => serial(flush),
    captureCheckpoint: () => serial(capture),
    serialize: () => serial(serialize),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      rejectDisposed(new DOMException('문서 세션이 종료되었습니다.', 'AbortError'));
      session.dispose();
    },
  };
}
