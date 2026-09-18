import { useRef } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import { Upload, ShieldCheck } from 'lucide-react';
import type { ArchiveSummary, RetainedDraftSummary } from '../../utils/db';
import { ACCENT, BG, SURFACE, SURFACE_SOFT, BORDER, BORDER_SOFT, BORDER_STRONG, TEXT, TEXT_MUTED, TEXT_SUBTLE, DANGER, FONT_STACK, PANEL_SHADOW, outlineAccentBtn } from '../../styles/theme';

export interface UploadScreenProps {
  fileName: string;
  dragOver: boolean;
  uploading: boolean;
  uploadSlowHint: boolean;
  uploadError: string | null;
  onDragOverChange: (v: boolean) => void;
  onFile: (file: File) => void;
  archives: ArchiveSummary[];
  retainedDrafts: RetainedDraftSummary[];
  onOpenArchive: (id: string) => void;
  onDeleteArchive: (id: string) => void;
  onDownloadRetained: (id: number) => void;
  onDeleteRetained: (id: number) => void;
}

const libraryButtonStyle = outlineAccentBtn({ border: `1px solid ${BORDER}`, color: TEXT, padding: '6px 12px', fontSize: 14, fontWeight: 400, borderRadius: 8 });

export function UploadScreen({ fileName, dragOver, uploading, uploadSlowHint, uploadError, onDragOverChange, onFile, archives, retainedDrafts, onOpenArchive, onDeleteArchive, onDownloadRetained, onDeleteRetained }: UploadScreenProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onDragOver = (e: DragEvent) => { e.preventDefault(); onDragOverChange(true); };
  const onDragLeave = () => onDragOverChange(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    onDragOverChange(false);
    const f = e.dataTransfer?.files?.[0];
    if (f && !uploading) onFile(f);
  };
  const onDropzoneClick = () => { if (!uploading) fileInputRef.current?.click(); };
  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f && !uploading) onFile(f);
    e.target.value = '';
  };

  const dropzoneBorder = dragOver ? `1px solid ${ACCENT}` : `1px dashed ${BORDER_STRONG}`;
  const dropzoneBg = dragOver ? 'var(--pdfe-selected, #f3f4f6)' : SURFACE_SOFT;

  return (
    <div data-screen-label="업로드" className="pdfe-scroll pdfe-screen-enter" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', justifyContent: 'center', background: BG, padding: 20 }}>
      <div style={{ maxWidth: 640, width: '100%', margin: 'auto 0', padding: 20, background: SURFACE, border: `1px solid ${BORDER_SOFT}`, borderRadius: 24, boxShadow: PANEL_SHADOW }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 11px',
            border: `1px solid ${BORDER}`,
            borderRadius: 999,
            fontSize: 13,
            color: TEXT_SUBTLE,
            marginBottom: 20,
            fontFamily: FONT_STACK,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT }}></span>
          PDF WORKSPACE · DOCUMENT EDITOR
        </div>
        <h1 style={{ fontSize: 21, lineHeight: 1.4, fontWeight: 700, margin: '0 0 12px' }}>
          PDF를 열어서<br />바로 수정하세요
        </h1>
        <p style={{ fontSize: 14, color: TEXT_MUTED, margin: '0 0 20px', maxWidth: 520, lineHeight: 1.6 }}>
          PDF를 브라우저에서 열고 편집합니다. 스캔 문서는 텍스트 인식 없이 원본으로 표시됩니다.
        </p>

        <div
          className="pdfe-upload-target"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            padding: '32px 20px',
            borderRadius: 24,
            cursor: uploading ? 'not-allowed' : 'pointer',
            border: dropzoneBorder,
            background: `var(--pdfe-button-bg, ${dropzoneBg})`,
            marginBottom: 20,
            opacity: uploading ? .5 : 1,
          }}
          role="button"
          tabIndex={uploading ? -1 : 0}
          aria-label="PDF 파일 첨부하기"
          aria-disabled={uploading}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDropzoneClick(); } }}
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
                <div style={{ fontSize: 13, color: TEXT_SUBTLE, maxWidth: 280, textAlign: 'center', lineHeight: 1.6 }}>
                  문서를 처리하고 있습니다. 완료될 때까지 기다려 주세요.
                </div>
              )}
            </div>
          ) : (
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 999,
                  background: SURFACE,
                  color: TEXT,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px',
                }}
              >
                <Upload size={22} strokeWidth={1.5} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
                {dragOver ? '여기에 놓으세요' : 'PDF 파일 첨부하기'}
              </div>
              <div style={{ fontSize: 13, color: TEXT_SUBTLE, lineHeight: 1.5 }}>
                클릭해서 업로드 또는 파일을 여기로 드래그
              </div>
            </div>
          )}
        </div>
        <input ref={fileInputRef} type="file" accept="application/pdf" disabled={uploading} style={{ display: 'none' }} onChange={onFileInputChange} />

        {uploadError && (
          <div role="alert" style={{ marginTop: 14, fontSize: 13, color: DANGER }}>{uploadError}</div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, fontSize: 13, color: TEXT_MUTED }}>
          <ShieldCheck size={22} strokeWidth={1.5} style={{ flexShrink: 0 }} />
          문서는 이 브라우저에서 처리되며, 임시 저장과 보관함은 이 기기에 저장됩니다.
        </div>

        <section aria-label="보관함" style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 500 }}>보관함</h2>
          {archives.length === 0 && <p style={{ color: TEXT_MUTED }}>보관함에 저장된 문서가 없습니다</p>}
          {archives.map(archive => (
            <div key={archive.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
              <div style={{ color: TEXT, fontWeight: 600, overflowWrap: 'anywhere' }}>{archive.fileName}</div>
              <div style={{ color: TEXT_SUBTLE, fontSize: 13, margin: '6px 0 10px' }}>{new Date(archive.savedAt).toLocaleString()} · {archive.pageCount}페이지</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={libraryButtonStyle} disabled={uploading} onClick={() => onOpenArchive(archive.id)}>열기</button>
                <button style={libraryButtonStyle} disabled={uploading} onClick={() => onDeleteArchive(archive.id)}>삭제</button>
              </div>
            </div>
          ))}
        </section>
        <section aria-label="이전 작업 백업" style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 500 }}>이전 작업 백업</h2>
          {retainedDrafts.length === 0 && <p style={{ color: TEXT_MUTED }}>이전 작업 백업이 없습니다</p>}
          {retainedDrafts.map(backup => (
            <div key={backup.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
              <div style={{ color: TEXT, fontWeight: 600 }}>백업 #{backup.id} · {backup.kind === 'legacy' ? '구버전 작업' : '복구하지 못한 작업'}</div>
              <p style={{ color: TEXT_MUTED, fontSize: 13 }}>{backup.reason}</p>
              <div style={{ color: TEXT_SUBTLE, fontSize: 13, marginBottom: 10 }}>{new Date(backup.savedAt).toLocaleString()}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={libraryButtonStyle} disabled={uploading} onClick={() => onDownloadRetained(backup.id)}>백업 다운로드</button>
                <button style={libraryButtonStyle} disabled={uploading} onClick={() => onDeleteRetained(backup.id)}>삭제</button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
