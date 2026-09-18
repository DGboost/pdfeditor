import { useEffect, useRef } from 'react';
import { ACCENT } from '../../../styles/theme';
import type { RefObject } from 'react';
import type { Page, Point, Tool } from '../../../types/pdfEditor';
import type { EditableTextTarget, RenderedPage } from '../../../pdf/engineTypes';
import { transformPoint } from '../../../pdf/pageCoordinates';
import { useCanvasPointerInteractions } from '../../../hooks/useCanvasPointerInteractions';

export interface PdfPageSurfaceProps {
  page: Page; render: RenderedPage; zoom: number; tool: Tool; disabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>; selectedIds: readonly string[]; multiSelect: boolean;
  onSelect: (target: EditableTextTarget, additive: boolean) => void;
  onEdit: (target: EditableTextTarget) => void; onClearSelection: () => void;
}
export function PdfPageSurface(p: PdfPageSurfaceProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const r = p.render;
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    el.width = r.width; el.height = r.height;
    el.getContext('2d')?.putImageData(new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
    return () => { el.width = 0; el.height = 0; };
  }, [r]);
  const cssWidth = (r.displayBounds[2] - r.displayBounds[0]) * 96 / 72 * p.zoom;
  const cssHeight = (r.displayBounds[3] - r.displayBounds[1]) * 96 / 72 * p.zoom;
  const rasterPoint = (x: number, y: number): Point => {
    const q = transformPoint([x, y], r.pageToRaster);
    return [(q[0] - r.pixelOrigin[0]) * cssWidth / r.width, (q[1] - r.pixelOrigin[1]) * cssHeight / r.height];
  };
  const boxStyle = (b: { x: number; y: number; w: number; h: number }) => {
    const points = [rasterPoint(b.x, b.y), rasterPoint(b.x + b.w, b.y), rasterPoint(b.x, b.y + b.h), rasterPoint(b.x + b.w, b.y + b.h)];
    const xs = points.map(q => q[0]), ys = points.map(q => q[1]);
    return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  };
  const pointer = useCanvasPointerInteractions({ pageId: p.page.id, tool: p.tool, scrollRef: p.scrollRef, disabled: p.disabled,
    onTap: () => { if (p.tool === 'select' && !p.disabled) p.onClearSelection(); } });
  const events = { onPointerMove: pointer.onPointerMove, onPointerUp: pointer.onPointerUp, onPointerCancel: pointer.onPointerCancel, onLostPointerCapture: pointer.onLostPointerCapture };
  return <div className="pdfe-native-page" style={{ position: 'relative', width: cssWidth, height: cssHeight, flex: '0 0 auto', touchAction: 'none', cursor: p.tool === 'pan' ? 'grab' : 'default' }} onPointerDown={e => pointer.onPointerDown(e)} {...events}>
    <canvas ref={canvas} style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }} aria-label={`PDF ${p.page.label}`} />
    {r.textTargets.map(t => {
      const id = t.lineIds[0];
      const selected = t.lineIds.some(member => p.selectedIds.includes(member));
      const b = { id, x: t.bounds[0], y: t.bounds[1], w: t.bounds[2] - t.bounds[0], h: t.bounds[3] - t.bounds[1] };
      return <button key={id} className="pdfe-text-hit" aria-label={t.lineIds.length > 1 ? '묶은 텍스트 선택' : '원본 텍스트 선택'} aria-pressed={selected} title={t.reason || (p.multiSelect ? '클릭 또는 Enter로 선택 추가/해제 · 편집하려면 여러 줄 선택을 끄세요.' : '더블클릭 또는 Enter로 텍스트 편집 · Ctrl/Cmd/Shift로 여러 줄 선택')} style={{ ...boxStyle(b), outline: selected ? `2px solid ${ACCENT}` : undefined, pointerEvents: p.tool === 'select' ? 'auto' : 'none' }}
        onPointerDown={e => { e.stopPropagation(); }}
        onClick={e => p.onSelect(t, p.multiSelect || e.ctrlKey || e.metaKey || e.shiftKey)}
        onDoubleClick={e => { if (!p.multiSelect && !e.ctrlKey && !e.metaKey && !e.shiftKey) p.onEdit(t); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (p.multiSelect || e.ctrlKey || e.metaKey || e.shiftKey) p.onSelect(t, true); else p.onEdit(t); } }} />;
    })}
  </div>;
}
