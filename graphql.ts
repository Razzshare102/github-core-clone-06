// graphql.ts — a small GraphQL executor for the suite's fixed documents:
// viewer/repository/node/__type, issue and pull-request connections, and
// the five mutations. The tokenizer, parser and resolver are hand-written
// here with no dependencies, so a query document is lexed, parsed and
// executed in one pass over the in-memory state.

import { State, type Repository, type IssueRec, type PullRec } from './store.ts';
import { squashMergePull, type HttpResult, type RequestContext, jsonResponse, errorResponse } from './rest.ts';
import { encodeBase64Url, decodeBase64Url, isoTimestamp } from './util.ts';

// ---------- tokenizer ----------

type LexToken =
  | { t: 'name'; v: string }
  | { t: 'string'; v: string }
  | { t: 'int'; v: number }
  | { t: 'punct'; v: string };

function lexQuery(src: string): LexToken[] {
  const found: LexToken[] = [];
  let at = 0;
  while (at < src.length) {
    const ch = src[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at++;
      continue;
    }
    if (ch === '#') {
      while (at < src.length && src[at] !== '\n') at++;
      continue;
    }
    if (ch === '.' && src[at + 1] === '.' && src[at + 2] === '.') {
      found.push({ t: 'punct', v: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      found.push({ t: 'punct', v: ch });
      at++;
      continue;
    }
    if (ch === '"') {
      let text = '';
      let end = at + 1;
      while (end < src.length) {
        const inner = src[end];
        if (inner === '"') break;
        if (inner === '\\' && end + 1 < src.length) {
          const esc = src[end + 1];
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === '"') text += '"';
          else if (esc === '\\') text += '\\';
          else if (esc === '/') text += '/';
          else text += esc;
          end += 2;
          continue;
        }
        text += inner;
        end++;
      }
      found.push({ t: 'string', v: text });
      at = end + 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '-' && src[at + 1] >= '0' && src[at + 1] <= '9')) {
      let end = at;
      if (src[end] === '-') end++;
      while (end < src.length && ((src[end] >= '0' && src[end] <= '9') || src[end] === '.')) end++;
      found.push({ t: 'int', v: parseInt(src.slice(at, end), 10) });
      at = end;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let end = at;
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end])) end++;
      found.push({ t: 'name', v: src.slice(at, end) });
      at = end;
      continue;
    }
    at++;
  }
  return found;
}

// ---------- parser ----------

export type GraphValue =
  | { k: 'var'; name: string }
  | { k: 'string'; v: string }
  | { k: 'int'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; items: GraphValue[] }
  | { k: 'object'; fields: { name: string; value: GraphValue }[] };

export interface Selection {
  kind: 'field' | 'inline' | 'fragment';
  name?: string;
  alias?: string;
  args?: { name: string; value: GraphValue }[];
  selections?: Selection[];
  typeCondition?: string | null;
  fragmentName?: string;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: GraphValue | null }[];
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
}

class QueryParser {
  private index = 0;
  private lexed: LexToken[];
  constructor(lexed: LexToken[]) {
    this.lexed = lexed;
  }

  private peek(): LexToken | undefined {
    return this.lexed[this.index];
  }

  private next(): LexToken | undefined {
    return this.lexed[this.index++];
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'punct' && t.v === v;
  }

  private eatPunct(v: string): boolean {
    if (this.isPunct(v)) {
      this.index++;
      return true;
    }
    return false;
  }

  private expectPunct(v: string): void {
    if (!this.eatPunct(v)) throw new Error('expected ' + v);
  }

  private takeIdentifier(): string {
    const t = this.next();
    if (!t || t.t !== 'name') throw new Error('expected a name');
    return t.v;
  }

  readDocument(): Document {
    const doc: Document = { operations: [], fragments: new Map() };
    while (this.peek()) {
      if (this.peek()?.t === 'name' && (this.peek() as { v: string }).v === 'fragment') {
        this.next();
        const fragName = this.takeIdentifier();
        let typeCondition: string | null = null;
        if (this.peek()?.t === 'name' && (this.peek() as { v: string }).v === 'on') {
          this.next();
          typeCondition = this.takeIdentifier();
        }
        const selections = this.readSelectionSet();
        doc.fragments.set(fragName, { typeCondition, selections });
        continue;
      }
      doc.operations.push(this.readOperation());
    }
    return doc;
  }

