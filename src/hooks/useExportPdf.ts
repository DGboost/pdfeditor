import { useCallback } from 'react';
import type { RefObject } from 'react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import type { Page, Tool } from '../types/pdfEditor';
import { sanitizeClonedColors } from '../utils/exportColorFix';

function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (k: number) => (k <= 0 ? resolve() : requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
}

export interface UseExportPdfOptions {
  pages: Page[];
  fileName: string;
  pageWrapRef: RefObject<HTMLElement | null>;
  ensurePageProcessed: (page: Page | undefined) => Promise<void>;
  activePageId: string;
  setActivePageId: (id: string) => void;
  setActiveTool: (t: Tool) => void;
  zoom: number;
  setZoom: (z: number) => void;
  setGridViewOpen: (v: boolean) => void;
  isExporting: boolean;
  setIsExporting: (v: boolean) => void;
  setExportProgress: (progress: { current: number; total: number } | null) => void;
  showToast: (msg: string) => void;
}

export function useExportPdf(opts: UseExportPdfOptions) {
  const {
    pages, fileName, pageWrapRef, ensurePageProcessed,
    activePageId, setActivePageId,
    setActiveTool, zoom, setZoom, setGridViewOpen,
    isExporting, setIsExporting, setExportProgress, showToast,
  } = opts;

  const downloadNow = useCallback(async () => {
    if (isExporting) return;
    const originActivePageId = activePageId;
    const originZoom = zoom;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    setIsExporting(true);
    setActiveTool('select');
    setZoom(1);
    setGridViewOpen(false);
    await waitFrames(2);

    try {
      let pdfDoc: jsPDF | null = null;
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        setExportProgress({ current: i + 1, total: pages.length });
        await ensurePageProcessed(page);
        setActivePageId(page.id);
        await waitFrames(3);
        const el = pageWrapRef.current;
        if (!el) continue;
        const canvas = await html2canvas(el, {
          scale: 2, backgroundColor: '#ffffff', useCORS: true,
          onclone: (clonedDoc) => sanitizeClonedColors(clonedDoc),
        });
        const imgData = canvas.toDataURL('image/jpeg', 0.95);
        const wPt = canvas.width / 2;
        const hPt = canvas.height / 2;
        if (!pdfDoc) {
          pdfDoc = new jsPDF({ orientation: wPt > hPt ? 'landscape' : 'portrait', unit: 'pt', format: [wPt, hPt] });
        } else {
          pdfDoc.addPage([wPt, hPt], wPt > hPt ? 'landscape' : 'portrait');
        }
        pdfDoc.addImage(imgData, 'JPEG', 0, 0, wPt, hPt);
      }
      if (pdfDoc) {
        const outName = (fileName || 'document').replace(/\.pdf$/i, '') + '_수정본.pdf';
        pdfDoc.save(outName);
        showToast('수정본 PDF를 다운로드했습니다');
      }
    } catch (err) {
      console.error('[export] failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      showToast('다운로드 중 오류가 발생했습니다: ' + detail);
    } finally {
      setExportProgress(null);
      setIsExporting(false);
      setActivePageId(originActivePageId);
      setZoom(originZoom);
    }
  }, [isExporting, activePageId, zoom, pages, fileName, pageWrapRef, ensurePageProcessed, setIsExporting, setExportProgress, setActiveTool, setZoom, setGridViewOpen, setActivePageId, showToast]);

  return { downloadNow };
}
