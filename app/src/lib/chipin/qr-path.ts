/** A QR matrix as one SVG path (dark modules only) with the standard 4-module quiet zone. Pure. */
export const QR_QUIET = 4;

export function qrPath(m: { size: number; get(row: number, col: number): number | boolean }): { path: string; viewBox: string } {
  let d = "";
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) if (m.get(y, x)) d += `M${x + QR_QUIET} ${y + QR_QUIET}h1v1h-1z`;
  }
  const side = m.size + QR_QUIET * 2;
  return { path: d, viewBox: `0 0 ${side} ${side}` };
}
