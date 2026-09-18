import { useEffect, useMemo, useRef } from 'react';
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
  onSelectMany: (targets: EditableTextTarget[], additive: boolean) => void;
  onClearSelection: () => void;
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
  const geometry = useMemo(() => ({ render: r, cssWidth, cssHeight }), [r, cssWidth, cssHeight]);
  const hitboxes = useMemo(() => {
    const rasterPoint = (x: number, y: number): Point => {
      const q = transformPoint([x, y], r.pageToRaster);
      return [(q[0] - r.pixelOrigin[0]) * cssWidth / r.width, (q[1] - r.pixelOrigin[1]) * cssHeight / r.height];
    };
    return r.textTargets.map(target => {
      const [x0, y0, x1, y1] = target.bounds;
      const points = [rasterPoint(x0, y0), rasterPoint(x1, y0), rasterPoint(x0, y1), rasterPoint(x1, y1)];
      const xs = points.map(q => q[0]), ys = points.map(q => q[1]);
      return { target, box: { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
    });
  }, [r, cssWidth, cssHeight]);
  const pointer = useCanvasPointerInteractions({
    pageId: p.page.id, tool: p.tool, scrollRef: p.scrollRef, disabled: p.disabled, geometry, multiSelect: p.multiSelect,
    onTap: (target, additive) => {
      const hit = target instanceof Element ? target.closest<HTMLButtonElement>('[data-text-target]') : null;
      const text = hit ? hitboxes[Number(hit.dataset.textTarget)]?.target : undefined;
      if (text) p.onSelect(text, additive);
      else p.onClearSelection();
    },
    onMarquee: (rectangle, additive) => {
      const right = rectangle.left + rectangle.width, bottom = rectangle.top + rectangle.height;
      const targets = hitboxes.filter(({ box }) => box.left <= right && box.left + box.width >= rectangle.left
        && box.top <= bottom && box.top + box.height >= rectangle.top).map(hit => hit.target);
      p.onSelectMany(targets, additive);
    },
  });
  const events = { onPointerMove: pointer.onPointerMove, onPointerUp: pointer.onPointerUp, onPointerCancel: pointer.onPointerCancel, onLostPointerCapture: pointer.onLostPointerCapture, onClickCapture: pointer.onClickCapture };
  return <div className="pdfe-native-page" style={{ position: 'relative', width: cssWidth, height: cssHeight, flex: '0 0 auto', touchAction: 'none', cursor: p.tool === 'pan' ? 'grab' : 'default' }} onPointerDown={pointer.onPointerDown} {...events}>
    <canvas ref={canvas} style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }} aria-label={`PDF ${p.page.label}`} />
    {hitboxes.map(({ target: t, box }, index) => {
      const id = t.lineIds[0];
      const selected = t.lineIds.some(member => p.selectedIds.includes(member));
      return <button key={id} data-text-target={index} className="pdfe-text-hit" disabled={p.disabled} aria-label={t.lineIds.length > 1 ? '묶은 텍스트 선택' : '원본 텍스트 선택'} aria-pressed={selected} title={t.reason || (p.multiSelect ? '클릭 또는 Enter로 선택 추가/해제 · 연속된 줄은 자동으로 묶어서 편집합니다.' : '클릭 또는 Enter로 텍스트 편집 · Ctrl/Cmd/Shift로 여러 줄 선택')} style={{ ...box, outline: selected ? `2px solid ${ACCENT}` : undefined, pointerEvents: p.tool === 'select' ? 'auto' : 'none' }}
        onClick={e => { if (p.tool === 'select' && !p.disabled) p.onSelect(t, p.multiSelect || e.ctrlKey || e.metaKey || e.shiftKey); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect(t, p.multiSelect || e.ctrlKey || e.metaKey || e.shiftKey); } }} />;
    })}
    {pointer.rectangle && <div aria-hidden="true" style={{ position: 'absolute', ...pointer.rectangle, boxSizing: 'border-box', border: '1px solid #222', background: 'rgba(0, 0, 0, 0.08)', pointerEvents: 'none' }} />}
  </div>;
}
