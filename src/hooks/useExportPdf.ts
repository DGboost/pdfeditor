import { useCallback, useRef } from 'react';
import type { Workspace } from '../types/pdfEditor';
import type { PdfDocumentController } from './usePdfDocument';

export interface UseExportPdfOptions {
  engine: PdfDocumentController;
  getSnapshot: () => Promise<{ workspace: Workspace; revision: number } | null>;
  setBusy: (value: boolean) => void;
  showToast: (message: string) => void;
}

export function useExportPdf({ engine, getSnapshot, setBusy, showToast }: UseExportPdfOptions) {
  const inFlight = useRef(false);
  const downloadNow = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const snapshot = await getSnapshot();
      if (!snapshot) return;
      const bytes = await engine.export(snapshot.workspace, snapshot.revision);
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = (snapshot.workspace.fileName || 'document').replace(/\.pdf$/i, '') + '_수정본.pdf';
      document.body.appendChild(link);
      try { link.click(); }
      finally {
        link.remove();
        // Let the browser consume the navigation before releasing its download URL.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      showToast('수정본 PDF를 다운로드했습니다');
    } catch (error) {
      showToast('다운로드 중 오류가 발생했습니다: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [engine, getSnapshot, setBusy, showToast]);
  return { downloadNow };
}
