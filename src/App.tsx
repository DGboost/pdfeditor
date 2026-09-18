import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DownloadedFontAsset, EditController, ExportSettings, Page, Screen, Tool, Workspace } from './types/pdfEditor';
import type { SourceInfo } from './pdf/engineTypes';
import { useDocumentReducer } from './hooks/useDocumentReducer';
import type { DocumentActions } from './hooks/useDocumentReducer';
import { useToast } from './hooks/useToast';
import { usePdfDocument } from './hooks/usePdfDocument';
import { useExportPdf } from './hooks/useExportPdf';
import { useDraftPersistence } from './hooks/useDraftPersistence';
import { UploadScreen } from './components/screens/UploadScreen';
import { EditorScreen } from './components/screens/EditorScreen/EditorScreen';
import { ExportModal } from './components/ExportModal';
import { GridView } from './components/screens/EditorScreen/GridView';
import { Toast } from './components/Toast';
import { ExportProgressOverlay } from './components/ExportProgressOverlay';
import { loadPdfDraft, savePdfArchive, listPdfArchives, loadPdfArchive, deletePdfArchive, listRetainedDrafts, loadRetainedDraft, deleteRetainedDraft, quarantineActiveDraft, serializeRetainedBackup, validateWorkspace, PDF_DRAFT_VERSION } from './utils/db';
import type { ArchiveSummary, PdfDraft, RetainedDraftSummary } from './utils/db';
import { randomUUID, sha256Hex } from './utils/crypto';
import { SURFACE, TEXT, TEXT_MUTED, BORDER_SOFT, BORDER_STRONG, DANGER, PANEL_SHADOW, solidAccentBtn } from './styles/theme';
import './styles/global.css';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
async function hashSource(source: Blob): Promise<string> {
  return sha256Hex(new Uint8Array(await source.arrayBuffer()));
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
function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadSlowHint, setUploadSlowHint] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pageNumInput, setPageNumInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [gridViewOpen, setGridViewOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const flushingRef = useRef(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({ format: 'pdf' });
  const [draftToRestore, setDraftToRestore] = useState<PdfDraft | null>(null);
  const initialLoad = useRef<Promise<void>>(Promise.resolve());
  const unverifiedDraftId = useRef<string | null>(null);
  const libraryBusy = useRef(false);
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const [retainedDrafts, setRetainedDrafts] = useState<RetainedDraftSummary[]>([]);
  const [hasUnappliedEdit, setHasUnappliedEdit] = useState(false);
  const editController = useRef<EditController | null>(null);
  const openSequence = useRef(0);
  const doc = useDocumentReducer();
  const toast = useToast();
  const pdf = usePdfDocument({ onProgress: (current, total) => setExportProgress({ current, total }) });
  const persistence = useDraftPersistence({ state: doc.state, getState: doc.getState, zoom, enabled: screen === 'editor' });
  const workspace = doc.state.workspace;
  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
    if (!value) setExportProgress(null);
  }, []);
  const registerEditController = useCallback((controller: EditController | null) => { editController.current = controller; }, []);
  const flushActiveEdit = useCallback(async () => {
    flushingRef.current = true;
    try { return await (editController.current?.flush() ?? Promise.resolve(true)); }
    finally { flushingRef.current = false; }
  }, []);

  const refreshLibrary = useCallback(async () => {
    const saved = await listPdfArchives();
    const retained = await listRetainedDrafts();
    setArchives(saved); setRetainedDrafts(retained);
  }, []);

  useEffect(() => {
    let mounted = true;
    initialLoad.current = (async () => {
      try {
        const loaded = await loadPdfDraft();
        if (!mounted) return;
        if (loaded.kind === 'ready') {
          const validHash = await hashSource(loaded.draft.workspace.source) === loaded.draft.workspace.sourceHash;
          if (!mounted) return;
          if (validHash) {
            unverifiedDraftId.current = loaded.draft.workspace.id;
            setDraftToRestore(loaded.draft);
          }
          else {
            await quarantineActiveDraft('invalid', '저장된 원본 PDF의 해시가 일치하지 않습니다.');
            setUploadError('원본 PDF의 해시가 일치하지 않아 이전 작업 백업에 보존했습니다.');
          }
        }
        else if (loaded.kind === 'legacy') setUploadError('구버전 작업은 원본 PDF가 없어 자동 복원할 수 없습니다. 이전 작업 백업에서 다운로드할 수 있습니다.');
        else if (loaded.kind === 'invalid') setUploadError(`${loaded.message} 이전 작업 백업에 보존했습니다.`);
        await refreshLibrary();
      } catch (error) { if (mounted) setUploadError(`기기 저장소를 열 수 없습니다: ${errorMessage(error)}. PDF 열기와 다운로드는 사용할 수 있습니다.`); }
    })();
    return () => { mounted = false; };
  }, [refreshLibrary]);

  useEffect(() => {
    const changed = hasUnappliedEdit || (screen === 'editor' && workspace !== null && persistence.status !== 'saved');
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnappliedEdit, persistence.status, screen, workspace]);

  useEffect(() => {
    if (!workspace) return;
    setPageNumInput(String(workspace.pages.findIndex(page => page.id === workspace.activePageId) + 1));
  }, [workspace?.activePageId, workspace?.pages]);

  const getSnapshot = async () => {
    if (!await flushActiveEdit()) return null;
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

  const resetView = (nextZoom: number) => {
    editController.current?.cancel(); editController.current = null;
    setHasUnappliedEdit(false); setActiveTool('select'); setZoom(nextZoom);
    setGridViewOpen(false); setExportModalOpen(false); setScreen('editor'); setDraftToRestore(null);
  };
  const showSignatureNotice = (info: SourceInfo) => {
    if (info.hasSignatures) window.alert('인증서 서명이 있는 문서입니다. 수정하여 출력하면 기존 서명 검증이 유지되지 않을 수 있습니다.');
  };
  const beginOpen = async (restoringId?: string) => {
    if (busyRef.current) return false;
    setBusy(true);
    await initialLoad.current;
    if (!await flushActiveEdit()) { setBusy(false); return false; }
    try {
      await persistence.drain();
      if (unverifiedDraftId.current && unverifiedDraftId.current !== restoringId) {
        await quarantineActiveDraft('invalid', '이전 작업의 원본 검증을 완료하기 전에 다른 문서를 열어 백업했습니다.');
        unverifiedDraftId.current = null;
        await refreshLibrary();
      }
    } catch (error) { setBusy(false); toast.showToast(errorMessage(error)); return false; }
    return true;
  };
  const handleFile = async (file: File) => {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { setUploadError('PDF 파일만 업로드할 수 있습니다.'); return; }
    if (!await beginOpen()) return;
    const sequence = ++openSequence.current;
    setUploading(true); setUploadError(null); setUploadSlowHint(false);
    const timer = setTimeout(() => setUploadSlowHint(true), 4000);
    let opened = false;
    try {
      const sourceHash = await hashSource(file);
      const info = await openNative(file);
      if (sequence !== openSequence.current) return;
      const pages: Page[] = info.pages.map((_, sourcePageIndex) => ({
        id: randomUUID(), kind: 'pdf', sourcePageIndex, originalInstance: true,
        label: String(sourcePageIndex + 1), rotation: 0, textEdits: [],
      }));
      const next: Workspace = { id: randomUUID(), fileName: file.name, source: file, sourceHash, pages, activePageId: pages[0].id };
      doc.actions.loadDocument(next); resetView(1); showSignatureNotice(info);
      opened = true;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setUploadError(errorMessage(error));
    } finally {
      clearTimeout(timer); setUploading(false); setUploadSlowHint(false);
      if (!opened && doc.getState().workspace) await persistence.retry().catch(error => toast.showToast(`저장 실패: ${errorMessage(error)}`));
      setBusy(false);
    }
  };

  const restoreDraft = async (draft: PdfDraft, fromActive: boolean) => {
    if (!await beginOpen(draft.workspace.id)) return;
    setUploading(true); setUploadError(null);
    let invalidSource = false;
    let opened = false;
    try {
      const restored = validateWorkspace(draft.workspace);
      if (await hashSource(restored.source) !== restored.sourceHash) { invalidSource = true; throw new Error('저장된 원본 PDF의 해시가 일치하지 않습니다.'); }
      const info = await openNative(restored.source, metadata => {
        try { checkSourceReferences(restored, metadata); }
        catch (error) { invalidSource = true; throw error; }
      }, restored.fontAssets);
      doc.actions.restoreState(restored, draft.revision);
      unverifiedDraftId.current = null;
      resetView(draft.zoom); showSignatureNotice(info); toast.showToast('이전 작업을 복구했습니다.');
      opened = true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = errorMessage(error);
      setUploadError(message);
      if (fromActive && (invalidSource || !['PASSWORD_REQUIRED', 'PASSWORD_INCORRECT', 'TIMEOUT', 'ABORTED'].includes(errorCode(error)))) {
        try { await quarantineActiveDraft('invalid', message); unverifiedDraftId.current = null; setDraftToRestore(null); await refreshLibrary(); }
        catch (storageError) { setUploadError(`${message} · 원본 백업 실패: ${errorMessage(storageError)}`); }
      }
    } finally {
      setUploading(false);
      if (!opened && doc.getState().workspace) await persistence.retry().catch(error => toast.showToast(`저장 실패: ${errorMessage(error)}`));
      setBusy(false);
    }
  };

  const bodyAllowed = useCallback(() => {
    if (busyRef.current && !flushingRef.current) return false;
    if (!pdf.info?.canEdit) { toast.showToast('이 PDF는 본문 및 요소 편집 권한이 없습니다.'); return false; }
    return true;
  }, [pdf.info, toast.showToast]);
  const guardedActions: DocumentActions = useMemo(() => ({
    ...doc.actions,
    upsertTextEdit: (...args) => { if (bodyAllowed()) doc.actions.upsertTextEdit(...args); },
    removeTextEdit: (...args) => { if (bodyAllowed()) doc.actions.removeTextEdit(...args); },
    undo: () => { if (!busyRef.current) { editController.current?.cancel(); doc.actions.undo(); } },
    redo: () => { if (!busyRef.current) { editController.current?.cancel(); doc.actions.redo(); } },
  }), [doc.actions, bodyAllowed, pdf.info]);

  const navigate = async (id: string) => {
    if (busyRef.current || !await flushActiveEdit()) return;
    doc.actions.setActivePage(id);
  };
  const structureAction = async (operation: (current: Workspace) => void) => {
    if (busyRef.current) return;
    if (!pdf.info?.canAssemble) { toast.showToast('이 PDF는 페이지 구조 변경 권한이 없습니다.'); return; }
    if (!await flushActiveEdit()) return;
    const current = doc.getState().workspace;
    if (current) operation(current);
  };
  const duplicatePage = (id: string) => void structureAction(current => {
    const page = current.pages.find(item => item.id === id);
    if (!page) return;
    if (page.kind === 'pdf') {
      const capability = pdf.info!.pages[page.sourcePageIndex].duplicate;
      if (!capability.allowed) { toast.showToast(capability.reason); return; }
    }
    doc.actions.duplicatePage(id, randomUUID());
    toast.showToast('페이지를 복제했습니다. 복제본은 원본 태그 구조에 포함되지 않습니다.');
  });
  const addPage = () => void structureAction(current => {
    const active = current.pages.find(page => page.id === current.activePageId)!;
    const bounds = active.kind === 'pdf' ? pdf.info!.pages[active.sourcePageIndex].bounds : [0, 0, active.widthPt, active.heightPt];
    doc.actions.addPage({ kind: 'blank', id: randomUUID(), label: String(current.pages.length + 1), rotation: 0,
      widthPt: bounds[2] - bounds[0], heightPt: bounds[3] - bounds[1] });
  });
  const deletePage = (id: string) => void structureAction(current => {
    if (current.pages.length > 1 && window.confirm('이 페이지를 삭제할까요?')) doc.actions.deletePage(id);
  });
  const rotatePage = (id: string, delta: number) => void structureAction(() => doc.actions.rotatePage(id, delta));
  const reorderPages = (from: string, to: string) => void structureAction(() => doc.actions.reorderPages(from, to));

  const saveToArchive = async () => {
    if (busyRef.current) return;
    setBusy(true);
    try {
      const snapshot = await getSnapshot();
      if (!snapshot) return;
      await savePdfArchive({ version: PDF_DRAFT_VERSION, id: snapshot.workspace.id, workspace: snapshot.workspace, revision: snapshot.revision, zoom, savedAt: Date.now() });
      toast.showToast('보관함에 저장되었습니다'); setExportModalOpen(false);
      await refreshLibrary().catch(error => setUploadError(`보관함 목록 갱신 실패: ${errorMessage(error)}`));
    } catch (error) { toast.showToast(`보관함 저장 실패: ${errorMessage(error)}`); }
    finally { setBusy(false); }
  };
  const goToUpload = async () => {
    if (busyRef.current) return;
    setBusy(true);
    try {
      if (!await flushActiveEdit()) return;
      await persistence.flushDraft();
      setScreen('upload'); setGridViewOpen(false);
      await refreshLibrary().catch(error => setUploadError(`저장은 완료되었습니다. 목록을 읽을 수 없습니다: ${errorMessage(error)}`));
    } catch (error) { toast.showToast(`저장 실패: ${errorMessage(error)}`); }
    finally { setBusy(false); }
  };
  const libraryAction = async (action: () => Promise<void>) => {
    if (busyRef.current || libraryBusy.current) return;
    libraryBusy.current = true;
    try { await action(); }
    catch (error) { setUploadError(errorMessage(error)); }
    finally { libraryBusy.current = false; }
  };

  return (
    <div className="pdf-editor-root" style={{ display: 'flex', flexDirection: 'column' }}>
      {screen === 'upload' && <header style={{ height: 60, flex: 'none', background: SURFACE, borderBottom: `1px solid ${BORDER_SOFT}`, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px' }}>
        <span className="pdfe-brand" style={{ fontSize: 17, fontWeight: 500, color: TEXT, whiteSpace: 'nowrap' }}>PDF 편집</span>
        {workspace && <button style={{ marginLeft: 'auto', minHeight: 32, border: `1px solid ${BORDER_STRONG}`, background: 'var(--pdfe-button-bg, var(--pdfe-surface))', color: TEXT, borderRadius: 999, padding: '6px 12px', fontSize: 13 }} disabled={busy} onClick={() => setScreen('editor')}>편집기로 돌아가기</button>}
      </header>}
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {screen === 'upload' && <UploadScreen fileName={workspace?.fileName ?? ''} dragOver={dragOver} uploading={uploading}
          uploadSlowHint={uploadSlowHint} uploadError={uploadError} onDragOverChange={setDragOver} onFile={file => void handleFile(file)}
          archives={archives} retainedDrafts={retainedDrafts}
          onOpenArchive={id => void libraryAction(async () => { try { const archive = await loadPdfArchive(id); if (archive) await restoreDraft(archive, false); } finally { await refreshLibrary(); } })}
          onDeleteArchive={id => void libraryAction(async () => { if (window.confirm('이 보관함 문서를 삭제할까요? 현재 초안은 유지됩니다.')) { await deletePdfArchive(id); await refreshLibrary(); } })}
          onDownloadRetained={id => void libraryAction(async () => { const raw = await loadRetainedDraft(id); if (raw !== null) downloadBlob(new Blob([await serializeRetainedBackup(raw)], { type: 'application/json' }), `이전작업_${id}.json`); })}
          onDeleteRetained={id => void libraryAction(async () => { if (window.confirm('이 이전 작업 백업을 영구 삭제할까요?')) { await deleteRetainedDraft(id); await refreshLibrary(); } })}
        />}
        {screen === 'editor' && workspace && <EditorScreen workspace={workspace} revision={doc.state.revision} engine={pdf}
          docActions={guardedActions} getDocumentState={doc.getState} canUndo={doc.state.history.undo.length > 0} canRedo={doc.state.history.redo.length > 0}
          onFileNameChange={name => { if (!busyRef.current) doc.actions.setFileName(name); }} pageNumInput={pageNumInput} setPageNumInput={setPageNumInput}
          goToPageIndex={index => { const page = doc.getState().workspace?.pages[index]; if (page) void navigate(page.id); }} zoom={zoom} setZoom={setZoom}
          isExporting={busy} showToast={toast.showToast} goToUpload={() => void goToUpload()} goExport={() => setExportModalOpen(true)}
          onOpenGridView={() => { if (!busyRef.current) void flushActiveEdit().then(ok => { if (ok) setGridViewOpen(true); }); }}
          onDuplicatePage={duplicatePage} onRotatePage={rotatePage} onDeletePage={deletePage} onAddPage={addPage} onReorderPages={reorderPages}
          onThumbClick={id => void navigate(id)} activeTool={activeTool} setActiveTool={setActiveTool}
          saveStatus={persistence.status} onRetrySave={() => void persistence.retry().catch(error => toast.showToast(errorMessage(error)))}
          hasUnappliedEdit={hasUnappliedEdit} onUnappliedEditChange={setHasUnappliedEdit} registerEditController={registerEditController}
        />}
      </main>
      <ExportModal open={exportModalOpen} exportSettings={exportSettings} setExportSettings={setExportSettings} isExporting={busy}
        onClose={() => { if (!busyRef.current) setExportModalOpen(false); }} onDownload={() => { if (!busyRef.current) void exporter.downloadNow(); }} onSaveToArchive={() => void saveToArchive()} />
      {gridViewOpen && workspace && <GridView pages={workspace.pages} activePageId={workspace.activePageId} engine={pdf} revision={doc.state.revision} disabled={busy}
        onClose={() => setGridViewOpen(false)} onOpenPage={id => { void navigate(id).then(() => setGridViewOpen(false)); }} onAddPage={addPage}
        onRotatePage={rotatePage} onDuplicatePage={duplicatePage} onDeletePage={deletePage} />}
      {draftToRestore && screen === 'upload' && <div role="dialog" aria-modal="true" aria-label="이전 작업 복구" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80, padding: 20 }}>
        <div className="pdfe-panel-enter" style={{ background: SURFACE, border: `1px solid ${BORDER_SOFT}`, borderRadius: 24, padding: 20, maxWidth: 420, maxHeight: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: PANEL_SHADOW }}>
          <h3 style={{ color: TEXT, fontSize: 17, fontWeight: 500, flexShrink: 0, margin: '0 0 20px' }}>이전 작업 복구</h3>
          <div className="pdfe-scroll" style={{ minHeight: 0, overflowY: 'auto' }}>
          <p style={{ color: TEXT_MUTED, fontSize: 14, lineHeight: 1.6 }}>이 기기에 저장된 작업을 이어서 편집할까요?</p>
          {uploadError && <p role="alert" style={{ color: DANGER, fontSize: 13 }}>{uploadError}</p>}
          </div>
          <div style={{ display: 'flex', flexShrink: 0, gap: 10 }}>
            <button disabled={busy} onClick={() => setDraftToRestore(null)} style={{ flex: 1, border: `1px solid ${BORDER_STRONG}`, background: 'var(--pdfe-button-bg, var(--pdfe-surface))', borderRadius: 8, padding: 10 }}>나중에</button>
            <button className="pdfe-primary-button" disabled={busy} onClick={() => void restoreDraft(draftToRestore, true)} style={solidAccentBtn({ flex: 1, padding: 10 })}>이어서 작업</button>
          </div>
        </div>
      </div>}
      {pdf.error && screen === 'editor' && <div role="alert" style={{ padding: 10, background: SURFACE, color: DANGER, fontSize: 13 }}>
        {pdf.error} <button disabled={busy} onClick={() => void pdf.retry().catch(error => toast.showToast(errorMessage(error)))}>다시 시도</button>
      </div>}
      <Toast message={toast.message} /><ExportProgressOverlay progress={exportProgress} />
    </div>
  );
}
