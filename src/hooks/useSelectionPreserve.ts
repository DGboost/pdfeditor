import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';

/**
 * Keeps a live copy of the current text selection while it's still inside the editable canvas.
 * Interacting with the toolbar's <select>/<input> steals DOM focus (and clears
 * window.getSelection()) before the "적용" click handler ever runs, so without this the font
 * toolbar would have nothing left to apply by the time the user clicks Apply.
 */
export function useSelectionPreserve(pageWrapRef: RefObject<HTMLElement | null>, showToast: (msg: string) => void) {
  const savedRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      if (pageWrapRef.current && pageWrapRef.current.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [pageWrapRef]);

  const restoreSelection = useCallback((): Selection | null => {
    const range = savedRangeRef.current;
    if (!range || range.collapsed) {
      showToast('먼저 수정할 텍스트를 드래그해 선택하세요');
      return null;
    }
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel;
  }, [showToast]);

  const applyBold = useCallback(() => {
    const sel = restoreSelection();
    if (!sel) return;
    try { document.execCommand('bold'); } catch { /* execCommand may be unsupported */ }
    if (sel.rangeCount) savedRangeRef.current = sel.getRangeAt(0).cloneRange();
  }, [restoreSelection]);

  const applyAlign = useCallback((dir: 'Left' | 'Center' | 'Right') => {
    const sel = restoreSelection();
    if (!sel) return;
    try { document.execCommand('justify' + dir); } catch { /* execCommand may be unsupported */ }
  }, [restoreSelection]);

  const applyColor = useCallback((hex: string) => {
    const sel = restoreSelection();
    if (!sel) return;
    try { document.execCommand('foreColor', false, hex); } catch { /* execCommand may be unsupported */ }
  }, [restoreSelection]);

  const applyHighlight = useCallback((hex: string) => {
    const sel = restoreSelection();
    if (!sel) return;
    try { document.execCommand('hiliteColor', false, hex); } catch { /* execCommand may be unsupported */ }
  }, [restoreSelection]);

  const preserveTextSelection = useCallback((e: ReactMouseEvent) => {
    // For the native <select>, preventDefault would stop it from opening — only guard the plain
    // buttons/number-input; the selectionchange listener is what actually preserves the range.
    if ((e.currentTarget as HTMLElement).tagName !== 'SELECT') e.preventDefault();
  }, []);

  const applyFontToSelection = useCallback((fontFamily: string, fontSize: number) => {
    const range = savedRangeRef.current;
    if (!range || range.collapsed) {
      showToast('먼저 수정할 텍스트를 드래그해 선택하세요');
      return;
    }
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const span = document.createElement('span');
    span.style.fontFamily = fontFamily;
    span.style.fontSize = fontSize + 'px';
    try {
      range.surroundContents(span);
    } catch {
      // surroundContents throws if the range crosses element boundaries — fall back to
      // extract+reinsert, which works for any selection shape.
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    savedRangeRef.current = null;
    showToast('선택한 텍스트에 글꼴을 적용했습니다');
  }, [showToast]);

  return { applyBold, applyAlign, applyColor, applyHighlight, preserveTextSelection, applyFontToSelection };
}
