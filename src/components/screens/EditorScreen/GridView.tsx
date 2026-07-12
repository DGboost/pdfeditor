import { useState } from 'react';
import type { Page } from '../../../types/pdfEditor';
import { ACCENT, BORDER } from '../../../styles/theme';

export interface GridViewProps {
  pages: Page[];
  onClose: () => void;
  onOpenPage: (id: string) => void;
  onAddPage: () => void;
  onRotatePage: (id: string, delta: number) => void;
  onDuplicatePage: (id: string) => void;
  onDeletePage: (id: string) => void;
}

export function GridView({ pages, onClose, onOpenPage, onAddPage, onRotatePage, onDuplicatePage, onDeletePage }: GridViewProps) {
  const rotTransform = (deg: number): React.CSSProperties => (deg ? { transform: `rotate(${deg}deg)` } : {});
  const [focusId, setFocusId] = useState<string | null>(null);
  const rotateDisabled = !focusId;
  const headerBtnStyle = { whiteSpace: 'nowrap' as const, flex: '0 0 auto', border: '1px solid oklch(85% 0.01 250)', background: '#fff', borderRadius: 7, padding: '8px 16px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: "'Pretendard',sans-serif", color: 'oklch(30% 0.02 250)' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'oklch(97% 0.005 250)', zIndex: 40, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 56, flex: '0 0 56px', display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', borderBottom: `1px solid ${BORDER}`, background: '#fff' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>모든 페이지 ({pages.length})</span>
        <div style={{ flex: 1 }} />
        <button onClick={onAddPage} style={headerBtnStyle}>+ 추가</button>
        <button onClick={() => focusId && onRotatePage(focusId, -90)} disabled={rotateDisabled} style={{ ...headerBtnStyle, opacity: rotateDisabled ? 0.5 : 1, cursor: rotateDisabled ? 'not-allowed' : 'pointer' }}>↺ 왼쪽</button>
        <button onClick={() => focusId && onRotatePage(focusId, 90)} disabled={rotateDisabled} style={{ ...headerBtnStyle, opacity: rotateDisabled ? 0.5 : 1, cursor: rotateDisabled ? 'not-allowed' : 'pointer' }}>↻ 오른쪽</button>
        <div style={{ width: 1, height: 22, background: 'oklch(88% 0.01 250)', flex: '0 0 auto' }} />
        <button onClick={onClose} style={{ whiteSpace: 'nowrap', flex: '0 0 auto', border: 'none', background: ACCENT, color: '#fff', borderRadius: 7, padding: '8px 20px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: "'Pretendard',sans-serif" }}>완료</button>
      </div>
      <div className="pdfe-scroll" style={{ flex: 1, overflowY: 'auto', padding: '28px 32px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '24px 18px', alignContent: 'start' }}>
        {pages.map((p, i) => {
          const isPdf = p.kind === 'pdf';
          const rot = p.rotation || 0;
          const thumb = isPdf ? p.pdfThumb : undefined;
          const isFocused = p.id === focusId;
          return (
            <div
              key={p.id}
              onClick={() => setFocusId(p.id)}
              onDoubleClick={() => onOpenPage(p.id)}
              style={{ cursor: 'pointer', border: isFocused ? `2px solid ${ACCENT}` : '2px solid transparent', borderRadius: 10, padding: 8 }}
            >
              <div style={{ width: '100%', aspectRatio: '3 / 4', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, background: isPdf && thumb ? `#fff url(${thumb}) no-repeat center / cover` : '#fff', ...rotTransform(rot) }} />
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(20,28,42,.4)', opacity: 0, transition: 'opacity .12s', borderRadius: 6, pointerEvents: 'none' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.pointerEvents = 'auto'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.pointerEvents = 'none'; }}
                >
                  <button onClick={(e) => { e.stopPropagation(); onDuplicatePage(p.id); }} title="복제" style={{ width: 28, height: 28, borderRadius: '50%', background: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }}>
                    <div style={{ width: 12, height: 12, position: 'relative' }}>
                      <div style={{ position: 'absolute', left: 0, top: 0, width: 9, height: 9, border: '1.5px solid oklch(35% 0.02 250)', borderRadius: 1 }} />
                      <div style={{ position: 'absolute', right: 0, bottom: 0, width: 9, height: 9, border: '1.5px solid oklch(35% 0.02 250)', borderRadius: 1, background: '#fff' }} />
                    </div>
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); onRotatePage(p.id, 90); }} title="회전 (PDF 페이지만 지원)" style={{ width: 28, height: 28, borderRadius: '50%', background: '#fff', border: 'none', cursor: isPdf ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.25)', opacity: isPdf ? 1 : 0.4 }}>
                    <div style={{ width: 13, height: 13, border: '1.5px solid oklch(35% 0.02 250)', borderRadius: '50%', borderBottomColor: 'transparent', borderLeftColor: 'transparent' }} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); onDeletePage(p.id); }} title="삭제" style={{ width: 28, height: 28, borderRadius: '50%', background: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.25)', fontSize: 14, color: 'oklch(45% 0.15 25)', lineHeight: 1 }}>×</button>
                </div>
              </div>
              <div style={{ textAlign: 'center', fontSize: '11.5px', color: 'oklch(45% 0.02 250)', marginTop: 8 }}>{i + 1}</div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '10px 20px', fontSize: '11.5px', color: 'oklch(50% 0.02 250)', textAlign: 'center', borderTop: `1px solid ${BORDER}`, background: '#fff' }}>페이지를 클릭해 선택한 뒤 회전하세요 · 더블클릭하면 해당 페이지로 이동합니다</div>
    </div>
  );
}
