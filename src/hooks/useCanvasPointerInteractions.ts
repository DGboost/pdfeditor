import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { Point, Tool } from '../types/pdfEditor';

interface Gesture { pointerId: number; element: HTMLElement; client: Point; scroll: Point; moved: boolean }
export interface CanvasPointerOptions {
  pageId: string; tool: Tool;
  scrollRef: RefObject<HTMLDivElement | null>; disabled: boolean;
  onTap: () => void;
}
export function useCanvasPointerInteractions(options: CanvasPointerOptions) {
  const latest = useRef(options); latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const cancel = () => {
    const g = gesture.current; gesture.current = null;
    if (g?.element.hasPointerCapture(g.pointerId)) g.element.releasePointerCapture(g.pointerId);
  };
  useEffect(() => { cancel(); }, [options.pageId, options.tool, options.disabled]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); cancel(); };
  }, []);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const o = latest.current;
    if (!e.isPrimary || e.button !== 0 || gesture.current) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { pointerId: e.pointerId, element: e.currentTarget, client: [e.clientX, e.clientY],
      scroll: [o.scrollRef.current?.scrollLeft || 0, o.scrollRef.current?.scrollTop || 0], moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current, o = latest.current; if (!g || g.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - g.client[0], e.clientY - g.client[1]) >= 3) g.moved = true;
    if (!g.moved) return;
    if (o.tool === 'pan') {
      const scroll = o.scrollRef.current;
      if (scroll) { scroll.scrollLeft = g.scroll[0] - e.clientX + g.client[0]; scroll.scrollTop = g.scroll[1] - e.clientY + g.client[1]; }
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current, o = latest.current; if (!g || g.pointerId !== e.pointerId) return;
    if (!g.moved && o.tool === 'select' && !o.disabled) o.onTap();
    cancel();
  };
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: cancel, onLostPointerCapture: cancel };
}
