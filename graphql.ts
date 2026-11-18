// graphql.ts — a small GraphQL executor for the suite's fixed documents:
// viewer/repository/node/__type, issue and pull-request connections, and
// the five mutations. Hand-written tokenizer, parser and resolver; no
// dependencies. Written fresh for this entry.

import { Store, type Repo, type Issue, type Pull } from './store.ts';
import { mergePull, type RestResult, type Ctx, jsonResult, errResult } from './rest.ts';
import { b64urlEncode, b64urlDecode, isoFromSec } from './util.ts';

// ---------- tokenizer ----------

type Token =
  | { t: 'name'; v: string }
  | { t: 'string'; v: string }
  | { t: 'int'; v: number }
  | { t: 'punct'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      out.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(c)) {
      out.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      let j = i + 1;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '"') break;
        if (ch === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') s += '\n';
          else if (e === 't') s += '\t';
          else if (e === 'r') s += '\r';
          else if (e === '"') s += '"';
          else if (e === '\\') s += '\\';
          else if (e === '/') s += '/';
          else s += e;
          j += 2;
          continue;
        }
        s += ch;
        j++;
      }
      out.push({ t: 'string', v: s });
      i = j + 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '-' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      out.push({ t: 'int', v: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

// ---------- parser ----------

export type GqlValue =
  | { k: 'var'; name: string }
  | { k: 'string'; v: string }
  | { k: 'int'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; items: GqlValue[] }
  | { k: 'object'; fields: { name: string; value: GqlValue }[] };

export interface GqlSelection {
  kind: 'field' | 'inline' | 'fragment';
  name?: string;
  alias?: string;
  args?: { name: string; value: GqlValue }[];
  selections?: GqlSelection[];
  typeCondition?: string | null;
  fragmentName?: string;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: GqlValue | null }[];
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string | null; selections: GqlSelection[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'punct' && t.v === v;
  }

  private eatPunct(v: string): boolean {
    if (this.isPunct(v)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectPunct(v: string): void {
    if (!this.eatPunct(v)) throw new Error('expected ' + v);
  }

  private takeName(): string {
    const t = this.next();
    if (!t || t.t !== 'name') throw new Error('expected a name');
    return t.v;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.peek()) {
      if (this.peek()?.t === 'name' && (this.peek() as { v: string }).v === 'fragment') {
        this.next();
        const fragName = this.takeName();
        let typeCondition: string | null = null;
        if (this.peek()?.t === 'name' && (this.peek() as { v: string }).v === 'on') {
          this.next();
          typeCondition = this.takeName();
        }
        const selections = this.parseSelectionSet();
        doc.fragments.set(fragName, { typeCondition, selections });
        continue;
      }
      doc.operations.push(this.parseOperation());
    }
    return doc;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t && t.t === 'name' && (t.v === 'query' || t.v === 'mutation')) {
      kind = this.next()!.v as 'query' | 'mutation';
      const nt = this.peek();
      if (nt && nt.t === 'name') name = this.next()!.v;
    }
    const varDefs: { name: string; defaultValue: GqlValue | null }[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const vname = this.takeName();
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
            this.parseValue();
            break;
          }
          this.next();
        }
        varDefs.push({ name: vname, defaultValue: null });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const out: GqlSelection[] = [];
    while (!this.isPunct('}')) {
      if (!this.peek()) throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): GqlSelection {
    if (this.isPunct('...')) {
      this.next();
      const nt = this.peek();
      if (nt && nt.t === 'name' && nt.v === 'on') {
        this.next();
        const tc = this.takeName();
        return { kind: 'inline', typeCondition: tc, selections: this.parseSelectionSet() };
      }
      if (nt && nt.t === 'name') {
        const fragName = this.next()!.v;
        return { kind: 'fragment', fragmentName: fragName };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.takeName();
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.takeName();
    }
    let args: { name: string; value: GqlValue }[] | undefined;
    if (this.isPunct('(')) {
      this.next();
      args = [];
      while (!this.isPunct(')')) {
        const aname = this.takeName();
        this.expectPunct(':');
        const value = this.parseValue();
        args.push({ name: aname, value });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    let selections: GqlSelection[] | undefined;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): GqlValue {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of query');
    if (t.t === 'punct' && t.v === '$') {
      this.next();
      return { k: 'var', name: this.takeName() };
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
      const items: GqlValue[] = [];
      while (!this.isPunct(']')) {
        items.push(this.parseValue());
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(']');
      return { k: 'list', items };
    }
    if (t.t === 'punct' && t.v === '{') {
      this.next();
      const fields: { name: string; value: GqlValue }[] = [];
      while (!this.isPunct('}')) {
        const name = this.takeName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct('}');
      return { k: 'object', fields };
    }
    throw new Error('unexpected token in value');
  }
}

export function parseGql(src: string): GqlDocument {
  return new Parser(tokenize(src)).parseDocument();
}

// ---------- value resolution ----------

function resolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
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
      return v.items.map((x) => resolveValue(x, vars));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const f of v.fields) o[f.name] = resolveValue(f.value, vars);
      return o;
    }
  }
}

function argVal(args: { name: string; value: GqlValue }[] | undefined, name: string, vars: Record<string, unknown>): unknown {
  if (!args) return undefined;
  const a = args.find((x) => x.name === name);
  if (!a) return undefined;
  return resolveValue(a.value, vars);
}

// ---------- node model ----------

type NodeObj =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; items: Issue[]; repo: Repo; afterIndex: number; hasNext: boolean; total: number }
  | { __typename: 'PullRequestConnection'; items: Pull[]; repo: Repo; afterIndex: number; hasNext: boolean; total: number }
  | { __typename: 'IssueEdge'; node: Issue; repo: Repo; cursor: string }
  | { __typename: 'PullRequestEdge'; node: Pull; repo: Repo; cursor: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }
  | { __typename: 'ChangedFileConnection'; paths: string[] }
  | { __typename: 'ChangedFile'; path: string }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; issue: Issue; repo: Repo }
  | { __typename: 'CloseIssuePayload'; issue: Issue; repo: Repo }
  | { __typename: 'CreatePullRequestPayload'; pull: Pull; repo: Repo }
  | { __typename: 'MergePullRequestPayload'; pull: Pull; repo: Repo }
  | { __typename: 'AddCommentPayload'; commentId: string; body: string }
  | { __typename: 'CommentEdge'; id: string; body: string }
  | { __typename: 'CommentNode'; id: string; body: string };

