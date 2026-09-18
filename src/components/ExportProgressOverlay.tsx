import { spinnerAccentStyle, SURFACE, TEXT_MUTED, BORDER_SOFT, FONT_STACK, PANEL_SHADOW } from '../styles/theme';

export interface ExportProgressOverlayProps {
  progress: { current: number; total: number } | null;
}

export function ExportProgressOverlay({ progress }: ExportProgressOverlayProps) {
  if (!progress) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 90, padding: 20,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div role="status" style={{
        background: SURFACE, border: `1px solid ${BORDER_SOFT}`, borderRadius: 24, padding: 20, display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 20, boxShadow: PANEL_SHADOW, minWidth: 220, maxWidth: '100%',
      }}>
        <div style={spinnerAccentStyle(34, 3)} />
        <div style={{ fontSize: 14, fontWeight: 500, fontFamily: FONT_STACK }}>PDF로 내보내는 중…</div>
        <div style={{ fontSize: 13, color: TEXT_MUTED, fontFamily: FONT_STACK }}>
          {progress.current} / {progress.total} 페이지
        </div>
      </div>
    </div>
  );
}
