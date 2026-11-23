/** Tests only: a WebP data URL whose image data is `bytes` long (a real RIFF/WEBP header, padding after). */
export function webpOf(bytes: number): string {
  const head = Buffer.from("RIFF\0\0\0\0WEBPVP8L", "latin1");
  return `data:image/webp;base64,${Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 7)]).toString("base64")}`;
}