  private readOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t && t.t === 'name' && (t.v === 'query' || t.v === 'mutation')) {
      kind = this.next()!.v as 'query' | 'mutation';
      const nt = this.peek();
      if (nt && nt.t === 'name') name = this.next()!.v;
    }
    const varDefs: { name: string; defaultValue: GraphValue | null }[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const vname = this.takeIdentifier();
        this.expectPunct(':');
        // Skip the type tokens (possibly [T]!, T!, etc.) until ',' or ')'.
        let depth = 0;
        while (true) {
          const tok = this.peek();
          if (!tok) break;
          if (tok.t === 'punct' && tok.v === '[') depth++;
          if (tok.t === 'punct' && tok.v === ']') depth--;
          if (depth === 0 && tok.t === 'punct' && (tok.v === ',' || tok.v === ')')) break;
          if (tok.t === 'punct' && tok.v === '=') {
            this.next();
            this.readValue();
            break;
          }
          this.next();
        }
        varDefs.push({ name: vname, defaultValue: null });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    const selections = this.readSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private readSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!this.isPunct('}')) {
      if (!this.peek()) throw new Error('unterminated selection set');
      out.push(this.readSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private readSelection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      const nt = this.peek();
      if (nt && nt.t === 'name' && nt.v === 'on') {
        this.next();
        const tc = this.takeIdentifier();
        return { kind: 'inline', typeCondition: tc, selections: this.readSelectionSet() };
      }
      if (nt && nt.t === 'name') {
        const fragName = this.next()!.v;
        return { kind: 'fragment', fragmentName: fragName };
      }
      return { kind: 'inline', typeCondition: null, selections: this.readSelectionSet() };
    }
    let name = this.takeIdentifier();
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.takeIdentifier();
    }
    let args: { name: string; value: GraphValue }[] | undefined;
    if (this.isPunct('(')) {
      this.next();
      args = [];
      while (!this.isPunct(')')) {
        const aname = this.takeIdentifier();
        this.expectPunct(':');
        const value = this.readValue();
        args.push({ name: aname, value });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    let selections: Selection[] | undefined;
    if (this.isPunct('{')) selections = this.readSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private readValue(): GraphValue {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of query');
    if (t.t === 'punct' && t.v === '$') {
      this.next();
      return { k: 'var', name: this.takeIdentifier() };
    }
    if (t.t === 'string') {
      this.next();
      return { k: 'string', v: t.v };
    }
    if (t.t === 'int') {
      this.next();
      return { k: 'int', v: t.v };
    }
    if (t.t === 'name') {
      this.next();
      if (t.v === 'true') return { k: 'bool', v: true };
      if (t.v === 'false') return { k: 'bool', v: false };
      if (t.v === 'null') return { k: 'null' };
      return { k: 'enum', v: t.v };
    }
    if (t.t === 'punct' && t.v === '[') {
      this.next();
      const items: GraphValue[] = [];
      while (!this.isPunct(']')) {
        items.push(this.readValue());
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(']');
      return { k: 'list', items };
    }
    if (t.t === 'punct' && t.v === '{') {
      this.next();
      const fields: { name: string; value: GraphValue }[] = [];
      while (!this.isPunct('}')) {
        const name = this.takeIdentifier();
        this.expectPunct(':');
        fields.push({ name, value: this.readValue() });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct('}');
      return { k: 'object', fields };
    }
    throw new Error('unexpected token in value');
  }
}

export function parseGraphqlDoc(src: string): Document {
  return new QueryParser(lexQuery(src)).readDocument();
}

// ---------- value resolution ----------

function evalValue(v: GraphValue, vars: Record<string, unknown>): unknown {
  switch (v.k) {
    case 'var': {
      const val = vars[v.name];
      return val === undefined ? null : val;
    }
    case 'string':
      return v.v;
    case 'int':
      return v.v;
    case 'bool':
      return v.v;
    case 'null':
      return null;
    case 'enum':
      return v.v;
    case 'list':
      return v.items.map((x) => evalValue(x, vars));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const f of v.fields) o[f.name] = evalValue(f.value, vars);
      return o;
    }
  }
}

function argumentValue(args: { name: string; value: GraphValue }[] | undefined, name: string, vars: Record<string, unknown>): unknown {
  if (!args) return undefined;
  const a = args.find((x) => x.name === name);
  if (!a) return undefined;
  return evalValue(a.value, vars);
}

// ---------- node model ----------

type GraphNode =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repository }
  | { __typename: 'Issue'; repo: Repository; issue: IssueRec }
  | { __typename: 'PullRequest'; repo: Repository; pull: PullRec }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; items: IssueRec[]; repo: Repository; afterIndex: number; hasNext: boolean; total: number }
  | { __typename: 'PullRequestConnection'; items: PullRec[]; repo: Repository; afterIndex: number; hasNext: boolean; total: number }
  | { __typename: 'IssueEdge'; node: IssueRec; repo: Repository; cursor: string }
  | { __typename: 'PullRequestEdge'; node: PullRec; repo: Repository; cursor: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }
  | { __typename: 'ChangedFileConnection'; paths: string[] }
  | { __typename: 'ChangedFile'; path: string }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; issue: IssueRec; repo: Repository }
  | { __typename: 'CloseIssuePayload'; issue: IssueRec; repo: Repository }
  | { __typename: 'CreatePullRequestPayload'; pull: PullRec; repo: Repository }
  | { __typename: 'MergePullRequestPayload'; pull: PullRec; repo: Repository }
  | { __typename: 'AddCommentPayload'; commentId: string; body: string }
  | { __typename: 'CommentEdge'; id: string; body: string }
  | { __typename: 'CommentNode'; id: string; body: string };

