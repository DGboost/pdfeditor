import type { PdfPage, Point, Quad, Rect, SourceTextLayout, TextContent } from '../types/pdfEditor';
import type { SourceTextLine, SourceTextPage } from './engineTypes';

export interface SourceTextGroup {
  lineIds: string[]; content: TextContent; widthPt: number; layout: SourceTextLayout;
  origin: Point; direction: Point; bounds: Rect; quads: Quad[];
}
const overlap = (a: Rect, b: Rect) => a[0] < b[2] - .01 && a[2] > b[0] + .01 && a[1] < b[3] - .01 && a[3] > b[1] + .01;
const contains = (a: Rect, b: Rect) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

/** Explicitly selected, geometrically consecutive source rows; never paragraph detection. */
export function buildSourceTextGroup(page: PdfPage, source: SourceTextPage, lineIds: string[]): SourceTextGroup {
  const ids = new Set(lineIds);
  if (ids.size < 2 || page.sourcePageIndex !== source.sourcePageIndex) throw new Error('같은 페이지의 본문 줄을 두 개 이상 선택해 주세요.');
  const selected = source.lines.filter(line => ids.has(line.lineId));
  if (selected.length !== ids.size) throw new Error('선택한 원본 줄을 찾을 수 없습니다.');
  for (const edit of page.textEdits) if (edit.lineIds.some(id => ids.has(id)) && !edit.lineIds.every(id => ids.has(id))) throw new Error('기존 묶음의 모든 줄을 함께 선택해 주세요.');
  const direction = selected[0].direction;
  if (selected.some(line => !line.editable || line.writingMode || Math.hypot(line.direction[0] - direction[0], line.direction[1] - direction[1]) > .001)) throw new Error('편집 가능한 같은 방향의 본문만 묶을 수 있습니다.');
  const project = (point: Point): Point => [point[0] * direction[0] + point[1] * direction[1], -point[0] * direction[1] + point[1] * direction[0]];
  const geometry = (line: SourceTextLine) => {
    const points = line.chars.flatMap(char => [0, 2, 4, 6].map(i => project([char.quad[i], char.quad[i + 1]])));
    const inkPoints = line.chars.flatMap(char => {
      const box = char.paintBounds;
      if (box) return box[0] < box[2] && box[1] < box[3] ? [[box[0],box[1]], [box[2],box[1]], [box[0],box[3]], [box[2],box[3]]].map(point => project(point as Point)) : [];
      return [0,2,4,6].map(i => project([char.quad[i],char.quad[i+1]]));
    });
    const ink:Rect = inkPoints.length ? [Math.min(...inkPoints.map(p=>p[0])),Math.min(...inkPoints.map(p=>p[1])),Math.max(...inkPoints.map(p=>p[0])),Math.max(...inkPoints.map(p=>p[1]))] : [Infinity,Infinity,-Infinity,-Infinity];
    return { line, u: project(line.origin)[0], v: project(line.origin)[1], end: points.length ? Math.max(...points.map(p => p[0])) : project(line.origin)[0] + line.widthPt, ink };
  };
  const ordered = selected.map(geometry).sort((a, b) => Math.abs(a.v - b.v) < .5 ? a.u - b.u : a.v - b.v);
  const size = Math.max(...selected.flatMap(line => line.content.runs.map(run => run.style.sizePt)));
  if (!Number.isFinite(size) || size <= 0) throw new Error('원본 글자 크기를 확인할 수 없습니다.');
  const rows: typeof ordered[] = [];
  for (const item of ordered) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].v - item.v) < .5) {
      const previous = row.at(-1)!;
      const gap = item.u - previous.end;
      let safeMetricOverlap = false;
      if (gap < -.5) {
        const last = previous.line.chars.at(-1), first = item.line.chars[0];
        // Only boundary-glyph side bearings may overlap, never painted text or whole glyph cells.
        safeMetricOverlap = !!last && !!first
          && [previous.line, item.line].every(line => line.chars.every(char => char.paintBounds?.every(Number.isFinite)))
          && [last, first].every(char => char.paintBounds![0] < char.paintBounds![2] && char.paintBounds![1] < char.paintBounds![3])
          && previous.ink[2] <= item.ink[0]
          && item.u > Math.max(previous.u, project(last.origin)[0])
          && previous.end < Math.min(item.end, Math.max(...[0, 2, 4, 6].map(i => project([first.quad[i], first.quad[i + 1]])[0])));
      }
      if ((gap < -.5 && !safeMetricOverlap) || gap > size * 1.5) throw new Error('서로 떨어진 열이나 표 셀은 묶을 수 없습니다.');
      row.push(item);
    } else rows.push([item]);
  }
  for (const [start,end] of source.rulingLines ?? []) {
    const a=project(start),b=project(end);
    if(Math.abs(a[1]-b[1])<.01)for(let i=1;i<rows.length;i++) {
      const upper=rows[i-1],lower=rows[i];
      const gapTop=Math.max(...upper.map(item=>item.ink[3])),gapBottom=Math.min(...lower.map(item=>item.ink[1]));
      const columnLeft=Math.min(...[...upper,...lower].map(item=>item.ink[0])),columnRight=Math.max(...[...upper,...lower].map(item=>item.ink[2]));
      if(a[1]>gapTop+.01&&a[1]<gapBottom-.01&&Math.min(a[0],b[0])<=columnLeft+.01&&Math.max(a[0],b[0])>=columnRight-.01)throw new Error('표의 구분선을 가로질러 본문을 묶을 수 없습니다.');
    }
    if(Math.abs(a[0]-b[0])<.01)for(const row of rows)for(let i=1;i<row.length;i++) {
      const before=row[i-1].ink,after=row[i].ink;
      if(a[0]>before[2]+.01&&a[0]<after[0]-.01&&Math.min(a[1],b[1])<=Math.min(before[1],after[1])+.01&&Math.max(a[1],b[1])>=Math.max(before[3],after[3])-.01)throw new Error('표의 구분선을 가로질러 본문을 묶을 수 없습니다.');
    }
  }
  const left = Math.min(...ordered.map(item => item.u));
  const right = Math.max(...ordered.map(item => item.end));
  const widthPt = right - left;
  const gaps = rows.slice(1).map((row, i) => row[0].v - rows[i][0].v);
  const leading = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : size * 1.35;
  if (gaps.some(gap => gap < size * .65 || gap > size * 2.5 || Math.abs(gap - leading) > size * .4) || rows.some(row => row[0].u - left > size * 3 || Math.min(...row.map(item => item.end)) <= left)) throw new Error('연속된 같은 열의 본문 줄만 묶을 수 있습니다.');
  if (rows.slice(1).some((row, i) => Math.max(row[0].u, rows[i][0].u) >= Math.min(row.at(-1)!.end, rows[i].at(-1)!.end))) throw new Error('서로 다른 열의 본문은 묶을 수 없습니다.');
  if (rows.slice(1).some(row => /^\s*(?:[•●▪◦]|[-*]\s|\d+[.)]\s)/u.test(row.map(item => item.line.text).join('')))) throw new Error('서로 다른 목록 항목은 하나의 본문 묶음으로 합칠 수 없습니다.');
  for (const line of source.lines) if (!ids.has(line.lineId)) {
    const other = geometry(line);
    if (other.v >= rows[0][0].v - .5 && other.v <= rows.at(-1)![0].v + .5 && other.u < right && other.end > left) throw new Error('선택 영역 안의 중간 본문 줄도 함께 선택해 주세요.');
  }
  const bounds: Rect = [Math.min(...selected.map(line => line.bounds[0])), Math.min(...selected.map(line => line.bounds[1])), Math.max(...selected.map(line => line.bounds[2])), Math.max(...selected.map(line => line.bounds[3]))];
  const obstacles = (source.imageBounds ?? []).filter(rect => !contains(rect, bounds));
  if (obstacles.some(rect => overlap(rect, bounds))) throw new Error('이미지나 다른 요소를 가로지르는 본문은 묶을 수 없습니다.');
  const runs: TextContent['runs'] = [];
  const consumed = new Set<string>();
  let previousRow = -1;
  let previousEnd = left;
  for (const [rowIndex, row] of rows.entries()) for (const { line, u, end } of row) {
    if (consumed.has(line.lineId)) { previousRow = rowIndex; previousEnd = end; continue; }
    const edit = page.textEdits.find(value => value.lineIds.includes(line.lineId));
    const content = edit?.content ?? line.content;
    const text = content.runs.map(run => run.text).join('');
    const previous = runs.at(-1);
    if (previous && text && !/\s$/u.test(previous.text) && !/^\s/u.test(text) && (previousRow !== rowIndex || u - previousEnd > size * .15)) runs.push({ text: ' ', style: previous.style });
    runs.push(...content.runs.map(run => ({ ...run })));
    for (const id of edit?.lineIds ?? [line.lineId]) consumed.add(id);
    previousRow = rowIndex;
    previousEnd = end;
  }
  const restLeft = rows.length > 1 ? Math.min(...rows.slice(1).map(row => row[0].u)) : left;
  const v = rows[0][0].v;
  return { lineIds: ordered.map(item => item.line.lineId), content: { runs, align: 'left' }, widthPt,
    layout: { lineHeightPt: leading, referenceSizePt: size, firstLineIndentPt: rows[0][0].u - left, restLineIndentPt: restLeft - left },
    origin: [left * direction[0] - v * direction[1], left * direction[1] + v * direction[0]], direction, bounds, quads: ordered.flatMap(item => item.line.chars.map(char => char.quad)) };
}
