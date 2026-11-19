// app.ts — the HTTP transport: a raw-TCP HTTP/1.1 server (net.Server,
// setNoDelay, keep-alive, pipelining) plus routing for the four surfaces.
//
// The read fast path lives here: GET /api/v3/repos/{owner}/{repo}/issues/{n}
// is answered by writing the issue's prebuilt response Buffer (built once
// at creation in store.ts) with no JSON work, no object allocation beyond
// the request parse, and no per-request header build. Everything else goes
// through the generic dispatcher below.

import { createServer, type Server, type Socket } from 'node:net';
import { State } from './store.ts';
import { serveRest, type RequestContext, type HttpResult, errorResponse } from './rest.ts';
import { serveGraphql } from './graphql.ts';
import { serveMcp } from './mcp.ts';
import {
  serveLsRefs,
  serveFetchV2,
  serveFetchV0,
  serveReceivePack,
  uploadPackVerb,
  buildV0UploadAdvert,
  buildV0ReceiveAdvert,
  advertV2,
} from './git.ts';

function parseTrialEpoch(raw: string | undefined): number {
  if (!raw) return 1735689600;
  if (/^\d+$/.test(raw)) {
    const ms = parseInt(raw, 10);
    return ms > 100000000000 ? Math.floor(ms / 1000) : ms;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 1735689600;
}

function parseQueryString(raw: string): Record<string, string> {
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

function decodePathSegment(s: string): string {
  if (s.indexOf('%') < 0) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const STATUS_TEXT: Record<number, string> = {
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
const KEPT_HEADERS = new Set(['authorization', 'content-length', 'git-protocol', 'host', 'connection', 'transfer-encoding', 'expect']);

interface IncomingRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  closeWhenDone: boolean;
}

/**
 * Parse one complete request out of `bytes`, or null when more bytes are
 * needed. `used` is how many bytes the request took. Sends a 100
 * Continue on the socket when the client asked for one and the headers
 * are in. The body is a view into `bytes`, never a copy.
 */
function parseHttpRequest(
  bytes: Buffer,
  socket: Socket,
): { request: IncomingRequest; used: number } | null | 'bad' {
  const hEnd = bytes.indexOf('\r\n\r\n');
  if (hEnd < 0) {
    if (bytes.length > 16384) return 'bad';
    return null;
  }
  const firstSp = bytes.indexOf(0x20);
  if (firstSp < 0 || firstSp > hEnd) return 'bad';
  const secondSp = bytes.indexOf(0x20, firstSp + 1);
  if (secondSp < 0 || secondSp > hEnd) return 'bad';
  const method = bytes.toString('ascii', 0, firstSp);
  let url = bytes.toString('ascii', firstSp + 1, secondSp);
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const slash = url.indexOf('/', url.indexOf('://') + 3);
    url = slash >= 0 ? url.slice(slash) : '/';
  }
  const headers: Record<string, string> = {};
  let lineStart = bytes.indexOf('\r\n', secondSp) + 2;
  while (lineStart < hEnd) {
    const lineEnd = bytes.indexOf('\r\n', lineStart);
    const end = lineEnd < 0 ? hEnd : lineEnd;
    const colon = bytes.indexOf(0x3a, lineStart);
    if (colon > 0 && colon < end) {
      const name = bytes.toString('ascii', lineStart, colon).trim().toLowerCase();
      if (KEPT_HEADERS.has(name) && !(name in headers)) {
        headers[name] = bytes.toString('ascii', colon + 1, end).trim();
      }
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 2;
  }
  const expect = headers['expect'] ?? '';
  if (expect.toLowerCase() === '100-continue') {
    socket.write('HTTP/1.1 100 Continue\r\n\r\n');
  }
  const bodyStart = hEnd + 4;
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (te.includes('chunked')) {
    let pos = bodyStart;
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const eol = bytes.indexOf('\r\n', pos);
      if (eol < 0) return null;
      const sizeText = bytes.subarray(pos, eol).toString('ascii').trim().split(';')[0];
      const size = parseInt(sizeText ?? '', 16);
      if (!Number.isFinite(size) || size < 0) return 'bad';
      if (size === 0) {
        const tailEnd = bytes.indexOf('\r\n', eol + 2);
        if (tailEnd < 0) return null;
        const body = Buffer.concat(chunks);
        const closeWhenDone = (headers['connection'] ?? '').toLowerCase().includes('close');
        return { request: { method, url, headers, body, closeWhenDone }, used: tailEnd + 2 };
      }
      const dataStart = eol + 2;
      if (bytes.length < dataStart + size + 2) return null;
      total += size;
      if (total > MAX_BODY) return 'bad';
      chunks.push(bytes.subarray(dataStart, dataStart + size));
      pos = dataStart + size + 2;
    }
  }
  const clenRaw = headers['content-length'];
  const clen = clenRaw !== undefined ? parseInt(clenRaw, 10) : 0;
  if (!Number.isFinite(clen) || clen < 0) return 'bad';
  if (clen > MAX_BODY) return 'bad';
  if (bytes.length < bodyStart + clen) return null;
  const body = clen > 0 ? bytes.subarray(bodyStart, bodyStart + clen) : Buffer.alloc(0);
  const closeWhenDone = (headers['connection'] ?? '').toLowerCase().includes('close');
  return { request: { method, url, headers, body, closeWhenDone }, used: bodyStart + clen };
}

/** Route one request through the forge and return its result. `bearer` is
 *  the prebuilt 'Bearer <token>' string, so no per-request concatenation. */
function dispatchRequest(state: State, token: string, bearer: string, request: IncomingRequest): HttpResult {
  try {
    const url = request.url;
    const qAt = url.indexOf('?');
    const rawPath = qAt >= 0 ? url.slice(0, qAt) : url;
    const rawQuery = qAt >= 0 ? url.slice(qAt + 1) : '';
    const segments = rawPath
      .split('/')
      .filter((s) => s !== '')
      .map(decodePathSegment);
    const query = parseQueryString(rawQuery);
    const method = request.method;
    const authHeader = request.headers['authorization'] ?? '';
    const authed = token !== '' ? authHeader === bearer : authHeader.startsWith('Bearer ') && authHeader.length > 7;
    const context: RequestContext = {
      state,
      method,
      segments,
      query,
      body: request.body,
      json: null,
      jsonError: false,
      host: request.headers['host'] ?? '127.0.0.1',
      authed,
    };

    if (segments.length === 1 && segments[0] === 'healthz') {
      return { status: 200, body: Buffer.from('{"ok":true}', 'utf8'), type: 'application/json; charset=utf-8' };
    }

    // git smart HTTP: /<owner>/<repo>.git/...
    if (segments.length >= 3 && segments[1].endsWith('.git')) {
      const owner = segments[0];
      const repoName = segments[1].slice(0, -4);
      if (!state.viewerOwns(owner)) return errorResponse(404, 'Not Found');
      const repository = state.findRepository(repoName);
      if (!repository) return errorResponse(404, 'Not Found');
      const gitPath = segments.slice(2);
      const isV2 = (request.headers['git-protocol'] ?? '') === 'version=2';
      if (method === 'GET' && gitPath.length === 2 && gitPath[0] === 'info' && gitPath[1] === 'refs') {
        const service = query.service ?? '';
        if (service === 'git-upload-pack') {
          const adv = isV2 ? advertV2() : buildV0UploadAdvert(state, repository);
          return { status: 200, body: adv, type: 'application/x-git-upload-pack-advertisement' };
        }
        if (service === 'git-receive-pack') {
          return { status: 200, body: buildV0ReceiveAdvert(repository), type: 'application/x-git-receive-pack-advertisement' };
        }
        return errorResponse(404, 'Not Found');
      }
      if (method === 'POST' && gitPath.length === 1 && gitPath[0] === 'git-upload-pack') {
        if (isV2) {
          const cmd = uploadPackVerb(request.body);
          if (cmd === 'ls-refs') {
            const out = serveLsRefs(state, repository, request.body);
            return { status: 200, body: out, type: 'application/x-git-upload-pack-result' };
          }
          if (cmd === 'fetch') {
            const out = serveFetchV2(state, repository, request.body);
            return { status: 200, body: out, type: 'application/x-git-upload-pack-result' };
          }
          return errorResponse(400, 'Unknown upload-pack command');
        }
        const out = serveFetchV0(state, repository, request.body);
        return { status: 200, body: out, type: 'application/x-git-upload-pack-result' };
      }
      if (method === 'POST' && gitPath.length === 1 && gitPath[0] === 'git-receive-pack') {
        const out = serveReceivePack(state, repository, request.body);
        return { status: 200, body: out, type: 'application/x-git-receive-pack-result' };
      }
      return errorResponse(404, 'Not Found');
    }

    if (request.body.length > 0) {
      try {
        context.json = JSON.parse(request.body.toString('utf8'));
      } catch {
        context.jsonError = true;
      }
    }

    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      const restContext: RequestContext = { ...context, segments: segments.slice(2) };
      const result = serveRest(restContext);
      if (result) return result;
      return errorResponse(404, 'Not Found');
    }

    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') return errorResponse(404, 'Not Found');
      return serveGraphql(context);
    }

    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method !== 'POST') return errorResponse(405, 'Method Not Allowed');
      return serveMcp(context);
    }

    return errorResponse(404, 'Not Found');
  } catch (e) {
    return errorResponse(500, e instanceof Error ? e.message : 'Internal Server Error');
  }
}

