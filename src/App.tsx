import { useRef, useState, useEffect } from 'react';
import type { Screen, ExportSettings, SigModalState, SigModalTarget, Tool } from './types/pdfEditor';
import { makeInitialPages } from './data/sampleContract';
import { useDocumentReducer } from './hooks/useDocumentReducer';
import { useToast } from './hooks/useToast';
import { useSignatureCanvas } from './hooks/useSignatureCanvas';
import { usePdfDocument } from './hooks/usePdfDocument';
import { useExportPdf } from './hooks/useExportPdf';
import { UploadScreen } from './components/screens/UploadScreen';
import { EditorScreen } from './components/screens/EditorScreen/EditorScreen';
import { ExportModal } from './components/ExportModal';
import { GridView } from './components/screens/EditorScreen/GridView';
import { SignatureModal } from './components/SignatureModal';
import { Toast } from './components/Toast';
import { ExportProgressOverlay } from './components/ExportProgressOverlay';
import { savePdfDraft, loadPdfDraft, clearPdfDraft } from './utils/db';
import { SURFACE, TEXT, TEXT_MUTED, BORDER_SOFT, BORDER_STRONG } from './styles/theme';
import './styles/global.css';

export default function App() {
  const accent = '#3d5afe';
  const appName = 'PDF 편집';
  const [screen, setScreen] = useState<Screen>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadSlowHint, setUploadSlowHint] = useState(false);
  const [fileName, setFileName] = useState('용역_계약서_초안.pdf');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [activePageId, setActivePageId] = useState('p1');
  const [pageNumInput, setPageNumInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [gridViewOpen, setGridViewOpen] = useState(false);

  const [sigModal, setSigModal] = useState<SigModalState>({ open: false, target: null });
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({ format: 'pdf' });
  const [draftToRestore, setDraftToRestore] = useState<any | null>(null);

  const doc = useDocumentReducer(makeInitialPages());
  const toast = useToast();
  const sigCanvas = useSignatureCanvas();
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const slowHintTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // ---- Unsaved changes safety guard ----
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (screen === 'editor') {
        e.preventDefault();
        e.returnValue = ''; // Shows standard browser alert dialog
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [screen]);

  // ---- Check for existing draft on mount ----
  useEffect(() => {
    const checkDraft = async () => {
      const draft = await loadPdfDraft();
      if (draft && draft.docState && draft.docState.pages && draft.docState.pages.length > 0) {
        setDraftToRestore(draft);
      }
    };
    checkDraft();
  }, []);

  // ---- Auto-save draft to IndexedDB ----
  useEffect(() => {
    if (screen !== 'editor') return;

    const timer = setTimeout(() => {
      savePdfDraft({
        fileName,
        activePageId,
        screen,
        pageNumInput,
        zoom,
        docState: doc.state,
        timestamp: Date.now(),
      });
    }, 1500); // 1.5s debounce

    return () => clearTimeout(timer);
  }, [screen, fileName, activePageId, pageNumInput, zoom, doc.state]);

  const pdf = usePdfDocument({
    actions: { patchPage: doc.actions.patchPage, replacePage: doc.actions.replacePage },
    onOpened: (pages, firstPageId) => {
      clearTimeout(slowHintTimerRef.current);
      clearPdfDraft();
      doc.actions.loadDocument(pages);
      setActivePageId(firstPageId);
      setUploading(false);
      setUploadSlowHint(false);
      setScreen('editor');
      setPageNumInput('1');
      setZoom(1);
      setGridViewOpen(false);
    },
    onError: (message) => {
      clearTimeout(slowHintTimerRef.current);
      setUploading(false);
      setUploadSlowHint(false);
      setUploadError(message);
    },
  });

  const [activeTool, setActiveTool] = useState<Tool>('select');
  const exportPdf = useExportPdf({
    pages: doc.state.pages,
    fileName,
    pageWrapRef,
    ensurePageProcessed: pdf.ensurePageProcessed,
    activePageId,
    setActivePageId,
    setActiveTool,
    zoom,
    setZoom,
    setGridViewOpen,
    isExporting,
    setIsExporting,
    setExportProgress,
    showToast: toast.showToast,
  });

  const saveToArchive = () => {
    clearPdfDraft();
    toast.showToast('보관함에 저장되었습니다');
  };

  const handleFile = (f: File) => {
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
      setUploadError('PDF 파일만 업로드할 수 있습니다.');
      return;
    }
    setUploadError(null);
    setFileName(f.name);
    setUploading(true);
    setUploadSlowHint(false);
    clearTimeout(slowHintTimerRef.current);
    slowHintTimerRef.current = setTimeout(() => setUploadSlowHint(true), 4000);
    const reader = new FileReader();
    reader.onload = () => pdf.loadPdf(reader.result as ArrayBuffer);
    reader.onerror = () => {
      clearTimeout(slowHintTimerRef.current);
      setUploading(false);
      setUploadSlowHint(false);
      setUploadError('파일을 읽는 중 오류가 발생했습니다.');
    };
    reader.readAsArrayBuffer(f);
  };

  const openSample = () => {
    doc.actions.loadDocument(makeInitialPages());
    setActivePageId('p1');
    setFileName('용역_계약서_초안.pdf');
    setUploadError(null);
    setScreen('editor');
    setPageNumInput('1');
    setZoom(1);
    setGridViewOpen(false);
  };

  const goToPageIndex = (idx: number) => {
    const pages = doc.state.pages;
    if (idx < 0 || idx >= pages.length) return;
    setActivePageId(pages[idx].id);
    setPageNumInput(String(idx + 1));
    pdf.ensurePageProcessed(pages[idx]);
  };

  const rotatePage = (id: string, delta: number) => {
    const target = doc.state.pages.find((p) => p.id === id);
    if (!target) return;
    if (target.kind !== 'pdf') { toast.showToast('회전은 PDF 페이지에서만 지원됩니다'); return; }
    doc.actions.rotatePage(id, delta);
  };

  const duplicatePage = (id: string) => {
    const pages = doc.state.pages;
    const idx = pages.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const newId = 'p' + Date.now() + Math.floor(Math.random() * 1000);
    doc.actions.duplicatePage(id, newId);
    setActivePageId(newId);
    setPageNumInput(String(idx + 2));
    toast.showToast('페이지를 복제했습니다');
  };

  const addPage = () => {
    const newId = 'p' + Date.now() + Math.floor(Math.random() * 100000);
    doc.actions.addPage(newId);
    setActivePageId(newId);
    setPageNumInput(String(doc.state.pages.length + 1));
  };

  const onDeletePageClick = (id: string) => {
    const pages = doc.state.pages;
    if (pages.length <= 1) return;
    if (!window.confirm('이 페이지를 삭제할까요?')) return;
    doc.actions.deletePage(id);
    const newPages = pages.filter((p) => p.id !== id);
    const newActiveId = activePageId === id ? newPages[0].id : activePageId;
    const idx = newPages.findIndex((p) => p.id === newActiveId);
    setActivePageId(newActiveId);
    setPageNumInput(String(idx + 1));
  };

  const onThumbClick = (id: string) => {
    const pages = doc.state.pages;
    const idx = pages.findIndex((p) => p.id === id);
    setActivePageId(id);
    setPageNumInput(String(idx + 1));
    pdf.ensurePageProcessed(pages[idx]);
  };

  const openSigModal = (target: SigModalTarget) => setSigModal({ open: true, target });
  const closeSigModal = () => { setSigModal({ open: false, target: null }); sigCanvas.reset(); };
  const saveSignature = () => {
    const dataUrl = sigCanvas.getDataUrl();
    if (!dataUrl || !sigModal.target) return;
    doc.actions.saveSignature(sigModal.target, dataUrl);
    setSigModal({ open: false, target: null });
    sigCanvas.reset();
  };

  return (
    <div className="pdf-editor-root" style={{ display: 'flex', flexDirection: 'column', '--accent': accent } as React.CSSProperties}>
      {screen === 'upload' && (
        <div
          style={{
            height: 60,
            flex: 'none',
            background: SURFACE,
            borderBottom: `1px solid ${BORDER_SOFT}`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 28px',
            boxSizing: 'border-box'
          }}
        >
          <button
            className="pdfe-brand"
            onClick={() => setScreen('upload')}
            title={appName}
            style={{
              fontSize: 19,
              fontWeight: 800,
              letterSpacing: '-.6px',
              color: TEXT,
              marginRight: 46,
              padding: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: "'Pretendard',system-ui,sans-serif",
              transition: 'opacity .12s'
            }}
          >
            {appName}
          </button>
        </div>
      )}

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {screen === 'upload' && (
          <UploadScreen
            fileName={fileName}
            dragOver={dragOver}
            uploading={uploading}
            uploadSlowHint={uploadSlowHint}
            uploadError={uploadError}
            onDragOverChange={setDragOver}
            onFile={handleFile}
            onSample={openSample}
          />
        )}

        {screen === 'editor' && (
          <EditorScreen
            fileName={fileName}
            onFileNameChange={setFileName}
            pages={doc.state.pages}
            signatures={doc.state.signatures}
            globalFontFamily={doc.state.globalFontFamily}
            globalFontSize={doc.state.globalFontSize}
            docActions={doc.actions}
            canUndo={doc.state.history.undo.length > 0}
            canRedo={doc.state.history.redo.length > 0}
            activePageId={activePageId}
            setActivePageId={setActivePageId}
            pageNumInput={pageNumInput}
            setPageNumInput={setPageNumInput}
            goToPageIndex={goToPageIndex}
            zoom={zoom}
            setZoom={setZoom}
            pageWrapRef={pageWrapRef}
            ensurePageProcessed={pdf.ensurePageProcessed}
            isExporting={isExporting}
            showToast={toast.showToast}
            goToUpload={async () => {
              if (window.confirm('편집기에서 나가면 현재 작업 중인 임시 내용이 지워집니다. 나갈까요?')) {
                await clearPdfDraft();
                setScreen('upload');
              }
            }}
            goExport={() => setExportModalOpen(true)}
            onOpenGridView={() => setGridViewOpen(true)}
            onDuplicatePage={duplicatePage}
            onRotatePage={rotatePage}
            onDeletePage={onDeletePageClick}
            onAddPage={addPage}
            onReorderPages={doc.actions.reorderPages}
            onThumbClick={onThumbClick}
            onOpenSigModal={openSigModal}
            activeTool={activeTool}
            setActiveTool={setActiveTool}
          />
        )}
      </div>

      <ExportModal
        open={exportModalOpen}
        exportSettings={exportSettings}
        setExportSettings={setExportSettings}
        isExporting={isExporting}
        onClose={() => setExportModalOpen(false)}
        onDownload={exportPdf.downloadNow}
        onSaveToArchive={saveToArchive}
      />

      {gridViewOpen && (
        <GridView
          pages={doc.state.pages}
          onClose={() => setGridViewOpen(false)}
          onOpenPage={(id) => {
            const pages = doc.state.pages;
            const idx = pages.findIndex((p) => p.id === id);
            setActivePageId(id);
            setGridViewOpen(false);
            setPageNumInput(String(idx + 1));
            pdf.ensurePageProcessed(pages[idx]);
          }}
          onAddPage={addPage}
          onRotatePage={rotatePage}
          onDuplicatePage={duplicatePage}
          onDeletePage={onDeletePageClick}
        />
      )}

      <SignatureModal
        open={sigModal.open}
        setCanvasRef={sigCanvas.setCanvasRef}
        hasStrokes={sigCanvas.hasStrokes}
        onClear={sigCanvas.clear}
        onClose={closeSigModal}
        onSave={saveSignature}
      />

      {draftToRestore && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(23, 23, 26, 0.4)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            animation: 'pdfe-pop .18s ease-out',
          }}
        >
          <div
            style={{
              background: SURFACE,
              borderRadius: 14,
              padding: '28px 32px',
              maxWidth: 420,
              width: '100%',
              boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
              textAlign: 'center',
              fontFamily: "'Pretendard', system-ui, sans-serif",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'color-mix(in srgb, var(--accent, #3d5afe) 10%, var(--pdfe-surface, #fff))',
                color: 'var(--accent, #3d5afe)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg>
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 8px', color: TEXT }}>이전 작업 복구</h3>
            <p style={{ fontSize: 14.5, color: TEXT_MUTED, margin: '0 0 24px', lineHeight: 1.55 }}>
              이전에 편집 중이던 임시 저장 문서가 있습니다.<br />
              이어서 작업을 진행하시겠습니까?
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={async () => {
                  await clearPdfDraft();
                  setDraftToRestore(null);
                  toast.showToast('새 작업을 시작합니다.');
                }}
                style={{
                  flex: 1,
                  border: `1px solid ${BORDER_STRONG}`,
                  background: SURFACE,
                  color: TEXT_MUTED,
                  borderRadius: 10,
                  height: 40,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                새로 시작
              </button>
              <button
                onClick={() => {
                  doc.actions.restoreState(draftToRestore.docState);
                  setFileName(draftToRestore.fileName);
                  setActivePageId(draftToRestore.activePageId);
                  setScreen(draftToRestore.screen);
                  setPageNumInput(draftToRestore.pageNumInput);
                  setZoom(draftToRestore.zoom);
                  setDraftToRestore(null);
                  toast.showToast('이전 작업을 성공적으로 복구했습니다.');
                }}
                style={{
                  flex: 1,
                  border: 'none',
                  background: 'var(--accent, #3d5afe)',
                  color: '#fff',
                  borderRadius: 10,
                  height: 40,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
                }}
              >
                이어서 작업
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast message={toast.message} />
      <ExportProgressOverlay progress={exportProgress} />
    </div>
  );
}
