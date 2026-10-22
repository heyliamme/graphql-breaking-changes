/**
 * Bytes as text the way VS Code opens a file: UTF-16 when a byte order mark says so (as
 * PowerShell 5 writes `>` redirects), else UTF-8, its mark dropped.
 */
export function decodeText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // Big-endian: swapped into little-endian, which every runtime decodes.
    const le = new Uint8Array(b.length - 2 - (b.length % 2));
    for (let i = 0; i < le.length; i += 2) {
      le[i] = b[i + 3];
      le[i + 1] = b[i + 2];
    }
    return new TextDecoder('utf-16le').decode(le);
  }
  return new TextDecoder().decode(b);
}