/** Write one response: headers first, then the body, as one socket write. */
function sendHttpResponse(socket: Socket, state: State, outcome: HttpResult, closeWhenDone: boolean): void {
  const reason = STATUS_TEXT[outcome.status] ?? '';
  let head = `HTTP/1.1 ${outcome.status} ${reason}\r\n`;
  if (outcome.type) head += `Content-Type: ${outcome.type}\r\n`;
  head += `Content-Length: ${outcome.body.length}\r\n`;
  head += `X-GitHub-Request-Id: ${state.nextRequestId()}\r\n`;
  if (outcome.headers) {
    for (const [k, v] of Object.entries(outcome.headers)) head += `${k}: ${v}\r\n`;
  }
  head += closeWhenDone ? 'Connection: close\r\n\r\n' : '\r\n';
  if (outcome.body.length > 0) {
    socket.write(Buffer.concat([Buffer.from(head, 'ascii'), outcome.body]));
  } else {
    socket.write(head);
  }
  if (closeWhenDone) socket.end();
}

/**
 * The read fast path. Returns true when the request was answered here.
 * Matches exactly GET /api/v3/repos/{owner}/{repo}/issues/{digits} with no
 * query string, a valid bearer token, and an already-adopted owner. The
 * answer is the issue's prebuilt response Buffer: one socket write, no
 * JSON, no lookup past two Maps, no header build.
 */