const FIELDS_BY_TYPE: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login', 'id', 'name']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'repository', 'author']),
  PullRequest: new Set(['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body']),
  Ref: new Set(['name']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']),
  ChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  ChangedFile: new Set(['path']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  CommentEdge: new Set(['node', 'cursor']),
  CommentNode: new Set(['id', 'body']),
};

const OBJECT_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const ENUM_MEMBERS: Record<string, string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
};

class GraphError extends Error {}

function decodeNodeId(id: string): { kind: string; rest: string } | null {
  const s = decodeBase64Url(id);
  if (!s) return null;
  const i = s.indexOf(':');
  if (i < 0) return null;
  return { kind: s.slice(0, i), rest: s.slice(i + 1) };
}

function issueObject(repo: Repository, issue: IssueRec): GraphNode {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repository, pull: PullRec): GraphNode {
  return { __typename: 'PullRequest', repo, pull };
}

function encodeCursor(index: number): string {
  return encodeBase64Url('c:' + index);
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  const s = decodeBase64Url(cursor);
  if (!s.startsWith('c:')) return -1;
  const n = parseInt(s.slice(2), 10);
  return Number.isFinite(n) ? n : -1;
}

function pullMergeState(state: State, repo: Repository, pull: PullRec): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get('refs/heads/' + pull.base);
  if (!baseTip) return 'UNKNOWN';
  const prBaseFlat = state.flattenTree(pull.baseSha);
  const headFlat = state.flattenTree(pull.headSha);
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
    if (a !== c && changedHead.has(p) && changedHead.get(p) !== c) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function pullChangedPaths(state: State, pull: PullRec): string[] {
  const baseFlat = state.flattenTree(pull.baseSha);
  const headFlat = state.flattenTree(pull.headSha);
  const out: string[] = [];
  for (const p of new Set([...baseFlat.keys(), ...headFlat.keys()])) {
    const a = baseFlat.get(p)?.oid ?? null;
    const c = headFlat.get(p)?.oid ?? null;
    if (a !== c) out.push(p);
  }
  return out.sort();
}

// ---------- executor ----------

