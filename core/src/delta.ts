import { createDelta, applyDelta } from "./vendor/fossil-delta.js";
/** Encode UTF-8 text as a base64 byte delta, without an argument-sized spread. */
export function encodeDelta(base: string, target: string): string {
  const bytes = createDelta(new TextEncoder().encode(base), new TextEncoder().encode(target));
  return toBase64(bytes);
}
function toBase64(bytes: Uint8Array | number[]): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 8192) {
    let chunk = "";
    for (let i = start; i < Math.min(start + 8192, bytes.length); i++)
      chunk += String.fromCharCode(bytes[i]!);
    chunks.push(chunk);
  }
  return btoa(chunks.join(""));
}
/** Reconstruct exactly one delta; checksum verification remains enabled. */
export function decodeDelta(base: string, payload: string): string {
  const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
  return new TextDecoder().decode(new Uint8Array(applyDelta(new TextEncoder().encode(base), bytes)));
}
