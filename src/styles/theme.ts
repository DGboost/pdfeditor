import type { CSSProperties } from 'react';

// Design tokens shared with 누끼컷(RemoveBg) — see /root/dglee/removebg/src/RemoveBgTool.tsx.
// ACCENT is a CSS custom property set on the root wrapper (see PdfEditor.tsx: `--accent`),
// so every literal below re-themes per-instance without any prop drilling.
export const ACCENT = 'var(--accent, #3d5afe)';
export const BORDER = 'var(--pdfe-border, #ececec)';
export const BORDER_SOFT = 'var(--pdfe-border-soft, #f0f0f0)';
export const TEXT = 'var(--pdfe-text, #17171a)';
export const TEXT_MUTED = 'var(--pdfe-text-muted, #6b6b72)';
export const TEXT_SUBTLE = 'var(--pdfe-text-subtle, #9a9aa2)';
export const TEXT_FAINT = 'var(--pdfe-text-faint, #c0c0c6)';
export const DANGER = '#e0553d';
export const SUCCESS = '#16a34a';

// Chrome surface(툴바·패널·카드) — 다크로 전환. PAGE는 문서 종이라 다크에서도 흰색 유지.
export const BG = 'var(--pdfe-bg, #fff)';
export const SURFACE = 'var(--pdfe-surface, #fff)';
export const SURFACE_SOFT = 'var(--pdfe-surface-soft, #f7f7f8)';
export const PAGE = 'var(--pdfe-page, #fff)';
export const BORDER_STRONG = 'var(--pdfe-border-strong, #e2e2e6)';

export const DENSE = false; // density: 'comfortable'

export const CANVAS_BG = 'var(--pdfe-canvas, #f5f5f7)';
export const PAGE_SHADOW = '0 2px 18px rgba(20,30,45,.12)';

export const TOOLBAR_H = DENSE ? 40 : 50;
export const FORMAT_H = DENSE ? 40 : 48;
export const RAIL_CARD_H = DENSE ? 76 : 108;
export const RAIL_GAP = DENSE ? 6 : 10;
export const TOOL_BTN = DENSE ? 30 : 38;
// Persistent app title bar height — matches 누끼컷's renderTopbar exactly.
export const TOPBAR_H = 60;

export const FONT_STACK = "'Pretendard',system-ui,-apple-system,sans-serif";

export function solidAccentBtn(extra?: CSSProperties): CSSProperties {
  return { background: ACCENT, color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer', fontFamily: FONT_STACK, fontWeight: 700, ...extra };
}

export function outlineAccentBtn(extra?: CSSProperties): CSSProperties {
  return { border: `1px solid ${ACCENT}`, background: SURFACE, color: ACCENT, borderRadius: '10px', cursor: 'pointer', fontFamily: FONT_STACK, fontWeight: 600, ...extra };
}

export function spinnerAccentStyle(size: number, borderW: number): CSSProperties {
  return {
    width: size + 'px',
    height: size + 'px',
    borderRadius: '50%',
    border: `${borderW}px solid ${BORDER_STRONG}`,
    borderTopColor: ACCENT,
    animation: 'pdfe-spin .8s linear infinite',
  };
}

export const toolBase: CSSProperties = {
  width: TOOL_BTN + 'px', height: TOOL_BTN + 'px', flex: '0 0 auto', border: 'none', background: 'none',
  borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: FONT_STACK, color: TEXT_MUTED,
};

export const toolActive: CSSProperties = { ...toolBase, background: 'color-mix(in srgb, var(--accent) 10%, var(--pdfe-surface, #fff))', color: ACCENT };
export const toolDisabled: CSSProperties = { ...toolBase, color: TEXT_FAINT, cursor: 'not-allowed' };

export const fmtBase: CSSProperties = { flex: 1, border: `1px solid ${BORDER}`, background: SURFACE, borderRadius: '8px', padding: '10px 4px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT_STACK, color: TEXT_MUTED };
export const fmtActive: CSSProperties = { ...fmtBase, background: ACCENT, color: '#fff', border: `1px solid ${ACCENT}` };

export const permBase: CSSProperties = { flex: 1, border: `1px solid ${BORDER}`, background: SURFACE, borderRadius: '8px', padding: '9px 4px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT_STACK, color: TEXT_MUTED };
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
