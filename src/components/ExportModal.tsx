import { ACCENT, BORDER, solidAccentBtn } from '../styles/theme';
import type { ExportSettings, ExportFormat } from '../types/pdfEditor';

export interface ExportModalProps {
  open: boolean;
  exportSettings: ExportSettings;
  setExportSettings: React.Dispatch<React.SetStateAction<ExportSettings>>;
  isExporting: boolean;
  onClose: () => void;
  onDownload: () => void;
  onSaveToArchive: () => void;
}

const fmtBase: React.CSSProperties = { flex: 1, border: `1px solid ${BORDER}`, background: '#fff', borderRadius: '7px', padding: '10px 4px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: "'Pretendard',sans-serif", color: 'oklch(40% 0.02 250)' };

export function ExportModal({ open, exportSettings, setExportSettings, isExporting, onClose, onDownload, onSaveToArchive }: ExportModalProps) {
  if (!open) return null;
  const fmtActive: React.CSSProperties = { ...fmtBase, background: ACCENT, color: '#fff', border: `1px solid ${ACCENT}` };

  const setFormat = (format: ExportFormat) => setExportSettings((s) => ({ ...s, format }));
  const isPdf = exportSettings.format === 'pdf';

  const onAction = () => (isPdf ? onDownload() : onSaveToArchive());
  const actionBtnStyle: React.CSSProperties = isPdf && isExporting
    ? { width: '100%', background: 'oklch(88% 0.01 250)', color: 'oklch(55% 0.02 250)', border: 'none', borderRadius: '9px', padding: '12px', fontSize: '13.5px', fontWeight: 700, cursor: 'not-allowed', fontFamily: "'Pretendard',sans-serif" }
    : { ...solidAccentBtn({ padding: '12px', fontSize: '13.5px', borderRadius: '9px' }), width: '100%' };
  const actionLabel = isPdf ? (isExporting ? '내보내는 중…' : 'PDF 다운로드') : '보관함에 저장';

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,25,35,.45)', zIndex: 55, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pdfe-pop .12s ease-out' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 14, padding: 24, width: 420, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,.25)', fontFamily: "'Pretendard',sans-serif" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>내보내기</h2>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: 'oklch(50% 0.02 250)', lineHeight: 1, padding: 4 }}>×</button>
        </div>

        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '15px 16px', marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>내보내기 형식</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setFormat('pdf')} style={exportSettings.format === 'pdf' ? fmtActive : fmtBase}>PDF</button>
            <button onClick={() => setFormat('archive')} style={exportSettings.format === 'archive' ? fmtActive : fmtBase}>보관함 저장</button>
          </div>
        </div>

        <button onClick={onAction} disabled={isPdf && isExporting} style={actionBtnStyle}>{actionLabel}</button>
      </div>
    </div>
  );
}
