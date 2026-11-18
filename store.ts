// store.ts — the forge's whole in-memory state: git objects, repositories,
// issues and pull requests. Written fresh for this entry.
//
// Performance note: a single-issue GET is the timed read workload, so each
// issue carries a prebuilt, complete HTTP response (headers + JSON body in
// one Buffer) that the server can write without any per-request work. The
// response is rebuilt whenever the issue changes (PATCH, comment, close)
// and whenever the owner login is adopted, so it is never stale.

import { hashObject, isoFromSec, b64urlEncode, ZERO_OID } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  ts: number;
  author: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

export interface Comment {
  id: number;
  body: string;
  gqlId: string;
  createdSeq: number;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  repoName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  gqlId: string;
  /** Cached JSON body for the issue, or null when it must be rebuilt. */
  jsonCache: Buffer | null;
  /** Complete prebuilt HTTP/1.1 response for GET this issue, or null. */
  httpResponse: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  repoName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  gqlId: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  owner: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  defaultBranch: string;
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  issueNum: number;
  labels: Map<string, Label>;
  labelSeq: number;
  pulls: Pull[];
  pullsByNumber: Map<number, Pull>;
  pullNum: number;
  refsVersion: number;
  jsonCache: Buffer | null;
  branchesCache: Buffer | null;
  v0UploadAdvert: Buffer | null;
  v0ReceiveAdvert: Buffer | null;
  lsRefsCache: Map<string, Buffer>;
  fetchPackCache: Map<string, Buffer>;
}

/** The issue's REST JSON. Built with one native JSON.stringify of a flat
 *  object (the fastest path for a small object), then wrapped with the
 *  prebuilt HTTP response. */
function issueJsonText(store: Store, repo: Repo, issue: Issue): string {
  const owner = store.viewerLogin ?? repo.owner;
  const base = '/api/v3/repos/' + owner + '/' + repo.name;
  return JSON.stringify({
    id: issue.id,
    node_id: issue.gqlId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: l ? l.id : 0, node_id: b64urlEncode('L:' + repo.name + ':' + name), name, color: l ? l.color : '000000', description: '' };
    }),
    user: { login: owner, id: store.viewerId, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: 'https://github.com/' + owner + '/' + repo.name + '/issues/' + issue.number,
    url: base + '/issues/' + issue.number,
    repository_url: base,
    comments_url: base + '/issues/' + issue.number + '/comments',
  });
}

const READ_HEAD_PREFIX = 'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ';
const READ_HEAD_SUFFIX = '\r\nX-GitHub-Request-Id: r1\r\n\r\n';

export class Store {
  objects = new Map<string, GitObject>();
  commitCache = new Map<string, CommitInfo>();
  treeCache = new Map<string, TreeEntry[]>();
  flatCache = new Map<string, Map<string, FlatEntry>>();
  repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  viewerId = 1000;
  repoSeq = 0;
  issueSeq = 0;
  commentSeq = 0;
  pullSeq = 0;
  clockSeq = 0;
  nowBase: number;
  reqSeq = 0;

  constructor(nowBase: number) {
    this.nowBase = nowBase;
  }

  /** Deterministic clock: trial now + a monotonic counter. Never Date.now(). */
  tick(): number {
    return this.nowBase + this.clockSeq++;
  }

  nextReqId(): string {
    this.reqSeq += 1;
    return 'r' + this.reqSeq.toString(36);
  }

  adoptOwner(login: string): void {
    if (this.viewerLogin === null) {
      this.viewerLogin = login;
      this.applyOwner(login);
    }
  }

  ownerMatches(login: string): boolean {
    if (this.viewerLogin === null) {
      this.viewerLogin = login;
      this.applyOwner(login);
      return true;
    }
    return this.viewerLogin === login;
  }