function tryIssueFastPath(socket: Socket, state: State, token: string, bearer: string, request: IncomingRequest): boolean {
  if (request.method !== 'GET') return false;
  const target = request.url;
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
  const auth = request.headers['authorization'] ?? '';
  if (token !== '') {
    if (auth !== bearer) return false;
  } else if (!auth.startsWith('Bearer ') || auth.length <= 7) {
    return false;
  }
  const owner = target.slice(prefix.length, s1);
  if (state.viewerName === null || state.viewerName !== owner) return false;
  const repository = state.findRepository(target.slice(s1 + 1, s2));
  if (!repository) return false;
  const issueRec = repository.issueByNumber.get(num);
  if (!issueRec || !issueRec.readyResponse) return false;
  socket.write(issueRec.readyResponse);
  if (request.closeWhenDone) socket.end();
  return true;
}

export function buildServer(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const bearer = 'Bearer ' + token;
  const epochBase = parseTrialEpoch(process.env.MAKEFUN_TRIAL_NOW);
  const state = new State(epochBase);

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(30000);
    socket.on('timeout', () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    let bytes = Buffer.alloc(0);
    let draining = false;
    function drain(): void {
      if (draining) return;
      draining = true;
      try {
        while (true) {
          if (bytes.length === 0) return;
          let parsed: ReturnType<typeof parseHttpRequest>;
          try {
            parsed = parseHttpRequest(bytes, socket);
          } catch {
            parsed = 'bad';
          }
          if (parsed === null) return;
          if (parsed === 'bad') {
            try {
              socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
              socket.end();
            } catch {
              /* ignore */
            }
            return;
          }
          const { request, used } = parsed;
          bytes = bytes.subarray(used);
          if (!tryIssueFastPath(socket, state, token, bearer, request)) {
            const outcome = dispatchRequest(state, token, bearer, request);
            try {
              sendHttpResponse(socket, state, outcome, request.closeWhenDone);
            } catch {
              return;
            }
          }
          if (request.closeWhenDone) return;
        }
      } finally {
        draining = false;
      }
    }
    socket.on('data', (chunk: Buffer) => {
      bytes = bytes.length === 0 ? chunk : Buffer.concat([bytes, chunk]);
      drain();
    });
  });

  return server;
}
