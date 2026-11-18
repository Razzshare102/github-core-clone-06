// app.ts — the HTTP transport: a raw-TCP HTTP/1.1 server (net.Server,
// setNoDelay, keep-alive, pipelining) plus routing for the four surfaces.
// Written fresh for this entry.
//
// The read fast path lives here: GET /api/v3/repos/{owner}/{repo}/issues/{n}
// is answered by writing the issue's prebuilt response Buffer (built once
// at creation in store.ts) with no JSON work, no object allocation beyond
// the request parse, and no per-request header build. Everything else goes
// through the generic router below.

import { createServer, type Server, type Socket } from 'node:net';
import { Store } from './store.ts';
import { handleRest, type Ctx, type RestResult, errResult } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleLsRefs,
  handleFetchV2,
  handleFetchV0,
  handleReceivePack,
  uploadPackCommand,
  v0UploadAdvert,
  v0ReceiveAdvert,
  v2Advert,
} from './git.ts';

function parseTrialNow(raw: string | undefined): number {
  if (!raw) return 1735689600;
  if (/^\d+$/.test(raw)) {
    const ms = parseInt(raw, 10);
    return ms > 100000000000 ? Math.floor(ms / 1000) : ms;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 1735689600;
}

function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq >= 0 ? part.slice(0, eq) : part;
    const v = eq >= 0 ? part.slice(eq + 1) : '';
    let dk: string;
    let dv: string;
    try {
      dk = decodeURIComponent(k.replace(/\+/g, ' '));
    } catch {
      dk = k;
    }
    try {
      dv = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      dv = v;
    }
    if (!(dk in out)) out[dk] = dv;
  }
  return out;
}

function decodeSegment(s: string): string {
  if (s.indexOf('%') < 0) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const MAX_BODY = 32 * 1024 * 1024;

/** The only request headers the forge reads. */
const WANTED = new Set(['authorization', 'content-length', 'git-protocol', 'host', 'connection', 'transfer-encoding', 'expect']);

interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  closeAfter: boolean;
}

/**
 * Parse one complete request out of `buf`, or null when more bytes are
 * needed. `consumed` is how many bytes the request took. Sends a 100
 * Continue on the socket when the client asked for one and the headers
 * are in. The body is a view into `buf`, never a copy.
 */
function parseRequest(
  buf: Buffer,
  sock: Socket,
): { req: HttpRequest; consumed: number } | null | 'bad' {
  const hEnd = buf.indexOf('\r\n\r\n');
  if (hEnd < 0) {
    if (buf.length > 16384) return 'bad';
    return null;
  }
  const firstSp = buf.indexOf(0x20);
  if (firstSp < 0 || firstSp > hEnd) return 'bad';
  const secondSp = buf.indexOf(0x20, firstSp + 1);
  if (secondSp < 0 || secondSp > hEnd) return 'bad';
  const method = buf.toString('ascii', 0, firstSp);
  let url = buf.toString('ascii', firstSp + 1, secondSp);
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const slash = url.indexOf('/', url.indexOf('://') + 3);
    url = slash >= 0 ? url.slice(slash) : '/';
  }
  const headers: Record<string, string> = {};
  let lineStart = buf.indexOf('\r\n', secondSp) + 2;
  while (lineStart < hEnd) {
    const lineEnd = buf.indexOf('\r\n', lineStart);
    const end = lineEnd < 0 ? hEnd : lineEnd;
    const colon = buf.indexOf(0x3a, lineStart);
    if (colon > 0 && colon < end) {
      const name = buf.toString('ascii', lineStart, colon).trim().toLowerCase();
      if (WANTED.has(name) && !(name in headers)) {
        headers[name] = buf.toString('ascii', colon + 1, end).trim();
      }
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 2;
  }
  const expect = headers['expect'] ?? '';
  if (expect.toLowerCase() === '100-continue') {
    sock.write('HTTP/1.1 100 Continue\r\n\r\n');
  }
  const bodyStart = hEnd + 4;
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (te.includes('chunked')) {
    let pos = bodyStart;
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const eol = buf.indexOf('\r\n', pos);
      if (eol < 0) return null;
      const sizeText = buf.subarray(pos, eol).toString('ascii').trim().split(';')[0];
      const size = parseInt(sizeText ?? '', 16);
      if (!Number.isFinite(size) || size < 0) return 'bad';
      if (size === 0) {
        const tailEnd = buf.indexOf('\r\n', eol + 2);
        if (tailEnd < 0) return null;
        const body = Buffer.concat(chunks);
        const closeAfter = (headers['connection'] ?? '').toLowerCase().includes('close');
        return { req: { method, url, headers, body, closeAfter }, consumed: tailEnd + 2 };
      }
      const dataStart = eol + 2;
      if (buf.length < dataStart + size + 2) return null;
      total += size;
      if (total > MAX_BODY) return 'bad';
      chunks.push(buf.subarray(dataStart, dataStart + size));
      pos = dataStart + size + 2;
    }
  }
  const clenRaw = headers['content-length'];
  const clen = clenRaw !== undefined ? parseInt(clenRaw, 10) : 0;
  if (!Number.isFinite(clen) || clen < 0) return 'bad';
  if (clen > MAX_BODY) return 'bad';
  if (buf.length < bodyStart + clen) return null;
  const body = clen > 0 ? buf.subarray(bodyStart, bodyStart + clen) : Buffer.alloc(0);
  const closeAfter = (headers['connection'] ?? '').toLowerCase().includes('close');
  return { req: { method, url, headers, body, closeAfter }, consumed: bodyStart + clen };
}

