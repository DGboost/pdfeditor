import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { BORDER, DANGER, SURFACE, TEXT_MUTED, BORDER_SOFT, FONT_STACK, PANEL_SHADOW, solidAccentBtn, toolBase, fmtBase, fmtActive } from '../styles/theme';

export type ExportActionId = 'download' | 'archive' | 'original';
export interface ExportAction { id: ExportActionId; label: string; run: () => Promise<void> }

export interface ExportModalProps {
  open: boolean;
  actions: ExportAction[];
  selectedAction: ExportActionId;
  onSelectedActionChange: (id: ExportActionId) => void;
  isExporting: boolean;
  onClose: () => void;
}


export function ExportModal({ open, actions, selectedAction, onSelectedActionChange, isExporting, onClose }: ExportModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  useEffect(() => { setError(null); }, [open, selectedAction]);
  if (!open) return null;

  const action = actions.find(item => item.id === selectedAction);
  const locked = isExporting || running;
  const onAction = async () => {
    if (isExporting || runningRef.current || !action) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    try { await action.run(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { runningRef.current = false; setRunning(false); }
  };
  const actionBtnStyle: React.CSSProperties = { ...solidAccentBtn({ padding: 12, fontSize: 14 }), width: '100%', opacity: locked ? .5 : 1, cursor: locked ? 'not-allowed' : 'pointer' };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 55, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={() => { if (!locked) onClose(); }}
    >
      <div
        role="dialog" aria-modal="true" aria-label="내보내기" className="pdfe-panel-enter"
        style={{ background: SURFACE, border: `1px solid ${BORDER_SOFT}`, borderRadius: 24, padding: 20, width: 420, maxWidth: '100%', maxHeight: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: PANEL_SHADOW, fontFamily: FONT_STACK }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 500, margin: 0 }}>내보내기</h2>
          <button disabled={locked} onClick={onClose} aria-label="닫기" style={toolBase}><X size={24} strokeWidth={1.5} /></button>
        </div>

        <div className="pdfe-scroll" style={{ minHeight: 0, overflowY: 'auto', marginBottom: 20 }}>
          <div style={{ fontSize: 14, color: TEXT_MUTED, marginBottom: 12 }}>내보내기 작업</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 4, background: 'var(--pdfe-selected, #f3f4f6)', border: `1px solid ${BORDER}`, borderRadius: 20 }}>
            {actions.map(item => <button key={item.id} disabled={locked} aria-pressed={selectedAction === item.id} onClick={() => onSelectedActionChange(item.id)} style={selectedAction === item.id ? fmtActive : fmtBase}>{item.label}</button>)}
          </div>
        </div>

        {error && <p role="alert" style={{ color: DANGER, overflowWrap: 'anywhere' }}>{error}</p>}
        <button className="pdfe-primary-button" onClick={() => void onAction()} disabled={locked || !action} style={{ ...actionBtnStyle, flexShrink: 0 }}>{locked ? '처리 중…' : action?.label ?? '작업을 선택하세요'}</button>
      </div>
    </div>
  );
}
