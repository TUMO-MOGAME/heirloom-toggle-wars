/** Test fixtures for asset photos (used by the vitest suites only). */
const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** A minimal lossy WebP header (RIFF, WEBP, VP8 chunk, key-frame start code, 14-bit size) padded to `size` bytes. */
export function fakeWebp(width = 800, height = 600, size = 256, seed = 0): Uint8Array {
  const b = new Uint8Array(size);
  b.set(enc("RIFF"), 0);
  new DataView(b.buffer).setUint32(4, size - 8, true);
  b.set(enc("WEBP"), 8);
  b.set(enc("VP8 "), 12);
  b.set([0x9d, 0x01, 0x2a], 23);
  new DataView(b.buffer).setUint16(26, width, true);
  new DataView(b.buffer).setUint16(28, height, true);
  for (let i = 30; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}