/** Route one request through the forge and return its result. `bearer` is
 *  the prebuilt 'Bearer <token>' string, so no per-request concatenation. */
function route(store: Store, token: string, bearer: string, req: HttpRequest): RestResult {
  try {
    const url = req.url;
    const qAt = url.indexOf('?');
    const rawPath = qAt >= 0 ? url.slice(0, qAt) : url;
    const rawQuery = qAt >= 0 ? url.slice(qAt + 1) : '';
    const segments = rawPath
      .split('/')
      .filter((s) => s !== '')
      .map(decodeSegment);
    const query = parseQuery(rawQuery);
    const method = req.method;
    const authHeader = req.headers['authorization'] ?? '';
    const authed = token !== '' ? authHeader === bearer : authHeader.startsWith('Bearer ') && authHeader.length > 7;
    const ctx: Ctx = {
      store,
      method,
      segments,
      query,
      body: req.body,
      json: null,
      jsonError: false,
      host: req.headers['host'] ?? '127.0.0.1',
      authed,
    };

    if (segments.length === 1 && segments[0] === 'healthz') {
      return { status: 200, body: Buffer.from('{"ok":true}', 'utf8'), type: 'application/json; charset=utf-8' };
    }

    // git smart HTTP: /<owner>/<repo>.git/...
    if (segments.length >= 3 && segments[1].endsWith('.git')) {
      const owner = segments[0];
      const repoName = segments[1].slice(0, -4);
      if (!store.ownerMatches(owner)) return errResult(404, 'Not Found');
      const repo = store.getRepo(repoName);
      if (!repo) return errResult(404, 'Not Found');
      const gitPath = segments.slice(2);
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (method === 'GET' && gitPath.length === 2 && gitPath[0] === 'info' && gitPath[1] === 'refs') {
        const service = query.service ?? '';
        if (service === 'git-upload-pack') {
          const adv = isV2 ? v2Advert() : v0UploadAdvert(store, repo);
          return { status: 200, body: adv, type: 'application/x-git-upload-pack-advertisement' };
        }
        if (service === 'git-receive-pack') {
          return { status: 200, body: v0ReceiveAdvert(repo), type: 'application/x-git-receive-pack-advertisement' };
        }
        return errResult(404, 'Not Found');
      }
      if (method === 'POST' && gitPath.length === 1 && gitPath[0] === 'git-upload-pack') {
        if (isV2) {
          const cmd = uploadPackCommand(req.body);
          if (cmd === 'ls-refs') {
            const out = handleLsRefs(store, repo, req.body);
            return { status: 200, body: out, type: 'application/x-git-upload-pack-result' };
          }
          if (cmd === 'fetch') {
            const out = handleFetchV2(store, repo, req.body);
            return { status: 200, body: out, type: 'application/x-git-upload-pack-result' };
          }
          return errResult(400, 'Unknown upload-pack command');
        }
        const out = handleFetchV0(store, repo, req.body);
        return { status: 200, body: out, type: 'application/x-git-upload-pack-result' };
      }
      if (method === 'POST' && gitPath.length === 1 && gitPath[0] === 'git-receive-pack') {
        const out = handleReceivePack(store, repo, req.body);
        return { status: 200, body: out, type: 'application/x-git-receive-pack-result' };
      }
      return errResult(404, 'Not Found');
    }

    if (req.body.length > 0) {
      try {
        ctx.json = JSON.parse(req.body.toString('utf8'));
      } catch {
        ctx.jsonError = true;
      }
    }

    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      const restCtx: Ctx = { ...ctx, segments: segments.slice(2) };
      const result = handleRest(restCtx);
      if (result) return result;
      return errResult(404, 'Not Found');
    }

    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') return errResult(404, 'Not Found');
      return handleGraphql(ctx);
    }

    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method !== 'POST') return errResult(405, 'Method Not Allowed');
      return handleMcp(ctx);
    }

    return errResult(404, 'Not Found');
  } catch (e) {
    return errResult(500, e instanceof Error ? e.message : 'Internal Server Error');
  }
}

