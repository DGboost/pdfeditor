import { useRef, useState } from 'react';
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

export default function App() {
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

  const doc = useDocumentReducer(makeInitialPages());
  const toast = useToast();
  const sigCanvas = useSignatureCanvas();
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const slowHintTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const pdf = usePdfDocument({
    actions: { patchPage: doc.actions.patchPage, replacePage: doc.actions.replacePage },
    onOpened: (pages, firstPageId) => {
      clearTimeout(slowHintTimerRef.current);
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
    <div style={{ height: '100vh', width: '100%', overflow: 'hidden', fontFamily: "'Pretendard',system-ui,sans-serif", background: 'oklch(97% 0.005 250)', color: 'oklch(22% 0.02 250)', position: 'relative' }}>
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
          goToUpload={() => setScreen('upload')}
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

      <Toast message={toast.message} />
      <ExportProgressOverlay progress={exportProgress} />
    </div>
  );
}
