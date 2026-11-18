// rest.ts — the REST v3 API under /api/v3. Written fresh for this entry.
// Route shapes and response fields follow the suite's contract (see the
// kit's RULES.txt); the issue serializers live in store.ts so the read
// fast path can reuse the same prebuilt bytes.

import { Store, type Repo, type Issue, type Pull, type Comment, type Label } from './store.ts';
import { isoFromSec, b64urlEncode } from './util.ts';

export interface Ctx {
  store: Store;
  method: string;
  segments: string[];
  query: Record<string, string>;
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  host: string;
  authed: boolean;
}

export interface RestResult {
  status: number;
  body: Buffer;
  type?: string;
  headers?: Record<string, string>;
}

export function jsonResult(status: number, obj: unknown, headers?: Record<string, string>): RestResult {
  return { status, body: Buffer.from(JSON.stringify(obj), 'utf8'), type: 'application/json; charset=utf-8', headers };
}

export function errResult(status: number, message: string): RestResult {
  return jsonResult(status, { message });
}

function bodyObj(ctx: Ctx): Record<string, unknown> {
  if (ctx.json && typeof ctx.json === 'object' && !Array.isArray(ctx.json)) return ctx.json as Record<string, unknown>;
  return {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

function intParam(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function pageLink(ctx: Ctx, base: string, page: number, perPage: number): string {
  return `http://${ctx.host}${base}?per_page=${perPage}&page=${page}`;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = line.match(/^(.*?) <(.*?)> (\d+) [+-]\d{4}$/);
  if (!m) return { name: line, email: '', date: '' };
  return { name: m[1], email: m[2], date: isoFromSec(parseInt(m[3], 10)) };
}

// ---- serializers ----

export function repoJson(store: Store, repo: Repo): Buffer {
  if (repo.jsonCache) return repo.jsonCache;
  const owner = store.viewerLogin ?? repo.owner;
  const obj = {
    id: repo.id,
    node_id: store.repoGqlId(repo),
    name: repo.name,
    full_name: owner + '/' + repo.name,
    owner: { login: owner, id: store.viewerId, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: 'https://github.com/' + owner + '/' + repo.name,
    url: '/api/v3/repos/' + owner + '/' + repo.name,
    clone_url: 'https://github.com/' + owner + '/' + repo.name + '.git',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  repo.jsonCache = buf;
  return buf;
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Buffer {
  return store.issueJson(repo, issue);
}

function commentJson(store: Store, repo: Repo, comment: Comment): Record<string, unknown> {
  const owner = store.viewerLogin ?? repo.owner;
  return {
    id: comment.id,
    node_id: comment.gqlId,
    body: comment.body,
    user: { login: owner, id: store.viewerId, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: 'https://github.com/' + owner + '/' + repo.name + '/issues/comments/' + comment.id,
    url: '/api/v3/repos/' + owner + '/' + repo.name + '/issues/comments/' + comment.id,
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: b64urlEncode('L:' + repo.name + ':' + label.name),
    name: label.name,
    color: label.color,
    description: '',
    default: false,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/labels/' + encodeURIComponent(label.name),
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = store.viewerLogin ?? repo.owner;
  return {
    id: pull.id,
    node_id: pull.gqlId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: !pull.merged && pull.state === 'open',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.head, sha: pull.headSha, label: owner + ':' + pull.head, repo: { name: repo.name, full_name: owner + '/' + repo.name } },
    base: { ref: pull.base, sha: pull.baseSha, label: owner + ':' + pull.base, repo: { name: repo.name, full_name: owner + '/' + repo.name } },
    user: { login: owner, id: store.viewerId, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: 'https://github.com/' + owner + '/' + repo.name + '/pull/' + pull.number,
    url: '/api/v3/repos/' + owner + '/' + repo.name + '/pulls/' + pull.number,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: '/api/v3/repos/' + repo.owner + '/' + repo.name + '/commits/' + sha },
    protected: false,
  };
}

function commitJson(store: Store, oid: string): Record<string, unknown> | null {
  const info = store.parseCommit(oid);
  if (!info) return null;
  const author = parseIdent(info.author);
  const owner = store.viewerLogin ?? '';
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
function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  if (al.length > 2000 || bl.length > 2000) return { additions: 1, deletions: 1 };
  const n = al.length;
  const m = bl.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
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
export function mergePull(store: Store, repo: Repo, pull: Pull): { ok: boolean; status: number; message: string; sha?: string } {
  const baseTip = repo.refs.get('refs/heads/' + pull.base);
  if (!baseTip) return { ok: false, status: 404, message: 'Not Found' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is not open' };
  const prBaseFlat = store.flatTree(pull.baseSha);
  const headFlat = store.flatTree(pull.headSha);
  const curBaseFlat = store.flatTree(baseTip);
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
  const headInfo = store.parseCommit(pull.headSha);
  if (!headInfo) return { ok: false, status: 422, message: 'Unknown head commit' };
  const mergeOid = store.createCommit(
    repo,
    headInfo.tree,
    [baseTip],
    'Merge pull request #' + pull.number + ' from ' + repo.owner + '/' + pull.head,
  );
  store.flatCache.set(mergeOid, new Map(headFlat));
  repo.refs.set('refs/heads/' + pull.base, mergeOid);
  store.bumpRefs(repo);
  const seq = store.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoFromSec(seq);
  pull.mergeSha = mergeOid;
  pull.updatedAt = isoFromSec(seq);
  return { ok: true, status: 200, message: 'Pull request successfully merged', sha: mergeOid };
}

function dirTreeOid(store: Store, commitOid: string, dirPath: string): string | null {
  const info = store.parseCommit(commitOid);
  if (!info) return null;
  if (dirPath === '') return info.tree;
  let cur = info.tree;
  for (const seg of dirPath.split('/')) {
    let found: string | null = null;
    for (const e of store.parseTree(cur)) {
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

function needRepo(ctx: Ctx, owner: string, name: string): Repo | RestResult {
  const store = ctx.store;
  if (!store.ownerMatches(owner)) return errResult(404, 'Not Found');
  const repo = store.getRepo(name);
  if (!repo) return errResult(404, 'Not Found');
  return repo;
}

function isRestResult(v: Repo | RestResult): v is RestResult {
  return (v as RestResult).status !== undefined;
}

// ---- main handler ----

export function handleRest(ctx: Ctx): RestResult | null {
  const { store, method, segments: s } = ctx;
  if (s.length === 0) {
    if (method !== 'GET') return errResult(404, 'Not Found');
    return jsonResult(
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }
  if (s.length === 1 && s[0] === 'meta') {
    if (method !== 'GET') return errResult(404, 'Not Found');
    return jsonResult(200, { installed_version: '1.0.0' });
  }
  if (!ctx.authed) return errResult(401, 'Requires authentication');
  if (ctx.jsonError) return errResult(400, 'Problems parsing JSON');

  if (s[0] === 'user') {
    if (s.length === 1) {
      if (method !== 'GET') return errResult(404, 'Not Found');
      if (!store.viewerLogin) return errResult(404, 'Not Found');
      return jsonResult(200, {
        login: store.viewerLogin,
        id: store.viewerId,
        node_id: b64urlEncode('U:' + store.viewerLogin),
        type: 'User',
        html_url: 'https://github.com/' + store.viewerLogin,
        url: '/api/v3/user',
      });
    }
    if (s.length === 2 && s[1] === 'repos') {
      if (method === 'POST') {
        const b = bodyObj(ctx);
        const name = str(b.name);
        if (!name || name.includes('/')) return errResult(422, 'Invalid repository name');
        if (store.getRepo(name)) return errResult(422, 'Repository already exists');
        const repo = store.createRepo(name, str(b.description), bool(b.private, false));
        return { status: 201, body: repoJson(store, repo), type: 'application/json; charset=utf-8' };
      }
      if (method === 'GET') {
        const perPage = intParam(ctx.query.per_page, 30);
        const page = intParam(ctx.query.page, 1);
        const all = [...store.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
        const start = (page - 1) * perPage;
        const slice = all.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < all.length) {
          headers.Link = '<' + pageLink(ctx, '/api/v3/user/repos', page + 1, perPage) + '>; rel="next"';
        }
        return jsonResult(
          200,
          slice.map((r) => JSON.parse(repoJson(store, r).toString('utf8'))),
          headers,
        );
      }
      return errResult(404, 'Not Found');
    }
    return errResult(404, 'Not Found');
  }

  if (s[0] === 'repos' && s.length >= 3) {
    const owner = s[1];
    const name = s[2];
    const rest = s.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') {
        const r = needRepo(ctx, owner, name);
        if (isRestResult(r)) return r;
        return { status: 200, body: repoJson(store, r), type: 'application/json; charset=utf-8' };
      }
      if (method === 'PATCH') {
        const r = needRepo(ctx, owner, name);
        if (isRestResult(r)) return r;
        const b = bodyObj(ctx);
        if (typeof b.description === 'string') r.description = b.description;
        r.updatedAt = isoFromSec(store.tick());
        r.jsonCache = null;
        return { status: 200, body: repoJson(store, r), type: 'application/json; charset=utf-8' };
      }
      if (method === 'DELETE') {
        const r = needRepo(ctx, owner, name);
        if (isRestResult(r)) return r;
        store.repos.delete(name);
        return { status: 204, body: Buffer.alloc(0) };
      }
      return errResult(404, 'Not Found');
    }

    const r0 = needRepo(ctx, owner, name);
    if (isRestResult(r0)) return r0;
    const repo = r0;

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        if (repo.branchesCache) return { status: 200, body: repo.branchesCache, type: 'application/json; charset=utf-8' };
        const list = [...repo.refs.entries()]
          .filter(([n]) => n.startsWith('refs/heads/'))
          .map(([n, oid]) => branchJson(repo, n.slice(11), oid))
          .sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
        const buf = Buffer.from(JSON.stringify(list), 'utf8');
        repo.branchesCache = buf;
        return { status: 200, body: buf, type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = repo.refs.get('refs/heads/' + rest[1]);
        if (!oid) return errResult(404, 'Not Found');
        return jsonResult(200, branchJson(repo, rest[1], oid));
      }
      return errResult(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const oid = repo.refs.get('refs/heads/' + rest[3]);
        if (!oid) return errResult(404, 'Not Found');
        return jsonResult(200, {
          ref: 'refs/heads/' + rest[3],
          node_id: b64urlEncode('REF:refs/heads/' + rest[3]),
          object: { sha: oid, type: 'commit', url: '/api/v3/repos/' + owner + '/' + name + '/git/commits/' + oid },
          url: '/api/v3/repos/' + owner + '/' + name + '/git/refs/heads/' + rest[3],
        });
      }
      if (rest.length === 2 && method === 'POST') {
        const b = bodyObj(ctx);
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return errResult(422, 'Invalid ref');
        if (!store.parseCommit(sha) && store.getObject(sha)?.type !== 'tag') return errResult(422, 'Unknown object');
        if (repo.refs.has(ref)) return errResult(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        store.bumpRefs(repo);
        return jsonResult(201, {
          ref,
          node_id: b64urlEncode('REF:' + ref),
          object: { sha, type: 'commit', url: '/api/v3/repos/' + owner + '/' + name + '/git/commits/' + sha },
          url: '/api/v3/repos/' + owner + '/' + name + '/git/refs/' + ref,
        });
      }
      return errResult(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const shaQ = ctx.query.sha;
        let tip: string | undefined;
        if (shaQ) {
          if (repo.refs.has('refs/heads/' + shaQ)) tip = repo.refs.get('refs/heads/' + shaQ);
          else if (store.getObject(shaQ)?.type === 'commit') tip = shaQ;
          else return errResult(404, 'Not Found');
        } else {
          tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
        }
        if (!tip) return jsonResult(200, []);
        const seen = new Set<string>();
        const stack = [tip];
        const found: string[] = [];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const info = store.parseCommit(cur);
          if (!info) continue;
          found.push(cur);
          for (const p of info.parents) stack.push(p);
        }
        found.sort((a, b) => {
          const ia = store.parseCommit(a)!;
          const ib = store.parseCommit(b)!;
          return ib.ts - ia.ts;
        });
        const list = found.map((oid) => commitJson(store, oid)).filter((x) => x !== null);
        return jsonResult(200, list);
      }
      return errResult(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'PUT') {
        const b = bodyObj(ctx);
        const message = str(b.message) || 'Update ' + path;
        const contentB64 = str(b.content);
        if (!contentB64) return errResult(422, 'content is required');
        const branch = str(b.branch) || repo.defaultBranch;
        const ref = 'refs/heads/' + branch;
        let tip = repo.refs.get(ref);
        if (!tip && branch !== repo.defaultBranch) {
          const baseTip = repo.refs.get('refs/heads/' + repo.defaultBranch);
          if (baseTip) {
            repo.refs.set(ref, baseTip);
            tip = baseTip;
          }
        }
        const flat = tip ? store.flatTree(tip) : new Map();
        const existing = flat.get(path);
        const sha = str(b.sha);
        if (existing && !sha) return errResult(409, 'sha is required to update a file');
        if (existing && sha && sha !== existing.oid) return errResult(409, 'sha does not match');
        const bytes = Buffer.from(contentB64, 'base64');
        const blobOid = store.putObject('blob', bytes);
        const commitOid = store.contentsCommit(repo, branch, path, blobOid, message);
        return jsonResult(existing ? 200 : 201, {
          content: {
            name: path.split('/').pop(),
            path,
            sha: blobOid,
            size: bytes.length,
            encoding: 'base64',
            content: contentB64,
            type: 'file',
            url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + path,
            html_url: 'https://github.com/' + owner + '/' + name + '/blob/' + branch + '/' + path,
            git_url: '/api/v3/repos/' + owner + '/' + name + '/git/blobs/' + blobOid,
            download_url: 'https://raw.githubusercontent.com/' + owner + '/' + name + '/' + branch + '/' + path,
          },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'GET') {
        const refQ = ctx.query.ref;
        const branch = refQ || repo.defaultBranch;
        const tip = repo.refs.get('refs/heads/' + branch);
        if (!tip) return errResult(404, 'Not Found');
        const flat = store.flatTree(tip);
        if (path === '') {
          const entries: Record<string, unknown>[] = [];
          const seen = new Map<string, { type: string; oid: string; size: number }>();
          for (const [p, e] of flat) {
            const first = p.split('/')[0];
            if (seen.has(first)) continue;
            if (p.includes('/')) {
              const treeOid = dirTreeOid(store, tip, first);
              seen.set(first, { type: 'dir', oid: treeOid ?? '', size: 0 });
            } else {
              seen.set(first, { type: 'file', oid: e.oid, size: store.getObject(e.oid)?.data.length ?? 0 });
            }
          }
          for (const [nm, v] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            entries.push({ type: v.type, name: nm, path: nm, sha: v.oid, size: v.type === 'file' ? v.size : undefined, url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + nm });
          }
          return jsonResult(200, entries);
        }
        const file = flat.get(path);
        if (file) {
          const obj = store.getObject(file.oid);
          const bytes = obj ? obj.data : Buffer.alloc(0);
          return jsonResult(200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path.split('/').pop(),
            path,
            content: bytes.toString('base64'),
            sha: file.oid,
            url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + path,
            html_url: 'https://github.com/' + owner + '/' + name + '/blob/' + branch + '/' + path,
            git_url: '/api/v3/repos/' + owner + '/' + name + '/git/blobs/' + file.oid,
            download_url: 'https://raw.githubusercontent.com/' + owner + '/' + name + '/' + branch + '/' + path,
          });
        }
        const treeOid = dirTreeOid(store, tip, path);
        if (treeOid) {
          const entries: Record<string, unknown>[] = [];
          for (const e of store.parseTree(treeOid)) {
            const childPath = path + '/' + e.name;
            const isDir = e.mode === '40000';
            entries.push({
              type: isDir ? 'dir' : 'file',
              name: e.name,
              path: childPath,
              sha: e.oid,
              size: isDir ? undefined : store.getObject(e.oid)?.data.length ?? 0,
              url: '/api/v3/repos/' + owner + '/' + name + '/contents/' + childPath,
            });
          }
          entries.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
          return jsonResult(200, entries);
        }
        return errResult(404, 'Not Found');
      }
      if (method === 'DELETE') {
        const b = bodyObj(ctx);
        const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
        if (!tip) return errResult(404, 'Not Found');
        const flat = store.flatTree(tip);
        const existing = flat.get(path);
        if (!existing) return errResult(404, 'Not Found');
        const sha = str(b.sha);
        if (sha && sha !== existing.oid) return errResult(409, 'sha does not match');
        const commitOid = store.contentsCommit(repo, repo.defaultBranch, path, null, str(b.message) || 'Delete ' + path);
        return jsonResult(200, { content: null, commit: { sha: commitOid } });
      }
      return errResult(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const b = bodyObj(ctx);
        const lname = str(b.name);
        if (!lname) return errResult(422, 'name is required');
        const existing = repo.labels.get(lname);
        if (existing) return jsonResult(201, labelJson(repo, existing));
        repo.labelSeq += 1;
        const label: Label = { id: repo.labelSeq, name: lname, color: str(b.color) || '000000' };
        repo.labels.set(lname, label);
        return jsonResult(201, labelJson(repo, label));
      }
      if (rest.length === 1 && method === 'GET') {
        return jsonResult(200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
      }
      return errResult(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        const b = bodyObj(ctx);
        const title = str(b.title);
        if (!title) return errResult(422, 'title is required');
        const labelNames: string[] = Array.isArray(b.labels) ? (b.labels as unknown[]).map((x) => String(x)) : [];
        for (const ln of labelNames) {
          if (!repo.labels.has(ln)) return errResult(422, 'Label does not exist: ' + ln);
        }
        const issue = store.createIssue(repo, title, str(b.body), labelNames);
        return { status: 201, body: issueJson(store, repo, issue), type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 1 && method === 'GET') {
        const state = ctx.query.state || 'open';
        const sort = ctx.query.sort || 'created';
        const direction = ctx.query.direction || 'desc';
        const perPage = intParam(ctx.query.per_page, 30);
        const page = intParam(ctx.query.page, 1);
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        list = [...list].sort((a, b) => {
          const d = direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq;
          return sort === 'created' ? d : d;
        });
        const start = (page - 1) * perPage;
        const slice = list.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < list.length) {
          headers.Link = '<' + pageLink(ctx, '/api/v3/repos/' + owner + '/' + name + '/issues', page + 1, perPage) + '>; rel="next"';
        }
        return jsonResult(
          200,
          slice.map((i) => JSON.parse(issueJson(store, repo, i).toString('utf8'))),
          headers,
        );
      }
      if (rest.length === 2 && method === 'GET') {
        const n = parseInt(rest[1], 10);
        const issue = repo.issuesByNumber.get(n);
        if (!issue) return errResult(404, 'Not Found');
        return { status: 200, body: issueJson(store, repo, issue), type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 2 && method === 'PATCH') {
        const n = parseInt(rest[1], 10);
        const issue = repo.issuesByNumber.get(n);
        if (!issue) return errResult(404, 'Not Found');
        const b = bodyObj(ctx);
        if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        issue.updatedAt = isoFromSec(store.tick());
        issue.jsonCache = null;
        issue.httpResponse = null;
        return { status: 200, body: issueJson(store, repo, issue), type: 'application/json; charset=utf-8' };
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const n = parseInt(rest[1], 10);
        const issue = repo.issuesByNumber.get(n);
        if (!issue) return errResult(404, 'Not Found');
        if (method === 'GET') {
          return jsonResult(200, issue.comments.map((c) => commentJson(store, repo, c)));
        }
        if (method === 'POST') {
          const b = bodyObj(ctx);
          const bodyText = str(b.body);
          if (!bodyText) return errResult(422, 'body is required');
          store.commentSeq += 1;
          const seq = store.tick();
          const comment: Comment = {
            id: store.commentSeq,
            body: bodyText,
            gqlId: b64urlEncode('C:' + repo.name + ':' + issue.number + ':' + store.commentSeq),
            createdSeq: seq,
            createdAt: isoFromSec(seq),
          };
          issue.comments.push(comment);
          issue.jsonCache = null;
          issue.httpResponse = null;
          return jsonResult(201, commentJson(store, repo, comment));
        }
      }
      return errResult(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        const b = bodyObj(ctx);
        const title = str(b.title);
        const head = str(b.head);
        const base = str(b.base);
        if (!title || !head || !base) return errResult(422, 'title, head and base are required');
        const headSha = repo.refs.get('refs/heads/' + head);
        const baseSha = repo.refs.get('refs/heads/' + base);
        if (!headSha || !baseSha) return errResult(422, 'head or base branch not found');
        const existing = repo.pulls.find((p) => p.head === head && p.state === 'open');
        if (existing) return jsonResult(201, pullJson(store, repo, existing));
        const pull = store.createPull(repo, title, str(b.body), head, base, headSha, baseSha);
        return jsonResult(201, pullJson(store, repo, pull));
      }
      if (rest.length === 1 && method === 'GET') {
        const state = ctx.query.state || 'open';
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        return jsonResult(200, list.map((p) => pullJson(store, repo, p)));
      }
      if (rest.length === 2 && method === 'GET') {
        const n = parseInt(rest[1], 10);
        const pull = repo.pullsByNumber.get(n);
        if (!pull) return errResult(404, 'Not Found');
        return jsonResult(200, pullJson(store, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const n = parseInt(rest[1], 10);
        const pull = repo.pullsByNumber.get(n);
        if (!pull) return errResult(404, 'Not Found');
        const baseFlat = store.flatTree(pull.baseSha);
        const headFlat = store.flatTree(pull.headSha);
        const files: Record<string, unknown>[] = [];
        const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
        for (const p of [...paths].sort()) {
          const be = baseFlat.get(p);
          const he = headFlat.get(p);
          if (be && !he) {
            files.push({ filename: p, status: 'removed', additions: 0, deletions: 1, changes: 1 });
          } else if (!be && he) {
            const text = store.getObject(he.oid)?.data.toString('utf8') ?? '';
            const lines = text === '' ? 0 : text.split('\n').length;
            files.push({ filename: p, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
          } else if (be && he && be.oid !== he.oid) {
            const a = store.getObject(be.oid)?.data.toString('utf8') ?? '';
            const c = store.getObject(he.oid)?.data.toString('utf8') ?? '';
            const d = lineDiff(a, c);
            const additions = Math.max(1, d.additions);
            const deletions = d.deletions;
            files.push({ filename: p, status: 'modified', additions, deletions, changes: additions + deletions });
          }
        }
        return jsonResult(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const n = parseInt(rest[1], 10);
        const pull = repo.pullsByNumber.get(n);
        if (!pull) return errResult(404, 'Not Found');
        const r = mergePull(store, repo, pull);
        if (!r.ok) return errResult(r.status, r.message);
        return jsonResult(200, {
          merged: true,
          sha: r.sha,
          message: r.message,
        });
      }
      return errResult(404, 'Not Found');
    }

    return errResult(404, 'Not Found');
  }

  return errResult(404, 'Not Found');
}
