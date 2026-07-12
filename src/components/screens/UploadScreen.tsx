import { useRef } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import { ACCENT } from '../../styles/theme';

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

const featureList = [
  { title: '텍스트 직접 수정', desc: '문서 내 텍스트를 클릭해서 바로 고쳐쓰세요' },
  { title: '전자서명 필드', desc: '서명란을 추가하고 마우스로 직접 서명하세요' },
  { title: '주석과 하이라이트', desc: '문서에 댓글을 남기고 중요한 부분을 강조하세요' },
];

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

  const dropzoneBorderColor = dragOver ? ACCENT : 'oklch(82% 0.01 250)';
  const dropzoneBg = dragOver ? 'oklch(96% 0.02 250)' : '#fff';

  return (
    <div data-screen-label="업로드" className="pdfe-scroll" style={{ height: '100%', overflowY: 'auto', display: 'flex', justifyContent: 'center', padding: 32 }}>
      <div style={{ display: 'flex', gap: 64, alignItems: 'center', maxWidth: 960, width: '100%', margin: 'auto 0' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 12, height: 14, border: '2px solid #fff', borderRadius: 2 }} />
            </div>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em' }}>DocEdit</span>
          </div>
          <h1 style={{ fontSize: 34, lineHeight: 1.25, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 12px' }}>
            PDF를 열어서<br />바로 수정하세요
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'oklch(45% 0.02 250)', margin: '0 0 32px', maxWidth: 380 }}>
            텍스트 수정, 이미지 삽입, 전자서명, 주석까지 — 브라우저에서 바로 편집하고 안전하게 내보냅니다.
          </p>

          <div
            style={{ border: `2px dashed ${dropzoneBorderColor}`, borderRadius: 14, padding: '40px 32px', textAlign: 'center', background: dropzoneBg, transition: 'background .15s,border-color .15s', cursor: 'pointer' }}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={onDropzoneClick}
          >
            {uploading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0' }}>
                <div style={{ width: 34, height: 34, borderRadius: '50%', border: '3px solid oklch(90% 0.01 250)', borderTopColor: ACCENT, animation: 'pdfe-spin .8s linear infinite' }} />
                <div style={{ fontSize: 14, color: 'oklch(45% 0.02 250)' }}>{fileName} 불러오는 중…</div>
                {uploadSlowHint && (
                  <div style={{ fontSize: 12.5, color: 'oklch(55% 0.02 250)', maxWidth: 280, textAlign: 'center', lineHeight: 1.6 }}>
                    평소보다 오래 걸리고 있어요. 이 탭을 다른 창으로 전환하지 않고 열어두면 더 빨라집니다.
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div style={{ width: 52, height: 52, borderRadius: 12, background: 'oklch(93% 0.01 250)', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 20, height: 24, border: `2.5px solid ${ACCENT}`, borderRadius: 3, position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 4, top: 5, width: 8, height: 2, background: ACCENT }} />
                    <div style={{ position: 'absolute', left: 4, top: 10, width: 8, height: 2, background: ACCENT }} />
                  </div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>여기로 파일을 끌어다 놓으세요</div>
                <div style={{ fontSize: 13, color: 'oklch(50% 0.02 250)', marginBottom: 18 }}>또는</div>
                <button style={{ background: ACCENT, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'Pretendard',sans-serif", fontWeight: 600, padding: '11px 22px', fontSize: 14 }}>
                  파일 선택
                </button>
                <div style={{ fontSize: 12, color: 'oklch(55% 0.02 250)', marginTop: 14 }}>지원 형식: PDF · 최대 50MB</div>
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onFileInputChange} />

          {uploadError && (
            <div style={{ marginTop: 14, fontSize: 12.5, color: 'oklch(55% 0.16 25)' }}>{uploadError}</div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22, fontSize: 12.5, color: 'oklch(50% 0.02 250)' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'oklch(55% 0.13 150)' }} />
            모든 파일은 SSL로 암호화되어 전송되며, 편집 후 자동으로 폐기됩니다
          </div>
          <button
            onClick={onSample}
            style={{ border: 'none', background: 'none', color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 10, padding: 0, textDecoration: 'underline' }}
          >
            또는 샘플 계약서로 체험하기
          </button>
        </div>

        <div style={{ flex: '0 0 320px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {featureList.map((feat) => (
            <div key={feat.title} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', background: '#fff', border: '1px solid oklch(91% 0.01 250)', borderRadius: 10, padding: 16 }}>
              <div style={{ width: 30, height: 30, flex: '0 0 30px', borderRadius: 7, background: 'oklch(93% 0.03 250)' }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>{feat.title}</div>
                <div style={{ fontSize: 12.5, color: 'oklch(48% 0.02 250)', lineHeight: 1.5 }}>{feat.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
