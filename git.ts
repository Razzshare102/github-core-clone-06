// git.ts — git smart HTTP: pack codec, advertisements, ls-refs, fetch
// (protocol v2 and v0) and receive-pack. Written fresh for this entry.
//
// Packs are plain objects only (no deltas), deflated at level 1. Deflated
// bytes are cached per object id forever (objects are immutable), so a
// repeated fetch of the same history is a concat of cached chunks instead
// of re-deflating. Pack inflation is synchronous (inflateSync with the
// engine's byte count), not a stream per object.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Store, type ObjType, type Repo } from './store.ts';
import { pktLine, parsePktLines, sidebandPackets, PKT_FLUSH, PKT_DELIM, isHex40, ZERO_OID } from './util.ts';

const TYPE_CODES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate one deflate stream starting at `start`; returns data + bytes consumed. */
export function inflateOne(buf: Buffer, start: number): { data: Buffer; consumed: number } | null {
  try {
    const result = inflateSync(buf.subarray(start), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = result.engine.bytesWritten;
    if (consumed > 0 && consumed <= buf.length - start) return { data: result.buffer, consumed };
  } catch {
    // fall through to the binary-search fallback below
  }
  // Fallback: binary search the minimal slice that inflates to a full stream.
  let lo = start;
  let hi = buf.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  try {
    const data = inflateSync(buf.subarray(start, hi));
    return { data, consumed: hi - start };
  } catch {
    return null;
  }
}

export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/** Parse a packfile. Returns null on any error (deltas never occur from the suite client). */
export function readPack(buf: Buffer, store: Store): PackEntry[] | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') return null;
  if (buf.readUInt32BE(4) !== 2) return null;
  const count = buf.readUInt32BE(8);
  let off = 12;
  const out: PackEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off >= buf.length) return null;
    let b = buf[off++];
    const typeCode = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      if (off >= buf.length) return null;
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) return null;
    const type = TYPE_CODES[typeCode];
    if (!type) return null;
    const inflated = inflateOne(buf, off);
    if (!inflated || inflated.data.length !== size) return null;
    off += inflated.consumed;
    const oid = store.putObject(type, inflated.data);
    out.push({ oid, type, data: inflated.data });
  }
  return out;
}

function entryHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let b = (size & 15) | (typeCode << 4);
  size >>>= 4;
  while (size > 0) {
    out.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  out.push(b);
  return Buffer.from(out);
}

/** Compressed bytes per object id. Objects are immutable, so a cached entry is valid forever. */
const deflateCache = new Map<string, Buffer>();

export function writePack(entries: PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const e of entries) {
    parts.push(entryHeader(TYPE_IDS[e.type], e.data.length));
    let comp = deflateCache.get(e.oid);
    if (!comp) {
      comp = deflateSync(e.data, { level: 1 });
      if (deflateCache.size > 20000) deflateCache.clear();
      deflateCache.set(e.oid, comp);
    }
    parts.push(comp);
  }
  const trailer = createHash('sha1');
  for (const p of parts) trailer.update(p);
  parts.push(trailer.digest());
  return Buffer.concat(parts);
}

export function emptyPack(): Buffer {
  return writePack([]);
}

export interface CollectResult {
  entries: PackEntry[];
  shallow: string[];
  unshallow: string[];
}

