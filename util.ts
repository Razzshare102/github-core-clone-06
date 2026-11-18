// util.ts — small shared helpers: git object ids, pkt-lines, base64url, time.
// Written fresh for this entry.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + data: sha1("<type> <len>\0" + data). */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(type + ' ' + data.length + '\0', 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function b64urlDecode(s: string): string {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/** ISO-8601 UTC timestamp for a unix-seconds value. */
export function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** One pkt-line framing `payload` (4 hex digits of total length + payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const out = Buffer.allocUnsafe(4 + body.length);
  out.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  body.copy(out, 4);
  return out;
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a buffer of pkt-lines. A delim line comes back as the 1-byte buffer [1]. */
export function parsePktLines(buf: Buffer, start = 0): { lines: Buffer[]; end: number; flush: boolean } {
  const lines: Buffer[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) return { lines, end: i + 4, flush: true };
    if (len === 1) {
      lines.push(Buffer.from([1]));
      i += 4;
      continue;
    }
    if (i + len > buf.length) break;
    lines.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { lines, end: i, flush: false };
}

/** Wrap raw bytes into sideband band-1 pkt-lines (band byte + at most 65515 data bytes each). */
export function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const chunk = data.subarray(off, Math.min(data.length, off + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(payload));
    off += chunk.length;
  }
  return out;
}

/** Extract the band-1 payloads from a sideband byte stream. */
export function sidebandBand1(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 0;
  while (i + 4 <= data.length) {
    const len = parseInt(data.subarray(i, i + 4).toString('ascii'), 16);
    if (len === 0 || i + len > data.length) break;
    const payload = data.subarray(i + 4, i + len);
    if (payload.length > 0 && payload[0] === 1) chunks.push(payload.subarray(1));
    i += len;
  }
  return Buffer.concat(chunks);
}

/** True when `s` is exactly 40 hex characters. */
export function isHex40(s: string): boolean {
  if (s.length !== 40) return false;
  for (let i = 0; i < 40; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!ok) return false;
  }
  return true;
}
