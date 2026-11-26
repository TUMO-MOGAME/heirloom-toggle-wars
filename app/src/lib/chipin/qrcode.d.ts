/** The one part of `qrcode` (1.5.4) the app uses: the module matrix, drawn as SVG by components/chipin/qr-code.tsx. */
declare module "qrcode" {
  export interface QRCodeMatrix { size: number; get(row: number, col: number): number | boolean }
  export function create(text: string, options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }): { modules: QRCodeMatrix };
}
