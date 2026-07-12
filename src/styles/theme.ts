import type { CSSProperties } from 'react';

// Tunable "identity" constants. These were exposed as external design-tool props in the
// original prototype (accentColor/density/canvasMood); hardcoded here since this is now a
// real standalone app rather than a themeable artifact.
export const ACCENT = 'oklch(48% 0.14 250)';
export const BORDER = 'oklch(90% 0.01 250)';
export const DENSE = false; // density: 'comfortable'
export const CANVAS_MOOD = 'paper' as 'paper' | 'focus' | 'dark';

export const CANVAS_BG =
  CANVAS_MOOD === 'dark' ? 'oklch(20% 0.01 250)' : CANVAS_MOOD === 'focus' ? 'oklch(30% 0.015 250)' : 'oklch(93% 0.006 250)';
export const PAGE_SHADOW =
  CANVAS_MOOD === 'dark' ? '0 8px 40px rgba(0,0,0,.55)' : CANVAS_MOOD === 'focus' ? '0 12px 44px rgba(0,0,0,.35)' : '0 2px 18px rgba(20,30,45,.12)';

export const TOOLBAR_H = DENSE ? 40 : 50;
export const FORMAT_H = DENSE ? 40 : 48;
export const RAIL_CARD_H = DENSE ? 76 : 108;
export const RAIL_GAP = DENSE ? 6 : 10;
export const TOOL_BTN = DENSE ? 30 : 38;

export const FONT_STACK = "'Pretendard',sans-serif";

export function solidAccentBtn(extra?: CSSProperties): CSSProperties {
  return { background: ACCENT, color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: FONT_STACK, fontWeight: 600, ...extra };
}

export function outlineAccentBtn(extra?: CSSProperties): CSSProperties {
  return { border: `1px solid ${ACCENT}`, background: '#fff', color: ACCENT, borderRadius: '6px', cursor: 'pointer', fontFamily: FONT_STACK, fontWeight: 600, ...extra };
}

export function spinnerAccentStyle(size: number, borderW: number): CSSProperties {
  return {
    width: size + 'px',
    height: size + 'px',
    borderRadius: '50%',
    border: `${borderW}px solid oklch(90% 0.01 250)`,
    borderTopColor: ACCENT,
    animation: 'pdfe-spin .8s linear infinite',
  };
}

export const toolBase: CSSProperties = {
  width: TOOL_BTN + 'px', height: TOOL_BTN + 'px', flex: '0 0 auto', border: 'none', background: 'none',
  borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: FONT_STACK, color: 'oklch(40% 0.02 250)',
};

export const toolActive: CSSProperties = { ...toolBase, background: 'oklch(93% 0.03 250)', color: ACCENT };
export const toolDisabled: CSSProperties = { ...toolBase, color: 'oklch(78% 0.01 250)', cursor: 'not-allowed' };

export const fmtBase: CSSProperties = { flex: 1, border: `1px solid ${BORDER}`, background: '#fff', borderRadius: '7px', padding: '10px 4px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT_STACK, color: 'oklch(40% 0.02 250)' };
export const fmtActive: CSSProperties = { ...fmtBase, background: ACCENT, color: '#fff', border: `1px solid ${ACCENT}` };

export const permBase: CSSProperties = { flex: 1, border: `1px solid ${BORDER}`, background: '#fff', borderRadius: '7px', padding: '9px 4px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT_STACK, color: 'oklch(40% 0.02 250)' };
export const permActive: CSSProperties = { ...permBase, background: ACCENT, color: '#fff', border: `1px solid ${ACCENT}` };

export const FONT_FAMILY_OPTIONS = [
  { value: "'Pretendard',sans-serif", label: 'Pretendard' },
  { value: "'Noto Sans KR',sans-serif", label: 'Noto Sans KR' },
  { value: "'Noto Serif KR',serif", label: 'Noto Serif KR' },
  { value: "'Nanum Gothic',sans-serif", label: 'Nanum Gothic' },
  { value: "'Nanum Myeongjo',serif", label: 'Nanum Myeongjo' },
  { value: 'Georgia,serif', label: 'Georgia' },
  { value: "'Courier New',monospace", label: 'Courier New' },
  { value: "'Times New Roman','Liberation Serif',serif", label: 'Times New Roman' },
  { value: "Arial,'Liberation Sans',sans-serif", label: 'Arial' },
  { value: "'Palatino Linotype','Book Antiqua',Palatino,serif", label: 'Palatino Linotype' },
  { value: "'FreeMono','Courier New',monospace", label: 'Free Mono' },
  { value: "'Source Han Serif KR','Noto Serif KR',serif", label: 'Source Han Serif KR' },
];

export const COLOR_SWATCHES = ['#1f2937', '#c0392b', '#1f7a4c', '#b8860b'];

export function rotTransform(deg: number): CSSProperties {
  return deg ? { transform: 'rotate(' + deg + 'deg)' } : {};
}
