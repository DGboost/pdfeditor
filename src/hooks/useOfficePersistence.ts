import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeRecord, OfficeSession } from '../documents/officeTypes';
import { saveOfficeDraft } from '../documents/officeDb';
import type { SaveStatus } from '../utils/db';

interface OfficePersistenceOptions {
  document: { session: OfficeSession; record: OfficeRecord; initialSaveError: string | null } | null;
  fileName: string;
  getFileName: () => string;
  enabled: boolean;
  onSaved: (record: OfficeRecord) => void;
}
interface Model {
  session: OfficeSession;
  record: OfficeRecord;
  fileName: string;
  modified: boolean;
  sequence: number;
  persisted: boolean;
  requested: boolean;
  pending: Promise<void> | null;
}
export interface OfficePersistenceController {
  status: SaveStatus;
  error: string | null;
  flushDraft(): Promise<void>;
  drain(): Promise<void>;
  retry(): Promise<void>;
}

export function useOfficePersistence(options: OfficePersistenceOptions): OfficePersistenceController {
  const latest = useRef(options);
  latest.current = options;
  const model = useRef<Model | null>(null);
  const document = options.document;
  if (document && model.current?.session !== document.session) {
    model.current = {
      session: document.session, record: document.record, fileName: options.fileName,
      modified: document.record.modified, sequence: document.record.checkpointSequence,
      persisted: !document.initialSaveError, requested: false, pending: null,
    };
  } else if (!document) model.current = null;
  if (model.current) model.current.fileName = options.fileName;
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [observed, setObserved] = useState({ session: '', revision: 0, zoom: 1, composing: false });
  const [view, setView] = useState<{ session: string; status: SaveStatus; error: string | null }>({ session: '', status: 'dirty', error: null });
  const cancelTimer = useCallback(() => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } }, []);

  const flushDraft = useCallback(async () => {
    cancelTimer();
    const current = model.current;
    if (!current) return;
    current.requested = true;
    if (current.pending) return current.pending;
    const isCurrent = () => mounted.current && model.current === current;
    const pending = queue.current.catch(() => undefined).then(async () => {
      while (current.requested) {
        current.requested = false;
        if (isCurrent()) setView({ session: current.session.getState().sessionId, status: 'saving', error: null });
        try {
          if (!await current.session.flush()) throw new Error('문서 입력을 확정하지 못했습니다. 편집기로 돌아가 다시 시도해 주세요.');
          const state = current.session.getState();
          current.modified ||= state.revision > current.record.revision;
          const needsCheckpoint = current.modified && (state.revision !== current.record.revision || current.record.checkpoint === null);
          const captured = needsCheckpoint
            ? await current.session.captureCheckpoint()
            : { revision: state.revision, checkpoint: current.record.checkpoint };
          const name = isCurrent() ? latest.current.getFileName() : current.fileName;
          const zoom = current.session.getState().zoom;
          const record: OfficeRecord = {
            ...current.record, fileName: name, zoom, revision: captured.revision,
            checkpoint: captured.checkpoint, checkpointSequence: ++current.sequence,
            modified: current.modified, savedAt: Date.now(),
          };
          await saveOfficeDraft(record);
          current.record = record;
          current.persisted = true;
          if (isCurrent()) {
            latest.current.onSaved(record);
            const now = current.session.getState();
            const saved = now.revision === record.revision && now.zoom === record.zoom && latest.current.getFileName() === record.fileName;
            setView({ session: now.sessionId, status: saved ? 'saved' : 'dirty', error: null });
          }
        } catch (error) {
          current.requested = false;
          if (isCurrent()) setView({ session: current.session.getState().sessionId, status: 'error', error: error instanceof Error ? error.message : 'Office 문서를 저장할 수 없습니다.' });
          throw error;
        }
      }
    });
    current.pending = pending;
    queue.current = pending;
    const release = () => { if (current.pending === pending) current.pending = null; };
    void pending.then(release, release);
    await pending;
  }, [cancelTimer]);

  const drain = useCallback(async () => { cancelTimer(); await queue.current; }, [cancelTimer]);
  useEffect(() => {
    if (!document) return;
    const session = document.session;
    const changed = () => {
      const state = session.getState();
      if (model.current?.session === session && state.revision > model.current.record.revision) model.current.modified = true;
      setObserved(previous => previous.session === state.sessionId && previous.revision === state.revision && previous.zoom === state.zoom && previous.composing === state.composing ? previous : { session: state.sessionId, revision: state.revision, zoom: state.zoom, composing: state.composing });
    };
    changed();
    return session.subscribe(changed);
  }, [document?.session]);

  useEffect(() => {
    cancelTimer();
    const current = model.current;
    if (!current || !options.enabled) return;
    const state = current.session.getState();
    const clean = current.persisted && current.record.revision === state.revision && current.record.zoom === state.zoom && current.record.fileName === options.getFileName();
    if (clean) return;
    setView(previous => ({ session: state.sessionId, status: current.pending ? 'saving' : previous.session === state.sessionId && previous.error ? 'error' : 'dirty', error: previous.session === state.sessionId ? previous.error : document?.initialSaveError ?? null }));
    if (state.composing) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!current.session.getState().composing) void flushDraft().catch(() => undefined);
    }, 1500);
    return cancelTimer;
  }, [document?.session, options.enabled, options.fileName, observed.revision, observed.zoom, observed.composing, cancelTimer, flushDraft]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelTimer(); }; }, [cancelTimer]);
  const sessionId = document?.session.getState().sessionId;
  const currentView = view.session === sessionId ? view : { status: document?.initialSaveError ? 'error' as const : 'saved' as const, error: document?.initialSaveError ?? null };
  return { status: currentView.status, error: currentView.error, flushDraft, drain, retry: flushDraft };
}
