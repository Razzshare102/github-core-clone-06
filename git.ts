// git.ts — git smart HTTP: pack codec, advertisements, ls-refs, fetch
// (protocol v2 and v0) and receive-pack.
//
// Packs hold plain objects only (no deltas), deflated at level 1. Deflated
// bytes are cached per object id forever (objects are immutable), so a
// repeated fetch of the same history is a concat of cached chunks instead
// of re-deflating. Pack inflation is synchronous (inflateSync with the
// engine's byte count), not a stream per object.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { State, type ObjectKind, type Repository } from './store.ts';
import { framePacket, splitPackets, wrapSideband, PACKET_FLUSH, PACKET_DELIM, isFortyHex, NULL_OID } from './util.ts';

const TYPE_CODES: Record<number, ObjectKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_IDS: Record<ObjectKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate one deflate stream starting at `start`; returns data plus bytes consumed. */
export function inflateChunk(buffer: Buffer, start: number): { data: Buffer; consumed: number } | null {
  try {
    const result = inflateSync(buffer.subarray(start), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = result.engine.bytesWritten;
    if (consumed > 0 && consumed <= buffer.length - start) return { data: result.buffer, consumed };
  } catch {
    // fall through to the binary-search fallback below
  }
  // Fallback: binary search the minimal slice that inflates to a full stream.
  let lo = start;
  let hi = buffer.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(start, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  try {
    const data = inflateSync(buffer.subarray(start, hi));
    return { data, consumed: hi - start };
  } catch {
    return null;
  }
}

export interface PackItem {
  oid: string;
  type: ObjectKind;
  data: Buffer;
}

/** Parse a packfile. Returns null on any error (deltas never occur from the suite client). */
export function decodePack(buffer: Buffer, state: State): PackItem[] | null {
  if (buffer.length < 12) return null;
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') return null;
  if (buffer.readUInt32BE(4) !== 2) return null;
  const count = buffer.readUInt32BE(8);
  let pos = 12;
  const out: PackItem[] = [];
  for (let i = 0; i < count; i++) {
    if (pos >= buffer.length) return null;
    let byte = buffer[pos++];
    const kindCode = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      if (pos >= buffer.length) return null;
      byte = buffer[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (kindCode === 6 || kindCode === 7) return null;
    const type = TYPE_CODES[kindCode];
    if (!type) return null;
    const inflated = inflateChunk(buffer, pos);
    if (!inflated || inflated.data.length !== size) return null;
    pos += inflated.consumed;
    const oid = state.storeObject(type, inflated.data);
    out.push({ oid, type, data: inflated.data });
  }
  return out;
}

function packEntryHeader(kindCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (size & 15) | (kindCode << 4);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Compressed bytes per object id. Objects are immutable, so a cached entry is valid forever. */
const compressedCache = new Map<string, Buffer>();

export function encodePack(items: PackItem[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(items.length, 8);
  chunks.push(header);
  for (const item of items) {
    chunks.push(packEntryHeader(TYPE_IDS[item.type], item.data.length));
    let compressed = compressedCache.get(item.oid);
    if (!compressed) {
      compressed = deflateSync(item.data, { level: 1 });
      if (compressedCache.size > 20000) compressedCache.clear();
      compressedCache.set(item.oid, compressed);
    }
    chunks.push(compressed);
  }
  const checksum = createHash('sha1');
  for (const chunk of chunks) checksum.update(chunk);
  chunks.push(checksum.digest());
  return Buffer.concat(chunks);
}

export function emptyPackBuffer(): Buffer {
  return encodePack([]);
}

export interface GatherResult {
  items: PackItem[];
  shallow: string[];
  unshallow: string[];
}

export function gatherObjects(
  state: State,
  wants: string[],
  haves: string[],
  shallowOids: Set<string>,
  depth: number,
): GatherResult {
  const skipSet = new Set<string>();
  const markReachable = (root: string, full: boolean) => {
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (skipSet.has(oid)) continue;
      const obj = state.fetchObject(oid);
      if (!obj) continue;
      skipSet.add(oid);
      if (obj.type === 'commit') {
        const info = state.readCommit(oid);
        if (info) {
          stack.push(info.tree);
          if (full) for (const p of info.parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of state.readTree(oid)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
  };
  for (const h of haves) {
    if (shallowOids.has(h)) markReachable(h, false);
    else markReachable(h, true);
  }
  for (const s of shallowOids) {
    if (!haves.includes(s)) markReachable(s, false);
  }

  const depthOf = new Map<string, number>();
  const tagTargets: string[] = [];
  const queue: [string, number][] = [];
  for (const w of wants) {
    const obj = state.fetchObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      tagTargets.push(w);
      const peeled = state.peelTag(w);
      if (peeled !== w && state.fetchObject(peeled)?.type === 'commit') queue.push([peeled, 0]);
    } else if (obj.type === 'commit') {
      queue.push([w, 0]);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const [oid, level] = queue[qi++];
    if (depthOf.has(oid)) continue;
    depthOf.set(oid, level);
    if (depth === 0 || level + 1 < depth) {
      const info = state.readCommit(oid);
      if (info) for (const p of info.parents) queue.push([p, level + 1]);
    }
  }

  const chosen = new Map<string, PackItem>();
  const addTree = (root: string) => {
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (chosen.has(oid) || skipSet.has(oid)) continue;
      const obj = state.fetchObject(oid);
      if (!obj) continue;
      chosen.set(oid, { oid, type: obj.type, data: obj.data });
      if (obj.type === 'commit') {
        const info = state.readCommit(oid);
        if (info) stack.push(info.tree);
      } else if (obj.type === 'tree') {
        for (const e of state.readTree(oid)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
  };
  for (const w of tagTargets) addTree(w);
  for (const oid of depthOf.keys()) addTree(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth > 0) {
    for (const [oid, level] of depthOf) {
      if (level === depth - 1 && chosen.has(oid)) {
        const info = state.readCommit(oid);
        if (info && info.parents.length > 0) shallow.push(oid);
      }
    }
  }
  for (const s of shallowOids) {
    const info = state.readCommit(s);
    if (!info || info.parents.length === 0) continue;
    if (info.parents.every((p) => depthOf.has(p))) unshallow.push(s);
  }
  return { items: [...chosen.values()], shallow, unshallow };
}

// ---- adverts ----

const V2_ADVERTISEMENT = Buffer.concat([
  framePacket('version 2\n'),
  framePacket('ls-refs\n'),
  framePacket('fetch=shallow\n'),
  framePacket('object-format=sha1\n'),
  framePacket('agent=github-core-clone/1.0.0\n'),
  PACKET_FLUSH,
]);

function orderedRefs(repository: Repository): [string, string][] {
  return [...repository.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function buildV0UploadAdvert(state: State, repository: Repository): Buffer {
  if (repository.v0UploadBytes) return repository.v0UploadBytes;
  const chunks: Buffer[] = [framePacket('# service=git-upload-pack\n'), PACKET_FLUSH];
  const refs = orderedRefs(repository);
  const tip = repository.refs.get('refs/heads/' + repository.defaultBranch);
  const caps = 'side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/' + repository.defaultBranch;
  if (tip && refs.length > 0) {
    chunks.push(framePacket(tip + ' HEAD\0' + caps + '\n'));
    for (const [name, oid] of refs) {
      chunks.push(framePacket(oid + ' ' + name + '\n'));
      const obj = state.fetchObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = state.peelTag(oid);
        if (peeled !== oid) chunks.push(framePacket(peeled + ' ' + name + '^{}\n'));
      }
    }
  } else {
    chunks.push(framePacket(NULL_OID + ' capabilities^{}\0' + caps + '\n'));
  }
  chunks.push(PACKET_FLUSH);
  const out = Buffer.concat(chunks);
  repository.v0UploadBytes = out;
  return out;
}

export function buildV0ReceiveAdvert(repository: Repository): Buffer {
  if (repository.v0ReceiveBytes) return repository.v0ReceiveBytes;
  const chunks: Buffer[] = [framePacket('# service=git-receive-pack\n'), PACKET_FLUSH];
  const refs = orderedRefs(repository);
  const tip = repository.refs.get('refs/heads/' + repository.defaultBranch);
  const caps = 'report-status side-band-64k delete-refs';
  if (tip && refs.length > 0) {
    chunks.push(framePacket(tip + ' HEAD\0' + caps + '\n'));
    for (const [name, oid] of refs) chunks.push(framePacket(oid + ' ' + name + '\n'));
  } else {
    chunks.push(framePacket(NULL_OID + ' capabilities^{}\0' + caps + '\n'));
  }
  chunks.push(PACKET_FLUSH);
  const out = Buffer.concat(chunks);
  repository.v0ReceiveBytes = out;
  return out;
}

// ---- ls-refs (v2) ----

/** Read the command= line of a v2 upload-pack POST body (ls-refs or fetch). */
export function uploadPackVerb(body: Buffer): 'ls-refs' | 'fetch' | null {
  if (body.length < 4) return null;
  const len = parseInt(body.subarray(0, 4).toString('ascii'), 16);
  if (!Number.isFinite(len) || len < 4 || len > body.length) return null;
  const first = body.subarray(4, len).toString('utf8').trim();
  if (first === 'command=ls-refs') return 'ls-refs';
  if (first === 'command=fetch') return 'fetch';
  return null;
}

export function serveLsRefs(state: State, repository: Repository, body: Buffer): Buffer {
  const { lines } = splitPackets(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const line of lines) {
    if (line.length === 1 && line[0] === 1) {
      pastDelim = true;
      continue;
    }
    const text = line.toString('utf8').trim();
    if (!pastDelim) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const key = (peel ? 'p' : '') + (symrefs ? 's' : '') + '|' + prefixes.join(',');
  const cached = repository.lsRefsStore.get(key);
  if (cached) return cached;
  const chunks: Buffer[] = [];
  const tip = repository.refs.get('refs/heads/' + repository.defaultBranch);
  const headAllowed = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (tip && headAllowed) {
    let line = tip + ' HEAD';
    if (symrefs) line += ' symref-target:refs/heads/' + repository.defaultBranch;
    chunks.push(framePacket(line + '\n'));
  }
  for (const [name, oid] of orderedRefs(repository)) {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
    let line = oid + ' ' + name;
    if (peel) {
      const obj = state.fetchObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = state.peelTag(oid);
        if (peeled !== oid) line += ' peeled:' + peeled;
      }
    }
    chunks.push(framePacket(line + '\n'));
  }
  chunks.push(PACKET_FLUSH);
  const out = Buffer.concat(chunks);
  if (repository.lsRefsStore.size > 64) repository.lsRefsStore.clear();
  repository.lsRefsStore.set(key, out);
  return out;
}

// ---- fetch (v2) ----

export function serveFetchV2(state: State, repository: Repository, body: Buffer): Buffer {
  const { lines } = splitPackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowOids = new Set<string>();
  let depth = 0;
  let pastDelim = false;
  for (const line of lines) {
    if (line.length === 1 && line[0] === 1) {
      pastDelim = true;
      continue;
    }
    if (!pastDelim) continue;
    const text = line.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
    else if (text.startsWith('shallow ')) shallowOids.add(text.slice(8, 48));
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const key =
    wants.join(',') + '|' + haves.join(',') + '|' + depth + '|' + [...shallowOids].sort().join(',');
  const cached = repository.fetchPackStore.get(key);
  if (cached) return cached;
  const { items, shallow, unshallow } = gatherObjects(state, wants, haves, shallowOids, depth);
  const pack = encodePack(items);
  const chunks: Buffer[] = [
    framePacket('acknowledgments\n'),
    framePacket('NAK\n'),
    PACKET_DELIM,
    framePacket('shallow-info\n'),
  ];
  for (const s of shallow) chunks.push(framePacket('shallow ' + s + '\n'));
  for (const s of unshallow) chunks.push(framePacket('unshallow ' + s + '\n'));
  chunks.push(PACKET_DELIM);
  chunks.push(framePacket('packfile\n'));
  for (const p of wrapSideband(pack)) chunks.push(p);
  chunks.push(PACKET_FLUSH);
  const out = Buffer.concat(chunks);
  if (repository.fetchPackStore.size > 64) repository.fetchPackStore.clear();
  repository.fetchPackStore.set(key, out);
  return out;
}

// ---- fetch (v0) ----

export function serveFetchV0(state: State, repository: Repository, body: Buffer): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowOids = new Set<string>();
  let depth = 0;
  let section = 0;
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      section += 1;
      i += 4;
      continue;
    }
    if (i + len > body.length) break;
    const text = body.subarray(i + 4, i + len).toString('utf8').trim();
    i += len;
    if (section === 0) {
      if (text.startsWith('want ')) wants.push(text.slice(5, 45));
      else if (text.startsWith('shallow ')) shallowOids.add(text.slice(8, 48));
      else if (text.startsWith('deepen ')) {
        const n = parseInt(text.slice(7), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5, 45));
    }
  }
  const key =
    'v0|' + wants.join(',') + '|' + haves.join(',') + '|' + depth + '|' + [...shallowOids].sort().join(',');
  const cached = repository.fetchPackStore.get(key);
  if (cached) return cached;
  const { items, shallow } = gatherObjects(state, wants, haves, shallowOids, depth);
  const pack = encodePack(items);
  const chunks: Buffer[] = [framePacket('NAK\n')];
  for (const s of shallow) chunks.push(framePacket('shallow ' + s + '\n'));
  for (const p of wrapSideband(pack)) chunks.push(p);
  chunks.push(PACKET_FLUSH);
  const out = Buffer.concat(chunks);
  if (repository.fetchPackStore.size > 64) repository.fetchPackStore.clear();
  repository.fetchPackStore.set(key, out);
  return out;
}

// ---- receive-pack ----

export function serveReceivePack(state: State, repository: Repository, body: Buffer): Buffer {
  const statusReport = (lines: string[]): Buffer => {
    const inner = Buffer.concat(lines.map((l) => framePacket(l)));
    return Buffer.concat([...wrapSideband(inner), PACKET_FLUSH]);
  };
  if (body.length === 0) return statusReport(['unpack error\n']);
  const parsed = splitPackets(body);
  const commandLines = parsed.lines;
  if (commandLines.length === 0) return statusReport(['unpack error\n']);
  interface RefCommand {
    old: string;
    next: string;
    ref: string;
  }
  const commands: RefCommand[] = [];
  let bad = false;
  for (const line of commandLines) {
    const text = line.toString('utf8');
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.trim().split(' ');
    if (parts.length < 3 || !isFortyHex(parts[0]) || !isFortyHex(parts[1])) {
      bad = true;
      break;
    }
    commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
  }
  if (bad || commands.length === 0) return statusReport(['unpack error\n']);
  const packBytes = body.subarray(parsed.end);
  if (packBytes.length > 0) {
    const items = decodePack(packBytes, state);
    if (!items) return statusReport(['unpack error\n']);
  }
  const results: string[] = ['unpack ok\n'];
  let mutated = false;
  for (const command of commands) {
    const current = repository.refs.get(command.ref);
    const tagRef = command.ref.startsWith('refs/tags/');
    if (command.next === NULL_OID) {
      if (current !== undefined && current === command.old) {
        repository.refs.delete(command.ref);
        mutated = true;
        results.push('ok ' + command.ref + '\n');
      } else if (current === undefined && command.old === NULL_OID) {
        results.push('ok ' + command.ref + '\n');
      } else {
        results.push('ng ' + command.ref + ' non-fast-forward\n');
      }
      continue;
    }
    if (command.old === NULL_OID) {
      if (current === undefined) {
        repository.refs.set(command.ref, command.next);
        mutated = true;
        results.push('ok ' + command.ref + '\n');
      } else {
        results.push('ng ' + command.ref + ' non-fast-forward\n');
      }
      continue;
    }
    if (current !== command.old) {
      results.push('ng ' + command.ref + ' non-fast-forward\n');
      continue;
    }
    if (tagRef) {
      repository.refs.set(command.ref, command.next);
      mutated = true;
      results.push('ok ' + command.ref + '\n');
      continue;
    }
    if (state.isReachable(command.old, command.next)) {
      repository.refs.set(command.ref, command.next);
      mutated = true;
      results.push('ok ' + command.ref + '\n');
    } else {
      results.push('ng ' + command.ref + ' non-fast-forward\n');
    }
  }
  if (mutated) state.invalidateRefCaches(repository);
  return statusReport(results);
}

export function advertV2(): Buffer {
  return V2_ADVERTISEMENT;
}
