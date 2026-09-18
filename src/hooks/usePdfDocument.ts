import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadedFontAsset, FontChoice, Page, Point, Workspace } from '../types/pdfEditor';
import type { EditValidation, NativeMethod, NativePdfApi, NativeRequest, NativeResponse, RenderedPage, SourceInfo, SourceTextPage } from '../pdf/engineTypes';
import { randomUUID } from '../utils/crypto';

export interface PdfDocumentController {
  info: SourceInfo | null;
  sessionId: string;
  isOpening: boolean;
  error: string | null;
  open(source: Blob, password?: string, beforeCommit?: (info: SourceInfo) => void, fontAssets?: DownloadedFontAsset[]): Promise<SourceInfo>;
  downloadFont(choice: Extract<FontChoice, { kind: 'source' }>): Promise<DownloadedFontAsset>;
  registerFonts(assets: DownloadedFontAsset[]): Promise<void>;
  text(index: number): Promise<SourceTextPage>;
  copySourceText(index: number, start: Point, end: Point): Promise<string>;
  validate(page: Page, revision: number, candidateRevision?: number): Promise<EditValidation>;
  render(page: Page, scale: number, revision: number, candidateRevision?: number, priority?: 'active' | 'thumbnail'): Promise<RenderedPage>;
  export(workspace: Workspace, revision: number): Promise<Uint8Array>;
  retry(): Promise<void>;
  close(): void;
}
type Result<M extends NativeMethod> = Awaited<ReturnType<NativePdfApi[M]>>;
interface PendingRequest {
  request: NativeRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}
function aborted() { return new DOMException('PDF 작업이 취소되었습니다.', 'AbortError'); }
function nativeError(code: string, message: string): Error {
  if (code === 'ABORTED') return new DOMException(message, 'AbortError');
  return Object.assign(new Error(message), { code });
}

