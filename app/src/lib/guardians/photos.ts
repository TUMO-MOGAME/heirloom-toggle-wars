/**
 * The on-chain photo root for an asset (AssetMedia.photos_root, docs/guardians-spec.md §4 D):
 * SHA-256 of the photos' 32-byte SHA-256 digests concatenated in display order. No photos = 32 zero bytes.
 * Shared by the uploader (Agent D), the mock and chain services, so all three agree. Browser and Node (WebCrypto).
 */
const ZERO = "0".repeat(64);

export async function photosRootHex(photoSha256s: string[]): Promise<string> {
  if (photoSha256s.length === 0) return ZERO;
  const bytes = new Uint8Array(photoSha256s.length * 32);
  photoSha256s.forEach((h, i) => {
    if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error("Each photo hash must be a 64-character SHA-256 hex string.");
    for (let j = 0; j < 32; j++) bytes[i * 32 + j] = Number.parseInt(h.slice(j * 2, j * 2 + 2), 16);
  });
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
