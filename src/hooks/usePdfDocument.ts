import { useCallback, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib } from '../pdf/pdfWorker';
import { buildPageObject, buildThumbOnly } from '../pdf/buildPageObject';
import { withTimeout } from '../utils/format';
import type { Page, PdfPage } from '../types/pdfEditor';

export interface DocumentActionsForPdf {
  patchPage: (pageId: string, patch: Partial<Page>) => void;
  replacePage: (pageId: string, page: Page) => void;
}

export interface UsePdfDocumentOptions {
  actions: DocumentActionsForPdf;
  onOpened: (pages: Page[], firstPageId: string) => void;
  onError: (message: string) => void;
}

function makePlaceholder(pageNum: number): PdfPage {
  return {
    id: 'pdfpage-' + pageNum, label: pageNum + '페이지', kind: 'pdf', pending: true, textItems: [],
    images: [], signatureFields: [], textBoxes: [], shapes: [], rotation: 0, blocks: [],
  };
}

export function usePdfDocument({ actions, onOpened, onError }: UsePdfDocumentOptions) {
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const targetWidthRef = useRef(800);
  const processingIdsRef = useRef<Set<string>>(new Set());

  const generateAllThumbnailsInBackground = useCallback(async (pdf: PDFDocumentProxy, pageNums: number[]) => {
    for (const pageNum of pageNums) {
      try {
        const pdfThumb = await buildThumbOnly(pdf, pageNum);
        actions.patchPage('pdfpage-' + pageNum, { pdfThumb } as Partial<Page>);
      } catch {
        // best-effort; leave the thumbnail blank if a single page fails
      }
      await new Promise((r) => setTimeout(r, 4));
    }
  }, [actions]);

  const loadPdf = useCallback(async (arrayBuffer: ArrayBuffer) => {
    try {
      const pdf = await withTimeout(pdfjsLib.getDocument({ data: arrayBuffer, useSystemFonts: true }).promise, 20000, 'PDF open');
      pdfDocRef.current = pdf;
      targetWidthRef.current = 800;
      try { await document.fonts.load("16px 'Pretendard'"); await document.fonts.ready; } catch { /* best-effort */ }

      const placeholders: PdfPage[] = [];
      for (let i = 2; i <= pdf.numPages; i++) placeholders.push(makePlaceholder(i));

      let openedEditor = false;
      const firstPage = await buildPageObject(pdf, 1, targetWidthRef.current, (imagePatch) => {
        const draft: PdfPage = {
          id: 'pdfpage-1', label: '1페이지', kind: 'pdf', pending: false, textPending: true, textItems: [],
          images: [], signatureFields: [], textBoxes: [], shapes: [], rotation: 0, blocks: [],
          ...imagePatch,
        };
        openedEditor = true;
        onOpened([draft, ...placeholders], draft.id);
      });

      if (openedEditor) {
        actions.replacePage(firstPage.id, firstPage);
      } else {
        onOpened([firstPage, ...placeholders], firstPage.id);
      }

      generateAllThumbnailsInBackground(pdf, placeholders.map((_, i) => i + 2));
    } catch {
      onError('PDF를 여는 중 오류가 발생했습니다. 손상되었거나 암호로 보호된 파일일 수 있습니다.');
    }
  }, [actions, onOpened, onError, generateAllThumbnailsInBackground]);

  const ensurePageProcessed = useCallback(async (page: Page | undefined) => {
    if (!page || page.kind !== 'pdf' || !page.pending) return;
    const pageId = page.id;
    if (processingIdsRef.current.has(pageId)) return;
    const pdf = pdfDocRef.current;
    if (!pdf) return;
    processingIdsRef.current.add(pageId);
    try {
      const pageNum = parseInt(pageId.replace('pdfpage-', ''), 10);
      const built = await buildPageObject(pdf, pageNum, targetWidthRef.current, (imagePatch) => {
        actions.patchPage(pageId, { pending: false, textPending: true, ...imagePatch } as Partial<Page>);
      });
      actions.replacePage(pageId, built);
    } catch {
      // Leave it pending — the background loop (or the next visit to this page) will retry.
    } finally {
      processingIdsRef.current.delete(pageId);
    }
  }, [actions]);

  return { loadPdf, ensurePageProcessed };
}