class WorkerSession {
  readonly id = randomUUID();
  private readonly worker = new Worker(new URL('../pdf/mupdf.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, PendingRequest>();
  private readonly renders = new Map<string, { promise: Promise<RenderedPage>; requestId: number }>();
  private nextId = 0;
  private failure: Error | null = null;
  constructor(private readonly onProgress: (current: number, total: number) => void, private readonly onFailure: (error: Error) => void) {
    this.worker.onmessage = (event: MessageEvent<NativeResponse>) => {
      const message = event.data;
      if (message.sessionId !== this.id) return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      if ('event' in message) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          const error = nativeError('TIMEOUT', '작업 시간이 초과되었습니다. 다시 시도해 주세요.');
          this.terminate(error);
          this.onFailure(error);
        }, 20_000);
        if (message.event === 'progress') this.onProgress(message.current, message.total);
        return;
      }
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if ('error' in message) pending.reject(nativeError(message.error.code, message.error.message));
      else pending.resolve(message.result);
    };
    this.worker.onerror = event => {
      event.preventDefault();
      const error = nativeError('WORKER_ERROR', event.message || 'PDF 엔진을 실행하지 못했습니다.');
      this.terminate(error);
      this.onFailure(error);
    };
    this.worker.onmessageerror = () => {
      const error = nativeError('WORKER_MESSAGE_ERROR', 'PDF 엔진의 응답을 읽지 못했습니다.');
      this.terminate(error);
      this.onFailure(error);
    };
  }
  request<M extends NativeMethod>(method: M, params: Parameters<NativePdfApi[M]>, revision = 0, candidateRevision = 0, priority: 'active' | 'thumbnail' = 'active'): Promise<Result<M>> {
    if (this.failure) return Promise.reject(this.failure);
    const requestId = ++this.nextId;
    // The mapped request union ties each method to precisely its native argument tuple.
    const request = { requestId, sessionId: this.id, revision, candidateRevision, method, params, priority } as NativeRequest;
    return new Promise<Result<M>>((resolve, reject) => {
      this.pending.set(requestId, { request, resolve: value => resolve(value as Result<M>), reject, timer: null });
      try { this.worker.postMessage(request); }
      catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
  render(page: Page, scale: number, revision: number, candidateRevision: number, priority: 'active' | 'thumbnail'): Promise<RenderedPage> {
    const key = `${this.id}:${page.id}:${revision}:${candidateRevision}:${scale}`;
    const existing = this.renders.get(key);
    if (existing) {
      const pending = this.pending.get(existing.requestId);
      if (priority === 'active' && pending?.request.priority === 'thumbnail') {
        pending.request.priority = 'active';
        this.worker.postMessage(pending.request);
      }
      return existing.promise;
    }
    const promise = this.request('render', [page, scale], revision, candidateRevision, priority);
    this.renders.set(key, { promise, requestId: this.nextId });
    void promise.then(() => this.renders.delete(key), () => this.renders.delete(key));
    return promise;
  }
  terminate(error: Error = aborted()) {
    if (this.failure) return;
    this.failure = error;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.renders.clear();
  }
}

export function usePdfDocument(options?: { onProgress?: (current: number, total: number) => void }): PdfDocumentController {
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<WorkerSession | null>(null);
  const opening = useRef<WorkerSession | null>(null);
  const retained = useRef<{ source: Blob; password?: string; fontAssets: DownloadedFontAsset[] } | null>(null);
  const generation = useRef(0);
  const progress = useRef(options?.onProgress);
  progress.current = options?.onProgress;

  const open = useCallback(async (source: Blob, password?: string, beforeCommit?: (info: SourceInfo) => void, fontAssets: DownloadedFontAsset[] = []): Promise<SourceInfo> => {
    const ticket = ++generation.current;
    opening.current?.terminate();
    setIsOpening(true);
    setError(null);
    let candidate: WorkerSession | null = null;
    try {
      candidate = new WorkerSession((current, total) => progress.current?.(current, total), failure => {
        if (active.current === candidate || opening.current === candidate) setError(failure.message);
      });
      opening.current = candidate;
      const metadata = await candidate.request('open', [source, password]);
      if (!metadata.pages.length) throw new Error('PDF에 페이지가 없습니다.');
      if (fontAssets.length) await candidate.request('registerFonts', [fontAssets]);
      const firstPage: Page = {
        id: randomUUID(), label: '1페이지', kind: 'pdf', sourcePageIndex: 0,
        originalInstance: true, rotation: 0, textEdits: [],
      };
      await candidate.render(firstPage, 96 / 72, 0, 0, 'active');
      if (ticket !== generation.current) throw aborted();
      beforeCommit?.(metadata);
      if (ticket !== generation.current) throw aborted();
      const previous = active.current;
      active.current = candidate;
      opening.current = null;
      retained.current = { source, password, fontAssets: fontAssets.slice() };
      setInfo(metadata);
      setSessionId(candidate.id);
      previous?.terminate();
      return metadata;
    } catch (failure) {
      candidate?.terminate();
      if (ticket === generation.current) {
        opening.current = null;
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      throw failure;
    } finally {
      if (ticket === generation.current) setIsOpening(false);
    }
  }, []);
  const requireSession = useCallback(() => {
    if (!active.current) throw new Error('먼저 PDF를 열어 주세요.');
    return active.current;
  }, []);
  const downloadFont = useCallback(async (choice: Extract<FontChoice, { kind: 'source' }>) => {
    const session = requireSession();
    const asset = await session.request('downloadFont', [choice]);
    if (active.current !== session) throw aborted();
    return asset;
  }, [requireSession]);
  const registerFonts = useCallback(async (assets: DownloadedFontAsset[]) => {
    const session = requireSession();
    if (!assets.length) return;
    await session.request('registerFonts', [assets]);
    if (active.current !== session) throw aborted();
    const previous = retained.current;
    if (previous) {
      const ids = new Set(previous.fontAssets.map(asset => asset.id));
      const added = assets.filter(asset => {
        if (ids.has(asset.id)) return false;
        ids.add(asset.id);
        return true;
      });
      if (added.length) retained.current = { ...previous, fontAssets: [...previous.fontAssets, ...added] };
    }
  }, [requireSession]);
  const text = useCallback((index: number) => requireSession().request('text', [index]), [requireSession]);
  const copySourceText = useCallback((index: number, start: Point, end: Point) => requireSession().request('copySourceText', [index, start, end]), [requireSession]);
  const validate = useCallback((page: Page, revision: number, candidateRevision = 0) => requireSession().request('validate', [page], revision, candidateRevision), [requireSession]);
  const render = useCallback((page: Page, scale: number, revision: number, candidateRevision = 0, priority: 'active' | 'thumbnail' = 'active') => requireSession().render(page, scale, revision, candidateRevision, priority), [requireSession]);
  const exportSnapshot = useCallback((workspace: Workspace, revision: number) => requireSession().request('export', [workspace], revision), [requireSession]);
  const retry = useCallback(async () => {
    const previous = retained.current;
    if (!previous) throw new Error('다시 열 PDF가 없습니다.');
    await open(previous.source, previous.password, undefined, previous.fontAssets);
  }, [open]);
  const close = useCallback(() => {
    ++generation.current;
    opening.current?.terminate();
    active.current?.terminate();
    opening.current = null;
    active.current = null;
    retained.current = null;
    setInfo(null);
    setSessionId('');
    setIsOpening(false);
    setError(null);
  }, []);
  useEffect(() => () => {
    ++generation.current;
    opening.current?.terminate();
    active.current?.terminate();
    opening.current = null;
    active.current = null;
    retained.current = null;
  }, []);
  return { info, sessionId, isOpening, error, open, downloadFont, registerFonts, text, copySourceText, validate, render, export: exportSnapshot, retry, close };
}