const KNOWN_FIELDS: Record<string, Set<string>> = {
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

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
};

class GqlError extends Error {}

function decodeGlobalId(id: string): { kind: string; rest: string } | null {
  const s = b64urlDecode(id);
  if (!s) return null;
  const i = s.indexOf(':');
  if (i < 0) return null;
  return { kind: s.slice(0, i), rest: s.slice(i + 1) };
}

function issueNode(repo: Repo, issue: Issue): NodeObj {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeObj {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(index: number): string {
  return b64urlEncode('c:' + index);
}

function indexFromCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  const s = b64urlDecode(cursor);
  if (!s.startsWith('c:')) return -1;
  const n = parseInt(s.slice(2), 10);
  return Number.isFinite(n) ? n : -1;
}

function prMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get('refs/heads/' + pull.base);
  if (!baseTip) return 'UNKNOWN';
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
    if (a !== c && changedHead.has(p) && changedHead.get(p) !== c) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function prFiles(store: Store, pull: Pull): string[] {
  const baseFlat = store.flatTree(pull.baseSha);
  const headFlat = store.flatTree(pull.headSha);
  const out: string[] = [];
  for (const p of new Set([...baseFlat.keys(), ...headFlat.keys()])) {
    const a = baseFlat.get(p)?.oid ?? null;
    const c = headFlat.get(p)?.oid ?? null;
    if (a !== c) out.push(p);
  }
  return out.sort();
}

// ---------- executor ----------

function resolveField(
  store: Store,
  parent: NodeObj,
  field: string,
  args: { name: string; value: GqlValue }[] | undefined,
  vars: Record<string, unknown>,
): unknown {
  const known = KNOWN_FIELDS[parent.__typename];
  if (known && field !== '__typename' && !known.has(field)) {
    throw new GqlError(`Cannot query field "${field}" on type "${parent.__typename}".`);
  }
  if (field === '__typename') return parent.__typename;
  switch (parent.__typename) {
    case 'Query': {
      if (field === 'viewer') {
        return { __typename: 'User', login: store.viewerLogin ?? '' } as NodeObj;
      }
      if (field === 'repository') {
        const owner = argVal(args, 'owner', vars) as string | undefined;
        const name = argVal(args, 'name', vars) as string | undefined;
        if (!owner || !name) return null;
        if (!store.ownerMatches(owner)) return null;
        const repo = store.getRepo(name);
        if (!repo) return null;
        return { __typename: 'Repository', repo } as NodeObj;
      }
      if (field === 'node') {
        const id = argVal(args, 'id', vars) as string | undefined;
        if (!id) return null;
        const dec = decodeGlobalId(id);
        if (!dec) return null;
        if (dec.kind === 'R') {
          const slash = dec.rest.indexOf('/');
          if (slash < 0) return null;
          const owner = dec.rest.slice(0, slash);
          const name = dec.rest.slice(slash + 1);
          if (!store.ownerMatches(owner)) return null;
          const repo = store.getRepo(name);
          if (!repo) return null;
          return { __typename: 'Repository', repo } as NodeObj;
        }
        if (dec.kind === 'I') {
          const parts = dec.rest.split(':');
          const repo = store.getRepo(parts[0]);
          if (!repo) return null;
          const issue = repo.issuesByNumber.get(parseInt(parts[1], 10));
          if (!issue) return null;
          return issueNode(repo, issue);
        }
        if (dec.kind === 'P') {
          const parts = dec.rest.split(':');
          const repo = store.getRepo(parts[0]);
          if (!repo) return null;
          const pull = repo.pullsByNumber.get(parseInt(parts[1], 10));
          if (!pull) return null;
          return pullNode(repo, pull);
        }
        return null;
      }
      if (field === '__type') {
        const name = argVal(args, 'name', vars) as string | undefined;
        if (!name) return null;
        if (TYPE_FIELDS[name] || TYPE_ENUMS[name]) return { __typename: '__Type', name } as NodeObj;
        return null;
      }
      if (field === '__schema') return null;
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = argVal(args, 'input', vars) as Record<string, unknown> | undefined;
        const repoId = input?.repositoryId as string | undefined;
        const title = input?.title as string | undefined;
        const body = (input?.body as string | undefined) ?? '';
        if (!repoId || !title) throw new GqlError('createIssue requires repositoryId and title');
        const dec = decodeGlobalId(repoId);
        if (!dec || dec.kind !== 'R') throw new GqlError('Invalid repositoryId');
        const slash = dec.rest.indexOf('/');
        const repo = store.getRepo(dec.rest.slice(slash + 1));
        if (!repo) throw new GqlError('Repository not found');
        const issue = store.createIssue(repo, title, body, []);
        return { __typename: 'CreateIssuePayload', issue, repo } as NodeObj;
      }
      if (field === 'closeIssue') {
        const input = argVal(args, 'input', vars) as Record<string, unknown> | undefined;
        const issueId = input?.issueId as string | undefined;
        if (!issueId) throw new GqlError('closeIssue requires issueId');
        const dec = decodeGlobalId(issueId);
        if (!dec || dec.kind !== 'I') throw new GqlError('Invalid issueId');
        const parts = dec.rest.split(':');
        const repo = store.getRepo(parts[0]);
        if (!repo) throw new GqlError('Repository not found');
        const issue = repo.issuesByNumber.get(parseInt(parts[1], 10));
        if (!issue) throw new GqlError('Issue not found');
        issue.state = 'closed';
        issue.updatedAt = isoFromSec(store.tick());
        issue.jsonCache = null;
        issue.httpResponse = null;
        return { __typename: 'CloseIssuePayload', issue, repo } as NodeObj;
      }
      if (field === 'createPullRequest') {
        const input = argVal(args, 'input', vars) as Record<string, unknown> | undefined;
        const repoId = input?.repositoryId as string | undefined;
        const baseRefName = input?.baseRefName as string | undefined;
        const headRefName = input?.headRefName as string | undefined;
        const title = input?.title as string | undefined;
        if (!repoId || !baseRefName || !headRefName || !title) throw new GqlError('createPullRequest requires repositoryId, baseRefName, headRefName and title');
        const dec = decodeGlobalId(repoId);
        if (!dec || dec.kind !== 'R') throw new GqlError('Invalid repositoryId');
        const slash = dec.rest.indexOf('/');
        const repo = store.getRepo(dec.rest.slice(slash + 1));
        if (!repo) throw new GqlError('Repository not found');
        const headSha = repo.refs.get('refs/heads/' + headRefName);
        const baseSha = repo.refs.get('refs/heads/' + baseRefName);
        if (!headSha || !baseSha) throw new GqlError('head or base branch not found');
        const existing = repo.pulls.find((p) => p.head === headRefName && p.state === 'open');
        const pull = existing ?? store.createPull(repo, title, (input?.body as string | undefined) ?? '', headRefName, baseRefName, headSha, baseSha);
        return { __typename: 'CreatePullRequestPayload', pull, repo } as NodeObj;
      }
      if (field === 'mergePullRequest') {
        const input = argVal(args, 'input', vars) as Record<string, unknown> | undefined;
        const prId = input?.pullRequestId as string | undefined;
        if (!prId) throw new GqlError('mergePullRequest requires pullRequestId');
        const dec = decodeGlobalId(prId);
        if (!dec || dec.kind !== 'P') throw new GqlError('Invalid pullRequestId');
        const parts = dec.rest.split(':');
        const repo = store.getRepo(parts[0]);
        if (!repo) throw new GqlError('Repository not found');
        const pull = repo.pullsByNumber.get(parseInt(parts[1], 10));
        if (!pull) throw new GqlError('Pull request not found');
        const r = mergePull(store, repo, pull);
        if (!r.ok) throw new GqlError(r.message);
        return { __typename: 'MergePullRequestPayload', pull, repo } as NodeObj;
      }
      if (field === 'addComment') {
        const input = argVal(args, 'input', vars) as Record<string, unknown> | undefined;
        const subjectId = input?.subjectId as string | undefined;
        const body = input?.body as string | undefined;
        if (!subjectId || !body) throw new GqlError('addComment requires subjectId and body');
        const dec = decodeGlobalId(subjectId);
        if (!dec || dec.kind !== 'I') throw new GqlError('Invalid subjectId');
        const parts = dec.rest.split(':');
        const repo = store.getRepo(parts[0]);
        if (!repo) throw new GqlError('Repository not found');
        const issue = repo.issuesByNumber.get(parseInt(parts[1], 10));
        if (!issue) throw new GqlError('Issue not found');
        store.commentSeq += 1;
        const seq = store.tick();
        const commentId = b64urlEncode('C:' + repo.name + ':' + issue.number + ':' + store.commentSeq);
        issue.comments.push({ id: store.commentSeq, body, gqlId: commentId, createdSeq: seq, createdAt: isoFromSec(seq) });
        issue.jsonCache = null;
        issue.httpResponse = null;
        return { __typename: 'AddCommentPayload', commentId, body } as NodeObj;
      }
      return null;
    }
    case 'User': {
      if (field === 'login') return parent.login;
      if (field === 'id') return b64urlEncode('U:' + parent.login);
      if (field === 'name') return parent.login;
      return null;
    }
    case 'Repository': {
      const repo = parent.repo;
      if (field === 'id') return store.repoGqlId(repo);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return (store.viewerLogin ?? repo.owner) + '/' + repo.name;
      if (field === 'owner') return { __typename: 'User', login: store.viewerLogin ?? repo.owner } as NodeObj;
      if (field === 'defaultBranchRef') {
        const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
        if (!tip) return null;
        return { __typename: 'Ref', name: repo.defaultBranch } as NodeObj;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const n = argVal(args, 'number', vars) as number | undefined;
        if (n === undefined) return null;
        const issue = repo.issuesByNumber.get(n);
        return issue ? issueNode(repo, issue) : null;
      }
      if (field === 'issues') {
        const first = argVal(args, 'first', vars) as number | undefined;
        const after = argVal(args, 'after', vars) as string | undefined;
        const states = argVal(args, 'states', vars) as string[] | undefined;
        const orderBy = argVal(args, 'orderBy', vars) as Record<string, unknown> | undefined;
        let list = [...repo.issues];
        if (states && states.length > 0) {
          const want = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => want.has(i.state));
        }
        if (orderBy && orderBy.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy.direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        } else {
          list.sort((a, b) => a.createdSeq - b.createdSeq);
        }
        const afterIdx = indexFromCursor(after);
        const start = afterIdx + 1;
        const total = list.length;
        const slice = first !== undefined ? list.slice(start, start + first) : list.slice(start);
        const hasNext = start + slice.length < total;
        return { __typename: 'IssueConnection', items: slice, repo, afterIndex: start, hasNext, total } as NodeObj;
      }
      if (field === 'pullRequests') {
        const first = argVal(args, 'first', vars) as number | undefined;
        const list = [...repo.pulls].sort((a, b) => a.createdSeq - b.createdSeq);
        const slice = first !== undefined ? list.slice(0, first) : list;
        return { __typename: 'PullRequestConnection', items: slice, repo, afterIndex: 0, hasNext: slice.length < list.length, total: list.length } as NodeObj;
      }
      if (field === 'pullRequest') {
        const n = argVal(args, 'number', vars) as number | undefined;
        if (n === undefined) return null;
        const pull = repo.pullsByNumber.get(n);
        return pull ? pullNode(repo, pull) : null;
      }
      return null;
    }
    case 'Issue': {
      const issue = parent.issue;
      if (field === 'id') return issue.gqlId;
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'body') return issue.body;
      if (field === 'repository') return { __typename: 'Repository', repo: parent.repo } as NodeObj;
      if (field === 'author') return { __typename: 'User', login: store.viewerLogin ?? parent.repo.owner } as NodeObj;
      return null;
    }
    case 'PullRequest': {
      const pull = parent.pull;
      if (field === 'id') return pull.gqlId;
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pull.merged;
      if (field === 'headRefName') return pull.head;
      if (field === 'baseRefName') return pull.base;
      if (field === 'mergeable') return prMergeable(store, parent.repo, pull);
      if (field === 'files') {
        const first = argVal(args, 'first', vars) as number | undefined;
        const paths = prFiles(store, pull);
        const slice = first !== undefined ? paths.slice(0, first) : paths;
        return { __typename: 'ChangedFileConnection', paths: slice } as NodeObj;
      }
      return null;
    }
    case 'Ref': {
      if (field === 'name') return parent.name;
      return null;
    }
    case 'IssueConnection': {
      if (field === 'nodes') return parent.items.map((i) => issueNode(parent.repo, i));
      if (field === 'edges') {
        return parent.items.map((i, idx) => ({ __typename: 'IssueEdge', node: i, repo: parent.repo, cursor: cursorFor(parent.afterIndex + idx) }) as NodeObj);
      }
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: parent.hasNext,
          endCursor: parent.items.length > 0 ? cursorFor(parent.afterIndex + parent.items.length - 1) : null,
          hasPreviousPage: parent.afterIndex > 0,
          startCursor: parent.items.length > 0 ? cursorFor(parent.afterIndex) : null,
        } as NodeObj;
      }
      if (field === 'totalCount') return parent.total;
      return null;
    }
    case 'PullRequestConnection': {
      if (field === 'nodes') return parent.items.map((p) => pullNode(parent.repo, p));
      if (field === 'edges') {
        return parent.items.map((p, idx) => ({ __typename: 'PullRequestEdge', node: p, repo: parent.repo, cursor: cursorFor(parent.afterIndex + idx) }) as NodeObj);
      }
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: parent.hasNext,
          endCursor: parent.items.length > 0 ? cursorFor(parent.afterIndex + parent.items.length - 1) : null,
          hasPreviousPage: parent.afterIndex > 0,
          startCursor: parent.items.length > 0 ? cursorFor(parent.afterIndex) : null,
        } as NodeObj;
      }
      if (field === 'totalCount') return parent.total;
      return null;
    }
    case 'IssueEdge': {
      if (field === 'node') return issueNode(parent.repo, parent.node);
      if (field === 'cursor') return parent.cursor;
      return null;
    }
    case 'PullRequestEdge': {
      if (field === 'node') return pullNode(parent.repo, parent.node);
      if (field === 'cursor') return parent.cursor;
      return null;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return parent.hasNextPage;
      if (field === 'endCursor') return parent.endCursor;
      if (field === 'hasPreviousPage') return parent.hasPreviousPage;
      if (field === 'startCursor') return parent.startCursor;
      return null;
    }
    case 'ChangedFileConnection': {
      if (field === 'nodes') return parent.paths.map((p) => ({ __typename: 'ChangedFile', path: p }) as NodeObj);
      if (field === 'edges') return parent.paths.map((p) => ({ __typename: 'ChangedFile', path: p }) as NodeObj);
      if (field === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } as NodeObj;
      }
      if (field === 'totalCount') return parent.paths.length;
      return null;
    }
    case 'ChangedFile': {
      if (field === 'path') return parent.path;
      return null;
    }
    case '__Type': {
      if (field === 'name') return parent.name;
      if (field === 'kind') return TYPE_ENUMS[parent.name] ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        const names = TYPE_FIELDS[parent.name] ?? [];
        return names.map((n) => ({ __typename: '__Field', name: n }) as NodeObj);
      }
      if (field === 'enumValues') {
        const vals = TYPE_ENUMS[parent.name] ?? [];
        return vals.map((n) => ({ __typename: '__EnumValue', name: n }) as NodeObj);
      }
      if (field === 'description') return null;
      return null;
    }
    case '__Field': {
      if (field === 'name') return parent.name;
      if (field === 'description') return null;
      return null;
    }
    case '__EnumValue': {
      if (field === 'name') return parent.name;
      if (field === 'description') return null;
      return null;
    }
    case 'CreateIssuePayload': {
      if (field === 'issue') return issueNode(parent.repo, parent.issue);
      return null;
    }
    case 'CloseIssuePayload': {
      if (field === 'issue') return issueNode(parent.repo, parent.issue);
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (field === 'pullRequest') return pullNode(parent.repo, parent.pull);
      return null;
    }
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return pullNode(parent.repo, parent.pull);
      return null;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') {
        return { __typename: 'CommentEdge', id: parent.commentId, body: parent.body } as NodeObj;
      }
      return null;
    }
    case 'CommentEdge': {
      if (field === 'node') return { __typename: 'CommentNode', id: parent.id, body: parent.body } as NodeObj;
      if (field === 'cursor') return '';
      return null;
    }
    case 'CommentNode': {
      if (field === 'id') return parent.id;
      if (field === 'body') return parent.body;
      return null;
    }
  }
  return null;
}

