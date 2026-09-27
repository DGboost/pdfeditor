import { useRef, useState } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import { Upload, ShieldCheck } from 'lucide-react';
import type { LibraryItem, LibraryKey } from '../../documents/officeTypes';
import { ACCENT, BG, SURFACE, SURFACE_SOFT, BORDER, BORDER_SOFT, BORDER_STRONG, TEXT, TEXT_MUTED, TEXT_SUBTLE, DANGER, FONT_STACK, PANEL_SHADOW, outlineAccentBtn } from '../../styles/theme';

export interface UploadScreenProps {
  fileName: string;
  dragOver: boolean;
  uploading: boolean;
  uploadSlowHint: boolean;
  uploadError: string | null;
  onDragOverChange: (v: boolean) => void;
  onFile: (file: File) => void;
  drafts: LibraryItem[];
  archives: LibraryItem[];
  retainedDrafts: LibraryItem[];
  onOpen: (key: LibraryKey) => void;
  onDelete: (key: LibraryKey) => void;
  onDownloadRetained: (key: LibraryKey) => void;
  onOpenRetainedOriginal: (key: LibraryKey) => void;
  onDownloadOriginal: (key: LibraryKey) => void;
}

const libraryButtonStyle = outlineAccentBtn({ border: `1px solid ${BORDER}`, color: TEXT, padding: '6px 12px', fontSize: 14, fontWeight: 400 });
const viewButtonStyle = (active: boolean, disabled: boolean) => ({
  border: `1px solid ${active ? ACCENT : BORDER}`,
  borderRadius: 999,
  padding: '7px 14px',
  color: active ? TEXT : TEXT_MUTED,
  background: active ? SURFACE_SOFT : SURFACE,
  fontSize: 14,
  fontWeight: active ? 600 : 400,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

export function UploadScreen({ fileName, dragOver, uploading, uploadSlowHint, uploadError, onDragOverChange, onFile, drafts, archives, retainedDrafts, onOpen, onDelete, onDownloadRetained, onOpenRetainedOriginal, onDownloadOriginal }: UploadScreenProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState<'home' | 'import'>('home');
  const onViewChange = (next: 'home' | 'import') => {
    if (uploading || next === view) return;
    onDragOverChange(false);
    setView(next);
  };

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
  const recentDocuments = [...drafts, ...archives].sort((a, b) => b.savedAt - a.savedAt);
  const libraryGroups = view === 'home'
    ? [
      { title: '최근 문서', items: recentDocuments, empty: '최근 문서가 없습니다.' },
      { title: '보관한 문서', items: archives, empty: '보관한 문서가 없습니다.' },
      { title: '이전 작업 백업', items: retainedDrafts, empty: '이전 작업 백업이 없습니다.' },
    ]
    : [{ title: '보관한 문서', items: archives, empty: '보관한 문서가 없습니다.' }];
  const loadingIndicator = (
    <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', border: `1px solid ${BORDER}`, borderRadius: 12, background: SURFACE_SOFT, marginBottom: 20 }}>
      <div style={{ width: 34, height: 34, flexShrink: 0, borderRadius: '50%', border: `3px solid ${BORDER}`, borderTopColor: ACCENT, animation: 'pdfe-spin .8s linear infinite' }} />
      <div>
        <div style={{ fontSize: 14, color: TEXT_MUTED }}>문서 처리 중…</div>
        {fileName && <div style={{ fontSize: 13, color: TEXT_SUBTLE, overflowWrap: 'anywhere' }}>현재 문서: {fileName}</div>}
        {uploadSlowHint && (
          <div style={{ fontSize: 13, color: TEXT_SUBTLE, maxWidth: 280, lineHeight: 1.6 }}>
            문서를 처리하고 있습니다. 완료될 때까지 기다려 주세요.
          </div>
        )}
      </div>
    </div>
  );
  const privacyNotice = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, fontSize: 13, color: TEXT_MUTED }}>
      <ShieldCheck size={22} strokeWidth={1.5} style={{ flexShrink: 0 }} />
      문서는 이 브라우저에서 처리되며, 임시 저장과 보관함은 이 기기에 저장됩니다.
    </div>
  );

  return (
    <div data-screen-label={view === 'home' ? '내 문서' : '불러오기'} className="pdfe-scroll pdfe-screen-enter" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', justifyContent: 'center', background: BG, padding: 20 }}>
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
          DOCUMENT WORKSPACE · DOCUMENT EDITOR
        </div>
        <h1 style={{ fontSize: 21, lineHeight: 1.4, fontWeight: 700, margin: '0 0 12px' }}>
          {view === 'home' ? '내 문서' : '불러오기'}
        </h1>
        <nav aria-label="문서 화면" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
          <button type="button" aria-pressed={view === 'home'} disabled={uploading} style={viewButtonStyle(view === 'home', uploading)} onClick={() => onViewChange('home')}>내 문서</button>
          <button type="button" aria-pressed={view === 'import'} disabled={uploading} style={viewButtonStyle(view === 'import', uploading)} onClick={() => onViewChange('import')}>불러오기</button>
        </nav>
        {uploadError && (
          <div role="alert" style={{ marginBottom: 20, fontSize: 13, color: DANGER }}>{uploadError}</div>
        )}
        {uploading && loadingIndicator}
        {view === 'home' && (
          <section aria-label="문서 요약" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[
              { title: '진행 중인 작업', value: `${drafts.length}개`, description: '저장된 작업을 이어서 편집합니다.' },
              { title: '양식 저장소', value: `${archives.length}개`, description: '보관한 문서를 다시 불러옵니다.' },
              { title: '지원 형식', value: 'HWP · HWPX · PDF · DOCX', description: '기존 PPTX 편집도 유지됩니다.' },
            ].map(card => (
              <div key={card.title} style={{ padding: 16, border: `1px solid ${BORDER}`, borderRadius: 12, background: SURFACE_SOFT }}>
                <h2 style={{ fontSize: 14, color: TEXT_MUTED, margin: '0 0 8px' }}>{card.title}</h2>
                <p style={{ fontSize: 18, fontWeight: 600, color: TEXT, margin: '0 0 8px' }}>{card.value}</p>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: TEXT_SUBTLE, margin: 0 }}>{card.description}</p>
              </div>
            ))}
          </section>
        )}
        {view === 'import' && <>
          <p style={{ fontSize: 14, color: TEXT_MUTED, margin: '0 0 20px', maxWidth: 520, lineHeight: 1.6 }}>
            PDF, DOCX, HWP, HWPX, PPTX 문서를 브라우저에서 열고 편집합니다. 스캔 PDF는 텍스트 인식 없이 원본으로 표시됩니다.
          </p>
          <p style={{ fontSize: 13, color: TEXT_SUBTLE, margin: '0 0 20px', maxWidth: 520, lineHeight: 1.6 }}>
            DOC/PPT는 직접 편집하지 않습니다. DOCX/PPTX로 변환한 파일을 열어 주세요.
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
            aria-label="내 컴퓨터에서 찾기"
            aria-disabled={uploading}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDropzoneClick(); } }}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={onDropzoneClick}
          >
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
                {dragOver ? '여기에 놓으세요' : '내 컴퓨터에서 찾기'}
              </div>
              <div style={{ fontSize: 13, color: TEXT_SUBTLE, lineHeight: 1.5 }}>
                클릭해서 업로드 또는 파일을 여기로 드래그
              </div>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept=".pdf,.docx,.hwp,.hwpx,.pptx,.doc,.ppt" disabled={uploading} style={{ display: 'none' }} onChange={onFileInputChange} />
        </>}
        {privacyNotice}

        {libraryGroups.map(group => <section key={group.title} aria-label={group.title} style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 500 }}>{group.title}</h2>
          {group.items.length === 0 && <p style={{ color: TEXT_MUTED }}>{group.empty}</p>}
          {group.items.map(item => <div key={`${item.key.namespace}:${item.key.kind}:${item.key.id}`} style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
            <div style={{ color: TEXT, fontWeight: 600, overflowWrap: 'anywhere' }}>
              {item.format && <span style={{ fontSize: 11, marginRight: 8 }}>{item.format.toUpperCase()}</span>}
              {item.fileName}
            </div>
            {item.reason && <p style={{ color: TEXT_MUTED, fontSize: 13 }}>{item.reason}</p>}
            <div style={{ color: TEXT_SUBTLE, fontSize: 13, margin: '6px 0 10px' }}>
              {new Date(item.savedAt).toLocaleString()}{item.pageCount !== undefined && ` · ${item.pageCount}페이지`}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {item.key.kind === 'retained' ? <>
                <button style={libraryButtonStyle} disabled={uploading} onClick={() => onDownloadRetained(item.key)}>백업 다운로드</button>
                <button style={libraryButtonStyle} disabled={uploading} onClick={() => onOpenRetainedOriginal(item.key)}>보존 원본 열기</button>
              </> : <button style={libraryButtonStyle} disabled={uploading} onClick={() => onOpen(item.key)}>{item.key.kind === 'draft' ? '작업 복구' : '열기'}</button>}
              {item.key.namespace === 'office' && item.key.kind !== 'retained' && <button style={libraryButtonStyle} disabled={uploading} onClick={() => onDownloadOriginal(item.key)}>보존 원본 다운로드</button>}
              {item.key.kind !== 'draft' && <button style={libraryButtonStyle} disabled={uploading} onClick={() => onDelete(item.key)}>삭제</button>}
            </div>
          </div>)}
        </section>)}
      </div>
    </div>
  );
}
