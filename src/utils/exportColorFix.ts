/**
 * html2canvas 1.4.1 bundles its own CSS color parser, which predates (and does not understand)
 * modern CSS Color 4/5 functions like oklch()/color-mix() — the app's design tokens lean on
 * color-mix() for accent tinting (see styles/theme.ts), so calling html2canvas directly on any
 * part of this UI throws ("Attempting to parse an unsupported color function") instead of rendering.
 *
 * Fix: right before html2canvas rasterizes its cloned copy of the DOM (its `onclone` hook), walk
 * every element and rewrite any computed color-bearing property that still contains oklch()/
 * color-mix() into an rgb()/rgba() the old parser understands. The browser's own Canvas 2D
 * context already knows how to parse any valid CSS color — including oklch()/color-mix() — so
 * painting a 1x1 pixel with it and reading back the composited byte values doubles as a
 * zero-maintenance color converter here, without a hand-rolled OKLCH->sRGB implementation to keep
 * in sync with the design tokens. (Reading back `ctx.fillStyle` as a string instead would NOT
 * work — Chromium's getter re-serializes it in the same color space it was given rather than
 * converting to rgb.)
 */

const COLOR_PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'box-shadow',
] as const;

function findMatchingParen(value: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function makeNormalizer() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return (colorFnCall: string): string => {
    // Setting fillStyle to an oklch()/color-mix() string and reading it back does NOT give us an
    // rgb() string — Chromium's Canvas2D fillStyle getter re-serializes it in the SAME color
    // space it was given (it preserves oklch, it doesn't convert). Instead, actually paint one
    // pixel and read back the composited byte values, which the browser always resolves to plain
    // 8-bit sRGB regardless of the input color space/function.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000000';
    try {
      ctx.fillStyle = colorFnCall;
    } catch {
      return colorFnCall;
    }
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 255 ? 'rgb(' + r + ', ' + g + ', ' + b + ')' : 'rgba(' + r + ', ' + g + ', ' + b + ', ' + (a / 255).toFixed(3) + ')';
  };
}

function replaceColorFunctions(value: string, normalize: (s: string) => string): string {
  if (!value || (!value.includes('oklch') && !value.includes('color-mix'))) return value;
  let result = '';
  let i = 0;
  while (i < value.length) {
    const oklchIdx = value.indexOf('oklch(', i);
    const mixIdx = value.indexOf('color-mix(', i);
    const matchIdx = oklchIdx === -1 ? mixIdx : mixIdx === -1 ? oklchIdx : Math.min(oklchIdx, mixIdx);
    if (matchIdx === -1) {
      result += value.slice(i);
      break;
    }
    const openParen = value.indexOf('(', matchIdx);
    const closeParen = findMatchingParen(value, openParen);
    if (closeParen === -1) {
      result += value.slice(i);
      break;
    }
    result += value.slice(i, matchIdx);
    result += normalize(value.slice(matchIdx, closeParen + 1));
    i = closeParen + 1;
  }
  return result;
}

/**
 * Mutates the cloned (offscreen) document only — never the live, on-screen app.
 *
 * html2canvas walks the ENTIRE cloned document (from `document.documentElement` down) when it
 * builds its render tree, not just the target element passed to `html2canvas(el, ...)` — so
 * ancestors/siblings of the captured element (e.g. the app's root wrapper div) must be sanitized
 * too, or its own oklch()-based styles still trip the same unsupported-color-function parse error.
 */
export function sanitizeClonedColors(clonedDocument: Document): void {
  const view = clonedDocument.defaultView;
  const root = clonedDocument.documentElement;
  if (!view || !root) return;
  const normalize = makeNormalizer();
  const nodes: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    const computed = view.getComputedStyle(node);
    for (const prop of COLOR_PROPERTIES) {
      const current = computed.getPropertyValue(prop);
      if (!current || (!current.includes('oklch') && !current.includes('color-mix'))) continue;
      node.style.setProperty(prop, replaceColorFunctions(current, normalize), 'important');
    }
  }
}
