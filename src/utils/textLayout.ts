import type { PdfTextItem } from '../types/pdfEditor';

export interface RawTextRun { text: string; left: number; top: number; width: number; height: number }

interface Line { top: number; items: RawTextRun[] }
interface Block { lines: RawTextRun[]; left: number; top: number; right: number; bottom: number; width: number }

/**
 * Groups raw per-glyph-run pdf.js text items into paragraph/list-level editable blocks.
 *
 * Many Korean PDF generators emit one item PER CHARACTER (each with its own tiny positioning
 * offset) — without this merge, every character would become its own separately-editable box.
 * Ported verbatim (3-pass line/run/block merge) from the original prototype's buildPageObject.
 */
export function mergeTextRunsIntoBlocks(rawItemsInput: RawTextRun[], idPrefix: string): PdfTextItem[] {
  const rawItems = [...rawItemsInput].sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));

  // Pass 1: group into lines (items whose baselines are close together).
  const lines: Line[] = [];
  for (const it of rawItems) {
    let line = lines.find((ln) => Math.abs(ln.top - it.top) < Math.max(3, it.height * 0.45));
    if (!line) { line = { top: it.top, items: [] }; lines.push(line); }
    line.items.push(it);
  }

  // Pass 2: within each line, merge runs that sit close enough together to be the same
  // word/sentence (small gap = same run continuing; a wide gap starts a new editable run,
  // e.g. across a tab-stop or a table column).
  const mergedRuns: RawTextRun[] = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.left - b.left);
    let cur: RawTextRun | null = null;
    for (const it of line.items) {
      const gap = cur ? it.left - (cur.left + cur.width) : 0;
      const runHeight = cur ? Math.max(cur.height, it.height) : it.height;
      const newRunThreshold = runHeight * 1.6;
      // A lot of Korean PDF generators encode a word break as a pure positioning gap in the
      // text array with no actual space glyph — re-insert one whenever the gap is bigger than
      // normal same-word kerning but not big enough to be a new run/column.
      const spaceThreshold = runHeight * 0.22;
      if (cur && gap <= newRunThreshold) {
        const needsSpace = gap > spaceThreshold && !/\s$/.test(cur.text) && !/^\s/.test(it.text);
        cur.text += (needsSpace ? ' ' : '') + it.text;
        cur.width = (it.left + it.width) - cur.left;
        cur.height = Math.max(cur.height, it.height);
      } else {
        cur = { text: it.text, left: it.left, top: it.top, width: it.width, height: it.height };
        mergedRuns.push(cur);
      }
    }
  }

  // Pass 3: group consecutive lines into paragraph/list-level blocks — one big editable box per
  // paragraph. A new block starts where the vertical gap is bigger than normal line-spacing, the
  // text size changes (heading vs. body), or the line no longer lines up with the block's column.
  const sortedRuns = mergedRuns.slice().sort((a, b) => (Math.abs(a.top - b.top) > 1 ? a.top - b.top : a.left - b.left));
  const blocks: Block[] = [];
  for (const run of sortedRuns) {
    const b = blocks[blocks.length - 1];
    let merge = false;
    if (b) {
      const lastLine = b.lines[b.lines.length - 1];
      const gap = run.top - (lastLine.top + lastLine.height);
      const heightRatio = run.height / lastLine.height;
      const overlapLeft = Math.max(run.left, b.left);
      const overlapRight = Math.min(run.left + run.width, b.left + b.width);
      const overlaps = overlapRight > overlapLeft;
      const leftAligned = Math.abs(run.left - b.left) < lastLine.height * 2.2;
      merge = gap >= -2 && gap < lastLine.height * 1.7 && heightRatio > 0.72 && heightRatio < 1.4 && (overlaps || leftAligned);
    }
    if (merge && b) {
      b.lines.push(run);
      b.left = Math.min(b.left, run.left);
      b.top = Math.min(b.top, run.top);
      b.right = Math.max(b.right, run.left + run.width);
      b.bottom = Math.max(b.bottom, run.top + run.height);
      b.width = b.right - b.left;
    } else {
      blocks.push({ lines: [run], left: run.left, top: run.top, right: run.left + run.width, bottom: run.top + run.height, width: run.width });
    }
  }

  return blocks.map((b, idx) => {
    const maxLineWidth = Math.max(...b.lines.map((l) => l.width));
    const text = b.lines.map((l, li) => {
      if (li === b.lines.length - 1) return l.text;
      // A line noticeably shorter than the block's widest line is an intentional break; otherwise
      // the line only wrapped because of the original page width, so let it re-flow as one run.
      return l.width < maxLineWidth * 0.92 ? l.text + '\n' : l.text + ' ';
    }).join('');
    const avgHeight = b.lines.reduce((sum, l) => sum + l.height, 0) / b.lines.length;
    return {
      id: idPrefix + '-blk' + idx,
      text, left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top,
      fontSizePx: Math.max(9, avgHeight * 0.85),
    };
  });
}
