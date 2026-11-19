// rest.ts — the REST v3 API under /api/v3. Route shapes and response
// fields follow the suite's contract (see the kit's RULES.txt); the issue
// serializers live in store.ts so the read fast path can reuse the same
// ready-made bytes.

import { State, type Repository, type IssueRec, type PullRec, type IssueComment, type RepoLabel } from './store.ts';
import { isoTimestamp, encodeBase64Url } from './util.ts';

export interface RequestContext {
  state: State;
  method: string;
  segments: string[];
  query: Record<string, string>;
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  host: string;
  authed: boolean;
}

export interface HttpResult {
  status: number;
  body: Buffer;
  type?: string;
  headers?: Record<string, string>;
}

export function jsonResponse(status: number, obj: unknown, headers?: Record<string, string>): HttpResult {
  return { status, body: Buffer.from(JSON.stringify(obj), 'utf8'), type: 'application/json; charset=utf-8', headers };
}

export function errorResponse(status: number, message: string): HttpResult {
  return jsonResponse(status, { message });
}

function requestBody(context: RequestContext): Record<string, unknown> {
  if (context.json && typeof context.json === 'object' && !Array.isArray(context.json)) return context.json as Record<string, unknown>;
  return {};
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

function pageNumber(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function pageUrl(context: RequestContext, base: string, page: number, perPage: number): string {
  return `http://${context.host}${base}?per_page=${perPage}&page=${page}`;
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const m = line.match(/^(.*?) <(.*?)> (\d+) [+-]\d{4}$/);
  if (!m) return { name: line, email: '', date: '' };
  return { name: m[1], email: m[2], date: isoTimestamp(parseInt(m[3], 10)) };
}

// ---- serializers ----

export function repositoryJson(state: State, repository: Repository): Buffer {
  if (repository.repoJsonBytes) return repository.repoJsonBytes;
  const owner = state.viewerName ?? repository.owner;
  const obj = {
    id: repository.id,
    node_id: state.repositoryNodeId(repository),
    name: repository.name,
    full_name: owner + '/' + repository.name,
    owner: { login: owner, id: state.viewerNumber, type: 'User' },
    private: repository.isPrivate,
    description: repository.description,
    default_branch: repository.defaultBranch,
    created_at: repository.createdAt,
    updated_at: repository.updatedAt,
    pushed_at: repository.updatedAt,
    html_url: 'https://github.com/' + owner + '/' + repository.name,
    url: '/api/v3/repos/' + owner + '/' + repository.name,
    clone_url: 'https://github.com/' + owner + '/' + repository.name + '.git',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    open_issues_count: repository.issueList.filter((i) => i.state === 'open').length,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    license: null,
    topics: [],
    visibility: repository.isPrivate ? 'private' : 'public',
  };
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  repository.repoJsonBytes = buf;
  return buf;
}

function renderComment(state: State, repository: Repository, comment: IssueComment): Record<string, unknown> {
  const owner = state.viewerName ?? repository.owner;
  return {
    id: comment.id,
    node_id: comment.gqlId,
    body: comment.body,
    user: { login: owner, id: state.viewerNumber, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: 'https://github.com/' + owner + '/' + repository.name + '/issues/comments/' + comment.id,
    url: '/api/v3/repos/' + owner + '/' + repository.name + '/issues/comments/' + comment.id,
  };
}

function renderLabel(repository: Repository, label: RepoLabel): Record<string, unknown> {
  return {
    id: label.id,
    node_id: encodeBase64Url('L:' + repository.name + ':' + label.name),
    name: label.name,
    color: label.color,
    description: '',
    default: false,
    url: '/api/v3/repos/' + repository.owner + '/' + repository.name + '/labels/' + encodeURIComponent(label.name),
  };
}

export function pullRequestJson(state: State, repository: Repository, pullRec: PullRec): Record<string, unknown> {
  const owner = state.viewerName ?? repository.owner;
  return {
    id: pullRec.id,
    node_id: pullRec.gqlId,
    number: pullRec.number,
    title: pullRec.title,
    body: pullRec.body,
    state: pullRec.state,
    merged: pullRec.merged,
    mergeable: !pullRec.merged && pullRec.state === 'open',
    merged_at: pullRec.mergedAt,
    merge_commit_sha: pullRec.mergeSha,
    head: { ref: pullRec.head, sha: pullRec.headSha, label: owner + ':' + pullRec.head, repo: { name: repository.name, full_name: owner + '/' + repository.name } },
    base: { ref: pullRec.base, sha: pullRec.baseSha, label: owner + ':' + pullRec.base, repo: { name: repository.name, full_name: owner + '/' + repository.name } },
    user: { login: owner, id: state.viewerNumber, type: 'User' },
    created_at: pullRec.createdAt,
    updated_at: pullRec.updatedAt,
    closed_at: pullRec.state === 'closed' ? pullRec.updatedAt : null,
    html_url: 'https://github.com/' + owner + '/' + repository.name + '/pull/' + pullRec.number,
    url: '/api/v3/repos/' + owner + '/' + repository.name + '/pulls/' + pullRec.number,
  };
}

function renderBranch(repository: Repository, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: '/api/v3/repos/' + repository.owner + '/' + repository.name + '/commits/' + sha },
    protected: false,
  };
}

function renderCommit(state: State, oid: string): Record<string, unknown> | null {
  const info = state.readCommit(oid);
  if (!info) return null;
  const author = parseAuthorLine(info.author);
  const owner = state.viewerName ?? '';
  return {
    sha: oid,
    commit: {
      message: info.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: author.name, email: author.email, date: author.date },
    },
    author: { login: owner },
    committer: { login: owner },
    parents: info.parents.map((p) => ({ sha: p })),
    url: '/api/v3/repos/x/x/commits/' + oid,
  };
}