function resolveNodeField(
  state: State,
  holder: GraphNode,
  field: string,
  args: { name: string; value: GraphValue }[] | undefined,
  vars: Record<string, unknown>,
): unknown {
  const known = FIELDS_BY_TYPE[holder.__typename];
  if (known && field !== '__typename' && !known.has(field)) {
    throw new GraphError(`Cannot query field "${field}" on type "${holder.__typename}".`);
  }
  if (field === '__typename') return holder.__typename;
  switch (holder.__typename) {
    case 'Query': {
      if (field === 'viewer') {
        return { __typename: 'User', login: state.viewerName ?? '' } as GraphNode;
      }
      if (field === 'repository') {
        const owner = argumentValue(args, 'owner', vars) as string | undefined;
        const name = argumentValue(args, 'name', vars) as string | undefined;
        if (!owner || !name) return null;
        if (!state.viewerOwns(owner)) return null;
        const repository = state.findRepository(name);
        if (!repository) return null;
        return { __typename: 'Repository', repo: repository } as GraphNode;
      }
      if (field === 'node') {
        const id = argumentValue(args, 'id', vars) as string | undefined;
        if (!id) return null;
        const dec = decodeNodeId(id);
        if (!dec) return null;
        if (dec.kind === 'R') {
          const slash = dec.rest.indexOf('/');
          if (slash < 0) return null;
          const owner = dec.rest.slice(0, slash);
          const name = dec.rest.slice(slash + 1);
          if (!state.viewerOwns(owner)) return null;
          const repository = state.findRepository(name);
          if (!repository) return null;
          return { __typename: 'Repository', repo: repository } as GraphNode;
        }
        if (dec.kind === 'I') {
          const parts = dec.rest.split(':');
          const repository = state.findRepository(parts[0]);
          if (!repository) return null;
          const issueRec = repository.issueByNumber.get(parseInt(parts[1], 10));
          if (!issueRec) return null;
          return issueObject(repository, issueRec);
        }
        if (dec.kind === 'P') {
          const parts = dec.rest.split(':');
          const repository = state.findRepository(parts[0]);
          if (!repository) return null;
          const pullRec = repository.pullByNumber.get(parseInt(parts[1], 10));
          if (!pullRec) return null;
          return pullObject(repository, pullRec);
        }
        return null;
      }
      if (field === '__type') {
        const name = argumentValue(args, 'name', vars) as string | undefined;
        if (!name) return null;
        if (OBJECT_FIELDS[name] || ENUM_MEMBERS[name]) return { __typename: '__Type', name } as GraphNode;
        return null;
      }
      if (field === '__schema') return null;
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = argumentValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const repoId = input?.repositoryId as string | undefined;
        const title = input?.title as string | undefined;
        const body = (input?.body as string | undefined) ?? '';
        if (!repoId || !title) throw new GraphError('createIssue requires repositoryId and title');
        const dec = decodeNodeId(repoId);
        if (!dec || dec.kind !== 'R') throw new GraphError('Invalid repositoryId');
        const slash = dec.rest.indexOf('/');
        const repository = state.findRepository(dec.rest.slice(slash + 1));
        if (!repository) throw new GraphError('Repository not found');
        const issueRec = state.addIssue(repository, title, body, []);
        return { __typename: 'CreateIssuePayload', issue: issueRec, repo: repository } as GraphNode;
      }
      if (field === 'closeIssue') {
        const input = argumentValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const issueId = input?.issueId as string | undefined;
        if (!issueId) throw new GraphError('closeIssue requires issueId');
        const dec = decodeNodeId(issueId);
        if (!dec || dec.kind !== 'I') throw new GraphError('Invalid issueId');
        const parts = dec.rest.split(':');
        const repository = state.findRepository(parts[0]);
        if (!repository) throw new GraphError('Repository not found');
        const issueRec = repository.issueByNumber.get(parseInt(parts[1], 10));
        if (!issueRec) throw new GraphError('Issue not found');
        issueRec.state = 'closed';
        issueRec.updatedAt = isoTimestamp(state.now());
        issueRec.jsonBytes = null;
        issueRec.readyResponse = null;
        return { __typename: 'CloseIssuePayload', issue: issueRec, repo: repository } as GraphNode;
      }
      if (field === 'createPullRequest') {
        const input = argumentValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const repoId = input?.repositoryId as string | undefined;
        const baseRefName = input?.baseRefName as string | undefined;
        const headRefName = input?.headRefName as string | undefined;
        const title = input?.title as string | undefined;
        if (!repoId || !baseRefName || !headRefName || !title) throw new GraphError('createPullRequest requires repositoryId, baseRefName, headRefName and title');
        const dec = decodeNodeId(repoId);
        if (!dec || dec.kind !== 'R') throw new GraphError('Invalid repositoryId');
        const slash = dec.rest.indexOf('/');
        const repository = state.findRepository(dec.rest.slice(slash + 1));
        if (!repository) throw new GraphError('Repository not found');
        const headSha = repository.refs.get('refs/heads/' + headRefName);
        const baseSha = repository.refs.get('refs/heads/' + baseRefName);
        if (!headSha || !baseSha) throw new GraphError('head or base branch not found');
        const existing = repository.pullList.find((p) => p.head === headRefName && p.state === 'open');
        const pullRec = existing ?? state.addPullRequest(repository, title, (input?.body as string | undefined) ?? '', headRefName, baseRefName, headSha, baseSha);
        return { __typename: 'CreatePullRequestPayload', pull: pullRec, repo: repository } as GraphNode;
      }
      if (field === 'mergePullRequest') {
        const input = argumentValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const prId = input?.pullRequestId as string | undefined;
        if (!prId) throw new GraphError('mergePullRequest requires pullRequestId');
        const dec = decodeNodeId(prId);
        if (!dec || dec.kind !== 'P') throw new GraphError('Invalid pullRequestId');
        const parts = dec.rest.split(':');
        const repository = state.findRepository(parts[0]);
        if (!repository) throw new GraphError('Repository not found');
        const pullRec = repository.pullByNumber.get(parseInt(parts[1], 10));
        if (!pullRec) throw new GraphError('Pull request not found');
        const r = squashMergePull(state, repository, pullRec);
        if (!r.ok) throw new GraphError(r.message);
        return { __typename: 'MergePullRequestPayload', pull: pullRec, repo: repository } as GraphNode;
      }
      if (field === 'addComment') {
        const input = argumentValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const subjectId = input?.subjectId as string | undefined;
        const body = input?.body as string | undefined;
        if (!subjectId || !body) throw new GraphError('addComment requires subjectId and body');
        const dec = decodeNodeId(subjectId);
        if (!dec || dec.kind !== 'I') throw new GraphError('Invalid subjectId');
        const parts = dec.rest.split(':');
        const repository = state.findRepository(parts[0]);
        if (!repository) throw new GraphError('Repository not found');
        const issueRec = repository.issueByNumber.get(parseInt(parts[1], 10));
        if (!issueRec) throw new GraphError('Issue not found');
        state.commentIdSeq += 1;
        const seq = state.now();
        const commentId = encodeBase64Url('C:' + repository.name + ':' + issueRec.number + ':' + state.commentIdSeq);
        issueRec.comments.push({ id: state.commentIdSeq, body, gqlId: commentId, createdSeq: seq, createdAt: isoTimestamp(seq) });
        issueRec.jsonBytes = null;
        issueRec.readyResponse = null;
        return { __typename: 'AddCommentPayload', commentId, body } as GraphNode;
      }
      return null;
    }
    case 'User': {
      if (field === 'login') return holder.login;
      if (field === 'id') return encodeBase64Url('U:' + holder.login);
      if (field === 'name') return holder.login;
      return null;
    }
    case 'Repository': {
      const repository = holder.repo;
      if (field === 'id') return state.repositoryNodeId(repository);
      if (field === 'databaseId') return repository.id;
      if (field === 'name') return repository.name;
      if (field === 'nameWithOwner') return (state.viewerName ?? repository.owner) + '/' + repository.name;
      if (field === 'owner') return { __typename: 'User', login: state.viewerName ?? repository.owner } as GraphNode;
      if (field === 'defaultBranchRef') {
        const tip = repository.refs.get('refs/heads/' + repository.defaultBranch);
        if (!tip) return null;
        return { __typename: 'Ref', name: repository.defaultBranch } as GraphNode;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const n = argumentValue(args, 'number', vars) as number | undefined;
        if (n === undefined) return null;
        const issueRec = repository.issueByNumber.get(n);
        return issueRec ? issueObject(repository, issueRec) : null;
      }
      if (field === 'issues') {
        const first = argumentValue(args, 'first', vars) as number | undefined;
        const after = argumentValue(args, 'after', vars) as string | undefined;
        const states = argumentValue(args, 'states', vars) as string[] | undefined;
        const orderBy = argumentValue(args, 'orderBy', vars) as Record<string, unknown> | undefined;
        let list = [...repository.issueList];
        if (states && states.length > 0) {
          const want = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => want.has(i.state));
        }
        if (orderBy && orderBy.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy.direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        } else {
          list.sort((a, b) => a.createdSeq - b.createdSeq);
        }
        const afterIdx = decodeCursor(after);
        const start = afterIdx + 1;
        const total = list.length;
        const slice = first !== undefined ? list.slice(start, start + first) : list.slice(start);
        const hasNext = start + slice.length < total;
        return { __typename: 'IssueConnection', items: slice, repo: repository, afterIndex: start, hasNext, total } as GraphNode;
      }
      if (field === 'pullRequests') {
        const first = argumentValue(args, 'first', vars) as number | undefined;
        const list = [...repository.pullList].sort((a, b) => a.createdSeq - b.createdSeq);
        const slice = first !== undefined ? list.slice(0, first) : list;
        return { __typename: 'PullRequestConnection', items: slice, repo: repository, afterIndex: 0, hasNext: slice.length < list.length, total: list.length } as GraphNode;
      }
      if (field === 'pullRequest') {
        const n = argumentValue(args, 'number', vars) as number | undefined;
        if (n === undefined) return null;
        const pullRec = repository.pullByNumber.get(n);
        return pullRec ? pullObject(repository, pullRec) : null;
      }
      return null;
    }
    case 'Issue': {
      const issueRec = holder.issue;
      if (field === 'id') return issueRec.gqlId;
      if (field === 'number') return issueRec.number;
      if (field === 'title') return issueRec.title;
      if (field === 'state') return issueRec.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'body') return issueRec.body;
      if (field === 'repository') return { __typename: 'Repository', repo: holder.repo } as GraphNode;
      if (field === 'author') return { __typename: 'User', login: state.viewerName ?? holder.repo.owner } as GraphNode;
      return null;
    }
    case 'PullRequest': {
      const pullRec = holder.pull;
      if (field === 'id') return pullRec.gqlId;
      if (field === 'number') return pullRec.number;
      if (field === 'title') return pullRec.title;
      if (field === 'body') return pullRec.body;
      if (field === 'state') return pullRec.merged ? 'MERGED' : pullRec.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pullRec.merged;
      if (field === 'headRefName') return pullRec.head;
      if (field === 'baseRefName') return pullRec.base;
      if (field === 'mergeable') return pullMergeState(state, holder.repo, pullRec);
      if (field === 'files') {
        const first = argumentValue(args, 'first', vars) as number | undefined;
        const paths = pullChangedPaths(state, pullRec);
        const slice = first !== undefined ? paths.slice(0, first) : paths;
        return { __typename: 'ChangedFileConnection', paths: slice } as GraphNode;
      }
      return null;
    }
    case 'Ref': {
      if (field === 'name') return holder.name;
      return null;
    }
    case 'IssueConnection': {
      if (field === 'nodes') return holder.items.map((i) => issueObject(holder.repo, i));
      if (field === 'edges') {
        return holder.items.map((i, idx) => ({ __typename: 'IssueEdge', node: i, repo: holder.repo, cursor: encodeCursor(holder.afterIndex + idx) }) as GraphNode);
      }
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: holder.hasNext,
          endCursor: holder.items.length > 0 ? encodeCursor(holder.afterIndex + holder.items.length - 1) : null,
          hasPreviousPage: holder.afterIndex > 0,
          startCursor: holder.items.length > 0 ? encodeCursor(holder.afterIndex) : null,
        } as GraphNode;
      }
      if (field === 'totalCount') return holder.total;
      return null;
    }
    case 'PullRequestConnection': {
      if (field === 'nodes') return holder.items.map((p) => pullObject(holder.repo, p));
      if (field === 'edges') {
        return holder.items.map((p, idx) => ({ __typename: 'PullRequestEdge', node: p, repo: holder.repo, cursor: encodeCursor(holder.afterIndex + idx) }) as GraphNode);
      }
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: holder.hasNext,
          endCursor: holder.items.length > 0 ? encodeCursor(holder.afterIndex + holder.items.length - 1) : null,
          hasPreviousPage: holder.afterIndex > 0,
          startCursor: holder.items.length > 0 ? encodeCursor(holder.afterIndex) : null,
        } as GraphNode;
      }
      if (field === 'totalCount') return holder.total;
      return null;
    }
    case 'IssueEdge': {
      if (field === 'node') return issueObject(holder.repo, holder.node);
      if (field === 'cursor') return holder.cursor;
      return null;
    }
    case 'PullRequestEdge': {
      if (field === 'node') return pullObject(holder.repo, holder.node);
      if (field === 'cursor') return holder.cursor;
      return null;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return holder.hasNextPage;
      if (field === 'endCursor') return holder.endCursor;
      if (field === 'hasPreviousPage') return holder.hasPreviousPage;
      if (field === 'startCursor') return holder.startCursor;
      return null;
    }
    case 'ChangedFileConnection': {
      if (field === 'nodes') return holder.paths.map((p) => ({ __typename: 'ChangedFile', path: p }) as GraphNode);
      if (field === 'edges') return holder.paths.map((p) => ({ __typename: 'ChangedFile', path: p }) as GraphNode);
      if (field === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } as GraphNode;
      }
      if (field === 'totalCount') return holder.paths.length;
      return null;
    }
    case 'ChangedFile': {
      if (field === 'path') return holder.path;
      return null;
    }
    case '__Type': {
      if (field === 'name') return holder.name;
      if (field === 'kind') return ENUM_MEMBERS[holder.name] ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        const names = OBJECT_FIELDS[holder.name] ?? [];
        return names.map((n) => ({ __typename: '__Field', name: n }) as GraphNode);
      }
      if (field === 'enumValues') {
        const vals = ENUM_MEMBERS[holder.name] ?? [];
        return vals.map((n) => ({ __typename: '__EnumValue', name: n }) as GraphNode);
      }
      if (field === 'description') return null;
      return null;
    }
    case '__Field': {
      if (field === 'name') return holder.name;
      if (field === 'description') return null;
      return null;
    }
    case '__EnumValue': {
      if (field === 'name') return holder.name;
      if (field === 'description') return null;
      return null;
    }
    case 'CreateIssuePayload': {
      if (field === 'issue') return issueObject(holder.repo, holder.issue);
      return null;
    }
    case 'CloseIssuePayload': {
      if (field === 'issue') return issueObject(holder.repo, holder.issue);
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (field === 'pullRequest') return pullObject(holder.repo, holder.pull);
      return null;
    }
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return pullObject(holder.repo, holder.pull);
      return null;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') {
        return { __typename: 'CommentEdge', id: holder.commentId, body: holder.body } as GraphNode;
      }
      return null;
    }
    case 'CommentEdge': {
      if (field === 'node') return { __typename: 'CommentNode', id: holder.id, body: holder.body } as GraphNode;
      if (field === 'cursor') return '';
      return null;
    }
    case 'CommentNode': {
      if (field === 'id') return holder.id;
      if (field === 'body') return holder.body;
      return null;
    }
  }
  return null;
}

