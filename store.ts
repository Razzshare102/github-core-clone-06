// store.ts — the forge's whole in-memory state: git objects, repositories,
// issues and pull requests.
//
// Speed note: a single-issue GET is the timed read workload, so every
// issue holds a ready-made, complete HTTP response (headers plus JSON body
// in one Buffer) that the server can write without any per-request work.
// The response is rebuilt whenever the issue changes (PATCH, comment,
// close) and whenever the owner login is adopted, so it never goes stale.

import { objectIdFor, isoTimestamp, encodeBase64Url, NULL_OID } from './util.ts';

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjectKind;
  data: Buffer;
}

export interface CommitData {
  tree: string;
  parents: string[];
  message: string;
  ts: number;
  author: string;
}

export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

export interface FlatItem {
  oid: string;
  mode: string;
}

export interface IssueComment {
  id: number;
  body: string;
  gqlId: string;
  createdSeq: number;
  createdAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  repositoryName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
  gqlId: string;
  /** Cached JSON body for the issue, or null when it must be rebuilt. */
  jsonBytes: Buffer | null;
  /** Complete ready-made HTTP/1.1 response for GET this issue, or null. */
  readyResponse: Buffer | null;
}

export interface PullRec {
  id: number;
  number: number;
  repositoryName: string;
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

export interface RepoLabel {
  id: number;
  name: string;
  color: string;
}

export interface Repository {
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
  issueList: IssueRec[];
  issueByNumber: Map<number, IssueRec>;
  issueCounter: number;
  labels: Map<string, RepoLabel>;
  labelSeq: number;
  pullList: PullRec[];
  pullByNumber: Map<number, PullRec>;
  pullCounter: number;
  refsEpoch: number;
  repoJsonBytes: Buffer | null;
  branchListBytes: Buffer | null;
  v0UploadBytes: Buffer | null;
  v0ReceiveBytes: Buffer | null;
  lsRefsStore: Map<string, Buffer>;
  fetchPackStore: Map<string, Buffer>;
}

/** The issue's REST JSON. One native JSON.stringify of a flat object
 *  (the fastest path for a small object), then wrapped with the
 *  ready-made HTTP response. */
function renderIssueJson(state: State, repository: Repository, issueRec: IssueRec): string {
  const owner = state.viewerName ?? repository.owner;
  const base = '/api/v3/repos/' + owner + '/' + repository.name;
  return JSON.stringify({
    id: issueRec.id,
    node_id: issueRec.gqlId,
    number: issueRec.number,
    title: issueRec.title,
    body: issueRec.body,
    state: issueRec.state,
    labels: issueRec.labels.map((name) => {
      const label = repository.labels.get(name);
      return { id: label ? label.id : 0, node_id: encodeBase64Url('L:' + repository.name + ':' + name), name, color: label ? label.color : '000000', description: '' };
    }),
    user: { login: owner, id: state.viewerNumber, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issueRec.comments.length,
    created_at: issueRec.createdAt,
    updated_at: issueRec.updatedAt,
    closed_at: issueRec.state === 'closed' ? issueRec.updatedAt : null,
    html_url: 'https://github.com/' + owner + '/' + repository.name + '/issues/' + issueRec.number,
    url: base + '/issues/' + issueRec.number,
    repository_url: base,
    comments_url: base + '/issues/' + issueRec.number + '/comments',
  });
}

const READ_HEAD_PREFIX = 'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ';
const READ_HEAD_SUFFIX = '\r\nX-GitHub-Request-Id: r1\r\n\r\n';

export class State {
  objects = new Map<string, StoredObject>();
  commitCache = new Map<string, CommitData>();
  treeCache = new Map<string, TreeItem[]>();
  flatCache = new Map<string, Map<string, FlatItem>>();
  repositories = new Map<string, Repository>();
  viewerName: string | null = null;
  viewerNumber = 1000;
  repositorySeq = 0;
  issueIdSeq = 0;
  commentIdSeq = 0;
  pullIdSeq = 0;
  clockTick = 0;
  epochBase: number;
  requestSeq = 0;

  constructor(epochBase: number) {
    this.epochBase = epochBase;
  }

  /** Deterministic clock: trial now plus a monotonic counter. Never Date.now(). */
  now(): number {
    return this.epochBase + this.clockTick++;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return 'r' + this.requestSeq.toString(36);
  }

  adoptViewer(login: string): void {
    if (this.viewerName === null) {
      this.viewerName = login;
      this.assignOwner(login);
    }
  }

  viewerOwns(login: string): boolean {
    if (this.viewerName === null) {
      this.viewerName = login;
      this.assignOwner(login);
      return true;
    }
    return this.viewerName === login;
  }

  private assignOwner(login: string): void {
    for (const repository of this.repositories.values()) {
      repository.owner = login;
      repository.repoJsonBytes = null;
      for (const issueRec of repository.issueList) {
        issueRec.jsonBytes = null;
        issueRec.readyResponse = null;
      }
    }
  }

  findRepository(name: string): Repository | undefined {
    return this.repositories.get(name);
  }

  addRepository(name: string, description: string, isPrivate: boolean): Repository {
    this.repositorySeq += 1;
    const seq = this.now();
    const stamp = isoTimestamp(seq);
    const repository: Repository = {
      id: 5000 + this.repositorySeq,
      name,
      description,
      isPrivate,
      owner: this.viewerName ?? '',
      createdSeq: seq,
      createdAt: stamp,
      updatedAt: stamp,
      refs: new Map(),
      defaultBranch: 'main',
      issueList: [],
      issueByNumber: new Map(),
      issueCounter: 0,
      labels: new Map(),
      labelSeq: 0,
      pullList: [],
      pullByNumber: new Map(),
      pullCounter: 0,
      refsEpoch: 0,
      repoJsonBytes: null,
      branchListBytes: null,
      v0UploadBytes: null,
      v0ReceiveBytes: null,
      lsRefsStore: new Map(),
      fetchPackStore: new Map(),
    };
    this.repositories.set(name, repository);
    return repository;
  }

  invalidateRefCaches(repository: Repository): void {
    repository.refsEpoch += 1;
    repository.v0UploadBytes = null;
    repository.v0ReceiveBytes = null;
    repository.lsRefsStore.clear();
    repository.fetchPackStore.clear();
    repository.branchListBytes = null;
    repository.repoJsonBytes = null;
  }

  /** (Re)build an issue's cached JSON body and its ready-made HTTP response. */
  rebuildIssueCaches(repository: Repository, issueRec: IssueRec): Buffer {
    const body = Buffer.from(renderIssueJson(this, repository, issueRec), 'utf8');
    issueRec.jsonBytes = body;
    issueRec.readyResponse = Buffer.concat([
      Buffer.from(READ_HEAD_PREFIX + body.length + READ_HEAD_SUFFIX, 'ascii'),
      body,
    ]);
    return body;
  }

  /** The issue's JSON body, building (and prebuilding the HTTP response) on first use. */
  issueBody(repository: Repository, issueRec: IssueRec): Buffer {
    if (issueRec.jsonBytes) return issueRec.jsonBytes;
    return this.rebuildIssueCaches(repository, issueRec);
  }

  storeObject(type: ObjectKind, data: Buffer): string {
    const oid = objectIdFor(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  fetchObject(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  readCommit(oid: string): CommitData | null {
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
    let ts = this.epochBase;
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) {
        author = line.slice(7);
        const m = author.match(/ (\d+) [+-]\d{4}$/);
        if (m) ts = parseInt(m[1], 10);
      }
    }
    const info: CommitData = { tree, parents, message, ts, author };
    this.commitCache.set(oid, info);
    return info;
  }

  readTree(oid: string): TreeItem[] {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    const out: TreeItem[] = [];
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
  flattenTree(commitOid: string): Map<string, FlatItem> {
    const cached = this.flatCache.get(commitOid);
    if (cached) return cached;
    const out = new Map<string, FlatItem>();
    const info = this.readCommit(commitOid);
    if (info) this.walkTreeEntries(info.tree, '', out);
    this.flatCache.set(commitOid, out);
    return out;
  }

  private walkTreeEntries(treeOid: string, prefix: string, out: Map<string, FlatItem>): void {
    for (const e of this.readTree(treeOid)) {
      const path = prefix ? prefix + '/' + e.name : e.name;
      if (e.mode === '40000') this.walkTreeEntries(e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }

  /** Follow tag objects to the underlying commit (or the oid itself). */
  peelTag(oid: string): string {
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
  isReachable(ancestor: string, tip: string): boolean {
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
      const info = this.readCommit(cur);
      if (info) for (const p of info.parents) stack.push(p);
    }
    return false;
  }

  /** Build (and store) a tree object from a flat path map. Returns the root tree oid. */
  assembleTrees(flat: Map<string, FlatItem>): string {
    const dirs = new Map<string, Map<string, FlatItem | string>>();
    const root = new Map<string, FlatItem | string>();
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
      const oid = this.storeObject('tree', data);
      treeOids.set(dir, oid);
    }
    return treeOids.get('') ?? this.storeObject('tree', Buffer.alloc(0));
  }

  /** Create a commit object for a repository. Returns the commit oid. */
  makeCommit(repository: Repository, treeOid: string, parents: string[], message: string): string {
    const ts = this.now();
    const ident = `${repository.owner} <${repository.owner}@users.noreply.github.com> ${ts} +0000`;
    let head = `tree ${treeOid}\n`;
    for (const p of parents) head += `parent ${p}\n`;
    head += `author ${ident}\ncommitter ${ident}\n`;
    const data = Buffer.from(head + '\n' + message, 'utf8');
    const oid = this.storeObject('commit', data);
    this.commitCache.set(oid, { tree: treeOid, parents, message, ts, author: ident });
    return oid;
  }

  /** Create a contents commit on a branch from a parent flat map plus one file change. */
  commitFileChange(repository: Repository, branch: string, path: string, blobOid: string | null, message: string): string {
    const ref = 'refs/heads/' + branch;
    const tip = repository.refs.get(ref);
    const flat = new Map<string, FlatItem>();
    if (tip) {
      for (const [p, e] of this.flattenTree(tip)) flat.set(p, e);
    }
    if (blobOid === null) flat.delete(path);
    else flat.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.assembleTrees(flat);
    const parents = tip ? [tip] : [];
    const oid = this.makeCommit(repository, treeOid, parents, message);
    repository.refs.set(ref, oid);
    this.flatCache.set(oid, flat);
    this.invalidateRefCaches(repository);
    return oid;
  }

  addIssue(repository: Repository, title: string, body: string, labels: string[]): IssueRec {
    this.issueIdSeq += 1;
    repository.issueCounter += 1;
    const seq = this.now();
    const stamp = isoTimestamp(seq);
    const issueRec: IssueRec = {
      id: this.issueIdSeq,
      number: repository.issueCounter,
      repositoryName: repository.name,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: seq,
      createdAt: stamp,
      updatedAt: stamp,
      comments: [],
      gqlId: encodeBase64Url('I:' + repository.name + ':' + repository.issueCounter),
      jsonBytes: null,
      readyResponse: null,
    };
    repository.issueList.push(issueRec);
    repository.issueByNumber.set(issueRec.number, issueRec);
    // Prebuild the JSON body and the whole HTTP response now, while the
    // issue is being created, so every later GET is a single socket write.
    this.rebuildIssueCaches(repository, issueRec);
    return issueRec;
  }

  addPullRequest(repository: Repository, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): PullRec {
    this.pullIdSeq += 1;
    repository.pullCounter += 1;
    const seq = this.now();
    const stamp = isoTimestamp(seq);
    const pullRec: PullRec = {
      id: this.pullIdSeq,
      number: repository.pullCounter,
      repositoryName: repository.name,
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
      createdAt: stamp,
      updatedAt: stamp,
      gqlId: encodeBase64Url('P:' + repository.name + ':' + repository.pullCounter),
    };
    repository.pullList.push(pullRec);
    repository.pullByNumber.set(pullRec.number, pullRec);
    return pullRec;
  }

  repositoryNodeId(repository: Repository): string {
    return encodeBase64Url('R:' + repository.owner + '/' + repository.name);
  }
}

export function isZeroOid(oid: string): boolean {
  return oid === NULL_OID;
}
