import { spinnerAccentStyle, SURFACE, TEXT_SUBTLE } from '../styles/theme';

export interface ExportProgressOverlayProps {
  progress: { current: number; total: number } | null;
}

export function ExportProgressOverlay({ progress }: ExportProgressOverlayProps) {
  if (!progress) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(23,23,26,.55)', zIndex: 90,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: SURFACE, borderRadius: 14, padding: '28px 36px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 14, boxShadow: '0 20px 60px rgba(0,0,0,.25)', minWidth: 220,
      }}>
        <div style={spinnerAccentStyle(34, 3)} />
        <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "'Pretendard',sans-serif" }}>PDF로 내보내는 중…</div>
        <div style={{ fontSize: 12.5, color: TEXT_SUBTLE, fontFamily: "'Pretendard',sans-serif" }}>
          {progress.current} / {progress.total} 페이지
        </div>
      </div>
    </div>
  );
}