function isGraphNode(v: unknown): v is GraphNode {
  return !!v && typeof v === 'object' && '__typename' in (v as Record<string, unknown>);
}

function runSelections(
  state: State,
  holder: GraphNode,
  selections: Selection[],
  vars: Record<string, unknown>,
  doc: Document,
  errors: GraphError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (!sel.typeCondition || sel.typeCondition === holder.__typename) {
        const sub = runSelections(state, holder, sel.selections ?? [], vars, doc, errors);
        Object.assign(out, sub);
      }
      continue;
    }
    if (sel.kind === 'fragment') {
      const frag = sel.fragmentName ? doc.fragments.get(sel.fragmentName) : undefined;
      if (frag && (!frag.typeCondition || frag.typeCondition === holder.__typename)) {
        const sub = runSelections(state, holder, frag.selections, vars, doc, errors);
        Object.assign(out, sub);
      }
      continue;
    }
    const key = sel.alias ?? sel.name ?? '';
    const fieldName = sel.name ?? '';
    try {
      const value = resolveNodeField(state, holder, fieldName, sel.args, vars);
      if (sel.selections && sel.selections.length > 0) {
        if (value === null || value === undefined) {
          out[key] = null;
        } else if (Array.isArray(value)) {
          out[key] = value.map((item) =>
            isGraphNode(item) ? runSelections(state, item, sel.selections!, vars, doc, errors) : item,
          );
        } else if (isGraphNode(value)) {
          out[key] = runSelections(state, value, sel.selections, vars, doc, errors);
        } else {
          out[key] = value;
        }
      } else {
        out[key] = value;
      }
    } catch (e) {
      if (e instanceof GraphError) {
        errors.push(e);
        out[key] = null;
      } else {
        throw e;
      }
    }
  }
  return out;
}