function isNodeObj(v: unknown): v is NodeObj {
  return !!v && typeof v === 'object' && '__typename' in (v as Record<string, unknown>);
}

function executeSelections(
  store: Store,
  parent: NodeObj,
  selections: GqlSelection[],
  vars: Record<string, unknown>,
  doc: GqlDocument,
  errors: GqlError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (!sel.typeCondition || sel.typeCondition === parent.__typename) {
        const sub = executeSelections(store, parent, sel.selections ?? [], vars, doc, errors);
        Object.assign(out, sub);
      }
      continue;
    }
    if (sel.kind === 'fragment') {
      const frag = sel.fragmentName ? doc.fragments.get(sel.fragmentName) : undefined;
      if (frag && (!frag.typeCondition || frag.typeCondition === parent.__typename)) {
        const sub = executeSelections(store, parent, frag.selections, vars, doc, errors);
        Object.assign(out, sub);
      }
      continue;
    }
    const key = sel.alias ?? sel.name ?? '';
    const fieldName = sel.name ?? '';
    try {
      const value = resolveField(store, parent, fieldName, sel.args, vars);
      if (sel.selections && sel.selections.length > 0) {
        if (value === null || value === undefined) {
          out[key] = null;
        } else if (Array.isArray(value)) {
          out[key] = value.map((item) =>
            isNodeObj(item) ? executeSelections(store, item, sel.selections!, vars, doc, errors) : item,
          );
        } else if (isNodeObj(value)) {
          out[key] = executeSelections(store, value, sel.selections, vars, doc, errors);
        } else {
          out[key] = value;
        }
      } else {
        out[key] = value;
      }
    } catch (e) {
      if (e instanceof GqlError) {
        errors.push(e);
        out[key] = null;
      } else {
        throw e;
      }
    }
  }
  return out;
}

