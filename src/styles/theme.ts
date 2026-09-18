import type { CSSProperties } from 'react';

// Monochrome editor chrome. PDF page rendering and document colors remain independent.
export const ACCENT = 'var(--accent, #000)';
export const BORDER = 'var(--pdfe-border, #e5e7eb)';
export const BORDER_SOFT = 'var(--pdfe-border-soft, rgba(229,231,235,.6))';
export const TEXT = 'var(--pdfe-text, #111827)';
export const TEXT_MUTED = 'var(--pdfe-text-muted, #6b7280)';
export const TEXT_SUBTLE = 'var(--pdfe-text-subtle, #9ca3af)';
export const TEXT_FAINT = 'var(--pdfe-text-faint, #9ca3af)';
export const DANGER = '#dc2626';
export const SUCCESS = '#111827';

// Chrome surfaces do not change the native PDF page pixels.
export const BG = 'var(--pdfe-bg, #fff)';
export const SURFACE = 'var(--pdfe-surface, #fff)';
export const SURFACE_SOFT = 'var(--pdfe-surface-soft, #f9fafb)';
export const PAGE = 'var(--pdfe-page, #fff)';
export const BORDER_STRONG = 'var(--pdfe-border-strong, #e5e7eb)';

export const DENSE = false; // density: 'comfortable'

export const CANVAS_BG = 'var(--pdfe-canvas, #f9fafb)';
export const PANEL_SHADOW = '0 12px 40px rgba(0,0,0,.12)';
export const PAGE_SHADOW = '0 2px 12px rgba(0,0,0,.08)';

export const TOOLBAR_H = DENSE ? 40 : 50;
export const RAIL_CARD_H = DENSE ? 76 : 108;
export const RAIL_GAP = DENSE ? 6 : 10;
export const TOOL_BTN = 32;
// Persistent editor title bar.
export const TOPBAR_H = 60;

export const FONT_STACK = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

export function solidAccentBtn(extra?: CSSProperties): CSSProperties {
  return { background: `var(--pdfe-button-bg, ${ACCENT})`, color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: FONT_STACK, fontSize: 14, fontWeight: 500, ...extra };
}

export function outlineAccentBtn(extra?: CSSProperties): CSSProperties {
  return { border: `1px solid ${BORDER}`, background: `var(--pdfe-button-bg, ${SURFACE})`, color: TEXT, borderRadius: '9999px', cursor: 'pointer', fontFamily: FONT_STACK, fontSize: 14, fontWeight: 500, ...extra };
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
  width: TOOL_BTN + 'px', height: TOOL_BTN + 'px', flex: '0 0 auto', border: 'none', background: 'var(--pdfe-button-bg, transparent)',
  borderRadius: '9999px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: FONT_STACK, color: `var(--pdfe-button-color, ${TEXT_MUTED})`,
};

export const toolActive: CSSProperties = { ...toolBase, background: `var(--pdfe-button-bg, ${SURFACE})`, color: TEXT, boxShadow: '0 1px 2px rgba(0,0,0,.05)' };
export const toolDisabled: CSSProperties = { ...toolBase, opacity: .5, cursor: 'not-allowed' };

export const fmtBase: CSSProperties = { flex: 1, border: 'none', background: 'var(--pdfe-button-bg, transparent)', borderRadius: '9999px', padding: '10px 4px', fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: FONT_STACK, color: `var(--pdfe-button-color, ${TEXT_MUTED})` };
export const fmtActive: CSSProperties = { ...fmtBase, background: `var(--pdfe-button-bg, ${SURFACE})`, color: TEXT, boxShadow: '0 1px 2px rgba(0,0,0,.05)' };

export const permBase: CSSProperties = { ...fmtBase, padding: '9px 4px', fontSize: '13px' };
export const permActive: CSSProperties = { ...permBase, background: `var(--pdfe-button-bg, ${SURFACE})`, color: TEXT, boxShadow: '0 1px 2px rgba(0,0,0,.05)' };


export const COLOR_SWATCHES = ['#1f2937', '#c0392b', '#1f7a4c', '#b8860b'];

