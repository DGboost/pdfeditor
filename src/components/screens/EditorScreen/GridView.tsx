import { useEffect, useRef, useState } from 'react';
import { Plus, RotateCcw, RotateCw, X } from 'lucide-react';
import type { Page } from '../../../types/pdfEditor';
import type { PdfDocumentController } from '../../../hooks/usePdfDocument';
import { ACCENT, BORDER, SURFACE, CANVAS_BG, TEXT_SUBTLE } from '../../../styles/theme';

export function PageThumbnail({ page, engine, revision }: { page: Page; engine: PdfDocumentController; revision: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      observer.disconnect(); setError('');
      void engine.render(page, .22, revision, 0, 'thumbnail').then(r => {
        if (cancelled) return;
        el.width = r.width; el.height = r.height;
        el.getContext('2d')?.putImageData(new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
      }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '미리 보기 실패'); });
    });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); el.width = 0; el.height = 0; };
  }, [page, revision, engine.render, engine.sessionId]);
  return <><canvas ref={canvas} aria-label={`${page.label} 미리 보기`} style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />{error && <span role="status" style={{ position: 'absolute', inset: 8, fontSize: 10 }}>{error}</span>}</>;
}
export interface GridViewProps {
  pages: Page[]; activePageId: string; engine: PdfDocumentController; revision: number; disabled: boolean;
  onClose: () => void; onOpenPage: (id: string) => void; onAddPage: () => void;
  onRotatePage: (id: string, delta: number) => void; onDuplicatePage: (id: string) => void; onDeletePage: (id: string) => void;
}
export function GridView(p: GridViewProps) {
  const [focusId, setFocusId] = useState(p.activePageId);
  const locked = p.disabled || !p.engine.info?.canAssemble;
  return <div className="pdfe-screen-enter" style={{ position: 'fixed', inset: 0, background: CANVAS_BG, zIndex: 40, display: 'flex', flexDirection: 'column' }}>
    <div className="pdfe-grid-header" style={{ minHeight: 56, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '12px 20px', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      <strong style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-.025em' }}>모든 페이지 ({p.pages.length})</strong><div style={{ flex: 1 }} />
      <button disabled={locked} onClick={p.onAddPage}><Plus size={22} strokeWidth={1.5} />추가</button>
      <button disabled={locked || !focusId} onClick={() => p.onRotatePage(focusId, -90)}><RotateCcw size={22} strokeWidth={1.5} />왼쪽</button>
      <button disabled={locked || !focusId} onClick={() => p.onRotatePage(focusId, 90)}><RotateCw size={22} strokeWidth={1.5} />오른쪽</button>
      <button aria-label="전체 페이지 닫기" title="완료" onClick={p.onClose}><X size={24} strokeWidth={1.5} /></button>
    </div>
    <div className="pdfe-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 20, alignContent: 'start' }}>
      {p.pages.map((page, i) => {
        const duplicate = page.kind === 'pdf' ? p.engine.info?.pages[page.sourcePageIndex]?.duplicate : undefined;
        return <div key={page.id} className="pdfe-page-card" data-selected={focusId === page.id} style={{ border: `2px solid ${focusId === page.id ? ACCENT : 'transparent'}`, borderRadius: 24, padding: 12 }}>
          <div style={{ aspectRatio: '3 / 4', position: 'relative', background: '#fff', border: `1px solid ${BORDER}` }}>
            <PageThumbnail page={page} engine={p.engine} revision={p.revision} />
            <button className="pdfe-thumb-hit" aria-label={`${i + 1} 페이지 선택`} onClick={() => setFocusId(page.id)} onDoubleClick={() => p.onOpenPage(page.id)} />
            <div className="pdfe-page-controls">
              <button onClick={() => p.onOpenPage(page.id)}>열기</button>
              <button disabled={locked || duplicate?.allowed === false} title={duplicate?.allowed === false ? duplicate.reason : '복제'} onClick={() => p.onDuplicatePage(page.id)}>복제</button>
              <button disabled={locked} onClick={() => p.onRotatePage(page.id, 90)}>회전</button>
              <button disabled={locked || p.pages.length === 1} onClick={() => p.onDeletePage(page.id)}>삭제</button>
            </div>
          </div><div style={{ textAlign: 'center', fontSize: 12, marginTop: 8 }}>{i + 1}</div>
        </div>;
      })}
    </div><div style={{ padding: 20, fontSize: 13, color: TEXT_SUBTLE, textAlign: 'center' }}>페이지를 선택한 뒤 조작하세요 · 더블클릭하면 페이지로 이동합니다</div>
  </div>;
}
