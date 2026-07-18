import { useRef } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import { ACCENT, BG, SURFACE_SOFT, BORDER, BORDER_STRONG, TEXT, TEXT_MUTED, TEXT_SUBTLE } from '../../styles/theme';

export interface UploadScreenProps {
  fileName: string;
  dragOver: boolean;
  uploading: boolean;
  uploadSlowHint: boolean;
  uploadError: string | null;
  onDragOverChange: (v: boolean) => void;
  onFile: (file: File) => void;
  onSample: () => void;
}

export function UploadScreen({ fileName, dragOver, uploading, uploadSlowHint, uploadError, onDragOverChange, onFile, onSample }: UploadScreenProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onDragOver = (e: DragEvent) => { e.preventDefault(); onDragOverChange(true); };
  const onDragLeave = () => onDragOverChange(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    onDragOverChange(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  };
  const onDropzoneClick = () => fileInputRef.current?.click();
  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = '';
  };

  const dropzoneBorder = dragOver ? `1.5px solid ${ACCENT}` : `1.5px dashed ${BORDER_STRONG}`;
  const dropzoneBg = dragOver ? 'color-mix(in srgb, var(--accent) 7%, var(--pdfe-surface, #fff))' : SURFACE_SOFT;

  return (
    <div data-screen-label="업로드" className="pdfe-scroll" style={{ height: '100%', overflowY: 'auto', display: 'flex', justifyContent: 'center', background: BG, padding: 32 }}>
      <div style={{ maxWidth: 640, width: '100%', margin: 'auto 0', padding: '48px 40px 80px' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 11px',
            border: `1px solid ${BORDER}`,
            borderRadius: 999,
            fontSize: '11.5px',
            color: TEXT_SUBTLE,
            marginBottom: 22,
            fontFamily: "'Spline Sans Mono',monospace",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT }}></span>
          PDF WORKSPACE · AI DOCUMENT EDITOR
        </div>
        <h1 style={{ fontSize: 40, lineHeight: 1.12, fontWeight: 800, letterSpacing: '-1.4px', margin: '0 0 12px' }}>
          PDF를 열어서<br />바로 수정하세요
        </h1>
        <p style={{ fontSize: 16, color: TEXT_MUTED, margin: '0 0 34px', maxWidth: 520, lineHeight: 1.55 }}>
          문서를 첨부하거나 불러오세요. <b style={{ color: TEXT, fontWeight: 600 }}>AI</b>가 문서의 텍스트 레이어를 분석하여 브라우저에서 바로 안전하게 편집할 수 있도록 도와드립니다.
        </p>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            padding: '48px 24px',
            borderRadius: 18,
            cursor: 'pointer',
            transition: '.15s',
            border: dropzoneBorder,
            background: dropzoneBg,
            marginBottom: 24,
          }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={onDropzoneClick}
        >
          {uploading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0' }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', border: `3px solid ${BORDER}`, borderTopColor: ACCENT, animation: 'pdfe-spin .8s linear infinite' }} />
              <div style={{ fontSize: 14, color: TEXT_MUTED }}>{fileName} 불러오는 중…</div>
              {uploadSlowHint && (
                <div style={{ fontSize: 12.5, color: TEXT_SUBTLE, maxWidth: 280, textAlign: 'center', lineHeight: 1.6 }}>
                  평소보다 오래 걸리고 있어요. 이 탭을 다른 창으로 전환하지 않고 열어두면 더 빨라집니다.
                </div>
              )}
            </div>
          ) : (
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 16,
                  background: ACCENT,
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px',
                }}
              >
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V4"></path>
                  <path d="m7.5 8.5 4.5-4.5 4.5 4.5"></path>
                  <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"></path>
                </svg>
              </div>
              <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 4 }}>
                {dragOver ? '여기에 놓으세요' : 'PDF 파일 첨부하기'}
              </div>
              <div style={{ fontSize: 12.5, color: TEXT_SUBTLE, lineHeight: 1.5 }}>
                클릭해서 업로드 또는 파일을 여기로 드래그
              </div>
            </div>
          )}
        </div>
        <input ref={fileInputRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onFileInputChange} />

        {uploadError && (
          <div style={{ marginTop: 14, fontSize: 12.5, color: '#e0553d' }}>{uploadError}</div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22, fontSize: 12.5, color: TEXT_SUBTLE }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a' }} />
          모든 파일은 SSL로 암호화되어 전송되며, 편집 후 자동으로 폐기됩니다
        </div>
      </div>
    </div>
  );
}