function executeOperation(store: Store, op: GqlOperation, vars: Record<string, unknown>, doc: GqlDocument): { data: unknown; errors: { message: string }[] } {
  const errors: GqlError[] = [];
  const root: NodeObj = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const mergedVars: Record<string, unknown> = {};
  for (const vd of op.varDefs) {
    if (vars[vd.name] !== undefined) mergedVars[vd.name] = vars[vd.name];
    else if (vd.defaultValue) mergedVars[vd.name] = resolveValue(vd.defaultValue, vars);
    else mergedVars[vd.name] = null;
  }
  for (const k of Object.keys(vars)) {
    if (!(k in mergedVars)) mergedVars[k] = vars[k];
  }
  let data: unknown;
  try {
    data = executeSelections(store, root, op.selections, mergedVars, doc, errors);
  } catch (e) {
    errors.push(new GqlError(e instanceof Error ? e.message : 'internal error'));
    data = null;
  }
  if (errors.length > 0) return { data: null, errors: errors.map((e) => ({ message: e.message })) };
  return { data, errors: [] };
}

// ---------- HTTP handler ----------

export function handleGraphql(ctx: Ctx): RestResult {
  const store = ctx.store;
  if (!ctx.authed) return errResult(401, 'Requires authentication');
  if (ctx.jsonError) return errResult(400, 'Problems parsing JSON');
  const body = ctx.json;
  const ops: { query?: string; variables?: Record<string, unknown>; operationName?: string }[] = Array.isArray(body)
    ? (body as { query?: string; variables?: Record<string, unknown>; operationName?: string }[])
    : [body as { query?: string; variables?: Record<string, unknown>; operationName?: string }];
  const results: unknown[] = [];
  for (const opDoc of ops) {
    const query = typeof opDoc.query === 'string' ? opDoc.query : '';
    const vars = (opDoc.variables ?? {}) as Record<string, unknown>;
    if (!query) {
      results.push({ data: null, errors: [{ message: 'Must provide query string.' }] });
      continue;
    }
    let doc: GqlDocument;
    try {
      doc = parseGql(query);
    } catch (e) {
      results.push({ data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax Error' }] });
      continue;
    }
    const opName = opDoc.operationName;
    const op = doc.operations.find((o) => !opName || o.name === opName) ?? doc.operations[0];
    if (!op) {
      results.push({ data: null, errors: [{ message: 'Must provide an operation.' }] });
      continue;
    }
    results.push(executeOperation(store, op, vars, doc));
  }
  return jsonResult(200, Array.isArray(body) ? results : results[0]);
}
