import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { Point, Tool } from '../types/pdfEditor';

interface SelectionRectangle { left: number; top: number; width: number; height: number }
interface Gesture {
  pointerId: number; element: HTMLElement; target: EventTarget; client: Point; scroll: Point; moved: boolean;
  bounds: DOMRect; additive: boolean; pageId: string; tool: Tool; geometry: unknown;
}
export interface CanvasPointerOptions {
  pageId: string; tool: Tool; geometry: unknown; multiSelect: boolean;
  scrollRef: RefObject<HTMLDivElement | null>; disabled: boolean;
  onTap: (target: EventTarget, additive: boolean) => void;
  onMarquee: (rectangle: SelectionRectangle, additive: boolean) => void;
}
export function useCanvasPointerInteractions(options: CanvasPointerOptions) {
  const latest = useRef(options); latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const suppressedClick = useRef<number | null>(null);
  const [rectangle, setRectangle] = useState<SelectionRectangle | null>(null);
  const cancel = () => {
    const g = gesture.current; gesture.current = null;
    setRectangle(null);
    if (g?.element.hasPointerCapture(g.pointerId)) g.element.releasePointerCapture(g.pointerId);
  };
  useLayoutEffect(() => { cancel(); }, [options.pageId, options.tool, options.disabled, options.geometry]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); cancel(); };
  }, []);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const o = latest.current;
    if (!e.isPrimary || e.button !== 0 || gesture.current) return;
    suppressedClick.current = null;
    if (o.disabled && o.tool === 'select') return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    suppressedClick.current = e.pointerId;
    gesture.current = { pointerId: e.pointerId, element: e.currentTarget, target: e.target, client: [e.clientX, e.clientY],
      scroll: [o.scrollRef.current?.scrollLeft || 0, o.scrollRef.current?.scrollTop || 0], moved: false,
      bounds: e.currentTarget.getBoundingClientRect(), additive: o.multiSelect || e.ctrlKey || e.metaKey || e.shiftKey,
      pageId: o.pageId, tool: o.tool, geometry: o.geometry };
  };
  const currentGesture = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current, o = latest.current;
    if (!g || g.pointerId !== e.pointerId) return null;
    if (g.pageId !== o.pageId || g.tool !== o.tool || g.geometry !== o.geometry || (o.disabled && o.tool === 'select')) { cancel(); return null; }
    if (o.tool === 'select') {
      const b = g.element.getBoundingClientRect();
      if (b.left !== g.bounds.left || b.top !== g.bounds.top || b.width !== g.bounds.width || b.height !== g.bounds.height) { cancel(); return null; }
    }
    if (Math.hypot(e.clientX - g.client[0], e.clientY - g.client[1]) >= 3) g.moved = true;
    return g;
  };
  const selectionRectangle = (g: Gesture, e: ReactPointerEvent<HTMLElement>): SelectionRectangle => ({
    left: Math.min(g.client[0], e.clientX) - g.bounds.left, top: Math.min(g.client[1], e.clientY) - g.bounds.top,
    width: Math.abs(e.clientX - g.client[0]), height: Math.abs(e.clientY - g.client[1]),
  });
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = currentGesture(e), o = latest.current; if (!g || !g.moved) return;
    if (o.tool === 'pan') {
      const scroll = o.scrollRef.current;
      if (scroll) { scroll.scrollLeft = g.scroll[0] - e.clientX + g.client[0]; scroll.scrollTop = g.scroll[1] - e.clientY + g.client[1]; }
    } else if (o.tool === 'select') setRectangle(selectionRectangle(g, e));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const g = currentGesture(e), o = latest.current; if (!g) return;
    cancel();
    if (o.tool === 'select') {
      if (g.moved) o.onMarquee(selectionRectangle(g, e), g.additive);
      else o.onTap(g.target, g.additive);
    }
  };
  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId === e.pointerId) {
      cancel();
    }
  };
  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    const suppressed = suppressedClick.current;
    if (suppressed === null || e.detail === 0) return;
    const pointerId = (e.nativeEvent as PointerEvent).pointerId;
    if (pointerId === undefined || pointerId === suppressed) {
      suppressedClick.current = null;
      e.preventDefault(); e.stopPropagation();
    }
  };
  return { rectangle, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onClickCapture };
}
