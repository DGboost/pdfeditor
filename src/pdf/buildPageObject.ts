import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdfWorker';
import { withTimeout } from '../utils/format';
import { mergeTextRunsIntoBlocks } from '../utils/textLayout';
import type { PdfPage } from '../types/pdfEditor';

export interface ImagePatch { pdfImage: string; pdfThumb: string; imgW: number; imgH: number }

function offscreenCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // pdf.js's page.render() is dramatically slower (and in some environments effectively hangs) on
  // a canvas that isn't attached to the DOM — attach it off-screen just for the render call.
  canvas.style.position = 'fixed';
  canvas.style.left = '-99999px';
  canvas.style.top = '0';
  document.body.appendChild(canvas);
  return canvas;
}

/**
 * Renders + recognizes text on ONE PDF page and returns its fully-built page object. The first
 * page is processed eagerly (for an instant-feeling open); the rest of a multi-page document is
 * processed lazily — see usePdfDocument.
 */
export async function buildPageObject(
  pdfDoc: PDFDocumentProxy,
  pageNum: number,
  targetWidth: number,
  onImageReady?: (patch: ImagePatch) => void,
): Promise<PdfPage> {
  const page = await pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = offscreenCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const ctx = canvas.getContext('2d')!;
  try {
    await withTimeout(page.render({ canvasContext: ctx, viewport }).promise, 20000, '페이지 렌더링');
  } finally {
    canvas.remove();
  }

  // Snapshot the sidebar thumbnail from the CLEAN raster, before the white text-cover below is
  // baked into `canvas` — keeps a text-heavy page's thumbnail from turning almost blank once the
  // page becomes active and gets its cover applied for the editable overlay.
  const thumbW = 220;
  const thumbH = Math.round(canvas.height * (thumbW / canvas.width));
  const tc0 = document.createElement('canvas');
  tc0.width = thumbW;
  tc0.height = thumbH;
  tc0.getContext('2d')!.drawImage(canvas, 0, 0, thumbW, thumbH);
  const cleanThumbDataUrl = tc0.toDataURL('image/jpeg', 0.75);

  // The raster render is the slow part; text extraction is comparatively instant. Report the page
  // image the moment it's ready so it appears on screen right away.
  if (onImageReady) {
    onImageReady({
      pdfImage: canvas.toDataURL('image/jpeg', 0.92),
      pdfThumb: cleanThumbDataUrl,
      imgW: canvas.width, imgH: canvas.height,
    });
  }

  let textItems: ReturnType<typeof mergeTextRunsIntoBlocks> = [];
  try {
    const textContent = await page.getTextContent();
    const overallScale = Math.hypot(viewport.transform[0], viewport.transform[1]);
    const rawItems = (textContent.items as any[])
      .filter((item) => item.str && item.str.trim().length > 0)
      .map((item) => {
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const w = Math.max(item.width * overallScale, 1);
        const h = Math.max(fontHeight, 8);
        return { text: item.str as string, left: tx[4], top: tx[5] - fontHeight, width: w, height: h };
      });
    textItems = mergeTextRunsIntoBlocks(rawItems, 'p' + pageNum);
  } catch {
    textItems = [];
  }

  // Bake a clean white cover over every original text region directly into the page image, so the
  // editable overlay text no longer needs its own opaque background.
  if (textItems.length) {
    ctx.save();
    ctx.fillStyle = '#fff';
    for (const ti of textItems) {
      // Descenders/diacritics extend past the glyph's measured ascent-to-baseline box — pad
      // proportional to font size so nothing pokes out at larger sizes.
      const padX = Math.max(1.5, ti.fontSizePx * 0.08);
      const padTop = Math.max(1.5, ti.fontSizePx * 0.15);
      const padBottom = Math.max(4, ti.fontSizePx * 0.4);
      ctx.fillRect(ti.left - padX, ti.top - padTop, ti.width + padX * 2, ti.height + padTop + padBottom);
    }
    ctx.restore();
  }

  return {
    id: 'pdfpage-' + pageNum, label: pageNum + '페이지', kind: 'pdf', pending: false, textPending: false,
    // JPEG instead of PNG keeps these data URLs small (re-embedded on every re-render).
    pdfImage: canvas.toDataURL('image/jpeg', 0.92),
    pdfThumb: cleanThumbDataUrl,
    imgW: canvas.width, imgH: canvas.height,
    textItems,
    images: [], signatureFields: [], textBoxes: [], shapes: [], rotation: 0, blocks: [],
  };
}

/**
 * Fast pass: render a small thumbnail WITHOUT the expensive full-size render + text-extraction
 * pipeline, so the page rail fills in almost immediately even on very long documents.
 */
export async function buildThumbOnly(pdfDoc: PDFDocumentProxy, pageNum: number): Promise<string> {
  const page = await pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const thumbW = 220;
  const scale = thumbW / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = offscreenCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const ctx = canvas.getContext('2d')!;
  try {
    await withTimeout(page.render({ canvasContext: ctx, viewport }).promise, 15000, '썸네일 렌더링');
  } finally {
    canvas.remove();
  }
  return canvas.toDataURL('image/jpeg', 0.75);
}
