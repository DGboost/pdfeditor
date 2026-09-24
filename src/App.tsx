import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DownloadedFontAsset, EditController, Page, Screen, Tool, Workspace } from './types/pdfEditor';
import type { SourceInfo } from './pdf/engineTypes';
import { useDocumentReducer } from './hooks/useDocumentReducer';
import type { DocumentActions } from './hooks/useDocumentReducer';
import { useToast } from './hooks/useToast';
import { usePdfDocument } from './hooks/usePdfDocument';
import { useExportPdf } from './hooks/useExportPdf';
import { useDraftPersistence } from './hooks/useDraftPersistence';
import { useOfficePersistence } from './hooks/useOfficePersistence';
import { UploadScreen } from './components/screens/UploadScreen';
import { EditorScreen } from './components/screens/EditorScreen/EditorScreen';
import { OfficeEditorScreen } from './components/editor/OfficeEditorScreen';
import { ExportModal } from './components/ExportModal';
import type { ExportAction, ExportActionId } from './components/ExportModal';
import { GridView } from './components/screens/EditorScreen/GridView';
import { Toast } from './components/Toast';
import { ExportProgressOverlay } from './components/ExportProgressOverlay';
import { loadPdfDraft, savePdfArchive, listPdfArchives, loadPdfArchive, deletePdfArchive, listRetainedDrafts, loadRetainedDraft, deleteRetainedDraft, quarantineActiveDraft, serializeRetainedBackup, validateWorkspace, PDF_DRAFT_VERSION } from './utils/db';
import type { ArchiveSummary, PdfDraft, RetainedDraftSummary } from './utils/db';
import { randomUUID } from './utils/crypto';
import { detectDocument, LEGACY_DOCUMENT_MESSAGE } from './documents/formats';
import type { DocumentFormat, OfficeFormat } from './documents/formats';
import { createOfficeSession } from './documents/officeSession';
import { OFFICE_ENGINES } from './documents/officeTypes';
import type { LibraryItem, LibraryKey, OfficeRecord, OfficeRecordSummary, OfficeRetainedSummary, OfficeSession } from './documents/officeTypes';
import { saveOfficeDraft, listOfficeDrafts, loadOfficeDraft, saveOfficeArchive, listOfficeArchives, loadOfficeArchive, deleteOfficeArchive, listOfficeRetained, loadOfficeRetained, deleteOfficeRetained } from './documents/officeDb';
import { downloadBlob, hashSource, modifiedFileName } from './documents/files';
import { SURFACE, TEXT, BORDER_SOFT, BORDER_STRONG, DANGER } from './styles/theme';
import './styles/global.css';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
const saveLabels = { dirty: '저장되지 않은 변경', saving: '저장 중…', saved: '자동 저장됨', error: '저장 실패' };
const PPTX_NOTICE = 'PPTX를 편집용으로 변환합니다. 일부 고급 서식·마스터가 달라질 수 있고, 원본의 애니메이션·화면 전환은 가져오지 않습니다. 편집기에서 추가한 애니메이션은 작업 사본에서만 재생되며 PPTX 수정본에는 포함되지 않습니다. 원본은 보존하고 수정본으로 저장합니다.';

