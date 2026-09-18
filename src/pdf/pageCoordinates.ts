import type { Matrix, Point } from '../types/pdfEditor';

export function transformPoint([x, y]: Point, [a, b, c, d, e, f]: Matrix): Point {
  return [a * x + c * y + e, b * x + d * y + f];
}
