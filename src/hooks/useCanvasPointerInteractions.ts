import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { DragKind } from '../types/pdfEditor';

interface DragState { kind: DragKind; pageId: string; id: string; lastX: number; lastY: number }

export interface CanvasPointerActions {
  moveItem: (pageId: string, kind: DragKind, id: string, dx: number, dy: number) => void;
  pushHistory: () => void;
}

/**
 * Exactly one window-level mousemove/mouseup pair drives ALL overlay-item dragging (images,
 * signature fields, shapes, text boxes) — matching the original prototype, which intentionally
 * used one shared listener instead of one per draggable item.
 */
export function useCanvasPointerInteractions(actions: CanvasPointerActions) {
  const dragStateRef = useRef<DragState | null>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const d = dragStateRef.current;
      if (!d) return;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      if (dx === 0 && dy === 0) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      actions.moveItem(d.pageId, d.kind, d.id, dx, dy);
    };
    const onMouseUp = () => {
      dragStateRef.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [actions]);

  const startItemDrag = useCallback((kind: DragKind) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const pageId = target.dataset.pageId!;
    const id = target.dataset.itemId!;
    actions.pushHistory();
    dragStateRef.current = { kind, pageId, id, lastX: e.clientX, lastY: e.clientY };
  }, [actions]);

  return {
    onImageMouseDown: startItemDrag('images'),
    onSigFieldMouseDown: startItemDrag('signatureFields'),
    onShapeMouseDown: startItemDrag('shapes'),
    onTextBoxMouseDown: startItemDrag('textBoxes'),
  };
}