/** Write one response: headers first, then the body, as one socket write. */
function writeResponse(sock: Socket, store: Store, result: RestResult, closeAfter: boolean): void {
  const reason = REASONS[result.status] ?? '';
  let head = `HTTP/1.1 ${result.status} ${reason}\r\n`;
  if (result.type) head += `Content-Type: ${result.type}\r\n`;
  head += `Content-Length: ${result.body.length}\r\n`;
  head += `X-GitHub-Request-Id: ${store.nextReqId()}\r\n`;
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) head += `${k}: ${v}\r\n`;
  }
  head += closeAfter ? 'Connection: close\r\n\r\n' : '\r\n';
  if (result.body.length > 0) {
    sock.write(Buffer.concat([Buffer.from(head, 'ascii'), result.body]));
  } else {
    sock.write(head);
  }
  if (closeAfter) sock.end();
}

/**
 * The read fast path. Returns true when the request was answered here.
 * Matches exactly GET /api/v3/repos/{owner}/{repo}/issues/{digits} with no
 * query string, a valid bearer token, and an already-adopted owner. The
 * answer is the issue's prebuilt response Buffer: one socket write, no
 * JSON, no lookup past two Maps, no header build.
 */
function tryFastRead(sock: Socket, store: Store, token: string, bearer: string, req: HttpRequest): boolean {
  if (req.method !== 'GET') return false;
  const target = req.url;
  if (target.indexOf('?') >= 0) return false;
  const prefix = '/api/v3/repos/';
  if (!target.startsWith(prefix)) return false;
  const s1 = target.indexOf('/', prefix.length);
  if (s1 < 0) return false;
  const s2 = target.indexOf('/', s1 + 1);
  if (s2 < 0) return false;
  const s3 = target.indexOf('/', s2 + 1);
  if (s3 < 0) return false;
  if (target.slice(s2 + 1, s3) !== 'issues') return false;
  const numText = target.slice(s3 + 1);
  if (numText.length === 0 || numText.length > 10) return false;
  let num = 0;
  for (let i = 0; i < numText.length; i++) {
    const c = numText.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    num = num * 10 + (c - 48);
  }
  const auth = req.headers['authorization'] ?? '';
  if (token !== '') {
    if (auth !== bearer) return false;
  } else if (!auth.startsWith('Bearer ') || auth.length <= 7) {
    return false;
  }
  const owner = target.slice(prefix.length, s1);
  if (store.viewerLogin === null || store.viewerLogin !== owner) return false;
  const repo = store.getRepo(target.slice(s1 + 1, s2));
  if (!repo) return false;
  const issue = repo.issuesByNumber.get(num);
  if (!issue || !issue.httpResponse) return false;
  sock.write(issue.httpResponse);
  if (req.closeAfter) sock.end();
  return true;
}

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const bearer = 'Bearer ' + token;
  const nowBase = parseTrialNow(process.env.MAKEFUN_TRIAL_NOW);
  const store = new Store(nowBase);

  const server = createServer((sock: Socket) => {
    sock.setNoDelay(true);
    sock.setTimeout(30000);
    sock.on('timeout', () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    });
    sock.on('error', () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    });
    let buf = Buffer.alloc(0);
    let draining = false;
    function drain(): void {
      if (draining) return;
      draining = true;
      try {
        while (true) {
          if (buf.length === 0) return;
          let parsed: ReturnType<typeof parseRequest>;
          try {
            parsed = parseRequest(buf, sock);
          } catch {
            parsed = 'bad';
          }
          if (parsed === null) return;
          if (parsed === 'bad') {
            try {
              sock.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
              sock.end();
            } catch {
              /* ignore */
            }
            return;
          }
          const { req, consumed } = parsed;
          buf = buf.subarray(consumed);
          if (!tryFastRead(sock, store, token, bearer, req)) {
            const result = route(store, token, bearer, req);
            try {
              writeResponse(sock, store, result, req.closeAfter);
            } catch {
              return;
            }
          }
          if (req.closeAfter) return;
        }
      } finally {
        draining = false;
      }
    }
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      drain();
    });
  });

  return server;
}
