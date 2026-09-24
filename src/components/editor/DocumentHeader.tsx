import { Download, FileText } from 'lucide-react';
import type { DocumentFormat } from '../../documents/formats';
import { BORDER, DANGER, SURFACE, TEXT, TEXT_SUBTLE, solidAccentBtn } from '../../styles/theme';

export interface DocumentHeaderProps {
  fileName: string;
  busy: boolean;
  preserveEditorFocus?: boolean;
  format: DocumentFormat;
  onFileNameChange: (name: string) => void;
  onHome: () => void;
  onExport: () => void;
  saveLabel: string;
  saveError: string | null;
  onRetrySave?: () => void;
}

export function DocumentHeader(p: DocumentHeaderProps) {
  return <>
    <header className="pdfe-editor-header" style={{ position: 'relative', display: 'flex', alignItems: 'center', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      <button className="pdfe-brand" disabled={p.busy} onPointerDown={e => { if (p.preserveEditorFocus !== false) e.preventDefault(); }} onClick={p.onHome} style={{ background: 'var(--pdfe-button-bg, transparent)', border: 0, height: 32, borderRadius: 9999, fontSize: 17, fontWeight: 500, letterSpacing: '-.025em', color: TEXT, flexShrink: 0 }}>문서 편집</button>
      <div className="pdfe-filename" style={{ minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileText size={22} strokeWidth={1.5} />
        <input aria-label="파일명" title={p.fileName} disabled={p.busy} value={p.fileName} onChange={e => p.onFileNameChange(e.target.value)} style={{ width: 220, minWidth: 0, maxWidth: '100%', height: 32, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '6px 12px', background: SURFACE, color: TEXT, fontSize: 14, fontWeight: 500, textOverflow: 'ellipsis' }} />
      </div>
      <span aria-label="문서 형식" style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '3px 6px', fontSize: 12, flexShrink: 0 }}>{p.format.toUpperCase()}</span>
      <span role="status" style={{ color: p.saveError ? DANGER : TEXT_SUBTLE, fontSize: 13 }}>{p.saveLabel}</span>
      <button className="pdfe-primary-button" disabled={p.busy} onPointerDown={e => { if (p.preserveEditorFocus !== false) e.preventDefault(); }} onClick={p.onExport} style={solidAccentBtn({ height: 32, borderRadius: 9999, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 })}><Download size={22} strokeWidth={1.5} />내보내기</button>
    </header>
    {p.saveError && <div role="alert" style={{ padding: '8px 20px', color: DANGER, background: SURFACE, borderBottom: `1px solid ${BORDER}`, overflowWrap: 'anywhere' }}>
      {p.saveError} {p.onRetrySave && <button disabled={p.busy} onPointerDown={e => { if (p.preserveEditorFocus !== false) e.preventDefault(); }} onClick={p.onRetrySave}>다시 시도</button>}
    </div>}
  </>;
}