function runOperation(state: State, operation: Operation, vars: Record<string, unknown>, doc: Document): { data: unknown; errors: { message: string }[] } {
  const errors: GraphError[] = [];
  const root: GraphNode = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const mergedVars: Record<string, unknown> = {};
  for (const vd of operation.varDefs) {
    if (vars[vd.name] !== undefined) mergedVars[vd.name] = vars[vd.name];
    else if (vd.defaultValue) mergedVars[vd.name] = evalValue(vd.defaultValue, vars);
    else mergedVars[vd.name] = null;
  }
  for (const k of Object.keys(vars)) {
    if (!(k in mergedVars)) mergedVars[k] = vars[k];
  }
  let data: unknown;
  try {
    data = runSelections(state, root, operation.selections, mergedVars, doc, errors);
  } catch (e) {
    errors.push(new GraphError(e instanceof Error ? e.message : 'internal error'));
    data = null;
  }
  if (errors.length > 0) return { data: null, errors: errors.map((e) => ({ message: e.message })) };
  return { data, errors: [] };
}

// ---------- HTTP handler ----------

export function serveGraphql(context: RequestContext): HttpResult {
  const state = context.state;
  if (!context.authed) return errorResponse(401, 'Requires authentication');
  if (context.jsonError) return errorResponse(400, 'Problems parsing JSON');
  const payload = context.json;
  const documents: { query?: string; variables?: Record<string, unknown>; operationName?: string }[] = Array.isArray(payload)
    ? (payload as { query?: string; variables?: Record<string, unknown>; operationName?: string }[])
    : [payload as { query?: string; variables?: Record<string, unknown>; operationName?: string }];
  const results: unknown[] = [];
  for (const entry of documents) {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const vars = (entry.variables ?? {}) as Record<string, unknown>;
    if (!query) {
      results.push({ data: null, errors: [{ message: 'Must provide query string.' }] });
      continue;
    }
    let parsed: Document;
    try {
      parsed = parseGraphqlDoc(query);
    } catch (e) {
      results.push({ data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax Error' }] });
      continue;
    }
    const operationName = entry.operationName;
    const operation = parsed.operations.find((o) => !operationName || o.name === operationName) ?? parsed.operations[0];
    if (!operation) {
      results.push({ data: null, errors: [{ message: 'Must provide an operation.' }] });
      continue;
    }
    results.push(runOperation(state, operation, vars, parsed));
  }
  return jsonResponse(200, Array.isArray(payload) ? results : results[0]);
}