export function collectObjects(
  store: Store,
  wants: string[],
  haves: string[],
  shallowSet: Set<string>,
  depth: number,
): CollectResult {
  const excluded = new Set<string>();
  const pushReachable = (root: string, full: boolean) => {
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (excluded.has(oid)) continue;
      const obj = store.getObject(oid);
      if (!obj) continue;
      excluded.add(oid);
      if (obj.type === 'commit') {
        const info = store.parseCommit(oid);
        if (info) {
          stack.push(info.tree);
          if (full) for (const p of info.parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of store.parseTree(oid)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
  };
  for (const h of haves) {
    if (shallowSet.has(h)) pushReachable(h, false);
    else pushReachable(h, true);
  }
  for (const s of shallowSet) {
    if (!haves.includes(s)) pushReachable(s, false);
  }

  const levelOf = new Map<string, number>();
  const tagWants: string[] = [];
  const queue: [string, number][] = [];
  for (const w of wants) {
    const obj = store.getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      tagWants.push(w);
      const peeled = store.peel(w);
      if (peeled !== w && store.getObject(peeled)?.type === 'commit') queue.push([peeled, 0]);
    } else if (obj.type === 'commit') {
      queue.push([w, 0]);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const [oid, level] = queue[qi++];
    if (levelOf.has(oid)) continue;
    levelOf.set(oid, level);
    if (depth === 0 || level + 1 < depth) {
      const info = store.parseCommit(oid);
      if (info) for (const p of info.parents) queue.push([p, level + 1]);
    }
  }

  const included = new Map<string, PackEntry>();
  const addClosure = (root: string) => {
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (included.has(oid) || excluded.has(oid)) continue;
      const obj = store.getObject(oid);
      if (!obj) continue;
      included.set(oid, { oid, type: obj.type, data: obj.data });
      if (obj.type === 'commit') {
        const info = store.parseCommit(oid);
        if (info) stack.push(info.tree);
      } else if (obj.type === 'tree') {
        for (const e of store.parseTree(oid)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
  };
  for (const w of tagWants) addClosure(w);
  for (const oid of levelOf.keys()) addClosure(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth > 0) {
    for (const [oid, level] of levelOf) {
      if (level === depth - 1 && included.has(oid)) {
        const info = store.parseCommit(oid);
        if (info && info.parents.length > 0) shallow.push(oid);
      }
    }
  }
  for (const s of shallowSet) {
    const info = store.parseCommit(s);
    if (!info || info.parents.length === 0) continue;
    if (info.parents.every((p) => levelOf.has(p))) unshallow.push(s);
  }
  return { entries: [...included.values()], shallow, unshallow };
}

// ---- adverts ----

const V2_ADVERT = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  pktLine('agent=github-core-clone/1.0.0\n'),
  PKT_FLUSH,
]);

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function v0UploadAdvert(store: Store, repo: Repo): Buffer {
  if (repo.v0UploadAdvert) return repo.v0UploadAdvert;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
  const caps = 'side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/' + repo.defaultBranch;
  if (tip && refs.length > 0) {
    parts.push(pktLine(tip + ' HEAD\0' + caps + '\n'));
    for (const [name, oid] of refs) {
      parts.push(pktLine(oid + ' ' + name + '\n'));
      const obj = store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = store.peel(oid);
        if (peeled !== oid) parts.push(pktLine(peeled + ' ' + name + '^{}\n'));
      }
    }
  } else {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  repo.v0UploadAdvert = out;
  return out;
}

export function v0ReceiveAdvert(repo: Repo): Buffer {
  if (repo.v0ReceiveAdvert) return repo.v0ReceiveAdvert;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
  const caps = 'report-status side-band-64k delete-refs';
  if (tip && refs.length > 0) {
    parts.push(pktLine(tip + ' HEAD\0' + caps + '\n'));
    for (const [name, oid] of refs) parts.push(pktLine(oid + ' ' + name + '\n'));
  } else {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  repo.v0ReceiveAdvert = out;
  return out;
}

// ---- ls-refs (v2) ----

/** Read the command= line of a v2 upload-pack POST body (ls-refs or fetch). */
export function uploadPackCommand(body: Buffer): 'ls-refs' | 'fetch' | null {
  if (body.length < 4) return null;
  const len = parseInt(body.subarray(0, 4).toString('ascii'), 16);
  if (!Number.isFinite(len) || len < 4 || len > body.length) return null;
  const first = body.subarray(4, len).toString('utf8').trim();
  if (first === 'command=ls-refs') return 'ls-refs';
  if (first === 'command=fetch') return 'fetch';
  return null;
}

export function handleLsRefs(store: Store, repo: Repo, body: Buffer): Buffer {
  const { lines } = parsePktLines(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const line of lines) {
    if (line.length === 1 && line[0] === 1) {
      afterDelim = true;
      continue;
    }
    const text = line.toString('utf8').trim();
    if (!afterDelim) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const cacheKey = (peel ? 'p' : '') + (symrefs ? 's' : '') + '|' + prefixes.join(',');
  const cached = repo.lsRefsCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [];
  const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
  const headAllowed = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (tip && headAllowed) {
    let line = tip + ' HEAD';
    if (symrefs) line += ' symref-target:refs/heads/' + repo.defaultBranch;
    parts.push(pktLine(line + '\n'));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
    let line = oid + ' ' + name;
    if (peel) {
      const obj = store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = store.peel(oid);
        if (peeled !== oid) line += ' peeled:' + peeled;
      }
    }
    parts.push(pktLine(line + '\n'));
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  if (repo.lsRefsCache.size > 64) repo.lsRefsCache.clear();
  repo.lsRefsCache.set(cacheKey, out);
  return out;
}

// ---- fetch (v2) ----

export function handleFetchV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const { lines } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowSet = new Set<string>();
  let depth = 0;
  let afterDelim = false;
  for (const line of lines) {
    if (line.length === 1 && line[0] === 1) {
      afterDelim = true;
      continue;
    }
    if (!afterDelim) continue;
    const text = line.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
    else if (text.startsWith('shallow ')) shallowSet.add(text.slice(8, 48));
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const cacheKey =
    wants.join(',') + '|' + haves.join(',') + '|' + depth + '|' + [...shallowSet].sort().join(',');
  const cached = repo.fetchPackCache.get(cacheKey);
  if (cached) return cached;
  const { entries, shallow, unshallow } = collectObjects(store, wants, haves, shallowSet, depth);
  const pack = writePack(entries);
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    PKT_DELIM,
    pktLine('shallow-info\n'),
  ];
  for (const s of shallow) parts.push(pktLine('shallow ' + s + '\n'));
  for (const s of unshallow) parts.push(pktLine('unshallow ' + s + '\n'));
  parts.push(PKT_DELIM);
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  if (repo.fetchPackCache.size > 64) repo.fetchPackCache.clear();
  repo.fetchPackCache.set(cacheKey, out);
  return out;
}

// ---- fetch (v0) ----

export function handleFetchV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowSet = new Set<string>();
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
      else if (text.startsWith('shallow ')) shallowSet.add(text.slice(8, 48));
      else if (text.startsWith('deepen ')) {
        const n = parseInt(text.slice(7), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5, 45));
    }
  }
  const cacheKey =
    'v0|' + wants.join(',') + '|' + haves.join(',') + '|' + depth + '|' + [...shallowSet].sort().join(',');
  const cached = repo.fetchPackCache.get(cacheKey);
  if (cached) return cached;
  const { entries, shallow } = collectObjects(store, wants, haves, shallowSet, depth);
  const pack = writePack(entries);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine('shallow ' + s + '\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  if (repo.fetchPackCache.size > 64) repo.fetchPackCache.clear();
  repo.fetchPackCache.set(cacheKey, out);
  return out;
}

// ---- receive-pack ----

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const report = (lines: string[]): Buffer => {
    const inner = Buffer.concat(lines.map((l) => pktLine(l)));
    return Buffer.concat([...sidebandPackets(inner), PKT_FLUSH]);
  };
  if (body.length === 0) return report(['unpack error\n']);
  const parsed = parsePktLines(body);
  const cmdLines = parsed.lines;
  if (cmdLines.length === 0) return report(['unpack error\n']);
  interface Cmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const cmds: Cmd[] = [];
  let bad = false;
  for (const line of cmdLines) {
    const text = line.toString('utf8');
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.trim().split(' ');
    if (parts.length < 3 || !isHex40(parts[0]) || !isHex40(parts[1])) {
      bad = true;
      break;
    }
    cmds.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (bad || cmds.length === 0) return report(['unpack error\n']);
  const packBytes = body.subarray(parsed.end);
  if (packBytes.length > 0) {
    const entries = readPack(packBytes, store);
    if (!entries) return report(['unpack error\n']);
  }
  const results: string[] = ['unpack ok\n'];
  let changed = false;
  for (const cmd of cmds) {
    const cur = repo.refs.get(cmd.ref);
    const isTag = cmd.ref.startsWith('refs/tags/');
    if (cmd.newOid === ZERO_OID) {
      if (cur !== undefined && cur === cmd.oldOid) {
        repo.refs.delete(cmd.ref);
        changed = true;
        results.push('ok ' + cmd.ref + '\n');
      } else if (cur === undefined && cmd.oldOid === ZERO_OID) {
        results.push('ok ' + cmd.ref + '\n');
      } else {
        results.push('ng ' + cmd.ref + ' non-fast-forward\n');
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (cur === undefined) {
        repo.refs.set(cmd.ref, cmd.newOid);
        changed = true;
        results.push('ok ' + cmd.ref + '\n');
      } else {
        results.push('ng ' + cmd.ref + ' non-fast-forward\n');
      }
      continue;
    }
    if (cur !== cmd.oldOid) {
      results.push('ng ' + cmd.ref + ' non-fast-forward\n');
      continue;
    }
    if (isTag) {
      repo.refs.set(cmd.ref, cmd.newOid);
      changed = true;
      results.push('ok ' + cmd.ref + '\n');
      continue;
    }
    if (store.isAncestor(cmd.oldOid, cmd.newOid)) {
      repo.refs.set(cmd.ref, cmd.newOid);
      changed = true;
      results.push('ok ' + cmd.ref + '\n');
    } else {
      results.push('ng ' + cmd.ref + ' non-fast-forward\n');
    }
  }
  if (changed) store.bumpRefs(repo);
  return report(results);
}

export function v2Advert(): Buffer {
  return V2_ADVERT;
}
