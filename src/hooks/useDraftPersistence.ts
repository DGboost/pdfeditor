import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentState } from '../types/pdfEditor';
import { PDF_DRAFT_VERSION, savePdfDraft } from '../utils/db';
import type { PdfDraft, SaveStatus } from '../utils/db';

interface DraftPersistenceOptions { state: DocumentState; zoom: number; enabled: boolean; getState?: () => DocumentState }
export interface DraftPersistenceController { status: SaveStatus; error: string | null; flushDraft: () => Promise<void>; drain: () => Promise<void>; retry: () => Promise<void> }
export function useDraftPersistence(options: DraftPersistenceOptions): DraftPersistenceController {
  const latest = useRef(options);
  latest.current = options;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState<SaveStatus>('dirty');
  const [error, setError] = useState<string | null>(null);
  const cancelTimer = useCallback(() => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } }, []);
  const flushDraft = useCallback(async () => {
    cancelTimer();
    const current = latest.current;
    const state = current.getState?.() ?? current.state;
    if (!state.workspace) return;
    const draft: PdfDraft = { version: PDF_DRAFT_VERSION, workspace: state.workspace, revision: state.revision, zoom: current.zoom, savedAt: Date.now() };
    const isCurrent = () => {
      const now = latest.current;
      const nowState = now.getState?.() ?? now.state;
      return nowState.workspace === draft.workspace && now.zoom === draft.zoom;
    };
    const pending = queue.current.catch(() => undefined).then(async () => {
      if (mounted.current && isCurrent()) { setStatus('saving'); setError(null); }
      try {
        await savePdfDraft(draft);
        if (mounted.current && isCurrent()) { setStatus('saved'); setError(null); }
      } catch (failure) {
        if (mounted.current && isCurrent()) { setStatus('error'); setError(failure instanceof Error ? failure.message : '저장할 수 없습니다.'); }
        throw failure;
      }
    });
    queue.current = pending;
    await pending;
  }, [cancelTimer]);
  const drain = useCallback(async () => { cancelTimer(); await queue.current; }, [cancelTimer]);
  useEffect(() => {
    cancelTimer();
    if (!options.enabled || !options.state.workspace) return;
    setStatus('dirty'); setError(null);
    timer.current = window.setTimeout(() => { timer.current = null; void flushDraft().catch(() => undefined); }, 1500);
    return cancelTimer;
  }, [options.enabled, options.state.workspace, options.state.revision, options.zoom, cancelTimer, flushDraft]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelTimer(); }; }, [cancelTimer]);
  return { status, error, flushDraft, drain, retry: flushDraft };
}