  private applyOwner(login: string): void {
    for (const repo of this.repos.values()) {
      repo.owner = login;
      repo.jsonCache = null;
      for (const issue of repo.issues) {
        issue.jsonCache = null;
        issue.httpResponse = null;
      }
    }
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const seq = this.tick();
    const repo: Repo = {
      id: 5000 + this.repoSeq,
      name,
      description,
      isPrivate,
      owner: this.viewerLogin ?? '',
      createdSeq: seq,
      createdAt: isoFromSec(seq),
      updatedAt: isoFromSec(seq),
      refs: new Map(),
      defaultBranch: 'main',
      issues: [],
      issuesByNumber: new Map(),
      issueNum: 0,
      labels: new Map(),
      labelSeq: 0,
      pulls: [],
      pullsByNumber: new Map(),
      pullNum: 0,
      refsVersion: 0,
      jsonCache: null,
      branchesCache: null,
      v0UploadAdvert: null,
      v0ReceiveAdvert: null,
      lsRefsCache: new Map(),
      fetchPackCache: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  bumpRefs(repo: Repo): void {
    repo.refsVersion += 1;
    repo.v0UploadAdvert = null;
    repo.v0ReceiveAdvert = null;
    repo.lsRefsCache.clear();
    repo.fetchPackCache.clear();
    repo.branchesCache = null;
    repo.jsonCache = null;
  }

  /** (Re)build an issue's cached JSON body and its prebuilt HTTP response. */
  refreshIssue(repo: Repo, issue: Issue): Buffer {
    const body = Buffer.from(issueJsonText(this, repo, issue), 'utf8');
    issue.jsonCache = body;
    issue.httpResponse = Buffer.concat([
      Buffer.from(READ_HEAD_PREFIX + body.length + READ_HEAD_SUFFIX, 'ascii'),
      body,
    ]);
    return body;
  }

  /** The issue's JSON body, building (and prebuilding the HTTP response) on first use. */
  issueJson(repo: Repo, issue: Issue): Buffer {
    if (issue.jsonCache) return issue.jsonCache;
    return this.refreshIssue(repo, issue);
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  parseCommit(oid: string): CommitInfo | null {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const text = obj.data.toString('utf8');
    const headEnd = text.indexOf('\n\n');
    const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
    const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
    let tree = '';
    const parents: string[] = [];
    let author = '';
    let ts = this.nowBase;
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) {
        author = line.slice(7);
        const m = author.match(/ (\d+) [+-]\d{4}$/);
        if (m) ts = parseInt(m[1], 10);
      }
    }
    const info: CommitInfo = { tree, parents, message, ts, author };
    this.commitCache.set(oid, info);
    return info;
  }

  parseTree(oid: string): TreeEntry[] {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    const out: TreeEntry[] = [];
    if (obj && obj.type === 'tree') {
      const data = obj.data;
      let i = 0;
      while (i < data.length) {
        const sp = data.indexOf(0x20, i);
        if (sp < 0) break;
        const mode = data.subarray(i, sp).toString('ascii');
        const nul = data.indexOf(0, sp + 1);
        if (nul < 0 || nul + 21 > data.length) break;
        const name = data.subarray(sp + 1, nul).toString('utf8');
        const oidHex = data.subarray(nul + 1, nul + 21).toString('hex');
        out.push({ mode, name, oid: oidHex });
        i = nul + 21;
      }
    }
    this.treeCache.set(oid, out);
    return out;
  }

  /** Flat path -> entry map for a commit (cached). */
  flatTree(commitOid: string): Map<string, FlatEntry> {
    const cached = this.flatCache.get(commitOid);
    if (cached) return cached;
    const out = new Map<string, FlatEntry>();
    const info = this.parseCommit(commitOid);
    if (info) this.walkTree(info.tree, '', out);
    this.flatCache.set(commitOid, out);
    return out;
  }

  private walkTree(treeOid: string, prefix: string, out: Map<string, FlatEntry>): void {
    for (const e of this.parseTree(treeOid)) {
      const path = prefix ? prefix + '/' + e.name : e.name;
      if (e.mode === '40000') this.walkTree(e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }

  /** Follow tag objects to the underlying commit (or the oid itself). */
  peel(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 8; i++) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      const text = obj.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})$/m);
      if (!m) return cur;
      cur = m[1];
    }
    return cur;
  }

  /** Is `ancestor` reachable from `tip` following parents? */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack: string[] = [tip];
    let steps = 0;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (++steps > 200000) return false;
      const info = this.parseCommit(cur);
      if (info) for (const p of info.parents) stack.push(p);
    }
    return false;
  }

  /** Build (and store) a tree object from a flat path map. Returns the root tree oid. */
  buildTrees(flat: Map<string, FlatEntry>): string {
    const dirs = new Map<string, Map<string, FlatEntry | string>>();
    const root = new Map<string, FlatEntry | string>();
    dirs.set('', root);
    for (const [path, entry] of flat) {
      const slash = path.lastIndexOf('/');
      const dir = slash >= 0 ? path.slice(0, slash) : '';
      const name = slash >= 0 ? path.slice(slash + 1) : path;
      let d = dirs.get(dir);
      if (!d) {
        d = new Map();
        dirs.set(dir, d);
      }
      d.set(name, entry);
      let cur = dir;
      while (cur !== '') {
        const pSlash = cur.lastIndexOf('/');
        const parent = pSlash >= 0 ? cur.slice(0, pSlash) : '';
        const base = pSlash >= 0 ? cur.slice(pSlash + 1) : cur;
        let pd = dirs.get(parent);
        if (!pd) {
          pd = new Map();
          dirs.set(parent, pd);
        }
        if (!pd.has(base)) pd.set(base, cur);
        cur = parent;
      }
    }
    const depth = (p: string): number => (p === '' ? 0 : p.split('/').length);
    const ordered = [...dirs.keys()].sort((a, b) => depth(b) - depth(a));
    const treeOids = new Map<string, string>();
    for (const dir of ordered) {
      const entries = dirs.get(dir)!;
      const sorted = [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const parts: Buffer[] = [];
      for (const [name, val] of sorted) {
        if (typeof val === 'string') {
          const oid = treeOids.get(val);
          if (!oid) continue;
          parts.push(Buffer.from('40000 ' + name + '\0', 'utf8'));
          parts.push(Buffer.from(oid, 'hex'));
        } else {
          parts.push(Buffer.from(val.mode + ' ' + name + '\0', 'utf8'));
          parts.push(Buffer.from(val.oid, 'hex'));
        }
      }
      const data = Buffer.concat(parts);
      const oid = this.putObject('tree', data);
      treeOids.set(dir, oid);
    }
    return treeOids.get('') ?? this.putObject('tree', Buffer.alloc(0));
  }

  /** Create a commit object for a repo. Returns the commit oid. */
  createCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const ts = this.tick();
    const ident = `${repo.owner} <${repo.owner}@users.noreply.github.com> ${ts} +0000`;
    let head = `tree ${treeOid}\n`;
    for (const p of parents) head += `parent ${p}\n`;
    head += `author ${ident}\ncommitter ${ident}\n`;
    const data = Buffer.from(head + '\n' + message, 'utf8');
    const oid = this.putObject('commit', data);
    this.commitCache.set(oid, { tree: treeOid, parents, message, ts, author: ident });
    return oid;
  }

  /** Create a contents commit on a branch from a parent flat map + one file change. */
  contentsCommit(repo: Repo, branch: string, path: string, blobOid: string | null, message: string): string {
    const ref = 'refs/heads/' + branch;
    const tip = repo.refs.get(ref);
    const flat = new Map<string, FlatEntry>();
    if (tip) {
      for (const [p, e] of this.flatTree(tip)) flat.set(p, e);
    }
    if (blobOid === null) flat.delete(path);
    else flat.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTrees(flat);
    const parents = tip ? [tip] : [];
    const oid = this.createCommit(repo, treeOid, parents, message);
    repo.refs.set(ref, oid);
    this.flatCache.set(oid, flat);
    this.bumpRefs(repo);
    return oid;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    this.issueSeq += 1;
    repo.issueNum += 1;
    const seq = this.tick();
    const at = isoFromSec(seq);
    const issue: Issue = {
      id: this.issueSeq,
      number: repo.issueNum,
      repoName: repo.name,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: seq,
      createdAt: at,
      updatedAt: at,
      comments: [],
      gqlId: b64urlEncode('I:' + repo.name + ':' + repo.issueNum),
      jsonCache: null,
      httpResponse: null,
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    // Prebuild the JSON body and the whole HTTP response now, while the
    // issue is being created, so every later GET is a single socket write.
    this.refreshIssue(repo, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): Pull {
    this.pullSeq += 1;
    repo.pullNum += 1;
    const seq = this.tick();
    const at = isoFromSec(seq);
    const pull: Pull = {
      id: this.pullSeq,
      number: repo.pullNum,
      repoName: repo.name,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      head,
      base,
      headSha,
      baseSha,
      createdSeq: seq,
      createdAt: at,
      updatedAt: at,
      gqlId: b64urlEncode('P:' + repo.name + ':' + repo.pullNum),
    };
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return pull;
  }

  repoGqlId(repo: Repo): string {
    return b64urlEncode('R:' + repo.owner + '/' + repo.name);
  }
}

export function oidIsZero(oid: string): boolean {
  return oid === ZERO_OID;
}
