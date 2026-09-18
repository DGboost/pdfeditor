import { X } from 'lucide-react';
import { BORDER, SURFACE, TEXT_MUTED, BORDER_SOFT, FONT_STACK, PANEL_SHADOW, solidAccentBtn, toolBase, fmtBase, fmtActive } from '../styles/theme';
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


export function ExportModal({ open, exportSettings, setExportSettings, isExporting, onClose, onDownload, onSaveToArchive }: ExportModalProps) {
  if (!open) return null;

  const setFormat = (format: ExportFormat) => setExportSettings((s) => ({ ...s, format }));
  const isPdf = exportSettings.format === 'pdf';

  const onAction = () => { if (!isExporting) { if (isPdf) onDownload(); else onSaveToArchive(); } };
  const actionBtnStyle: React.CSSProperties = { ...solidAccentBtn({ padding: 12, fontSize: 14 }), width: '100%', opacity: isExporting ? .5 : 1, cursor: isExporting ? 'not-allowed' : 'pointer' };
  const actionLabel = isExporting ? (isPdf ? '내보내는 중…' : '저장 중…') : (isPdf ? 'PDF 다운로드' : '보관함에 저장');

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 55, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={() => { if (!isExporting) onClose(); }}
    >
      <div
        role="dialog" aria-modal="true" aria-label="내보내기" className="pdfe-panel-enter"
        style={{ background: SURFACE, border: `1px solid ${BORDER_SOFT}`, borderRadius: 24, padding: 20, width: 420, maxWidth: '100%', maxHeight: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: PANEL_SHADOW, fontFamily: FONT_STACK }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 500, margin: 0 }}>내보내기</h2>
          <button disabled={isExporting} onClick={onClose} aria-label="닫기" style={toolBase}><X size={24} strokeWidth={1.5} /></button>
        </div>

        <div className="pdfe-scroll" style={{ minHeight: 0, overflowY: 'auto', marginBottom: 20 }}>
          <div style={{ fontSize: 14, color: TEXT_MUTED, marginBottom: 12 }}>내보내기 형식</div>
          <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--pdfe-selected, #f3f4f6)', border: `1px solid ${BORDER}`, borderRadius: 999 }}>
            <button disabled={isExporting} aria-pressed={exportSettings.format === 'pdf'} onClick={() => setFormat('pdf')} style={exportSettings.format === 'pdf' ? fmtActive : fmtBase}>PDF</button>
            <button disabled={isExporting} aria-pressed={exportSettings.format === 'archive'} onClick={() => setFormat('archive')} style={exportSettings.format === 'archive' ? fmtActive : fmtBase}>보관함 저장</button>
          </div>
        </div>

        <button className="pdfe-primary-button" onClick={onAction} disabled={isExporting} style={{ ...actionBtnStyle, flexShrink: 0 }}>{actionLabel}</button>
      </div>
    </div>
  );
}
