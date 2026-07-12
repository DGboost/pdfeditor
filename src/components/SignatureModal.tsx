import { ACCENT } from '../styles/theme';

export interface SignatureModalProps {
  open: boolean;
  setCanvasRef: (el: HTMLCanvasElement | null) => void;
  hasStrokes: boolean;
  onClear: () => void;
  onClose: () => void;
  onSave: () => void;
}

export function SignatureModal({ open, setCanvasRef, hasStrokes, onClear, onClose, onSave }: SignatureModalProps) {
  if (!open) return null;

  const saveBtnStyle = hasStrokes
    ? { border: 'none', background: ACCENT, color: '#fff', borderRadius: '7px', padding: '9px 16px', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Pretendard',sans-serif", whiteSpace: 'nowrap' as const }
    : { border: 'none', background: 'oklch(88% 0.01 250)', color: 'oklch(60% 0.02 250)', borderRadius: '7px', padding: '9px 16px', fontSize: '12.5px', fontWeight: 700, cursor: 'not-allowed', fontFamily: "'Pretendard',sans-serif", whiteSpace: 'nowrap' as const };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,25,35,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, animation: 'pdfe-pop .12s ease-out' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>전자서명</div>
        <div style={{ fontSize: '12.5px', color: 'oklch(50% 0.02 250)', marginBottom: 14 }}>아래 영역에 마우스로 서명을 그려주세요</div>
        <canvas
          ref={setCanvasRef}
          width={372}
          height={160}
          style={{ width: '100%', height: 160, border: '1.5px dashed oklch(85% 0.01 250)', borderRadius: 8, background: 'oklch(98% 0.005 250)', touchAction: 'none' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          <button onClick={onClear} style={{ border: '1px solid oklch(85% 0.01 250)', background: '#fff', borderRadius: 7, padding: '9px 14px', fontSize: '12.5px', cursor: 'pointer', fontFamily: 'inherit' }}>지우기</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ border: '1px solid oklch(85% 0.01 250)', background: '#fff', borderRadius: 7, padding: '9px 16px', fontSize: '12.5px', cursor: 'pointer', fontFamily: 'inherit' }}>취소</button>
            <button onClick={onSave} disabled={!hasStrokes} style={saveBtnStyle}>서명 완료</button>
          </div>
        </div>
      </div>
    </div>
  );
}
