import type { StyledRun, TextContent, TextStyle } from '../types/pdfEditor';

export interface TextSelection { start: number; end: number }
export interface NormalizedInput extends TextSelection { text: string }
export interface InputAnchor extends TextSelection { inputType: string }

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
export const defaultTextStyle = (): TextStyle => ({
  font: { kind: 'bundled', family: 'NanumGothic', bold: false },
  sizePt: 12, color: [0, 0, 0],
});
export function plainText(content: TextContent | StyledRun[]): string {
  return (Array.isArray(content) ? content : content.runs).map(run => run.text).join('');
}
function normalize(text: string): string { return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').normalize('NFC'); }
export function normalizeInput(text: string, start = text.length, end = start): NormalizedInput {
  const map = (offset: number) => {
    offset = Math.max(0, Math.min(text.length, offset));
    let result = 0;
    for (const part of segmenter.segment(text)) {
      if (part.index >= offset) break;
      // A caret within a composing grapheme moves to its normalized end.
      result += normalize(part.segment).length;
    }
    return result;
  };
  return { text: normalize(text), start: map(start), end: map(end) };
}
export function graphemeRange(text: string, start: number, end: number): TextSelection {
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  const boundaries = [0, ...Array.from(segmenter.segment(text), part => part.index + part.segment.length)];
  const left = boundaries.filter(n => n <= start).at(-1) ?? 0;
  return { start: left, end: start === end ? left : boundaries.find(n => n >= end) ?? text.length };
}
export function styleAt(runs: StyledRun[], offset: number, fallback = defaultTextStyle()): TextStyle {
  let position = 0;
  for (const run of runs) {
    position += run.text.length;
    if (offset < position) return run.style;
  }
  return runs.at(-1)?.style ?? fallback;
}
function compact(runs: StyledRun[], fallback: TextStyle): StyledRun[] {
  const result: StyledRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = result.at(-1);
    if (last && JSON.stringify(last.style) === JSON.stringify(run.style)) last.text += run.text;
    else result.push({ text: run.text, style: run.style });
  }
  return result.length ? result : [{ text: '', style: fallback }];
}
function sliceRuns(runs: StyledRun[], start: number, end: number): StyledRun[] {
  let position = 0;
  const result: StyledRun[] = [];
  for (const run of runs) {
    const from = Math.max(0, start - position), to = Math.min(run.text.length, end - position);
    if (from < to) result.push({ text: run.text.slice(from, to), style: run.style });
    position += run.text.length;
  }
  return result;
}
export function spliceRuns(runs: StyledRun[], start: number, end: number, inserted: string, fallback = defaultTextStyle()): StyledRun[] {
  const text = plainText(runs), range = graphemeRange(text, start, end);
  const style = styleAt(runs, range.start, fallback);
  return compact([...sliceRuns(runs, 0, range.start), { text: inserted, style }, ...sliceRuns(runs, range.end, text.length)], style);
}
export function applyRunStyle(runs: StyledRun[], start: number, end: number, patch: Partial<TextStyle>): StyledRun[] {
  const text = plainText(runs);
  const range = start === end ? { start: 0, end: text.length } : graphemeRange(text, start, end);
  const fallback = { ...styleAt(runs, range.start), ...patch };
  return compact([
    ...sliceRuns(runs, 0, range.start),
    ...sliceRuns(runs, range.start, range.end).map(run => ({ ...run, style: { ...run.style, ...patch } })),
    ...sliceRuns(runs, range.end, text.length),
  ], fallback);
}
export function normalizeRuns(runs: StyledRun[]): StyledRun[] {
  const text = plainText(runs);
  return compact(Array.from(segmenter.segment(text), part => ({ text: normalize(part.segment), style: styleAt(runs, part.index) })), styleAt(runs, 0));
}
/** Reconcile only around the captured browser input location, never a global repeated-text diff. */
export function reconcileInput(runs: StyledRun[], anchor: InputAnchor, value: string): StyledRun[] {
  const before = plainText(runs);
  let { start, end } = graphemeRange(before, anchor.start, anchor.end);
  if (start === end && anchor.inputType.startsWith('delete')) {
    if (anchor.inputType.includes('Backward')) {
      const removed = Math.max(0, before.length - value.length);
      start = graphemeRange(before, Math.max(0, start - removed), end).start;
    } else end = graphemeRange(before, start, Math.min(before.length, end + Math.max(0, before.length - value.length))).end;
  }
  const prefix = before.slice(0, start), suffix = before.slice(end);
  if (value.startsWith(prefix) && value.endsWith(suffix) && value.length >= prefix.length + suffix.length) {
    return spliceRuns(runs, start, end, value.slice(prefix.length, value.length - suffix.length));
  }
  // Autocorrection may extend the captured replacement, but matching cannot pass its anchor.
  let left = 0;
  while (left < start && left < value.length && before[left] === value[left]) left++;
  let right = 0;
  while (right < before.length - end && right < value.length - left && before[before.length - 1 - right] === value[value.length - 1 - right]) right++;
  const range = graphemeRange(before, left, before.length - right);
  const adjustedRight = before.length - range.end;
  return spliceRuns(runs, range.start, range.end, value.slice(range.start, value.length - adjustedRight));
}