interface WorkingOffice {
  session: OfficeSession;
  mount: HTMLElement;
  detach: () => void;
  record: OfficeRecord;
  fileName: string;
  initialSaveError: string | null;
}
function disposeOffice(office: WorkingOffice): void {
  office.detach();
  office.session.dispose();
  office.mount.remove();
}
function checkSourceReferences(workspace: Workspace, info: SourceInfo): void {
  const originals = new Set<number>();
  for (const page of workspace.pages) {
    const contents = page.kind === 'pdf' ? page.textEdits.map(edit => edit.content) : [];
    for (const content of contents) for (const run of content.runs) {
      if (run.style.font.kind === 'source' && run.style.font.sourcePageIndex >= info.pages.length) throw new Error('저장된 원본 글꼴 참조가 PDF 범위를 벗어납니다.');
    }
    if (page.kind !== 'pdf') continue;
    if (page.sourcePageIndex >= info.pages.length) throw new Error('저장된 페이지가 원본 PDF 범위를 벗어납니다.');
    if (page.originalInstance) {
      if (originals.has(page.sourcePageIndex)) throw new Error('원본 페이지 참조가 중복되었습니다.');
      originals.add(page.sourcePageIndex);
    } else {
      const capability = info.pages[page.sourcePageIndex].duplicate;
      if (!capability.allowed) throw new Error(capability.reason);
    }
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('upload');
  const [activeFormat, setActiveFormatState] = useState<DocumentFormat | null>(null);
  const activeFormatRef = useRef<DocumentFormat | null>(null);
  const [office, setOfficeState] = useState<WorkingOffice | null>(null);
  const officeRef = useRef<WorkingOffice | null>(null);
  const setOffice = useCallback((value: WorkingOffice | null) => { officeRef.current = value; setOfficeState(value); }, []);
  const setActiveFormat = (value: DocumentFormat | null) => { activeFormatRef.current = value; setActiveFormatState(value); };
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadSlowHint, setUploadSlowHint] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [pageNumInput, setPageNumInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [gridViewOpen, setGridViewOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const flushingRef = useRef(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<ExportActionId>('download');
  const [pdfDraft, setPdfDraft] = useState<PdfDraft | null>(null);
  const initialLoad = useRef<Promise<void>>(Promise.resolve());
  const unverifiedDraftId = useRef<string | null>(null);
  const verifiedPdfId = useRef<string | null>(null);
  const libraryBusyRef = useRef(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [pdfArchives, setPdfArchives] = useState<ArchiveSummary[]>([]);
  const [pdfRetained, setPdfRetained] = useState<RetainedDraftSummary[]>([]);
  const [officeDrafts, setOfficeDrafts] = useState<OfficeRecordSummary[]>([]);
  const [officeArchives, setOfficeArchives] = useState<OfficeRecordSummary[]>([]);
  const [officeRetained, setOfficeRetained] = useState<OfficeRetainedSummary[]>([]);
  const [hasUnappliedEdit, setHasUnappliedEdit] = useState(false);
  const editController = useRef<EditController | null>(null);
  const openSequence = useRef(0);
  const librarySequence = useRef(0);
  const mounted = useRef(true);
  const retire = useRef<(() => void) | null>(null);
  const candidate = useRef<{ abort: AbortController; mount: HTMLElement; detach: () => void } | null>(null);
  const [canCancelOpen, setCanCancelOpen] = useState(false);
  const doc = useDocumentReducer();
  const toast = useToast();
  const pdf = usePdfDocument({ onProgress: (current, total) => setExportProgress({ current, total }) });
  const persistence = useDraftPersistence({ state: doc.state, getState: doc.getState, zoom, enabled: screen === 'editor' && activeFormat === 'pdf' });
  const officePersistence = useOfficePersistence({
    document: office, fileName: office?.fileName ?? '', getFileName: () => officeRef.current?.fileName ?? '',
    enabled: screen === 'editor' && activeFormat !== null && activeFormat !== 'pdf',
    onSaved: record => {
      const current = officeRef.current;
      if (current?.record.id === record.id) setOffice({ ...current, record, initialSaveError: null });
    },
  });
  const workspace = doc.state.workspace;
  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
    if (!value) setExportProgress(null);
  }, []);
  const registerEditController = useCallback((controller: EditController | null) => { editController.current = controller; }, []);
  const flushActiveEdit = useCallback(async () => {
    if (activeFormatRef.current !== 'pdf') return await (officeRef.current?.session.flush() ?? Promise.resolve(true));
    flushingRef.current = true;
    try { return await (editController.current?.flush() ?? Promise.resolve(true)); }
    finally { flushingRef.current = false; }
  }, []);

  const refreshLibrary = useCallback(async () => {
    const sequence = ++librarySequence.current;
    const current = () => mounted.current && sequence === librarySequence.current;
    const errors: string[] = [];
    await Promise.all([
      (async () => {
        try {
          const loaded = await loadPdfDraft();
          if (!current()) return;
          if (loaded.kind === 'ready') {
            if (await hashSource(loaded.draft.workspace.source) !== loaded.draft.workspace.sourceHash) {
              if (!current()) return;
              await quarantineActiveDraft('invalid', '저장된 원본 PDF의 해시가 일치하지 않습니다.');
              if (current()) { setPdfDraft(null); unverifiedDraftId.current = null; }
            } else if (current()) {
              setPdfDraft(loaded.draft);
              if (verifiedPdfId.current !== loaded.draft.workspace.id) unverifiedDraftId.current = loaded.draft.workspace.id;
            }
          } else { setPdfDraft(null); unverifiedDraftId.current = null; if (loaded.kind !== 'empty') errors.push('이전 PDF 작업을 백업에 보존했습니다.'); }
          const saved = await listPdfArchives();
          const retained = await listRetainedDrafts();
          if (current()) { setPdfArchives(saved); setPdfRetained(retained); }
        } catch (error) { errors.push(`PDF 저장소: ${errorMessage(error)}`); }
      })(),
      (async () => {
        try {
          const [drafts, archives] = await Promise.all([listOfficeDrafts(), listOfficeArchives()]);
          const retained = await listOfficeRetained();
          if (current()) { setOfficeDrafts(drafts); setOfficeArchives(archives); setOfficeRetained(retained); }
        } catch (error) { errors.push(`Office 저장소: ${errorMessage(error)}`); }
      })(),
    ]);
    if (current()) setLibraryError(errors.length ? `${errors.join(' · ')} 로컬 파일 열기와 다운로드는 사용할 수 있습니다.` : null);
  }, []);

  useEffect(() => { mounted.current = true; initialLoad.current = refreshLibrary(); return () => { mounted.current = false; librarySequence.current++; }; }, [refreshLibrary]);
  useEffect(() => {
    const dispose = retire.current;
    retire.current = null;
    dispose?.();
  }, [activeFormat, office?.session]);
  useEffect(() => () => {
    openSequence.current++;
    candidate.current?.abort.abort(); candidate.current?.detach(); candidate.current?.mount.remove();
    if (officeRef.current) disposeOffice(officeRef.current);
    retire.current?.(); retire.current = null;
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const current = officeRef.current;
      const changed = activeFormatRef.current === 'pdf'
        ? hasUnappliedEdit || (doc.getState().workspace !== null && persistence.status !== 'saved')
        : current !== null && (current.session.getState().composing || officePersistence.status !== 'saved');
      if (changed || busyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnappliedEdit, persistence.status, officePersistence.status, doc.getState]);
  useEffect(() => {
    if (activeFormat !== 'pdf' || !workspace) return;
    setPageNumInput(String(workspace.pages.findIndex(page => page.id === workspace.activePageId) + 1));
  }, [activeFormat, workspace?.activePageId, workspace?.pages]);

  const getSnapshot = async () => {
    if (activeFormatRef.current !== 'pdf' || !await flushActiveEdit()) return null;
    const current = doc.getState();
    return current.workspace ? { workspace: current.workspace, revision: current.revision } : null;
  };
  const exporter = useExportPdf({ engine: pdf, getSnapshot, setBusy, showToast: toast.showToast });
  const openNative = async (source: Blob, beforeCommit?: (info: SourceInfo) => void, fontAssets?: DownloadedFontAsset[]) => {
    let password: string | undefined;
    for (;;) {
      try { return await pdf.open(source, password, beforeCommit, fontAssets); }
      catch (error) {
        if (!['PASSWORD_REQUIRED', 'PASSWORD_INCORRECT'].includes(errorCode(error))) throw error;
        const entered = window.prompt(errorCode(error) === 'PASSWORD_INCORRECT' ? '암호가 올바르지 않습니다. PDF 암호를 다시 입력하세요.' : '암호화된 PDF입니다. 암호를 입력하세요.');
        if (entered === null) throw new DOMException('문서 열기를 취소했습니다.', 'AbortError');
        password = entered;
      }
    }
  };
  const resetView = (nextZoom?: number) => {
    editController.current?.cancel(); editController.current = null;
    setHasUnappliedEdit(false); setActiveTool('select');
    if (nextZoom !== undefined) setZoom(nextZoom);
    setGridViewOpen(false); setExportModalOpen(false); setSelectedAction('download'); setScreen('editor');
  };
  const showSignatureNotice = (info: SourceInfo) => {
    if (info.hasSignatures) window.alert('인증서 서명이 있는 문서입니다. 수정하여 출력하면 기존 서명 검증이 유지되지 않을 수 있습니다.');
  };
  const saveCurrentDraft = async () => {
    if (!await flushActiveEdit()) throw new Error('미적용 입력을 확인한 뒤 다시 시도해 주세요.');
    if (activeFormatRef.current === 'pdf' && doc.getState().workspace) { await persistence.flushDraft(); await persistence.drain(); }
    else if (officeRef.current) { await officePersistence.flushDraft(); await officePersistence.drain(); }
  };
  const beginOpen = async (format: DocumentFormat, restoringId?: string) => {
    if (busyRef.current) return false;
    setBusy(true);
    try {
      await initialLoad.current;
      await saveCurrentDraft();
      if (format === 'pdf' && unverifiedDraftId.current && unverifiedDraftId.current !== restoringId) {
        await quarantineActiveDraft('invalid', '이전 작업의 원본 검증을 완료하기 전에 다른 PDF를 열어 백업했습니다.');
        unverifiedDraftId.current = null;
        await refreshLibrary();
      }
      return true;
    } catch (error) { setBusy(false); setUploadError(errorMessage(error)); return false; }
  };

  const prepareOffice = async (record: OfficeRecord, sequence: number, initialSaveError: string | null): Promise<WorkingOffice> => {
    const mount = document.createElement('div');
    Object.assign(mount.style, { position: 'fixed', left: '-100000px', top: '0', width: `${Math.max(320, window.innerWidth)}px`, height: `${Math.max(300, window.innerHeight - 130)}px` });
    mount.inert = true;
    document.body.appendChild(mount);
    const abort = new AbortController();
    const saveIntent = () => { if (officeRef.current?.mount === mount && !busyRef.current) setExportModalOpen(true); };
    const openRequest = (event: Event) => { if (officeRef.current?.mount === mount && !busyRef.current && (event as CustomEvent).detail instanceof File) void handleFile((event as CustomEvent<File>).detail); };
    const engineError = (event: Event) => { if (officeRef.current?.mount === mount) setUploadError(String((event as CustomEvent).detail)); };
    mount.addEventListener('office-save-intent', saveIntent);
    mount.addEventListener('office-open-request', openRequest);
    mount.addEventListener('office-error', engineError);
    const detach = () => { mount.removeEventListener('office-save-intent', saveIntent); mount.removeEventListener('office-open-request', openRequest); mount.removeEventListener('office-error', engineError); };
    const owned = { mount, abort, detach };
    candidate.current = owned;
    setCanCancelOpen(true);
    try {
      const session = await createOfficeSession({ format: record.format, mount, source: record.source, fileName: record.fileName, sessionId: randomUUID(), signal: abort.signal, checkpoint: record.checkpoint ?? undefined, initialRevision: record.revision });
      if (sequence !== openSequence.current || abort.signal.aborted) { session.dispose(); throw new DOMException('문서 열기를 취소했습니다.', 'AbortError'); }
      if (record.zoom !== session.getState().zoom) {
        const zoomed = await session.execute({ type: 'zoom', value: record.zoom });
        if (!zoomed.ok) { session.dispose(); throw new Error(zoomed.reason); }
      }
      return { session, mount, detach, record, fileName: record.fileName, initialSaveError };
    } catch (error) { abort.abort(); detach(); mount.remove(); throw error; }
    finally { if (candidate.current === owned) { candidate.current = null; setCanCancelOpen(false); } }
  };
  const commitOffice = (next: WorkingOffice) => {
    const previous = officeRef.current;
    const closePdf = activeFormatRef.current === 'pdf';
    retire.current = () => { if (previous) disposeOffice(previous); if (closePdf) pdf.close(); };
    setOffice(next); setActiveFormat(next.record.format); resetView();
  };
  const commitPdf = (next: Workspace, revision: number | null, nextZoom: number, info: SourceInfo) => {
    const previous = officeRef.current;
    if (previous) retire.current = () => disposeOffice(previous);
    setOffice(null); setActiveFormat('pdf');
    if (revision === null) doc.actions.loadDocument(next); else doc.actions.restoreState(next, revision);
    verifiedPdfId.current = next.id; unverifiedDraftId.current = null;
    resetView(nextZoom); showSignatureNotice(info);
  };
  const handleFile = async (file: File) => {
    if (busyRef.current) return;
    const sequence = ++openSequence.current;
    let format: DocumentFormat;
    try {
      const detection = await detectDocument(file);
      if (sequence !== openSequence.current) return;
      if (detection.kind !== 'supported') { setUploadError(detection.kind === 'legacy' ? LEGACY_DOCUMENT_MESSAGE : detection.message); return; }
      format = detection.format;
      if (format === 'pptx' && !window.confirm(PPTX_NOTICE)) return;
      if (detection.extensionMismatch) toast.showToast(`파일 내용은 ${format.toUpperCase()}입니다. 확장자와 관계없이 실제 형식으로 엽니다.`);
    } catch (error) { if (sequence === openSequence.current) setUploadError(errorMessage(error)); return; }
    if (!await beginOpen(format) || sequence !== openSequence.current) return;
    setUploading(true); setUploadError(null); setUploadSlowHint(false);
    const timer = setTimeout(() => setUploadSlowHint(true), 4000);
    try {
      const sourceHash = await hashSource(file);
      if (format === 'pdf') {
        const info = await openNative(file);
        if (sequence !== openSequence.current) return;
        const pages: Page[] = info.pages.map((_, sourcePageIndex) => ({ id: randomUUID(), kind: 'pdf', sourcePageIndex, originalInstance: true, label: String(sourcePageIndex + 1), rotation: 0, textEdits: [] }));
        commitPdf({ id: randomUUID(), fileName: file.name, source: file, sourceHash, pages, activePageId: pages[0].id }, null, 1, info);
      } else {
        const record: OfficeRecord = { version: 1, id: randomUUID(), format, fileName: file.name, sourceName: file.name, source: file, sourceHash, engine: OFFICE_ENGINES[format], checkpoint: null, checkpointSequence: 0, revision: 0, modified: false, zoom: 1, savedAt: Date.now(), pptxConversionAccepted: format === 'pptx' };
        let initialSaveError: string | null = null;
        try { await saveOfficeDraft(record); } catch (error) { initialSaveError = `자동 저장 불가: ${errorMessage(error)}`; }
        commitOffice(await prepareOffice(record, sequence, initialSaveError));
      }
    } catch (error) { if (sequence === openSequence.current && !(error instanceof Error && error.name === 'AbortError')) setUploadError(errorMessage(error)); }
    finally {
      clearTimeout(timer);
      if (sequence === openSequence.current) { setUploading(false); setUploadSlowHint(false); setBusy(false); }
      void refreshLibrary();
    }
  };
  const cancelOpen = () => {
    const owned = candidate.current;
    if (!owned) return;
    openSequence.current++;
    owned.abort.abort(); owned.detach(); owned.mount.remove(); candidate.current = null;
    setCanCancelOpen(false); setUploading(false); setUploadSlowHint(false); setBusy(false);
  };

  const restoreDraft = async (draft: PdfDraft, fromActive: boolean) => {
    if (!await beginOpen('pdf', draft.workspace.id)) return;
    const sequence = ++openSequence.current;
    setUploading(true); setUploadError(null);
    let invalidSource = false;
    try {
      if (fromActive) {
        const latest = await loadPdfDraft();
        if (latest.kind !== 'ready' || latest.draft.workspace.id !== draft.workspace.id) { setUploadError('선택한 PDF 작업이 변경되었습니다. 갱신된 목록에서 다시 선택해 주세요.'); return; }
        draft = latest.draft;
      }
      const restored = validateWorkspace(draft.workspace);
      if (await hashSource(restored.source) !== restored.sourceHash) { invalidSource = true; throw new Error('저장된 원본 PDF의 해시가 일치하지 않습니다.'); }
      const info = await openNative(restored.source, metadata => {
        try { checkSourceReferences(restored, metadata); }
        catch (error) { invalidSource = true; throw error; }
      }, restored.fontAssets);
      if (sequence !== openSequence.current) return;
      commitPdf(restored, draft.revision, draft.zoom, info);
      toast.showToast('이전 작업을 복구했습니다.');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      const message = errorMessage(error);
      setUploadError(message);
      if (fromActive && (invalidSource || !['PASSWORD_REQUIRED', 'PASSWORD_INCORRECT', 'TIMEOUT', 'ABORTED'].includes(errorCode(error)))) {
        try { await quarantineActiveDraft('invalid', message); unverifiedDraftId.current = null; setPdfDraft(null); }
        catch (storageError) { setUploadError(`${message} · 원본 백업 실패: ${errorMessage(storageError)}`); }
      }
    } finally { if (sequence === openSequence.current) { setUploading(false); setBusy(false); } void refreshLibrary(); }
  };
  const restoreOffice = async (record: OfficeRecord, archive: boolean) => {
    if (!await beginOpen(record.format)) return;
    const sequence = ++openSequence.current;
    setUploading(true); setUploadError(null); setUploadSlowHint(false);
    const timer = setTimeout(() => setUploadSlowHint(true), 4000);
    try {
      const working = archive ? { ...record, id: randomUUID(), checkpointSequence: 0, savedAt: Date.now() } : await loadOfficeDraft(record.id);
      if (!working) { setUploadError('선택한 작업이 변경되었습니다. 갱신된 목록에서 다시 선택해 주세요.'); return; }
      let initialSaveError: string | null = null;
      if (archive) try { await saveOfficeDraft(working); } catch (error) { initialSaveError = `작업 사본 자동 저장 불가: ${errorMessage(error)}`; }
      commitOffice(await prepareOffice(working, sequence, initialSaveError));
      toast.showToast(archive ? '보관 문서의 새 작업 사본을 열었습니다.' : '이전 작업을 복구했습니다.');
    } catch (error) { if (sequence === openSequence.current && !(error instanceof Error && error.name === 'AbortError')) setUploadError(errorMessage(error)); }
    finally { clearTimeout(timer); if (sequence === openSequence.current) { setUploading(false); setUploadSlowHint(false); setBusy(false); } void refreshLibrary(); }
  };

  const bodyAllowed = useCallback(() => {
    if (activeFormatRef.current !== 'pdf' || (busyRef.current && !flushingRef.current)) return false;
    if (!pdf.info?.canEdit) { toast.showToast('이 PDF는 본문 및 요소 편집 권한이 없습니다.'); return false; }
    return true;
  }, [pdf.info, toast.showToast]);
  const guardedActions: DocumentActions = useMemo(() => ({
    ...doc.actions,
    upsertTextEdit: (...args) => { if (bodyAllowed()) doc.actions.upsertTextEdit(...args); },
    removeTextEdit: (...args) => { if (bodyAllowed()) doc.actions.removeTextEdit(...args); },
    undo: () => { if (activeFormatRef.current === 'pdf' && !busyRef.current) { editController.current?.cancel(); doc.actions.undo(); } },
    redo: () => { if (activeFormatRef.current === 'pdf' && !busyRef.current) { editController.current?.cancel(); doc.actions.redo(); } },
  }), [doc.actions, bodyAllowed, pdf.info]);
  const navigate = async (id: string) => { if (busyRef.current || !await flushActiveEdit()) return; doc.actions.setActivePage(id); };
  const structureAction = async (operation: (current: Workspace) => void) => {
    if (busyRef.current || activeFormatRef.current !== 'pdf') return;
    if (!pdf.info?.canAssemble) { toast.showToast('이 PDF는 페이지 구조 변경 권한이 없습니다.'); return; }
    if (!await flushActiveEdit()) return;
    const current = doc.getState().workspace;
    if (current) operation(current);
  };
  const duplicatePage = (id: string) => void structureAction(current => {
    const page = current.pages.find(item => item.id === id);
    if (!page) return;
    if (page.kind === 'pdf') { const capability = pdf.info!.pages[page.sourcePageIndex].duplicate; if (!capability.allowed) { toast.showToast(capability.reason); return; } }
    doc.actions.duplicatePage(id, randomUUID()); toast.showToast('페이지를 복제했습니다. 복제본은 원본 태그 구조에 포함되지 않습니다.');
  });
  const addPage = () => void structureAction(current => {
    const active = current.pages.find(page => page.id === current.activePageId)!;
    const bounds = active.kind === 'pdf' ? pdf.info!.pages[active.sourcePageIndex].bounds : [0, 0, active.widthPt, active.heightPt];
    doc.actions.addPage({ kind: 'blank', id: randomUUID(), label: String(current.pages.length + 1), rotation: 0, widthPt: bounds[2] - bounds[0], heightPt: bounds[3] - bounds[1] });
  });
  const deletePage = (id: string) => void structureAction(current => { if (current.pages.length > 1 && window.confirm('이 페이지를 삭제할까요?')) doc.actions.deletePage(id); });
  const rotatePage = (id: string, delta: number) => void structureAction(() => doc.actions.rotatePage(id, delta));
  const reorderPages = (from: string, to: string) => void structureAction(() => doc.actions.reorderPages(from, to));

  const saveToArchive = async () => {
    if (busyRef.current) return;
    if (activeFormatRef.current !== 'pdf' && !officeRef.current?.session.getState().canSaveModified) throw new Error('보호된 문서는 보존 원본만 다운로드할 수 있습니다.');
    setBusy(true);
    try {
      if (activeFormatRef.current === 'pdf') {
        const snapshot = await getSnapshot();
        if (!snapshot) throw new Error('미적용 입력을 확인해 주세요.');
        await savePdfArchive({ version: PDF_DRAFT_VERSION, id: snapshot.workspace.id, workspace: snapshot.workspace, revision: snapshot.revision, zoom, savedAt: Date.now() });
      } else {
        await saveCurrentDraft();
        const current = officeRef.current;
        if (!current) throw new Error('활성 문서가 없습니다.');
        await saveOfficeArchive({ ...current.record, savedAt: Date.now() });
      }
      toast.showToast('보관함에 저장되었습니다'); setExportModalOpen(false); await refreshLibrary();
    } finally { setBusy(false); }
  };
  const downloadOffice = async () => {
    const current = officeRef.current;
    if (!current || busyRef.current) return;
    if (!current.session.getState().canSaveModified) throw new Error('보호된 문서는 보존 원본만 다운로드할 수 있습니다.');
    setBusy(true);
    try {
      if (!await current.session.flush()) throw new Error('문서 입력을 확정하지 못했습니다.');
      const modified = current.record.modified || current.session.getState().revision > current.record.revision;
      const serialized = modified ? await current.session.serialize() : { bytes: current.record.source, warnings: [] };
      if (serialized.warnings.length && !window.confirm(`수정본 저장 시 다음 사항을 확인해 주세요.\n\n${serialized.warnings.join('\n')}\n\n이 수정본을 다운로드할까요? 원본은 그대로 보존됩니다.`)) return;
      downloadBlob(serialized.bytes, modifiedFileName(current.fileName, current.record.format)); setExportModalOpen(false);
    } finally { setBusy(false); }
  };
  const recoverOffice = async () => {
    const current = officeRef.current;
    if (!current || !window.confirm('편집 엔진을 종료하고 작업 목록으로 이동할까요?\n마지막 저장 이후 변경과 작성 중인 입력은 복구할 수 없을 수 있습니다. 보존 원본과 마지막 저장 작업은 유지됩니다.\n필요하면 취소한 뒤 먼저 복구 자료를 다운로드하세요.')) return;
    current.session.dispose();
    try { await officePersistence.drain(); } catch { /* Keep the last successful checkpoint. */ }
    const latest = officeRef.current;
    if (latest?.session !== current.session) return;
    disposeOffice(latest);
    setOffice(null); setActiveFormat(null); setBusy(false);
    setExportModalOpen(false); setGridViewOpen(false); setScreen('upload');
    setUploadError('편집 엔진을 종료했습니다. 마지막 저장 작업을 복구하거나 보존 원본을 다시 열어 주세요. 저장 이후 변경은 포함되지 않을 수 있습니다.');
    await refreshLibrary();
  };
  const goToUpload = async () => {
    if (busyRef.current) return;
    setBusy(true);
    try { await saveCurrentDraft(); setScreen('upload'); setGridViewOpen(false); await refreshLibrary(); }
    catch (error) { toast.showToast(`저장 실패: ${errorMessage(error)}`); }
    finally { setBusy(false); }
  };
  const retrySave = async () => {
    if (busyRef.current) return;
    try { await saveCurrentDraft(); } catch (error) { toast.showToast(`저장 실패: ${errorMessage(error)}`); }
  };
  const libraryAction = async (action: () => Promise<void>) => {
    if (busyRef.current || libraryBusyRef.current) return;
    libraryBusyRef.current = true; setLibraryBusy(true);
    try { await action(); }
    catch (error) { setUploadError(errorMessage(error)); }
    finally { libraryBusyRef.current = false; setLibraryBusy(false); await refreshLibrary(); }
  };
  const openLibrary = async (key: LibraryKey) => {
    if (key.kind === 'retained') return;
    if (key.namespace === 'pdf') {
      const loaded = key.kind === 'draft' ? await loadPdfDraft() : null;
      const record = key.kind === 'draft' ? loaded?.kind === 'ready' ? loaded.draft : null : await loadPdfArchive(key.id);
      if (record) await restoreDraft(record, key.kind === 'draft'); else setUploadError('복구할 수 없는 기록은 이전 작업 백업에서 확인해 주세요.');
    } else {
      const record = key.kind === 'draft' ? await loadOfficeDraft(key.id) : await loadOfficeArchive(key.id);
      if (record) await restoreOffice(record, key.kind === 'archive'); else setUploadError('복구할 수 없는 기록은 이전 작업 백업에서 원본을 다시 열거나 다운로드할 수 있습니다.');
    }
  };
  const downloadLibraryOriginal = async (key: LibraryKey) => {
    if (key.namespace !== 'office' || key.kind === 'retained') return;
    const record = key.kind === 'draft' ? await loadOfficeDraft(key.id) : await loadOfficeArchive(key.id);
    if (!record) throw new Error('보존 원본을 찾을 수 없습니다. 이전 작업 백업을 확인해 주세요.');
    downloadBlob(record.source, record.sourceName);
  };
  const deleteLibrary = async (key: LibraryKey) => {
    if (key.kind === 'draft' || !window.confirm(key.kind === 'archive' ? '이 보관 문서를 삭제할까요? 현재 초안은 유지됩니다.' : '이 이전 작업 백업을 영구 삭제할까요?')) return;
    if (key.namespace === 'pdf') { if (key.kind === 'retained') await deleteRetainedDraft(key.id); else await deletePdfArchive(key.id); }
    else { if (key.kind === 'retained') await deleteOfficeRetained(key.id); else await deleteOfficeArchive(key.id); }
  };
  const retainedRaw = async (key: LibraryKey) => key.kind !== 'retained' ? null : key.namespace === 'pdf' ? loadRetainedDraft(key.id) : loadOfficeRetained(key.id);
  const reopenOriginal = async (key: LibraryKey) => {
    const raw = await retainedRaw(key);
    if (!raw || typeof raw !== 'object') throw new Error('이 백업에는 다시 열 수 있는 원본이 없습니다.');
    const value = raw as { source?: unknown; sourceName?: unknown; fileName?: unknown; workspace?: { source?: unknown; fileName?: unknown } };
    const source = key.namespace === 'office' ? value.source : value.workspace?.source;
    const name = key.namespace === 'office' ? value.sourceName : value.workspace?.fileName;
    if (!(source instanceof Blob)) throw new Error('이 백업에는 원본 바이트가 없습니다. 백업 JSON을 다운로드해 주세요.');
    await handleFile(new File([source], typeof name === 'string' ? name : '문서', { type: source.type }));
  };

  const drafts: LibraryItem[] = [
    ...(pdfDraft ? [{ key: { namespace: 'pdf', kind: 'draft', id: pdfDraft.workspace.id } as const, fileName: pdfDraft.workspace.fileName, format: 'pdf' as const, savedAt: pdfDraft.savedAt, pageCount: pdfDraft.workspace.pages.length }] : []),
    ...officeDrafts.map(item => ({ ...item, key: { namespace: 'office', kind: 'draft', id: item.id } as const })),
  ].sort((a, b) => b.savedAt - a.savedAt);
  const archives: LibraryItem[] = [
    ...pdfArchives.map(item => ({ ...item, format: 'pdf' as const, key: { namespace: 'pdf', kind: 'archive', id: item.id } as const })),
    ...officeArchives.map(item => ({ ...item, key: { namespace: 'office', kind: 'archive', id: item.id } as const })),
  ].sort((a, b) => b.savedAt - a.savedAt);
  const retainedDrafts: LibraryItem[] = [
    ...pdfRetained.map(item => ({ ...item, fileName: 'PDF 이전 작업', key: { namespace: 'pdf', kind: 'retained', id: item.id } as const })),
    ...officeRetained.map(item => ({ ...item, fileName: 'Office 이전 작업', key: { namespace: 'office', kind: 'retained', id: item.id } as const })),
  ].sort((a, b) => b.savedAt - a.savedAt);
  const exportActions: ExportAction[] = activeFormat === 'pdf' ? [
    { id: 'download', label: 'PDF 다운로드', run: async () => { if (!busyRef.current) await exporter.downloadNow(); } },
    { id: 'archive', label: '보관함에 저장', run: saveToArchive },
  ] : office ? [
    ...(office.session.getState().canSaveModified ? [
      { id: 'download' as const, label: `${office.record.format.toUpperCase()} 수정본 다운로드`, run: downloadOffice },
      { id: 'archive' as const, label: '보관함에 저장', run: saveToArchive },
    ] : []),
    { id: 'original', label: '보존 원본 다운로드', run: async () => { const current = officeRef.current; if (current) downloadBlob(current.record.source, current.record.sourceName); } },
  ] : [];

  return (
    <div className="pdf-editor-root" style={{ display: 'flex', flexDirection: 'column' }}>
      {screen === 'upload' && <header style={{ height: 60, flex: 'none', background: SURFACE, borderBottom: `1px solid ${BORDER_SOFT}`, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px' }}>
        <span className="pdfe-brand" style={{ fontSize: 17, fontWeight: 500, color: TEXT, whiteSpace: 'nowrap' }}>문서 편집</span>
        {activeFormat && <button style={{ marginLeft: 'auto', minHeight: 32, border: `1px solid ${BORDER_STRONG}`, background: 'var(--pdfe-button-bg, var(--pdfe-surface))', color: TEXT, padding: '6px 12px', fontSize: 13 }} disabled={busy} onClick={() => { setUploadError(null); setScreen('editor'); }}>편집기로 돌아가기</button>}
      </header>}
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {screen === 'upload' && <UploadScreen fileName={activeFormat === 'pdf' ? workspace?.fileName ?? '' : office?.fileName ?? ''} dragOver={dragOver} uploading={uploading || busy || libraryBusy}
          uploadSlowHint={uploadSlowHint} uploadError={[uploadError, libraryError].filter(Boolean).join(' · ') || null} onDragOverChange={setDragOver} onFile={file => void handleFile(file)}
          drafts={drafts} archives={archives} retainedDrafts={retainedDrafts}
          onOpen={key => void libraryAction(() => openLibrary(key))} onDelete={key => void libraryAction(() => deleteLibrary(key))}
          onDownloadOriginal={key => void libraryAction(() => downloadLibraryOriginal(key))}
          onDownloadRetained={key => void libraryAction(async () => { const raw = await retainedRaw(key); if (raw !== null) downloadBlob(new Blob([await serializeRetainedBackup(raw)], { type: 'application/json' }), `이전작업_${key.namespace}_${key.id}.json`); })}
          onOpenRetainedOriginal={key => void libraryAction(() => reopenOriginal(key))}
        />}
        {screen === 'editor' && activeFormat === 'pdf' && workspace && <EditorScreen workspace={workspace} revision={doc.state.revision} engine={pdf}
          docActions={guardedActions} getDocumentState={doc.getState} canUndo={doc.state.history.undo.length > 0} canRedo={doc.state.history.redo.length > 0}
          onFileNameChange={name => { if (!busyRef.current) doc.actions.setFileName(name); }} pageNumInput={pageNumInput} setPageNumInput={setPageNumInput}
          goToPageIndex={index => { const page = doc.getState().workspace?.pages[index]; if (page) void navigate(page.id); }} zoom={zoom} setZoom={setZoom}
          isExporting={busy} showToast={toast.showToast} goToUpload={() => void goToUpload()} goExport={() => setExportModalOpen(true)}
          onOpenGridView={() => { if (!busyRef.current) void flushActiveEdit().then(ok => { if (ok) setGridViewOpen(true); }); }}
          onDuplicatePage={duplicatePage} onRotatePage={rotatePage} onDeletePage={deletePage} onAddPage={addPage} onReorderPages={reorderPages}
          onThumbClick={id => void navigate(id)} activeTool={activeTool} setActiveTool={setActiveTool}
          saveStatus={persistence.status} saveError={persistence.error} onRetrySave={() => void retrySave()}
          hasUnappliedEdit={hasUnappliedEdit} onUnappliedEditChange={setHasUnappliedEdit} registerEditController={registerEditController}
        />}
        {screen === 'editor' && activeFormat !== 'pdf' && office && <OfficeEditorScreen session={office.session} mount={office.mount} fileName={office.fileName} format={office.record.format} busy={busy}
          saveLabel={saveLabels[officePersistence.status]} saveError={officePersistence.error} onRetrySave={() => void retrySave()}
          onFileNameChange={name => { const current = officeRef.current; if (current && !busyRef.current) setOffice({ ...current, fileName: name }); }}
          onHome={() => void goToUpload()} onExport={() => setExportModalOpen(true)} onError={toast.showToast}
        />}
        {screen === 'editor' && activeFormat !== 'pdf' && office && <div style={{ padding: '6px 20px', background: SURFACE, zIndex: 100 }}>
          <details><summary>편집기 응답이 없나요? 원본 및 작업 복구</summary>
            <p>큰 문서 저장이나 입력 처리 중이면 기다려 주세요. 강제 종료 시 마지막 저장 이후 변경과 작성 중인 입력은 유실될 수 있습니다.</p>
            <button onClick={() => downloadBlob(office.record.source, office.record.sourceName)}>보존 원본 다운로드</button>
            <button onClick={() => void serializeRetainedBackup(office.record).then(data => downloadBlob(new Blob([data], { type: 'application/json' }), `${office.record.id}_복구자료.json`)).catch(error => toast.showToast(errorMessage(error)))}>마지막 저장 복구 자료 다운로드</button>
            <button onClick={() => void recoverOffice()}>엔진 종료 후 작업 목록으로</button>
          </details>
        </div>}
        {screen === 'editor' && uploadError && <div role="alert" style={{ padding: 10, background: SURFACE, color: DANGER, zIndex: 12 }}>{uploadError}</div>}
      </main>
      <ExportModal open={exportModalOpen} actions={exportActions} selectedAction={exportActions.some(action => action.id === selectedAction) ? selectedAction : 'original'} onSelectedActionChange={setSelectedAction} isExporting={busy} onClose={() => { if (!busyRef.current) setExportModalOpen(false); }} />
      {activeFormat === 'pdf' && screen === 'editor' && gridViewOpen && workspace && <GridView pages={workspace.pages} activePageId={workspace.activePageId} engine={pdf} revision={doc.state.revision} disabled={busy}
        onClose={() => setGridViewOpen(false)} onOpenPage={id => { void navigate(id).then(() => setGridViewOpen(false)); }} onAddPage={addPage}
        onRotatePage={rotatePage} onDuplicatePage={duplicatePage} onDeletePage={deletePage} />}
      {uploading && <div role="status" style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 90, background: SURFACE, color: TEXT, border: `1px solid ${BORDER_STRONG}`, padding: 12 }}>
        {uploadSlowHint ? '엔진 응답을 기다리고 있습니다.' : '문서를 여는 중입니다.'}
        {canCancelOpen && <button onClick={cancelOpen} style={{ marginLeft: 12 }}>취소하고 이전 문서로 돌아가기</button>}
      </div>}
      {pdf.error && activeFormat === 'pdf' && screen === 'editor' && <div role="alert" style={{ padding: 10, background: SURFACE, color: DANGER, fontSize: 13 }}>
        {pdf.error} <button disabled={busy} onClick={() => void pdf.retry().catch(error => toast.showToast(errorMessage(error)))}>다시 시도</button>
      </div>}
      <Toast message={toast.message} /><ExportProgressOverlay progress={exportProgress} />
    </div>
  );
}