/** Simple LCS line diff; returns {additions, deletions}. */
function countLineDiff(a: string, b: string): { additions: number; deletions: number } {
  const left = a === '' ? [] : a.split('\n');
  const right = b === '' ? [] : b.split('\n');
  if (left.length > 2000 || right.length > 2000) return { additions: 1, deletions: 1 };
  const n = left.length;
  const m = right.length;
  const table: number[][] = [];
  for (let i = 0; i <= n; i++) table.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      deletions++;
      i++;
    } else {
      additions++;
      j++;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

/** Squash-merge a pull request. Shared by REST, GraphQL and MCP. */
export function squashMergePull(state: State, repository: Repository, pullRec: PullRec): { ok: boolean; status: number; message: string; sha?: string } {
  const baseTip = repository.refs.get('refs/heads/' + pullRec.base);
  if (!baseTip) return { ok: false, status: 404, message: 'Not Found' };
  if (pullRec.state !== 'open') return { ok: false, status: 405, message: 'Pull request is not open' };
  const prBaseFlat = state.flattenTree(pullRec.baseSha);
  const headFlat = state.flattenTree(pullRec.headSha);
  const curBaseFlat = state.flattenTree(baseTip);
  const changedHead = new Map<string, string | null>();
  for (const p of new Set([...prBaseFlat.keys(), ...headFlat.keys()])) {
    const a = prBaseFlat.get(p)?.oid ?? null;
    const c = headFlat.get(p)?.oid ?? null;
    if (a !== c) changedHead.set(p, c);
  }
  for (const p of new Set([...prBaseFlat.keys(), ...curBaseFlat.keys()])) {
    const a = prBaseFlat.get(p)?.oid ?? null;
    const c = curBaseFlat.get(p)?.oid ?? null;
    if (a !== c && changedHead.has(p) && changedHead.get(p) !== c) {
      return { ok: false, status: 405, message: 'Merge conflict' };
    }
  }
  const headInfo = state.readCommit(pullRec.headSha);
  if (!headInfo) return { ok: false, status: 422, message: 'Unknown head commit' };
  const mergeOid = state.makeCommit(
    repository,
    headInfo.tree,
    [baseTip],
    'Merge pull request #' + pullRec.number + ' from ' + repository.owner + '/' + pullRec.head,
  );
  state.flatCache.set(mergeOid, new Map(headFlat));
  repository.refs.set('refs/heads/' + pullRec.base, mergeOid);
  state.invalidateRefCaches(repository);
  const seq = state.now();
  pullRec.state = 'closed';
  pullRec.merged = true;
  pullRec.mergedAt = isoTimestamp(seq);
  pullRec.mergeSha = mergeOid;
  pullRec.updatedAt = isoTimestamp(seq);
  return { ok: true, status: 200, message: 'Pull request successfully merged', sha: mergeOid };
}

function subtreeOid(state: State, commitOid: string, dirPath: string): string | null {
  const info = state.readCommit(commitOid);
  if (!info) return null;
  if (dirPath === '') return info.tree;
  let cur = info.tree;
  for (const seg of dirPath.split('/')) {
    let found: string | null = null;
    for (const e of state.readTree(cur)) {
      if (e.name === seg && e.mode === '40000') {
        found = e.oid;
        break;
      }
    }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

// ---- route helpers ----

function loadRepository(context: RequestContext, owner: string, name: string): Repository | HttpResult {
  const state = context.state;
  if (!state.viewerOwns(owner)) return errorResponse(404, 'Not Found');
  const repository = state.findRepository(name);
  if (!repository) return errorResponse(404, 'Not Found');
  return repository;
}

function isErrorResult(v: Repository | HttpResult): v is HttpResult {
  return (v as HttpResult).status !== undefined;
}

// ---- main handler ----

export function serveRest(context: RequestContext): HttpResult | null {
  const { state, method, segments: path } = context;
  if (path.length === 0) {
    if (method !== 'GET') return errorResponse(404, 'Not Found');
    return jsonResponse(
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }
  if (path.length === 1 && path[0] === 'meta') {
    if (method !== 'GET') return errorResponse(404, 'Not Found');
    return jsonResponse(200, { installed_version: '1.0.0' });
  }
  if (!context.authed) return errorResponse(401, 'Requires authentication');
  if (context.jsonError) return errorResponse(400, 'Problems parsing JSON');

  if (path[0] === 'user') {
    if (path.length === 1) {
      if (method !== 'GET') return errorResponse(404, 'Not Found');
      if (!state.viewerName) return errorResponse(404, 'Not Found');
      return jsonResponse(200, {
        login: state.viewerName,
        id: state.viewerNumber,
        node_id: encodeBase64Url('U:' + state.viewerName),
        type: 'User',
        html_url: 'https://github.com/' + state.viewerName,
        url: '/api/v3/user',
      });
    }
    if (path.length === 2 && path[1] === 'repos') {
      if (method === 'POST') {
        const b = requestBody(context);
        const name = asString(b.name);
        if (!name || name.includes('/')) return errorResponse(422, 'Invalid repository name');
        if (state.findRepository(name)) return errorResponse(422, 'Repository already exists');
        const repository = state.addRepository(name, asString(b.description), asBool(b.private, false));
        return { status: 201, body: repositoryJson(state, repository), type: 'application/json; charset=utf-8' };
      }
      if (method === 'GET') {
        const perPage = pageNumber(context.query.per_page, 30);
        const page = pageNumber(context.query.page, 1);
        const all = [...state.repositories.values()].sort((a, b) => a.createdSeq - b.createdSeq);
        const start = (page - 1) * perPage;
        const slice = all.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < all.length) {
          headers.Link = '<' + pageUrl(context, '/api/v3/user/repos', page + 1, perPage) + '>; rel="next"';
        }
        return jsonResponse(
          200,
          slice.map((r) => JSON.parse(repositoryJson(state, r).toString('utf8'))),
          headers,
        );
      }
      return errorResponse(404, 'Not Found');
    }
    return errorResponse(404, 'Not Found');
  }

  if (path[0] === 'repos' && path.length >= 3) {
    const owner = path[1];
    const name = path[2];
    const rest = path.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') {
        const r = loadRepository(context, owner, name);
        if (isErrorResult(r)) return r;
        return { status: 200, body: repositoryJson(state, r), type: 'application/json; charset=utf-8' };
      }
      if (method === 'PATCH') {
        const r = loadRepository(context, owner, name);
        if (isErrorResult(r)) return r;
        const b = requestBody(context);
        if (typeof b.description === 'string') r.description = b.description;
        r.updatedAt = isoTimestamp(state.now());
        r.repoJsonBytes = null;
        return { status: 200, body: repositoryJson(state, r), type: 'application/json; charset=utf-8' };
      }
      if (method === 'DELETE') {
        const r = loadRepository(context, owner, name);
        if (isErrorResult(r)) return r;
        state.repositories.delete(name);
        return { status: 204, body: Buffer.alloc(0) };
      }
      return errorResponse(404, 'Not Found');
    }

    const r0 = loadRepository(context, owner, name);
    if (isErrorResult(r0)) return r0;
    const repository = r0;

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        if (repository.branchListBytes) return { status: 200, body: repository.branchListBytes, type: 'application/json; charset=utf-8' };
        const list = [...repository.refs.entries()]
          .filter(([n]) => n.startsWith('refs/heads/'))
          .map(([n, oid]) => renderBranch(repository, n.slice(11), oid))
          .sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
        const buf = Buffer.from(JSON.stringify(list), 'utf8');
        repository.branchListBytes = buf;
        return { status: 200, body: buf, type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = repository.refs.get('refs/heads/' + rest[1]);
        if (!oid) return errorResponse(404, 'Not Found');
        return jsonResponse(200, renderBranch(repository, rest[1], oid));
      }
      return errorResponse(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const oid = repository.refs.get('refs/heads/' + rest[3]);
        if (!oid) return errorResponse(404, 'Not Found');
        return jsonResponse(200, {
          ref: 'refs/heads/' + rest[3],
          node_id: encodeBase64Url('REF:refs/heads/' + rest[3]),
          object: { sha: oid, type: 'commit', url: '/api/v3/repos/' + owner + '/' + name + '/git/commits/' + oid },
          url: '/api/v3/repos/' + owner + '/' + name + '/git/refs/heads/' + rest[3],
        });
      }
      if (rest.length === 2 && method === 'POST') {
        const b = requestBody(context);
        const ref = asString(b.ref);
        const sha = asString(b.sha);
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return errorResponse(422, 'Invalid ref');
        if (!state.readCommit(sha) && state.fetchObject(sha)?.type !== 'tag') return errorResponse(422, 'Unknown object');
        if (repository.refs.has(ref)) return errorResponse(422, 'Reference already exists');
        repository.refs.set(ref, sha);
        state.invalidateRefCaches(repository);
        return jsonResponse(201, {
          ref,
          node_id: encodeBase64Url('REF:' + ref),
          object: { sha, type: 'commit', url: '/api/v3/repos/' + owner + '/' + name + '/git/commits/' + sha },
          url: '/api/v3/repos/' + owner + '/' + name + '/git/refs/' + ref,
        });
      }
      return errorResponse(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const shaQ = context.query.sha;
        let tip: string | undefined;
        if (shaQ) {
          if (repository.refs.has('refs/heads/' + shaQ)) tip = repository.refs.get('refs/heads/' + shaQ);
          else if (state.fetchObject(shaQ)?.type === 'commit') tip = shaQ;
          else return errorResponse(404, 'Not Found');
        } else {
          tip = repository.refs.get('refs/heads/' + repository.defaultBranch);
        }
        if (!tip) return jsonResponse(200, []);
        const seen = new Set<string>();
        const stack = [tip];
        const found: string[] = [];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const info = state.readCommit(cur);
          if (!info) continue;
          found.push(cur);
          for (const p of info.parents) stack.push(p);
        }
        found.sort((a, b) => {
          const ia = state.readCommit(a)!;
          const ib = state.readCommit(b)!;
          return ib.ts - ia.ts;
        });
        const list = found.map((oid) => renderCommit(state, oid)).filter((x) => x !== null);
        return jsonResponse(200, list);
      }
      return errorResponse(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const path2 = rest.slice(1).join('/');
      if (method === 'PUT') {
        const b = requestBody(context);
        const message = asString(b.message) || 'Update ' + path2;
        const contentB64 = asString(b.content);
        if (!contentB64) return errorResponse(422, 'content is required');
        const branch = asString(b.branch) || repository.defaultBranch;
        const ref = 'refs/heads/' + branch;
        let tip = repository.refs.get(ref);
        if (!tip && branch !== repository.defaultBranch) {
          const baseTip = repository.refs.get('refs/heads/' + repository.defaultBranch);
          if (baseTip) {
            repository.refs.set(ref, baseTip);
            tip = baseTip;
          }
        }
        const flat = tip ? state.flattenTree(tip) : new Map();
        const existing = flat.get(path2);
        const sha = asString(b.sha);
        if (existing && !sha) return errorResponse(409, 'sha is required to update a file');
        if (existing && sha && sha !== existing.oid) return errorResponse(409, 'sha does not match');
        const bytes = Buffer.from(contentB64, 'base64');
        const blobOid = state.storeObject('blob', bytes);
        const commitOid = state.commitFileChange(repository, branch, path2, blobOid, message);
        return jsonResponse(existing ? 200 : 201, {
          content: {
            name: path2.split('/').pop(),
            path: path2,
            sha: blobOid,
            size: bytes.length,
            encoding: 'base64',
            content: contentB64,
            type: 'file',
            url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + path2,
            html_url: 'https://github.com/' + owner + '/' + name + '/blob/' + branch + '/' + path2,
            git_url: '/api/v3/repos/' + owner + '/' + name + '/git/blobs/' + blobOid,
            download_url: 'https://raw.githubusercontent.com/' + owner + '/' + name + '/' + branch + '/' + path2,
          },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'GET') {
        const refQ = context.query.ref;
        const branch = refQ || repository.defaultBranch;
        const tip = repository.refs.get('refs/heads/' + branch);
        if (!tip) return errorResponse(404, 'Not Found');
        const flat = state.flattenTree(tip);
        if (path2 === '') {
          const entries: Record<string, unknown>[] = [];
          const seen = new Map<string, { type: string; oid: string; size: number }>();
          for (const [p, e] of flat) {
            const first = p.split('/')[0];
            if (seen.has(first)) continue;
            if (p.includes('/')) {
              const treeOid = subtreeOid(state, tip, first);
              seen.set(first, { type: 'dir', oid: treeOid ?? '', size: 0 });
            } else {
              seen.set(first, { type: 'file', oid: e.oid, size: state.fetchObject(e.oid)?.data.length ?? 0 });
            }
          }
          for (const [nm, v] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            entries.push({ type: v.type, name: nm, path: nm, sha: v.oid, size: v.type === 'file' ? v.size : undefined, url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + nm });
          }
          return jsonResponse(200, entries);
        }
        const file = flat.get(path2);
        if (file) {
          const obj = state.fetchObject(file.oid);
          const bytes = obj ? obj.data : Buffer.alloc(0);
          return jsonResponse(200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path2.split('/').pop(),
            path: path2,
            content: bytes.toString('base64'),
            sha: file.oid,
            url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + path2,
            html_url: 'https://github.com/' + owner + '/' + name + '/blob/' + branch + '/' + path2,
            git_url: '/api/v3/repos/' + owner + '/' + name + '/git/blobs/' + file.oid,
            download_url: 'https://raw.githubusercontent.com/' + owner + '/' + name + '/' + branch + '/' + path2,
          });
        }
        const treeOid = subtreeOid(state, tip, path2);
        if (treeOid) {
          const entries: Record<string, unknown>[] = [];
          for (const e of state.readTree(treeOid)) {
            const childPath = path2 + '/' + e.name;
            const isDir = e.mode === '40000';
            entries.push({
              type: isDir ? 'dir' : 'file',
              name: e.name,
              path: childPath,
              sha: e.oid,
              size: isDir ? undefined : state.fetchObject(e.oid)?.data.length ?? 0,
              url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + childPath,
            });
          }
          entries.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
          return jsonResponse(200, entries);
        }
        return errorResponse(404, 'Not Found');
      }
      if (method === 'DELETE') {
        const b = requestBody(context);
        const tip = repository.refs.get('refs/heads/' + repository.defaultBranch);
        if (!tip) return errorResponse(404, 'Not Found');
        const flat = state.flattenTree(tip);
        const existing = flat.get(path2);
        if (!existing) return errorResponse(404, 'Not Found');
        const sha = asString(b.sha);
        if (sha && sha !== existing.oid) return errorResponse(409, 'sha does not match');
        const commitOid = state.commitFileChange(repository, repository.defaultBranch, path2, null, asString(b.message) || 'Delete ' + path2);
        return jsonResponse(200, { content: null, commit: { sha: commitOid } });
      }
      return errorResponse(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const b = requestBody(context);
        const lname = asString(b.name);
        if (!lname) return errorResponse(422, 'name is required');
        const existing = repository.labels.get(lname);
        if (existing) return jsonResponse(201, renderLabel(repository, existing));
        repository.labelSeq += 1;
        const label: RepoLabel = { id: repository.labelSeq, name: lname, color: asString(b.color) || '000000' };
        repository.labels.set(lname, label);
        return jsonResponse(201, renderLabel(repository, label));
      }
      if (rest.length === 1 && method === 'GET') {
        return jsonResponse(200, [...repository.labels.values()].map((l) => renderLabel(repository, l)));
      }
      return errorResponse(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        const b = requestBody(context);
        const title = asString(b.title);
        if (!title) return errorResponse(422, 'title is required');
        const labelNames: string[] = Array.isArray(b.labels) ? (b.labels as unknown[]).map((x) => String(x)) : [];
        for (const ln of labelNames) {
          if (!repository.labels.has(ln)) return errorResponse(422, 'Label does not exist: ' + ln);
        }
        const issueRec = state.addIssue(repository, title, asString(b.body), labelNames);
        return { status: 201, body: state.issueBody(repository, issueRec), type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 1 && method === 'GET') {
        const stateFilter = context.query.state || 'open';
        const sort = context.query.sort || 'created';
        const direction = context.query.direction || 'desc';
        const perPage = pageNumber(context.query.per_page, 30);
        const page = pageNumber(context.query.page, 1);
        let list = repository.issueList.filter((i) => stateFilter === 'all' || i.state === stateFilter);
        list = [...list].sort((a, b) => {
          const d = direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq;
          return sort === 'created' ? d : d;
        });
        const start = (page - 1) * perPage;
        const slice = list.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < list.length) {
          headers.Link = '<' + pageUrl(context, '/api/v3/repos/' + owner + '/' + name + '/issues', page + 1, perPage) + '>; rel="next"';
        }
        return jsonResponse(
          200,
          slice.map((i) => JSON.parse(state.issueBody(repository, i).toString('utf8'))),
          headers,
        );
      }
      if (rest.length === 2 && method === 'GET') {
        const n = parseInt(rest[1], 10);
        const issueRec = repository.issueByNumber.get(n);
        if (!issueRec) return errorResponse(404, 'Not Found');
        return { status: 200, body: state.issueBody(repository, issueRec), type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 2 && method === 'PATCH') {
        const n = parseInt(rest[1], 10);
        const issueRec = repository.issueByNumber.get(n);
        if (!issueRec) return errorResponse(404, 'Not Found');
        const b = requestBody(context);
        if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issueRec.state = b.state;
        if (typeof b.title === 'string') issueRec.title = b.title;
        if (typeof b.body === 'string') issueRec.body = b.body;
        issueRec.updatedAt = isoTimestamp(state.now());
        issueRec.jsonBytes = null;
        issueRec.readyResponse = null;
        return { status: 200, body: state.issueBody(repository, issueRec), type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const n = parseInt(rest[1], 10);
        const issueRec = repository.issueByNumber.get(n);
        if (!issueRec) return errorResponse(404, 'Not Found');
        if (method === 'GET') {
          return jsonResponse(200, issueRec.comments.map((c) => renderComment(state, repository, c)));
        }
        if (method === 'POST') {
          const b = requestBody(context);
          const bodyText = asString(b.body);
          if (!bodyText) return errorResponse(422, 'body is required');
          state.commentIdSeq += 1;
          const seq = state.now();
          const comment: IssueComment = {
            id: state.commentIdSeq,
            body: bodyText,
            gqlId: encodeBase64Url('C:' + repository.name + ':' + issueRec.number + ':' + state.commentIdSeq),
            createdSeq: seq,
            createdAt: isoTimestamp(seq),
          };
          issueRec.comments.push(comment);
          issueRec.jsonBytes = null;
          issueRec.readyResponse = null;
          return jsonResponse(201, renderComment(state, repository, comment));
        }
      }
      return errorResponse(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        const b = requestBody(context);
        const title = asString(b.title);
        const head = asString(b.head);
        const base = asString(b.base);
        if (!title || !head || !base) return errorResponse(422, 'title, head and base are required');
        const headSha = repository.refs.get('refs/heads/' + head);
        const baseSha = repository.refs.get('refs/heads/' + base);
        if (!headSha || !baseSha) return errorResponse(422, 'head or base branch not found');
        const existing = repository.pullList.find((p) => p.head === head && p.state === 'open');
        if (existing) return jsonResponse(201, pullRequestJson(state, repository, existing));
        const pullRec = state.addPullRequest(repository, title, asString(b.body), head, base, headSha, baseSha);
        return jsonResponse(201, pullRequestJson(state, repository, pullRec));
      }
      if (rest.length === 1 && method === 'GET') {
        const stateFilter = context.query.state || 'open';
        const list = repository.pullList.filter((p) => stateFilter === 'all' || p.state === stateFilter);
        return jsonResponse(200, list.map((p) => pullRequestJson(state, repository, p)));
      }
      if (rest.length === 2 && method === 'GET') {
        const n = parseInt(rest[1], 10);
        const pullRec = repository.pullByNumber.get(n);
        if (!pullRec) return errorResponse(404, 'Not Found');
        return jsonResponse(200, pullRequestJson(state, repository, pullRec));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const n = parseInt(rest[1], 10);
        const pullRec = repository.pullByNumber.get(n);
        if (!pullRec) return errorResponse(404, 'Not Found');
        const baseFlat = state.flattenTree(pullRec.baseSha);
        const headFlat = state.flattenTree(pullRec.headSha);
        const files: Record<string, unknown>[] = [];
        const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
        for (const p of [...paths].sort()) {
          const be = baseFlat.get(p);
          const he = headFlat.get(p);
          if (be && !he) {
            files.push({ filename: p, status: 'removed', additions: 0, deletions: 1, changes: 1 });
          } else if (!be && he) {
            const text = state.fetchObject(he.oid)?.data.toString('utf8') ?? '';
            const lines = text === '' ? 0 : text.split('\n').length;
            files.push({ filename: p, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
          } else if (be && he && be.oid !== he.oid) {
            const a = state.fetchObject(be.oid)?.data.toString('utf8') ?? '';
            const c = state.fetchObject(he.oid)?.data.toString('utf8') ?? '';
            const d = countLineDiff(a, c);
            const additions = Math.max(1, d.additions);
            const deletions = d.deletions;
            files.push({ filename: p, status: 'modified', additions, deletions, changes: additions + deletions });
          }
        }
        return jsonResponse(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const n = parseInt(rest[1], 10);
        const pullRec = repository.pullByNumber.get(n);
        if (!pullRec) return errorResponse(404, 'Not Found');
        const r = squashMergePull(state, repository, pullRec);
        if (!r.ok) return errorResponse(r.status, r.message);
        return jsonResponse(200, {
          merged: true,
          sha: r.sha,
          message: r.message,
        });
      }
      return errorResponse(404, 'Not Found');
    }

    return errorResponse(404, 'Not Found');
  }

  return errorResponse(404, 'Not Found');
}
