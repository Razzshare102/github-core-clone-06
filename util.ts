// util.ts — small shared helpers: object ids, packet framing, base64url,
// and clock formatting. No behavior beyond what the other modules need.

import { createHash } from 'node:crypto';

export const NULL_OID = '0000000000000000000000000000000000000000';

export function sha1Digest(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a typed blob: sha1("<type> <length>\0" + data). */
export function objectIdFor(kind: string, data: Buffer): string {
  const prefix = Buffer.from(kind + ' ' + data.length + '\0', 'ascii');
  return createHash('sha1').update(prefix).update(data).digest('hex');
}

export function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function decodeBase64Url(text: string): string {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/** An ISO-8601 UTC timestamp for a unix-seconds value. */
export function isoTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Frame `payload` as one pkt-line: 4 hex digits of total length, then payload. */
export function framePacket(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const framed = Buffer.allocUnsafe(4 + body.length);
  framed.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  body.copy(framed, 4);
  return framed;
}

export const PACKET_FLUSH = Buffer.from('0000', 'ascii');
export const PACKET_DELIM = Buffer.from('0001', 'ascii');

/** Split a buffer of pkt-lines. A delim line returns as the 1-byte buffer [1]. */
export function splitPackets(buffer: Buffer, start = 0): { lines: Buffer[]; end: number; flush: boolean } {
  const lines: Buffer[] = [];
  let cursor = start;
  while (cursor + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(cursor, cursor + 4).toString('ascii'), 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) return { lines, end: cursor + 4, flush: true };
    if (length === 1) {
      lines.push(Buffer.from([1]));
      cursor += 4;
      continue;
    }
    if (cursor + length > buffer.length) break;
    lines.push(buffer.subarray(cursor + 4, cursor + length));
    cursor += length;
  }
  return { lines, end: cursor, flush: false };
}

/** Wrap raw bytes into sideband band-1 pkt-lines: one band byte, then at most 65515 data bytes each. */
export function wrapSideband(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const slice = data.subarray(offset, Math.min(data.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    packets.push(framePacket(payload));
    offset += slice.length;
  }
  return packets;
}

/** Pull the band-1 payloads back out of a sideband byte stream. */
export function unwrapSideband(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let cursor = 0;
  while (cursor + 4 <= data.length) {
    const length = parseInt(data.subarray(cursor, cursor + 4).toString('ascii'), 16);
    if (length === 0 || cursor + length > data.length) break;
    const payload = data.subarray(cursor + 4, cursor + length);
    if (payload.length > 0 && payload[0] === 1) chunks.push(payload.subarray(1));
    cursor += length;
  }
  return Buffer.concat(chunks);
}

/** True when `text` is exactly 40 hexadecimal characters. */
export function isFortyHex(text: string): boolean {
  if (text.length !== 40) return false;
  for (let idx = 0; idx < 40; idx++) {
    const code = text.charCodeAt(idx);
    const digit = (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
    if (!digit) return false;
  }
  return true;
}
