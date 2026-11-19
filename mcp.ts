// mcp.ts — the Model Context Protocol endpoint at /mcp (JSON-RPC 2.0 over
// Streamable HTTP). The tools act on the same state as REST, so a
// repository or issue created over MCP reads back over /api/v3 as the same
// object.

import { State, type IssueRec, type PullRec } from './store.ts';
import { squashMergePull, repositoryJson, pullRequestJson, type HttpResult, type RequestContext, jsonResponse, errorResponse } from './rest.ts';

const TOOL_DEFS = [
  {
    name: 'create_repo',
    description: 'Create a new repository.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_NAME_SET = new Set(TOOL_DEFS.map((t) => t.name));

/** Match a tool name exactly, or as a suffix after a server prefix
 *  (e.g. github__create_issue), case-insensitively. */
function resolveToolName(name: string): string | null {
  if (TOOL_NAME_SET.has(name)) return name;
  const base = name.split('/').pop() ?? name;
  if (TOOL_NAME_SET.has(base)) return base;
  const lower = base.toLowerCase();
  for (const t of TOOL_NAME_SET) {
    if (lower === t || lower.endsWith('__' + t) || lower.endsWith('_' + t)) return t;
  }
  return null;
}

const ARG_ALIASES: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'owner_name'],
  repo: ['repo', 'repository', 'repo_name'],
  head: ['head', 'head_ref', 'head_branch'],
  base: ['base', 'base_ref', 'base_branch'],
  pull_number: ['pull_number', 'pr_number', 'number', 'pull_request_number'],
  name: ['name', 'repo', 'repository', 'repo_name'],
  body: ['body', 'description', 'content'],
  state: ['state', 'status'],
  title: ['title'],
  description: ['description', 'body', 'content'],
  private: ['private'],
};

function pickArg(args: Record<string, unknown>, key: string): unknown {
  for (const cand of ARG_ALIASES[key] ?? [key]) {
    if (args[cand] !== undefined && args[cand] !== null) return args[cand];
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, key: string): string {
  const v = pickArg(args, key);
  return typeof v === 'string' ? v : v === undefined ? '' : String(v);
}

function toolOk(obj: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolFail(message: string): { isError: boolean; content: { type: string; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function runTool(state: State, name: string, args: Record<string, unknown>): unknown {
  const owner = pickString(args, 'owner');
  const repositoryName = pickString(args, 'repo');
  if (name === 'create_repo') {
    const repoNameArg = pickString(args, 'name');
    if (!repoNameArg) return toolFail('missing required argument: name');
    const existing = state.findRepository(repoNameArg);
    if (existing) return toolOk(JSON.parse(repositoryJson(state, existing).toString('utf8')));
    const repository = state.addRepository(repoNameArg, pickString(args, 'description'), args.private === true);
    return toolOk(JSON.parse(repositoryJson(state, repository).toString('utf8')));
  }
  if (!owner || !repositoryName) return toolFail('missing required arguments: owner and repo');
  if (!state.viewerOwns(owner)) return toolFail('Repository not found');
  const repository = state.findRepository(repositoryName);
  if (!repository) return toolFail('Repository not found');
  if (name === 'get_repo') {
    return toolOk(JSON.parse(repositoryJson(state, repository).toString('utf8')));
  }
  if (name === 'create_issue') {
    const title = pickString(args, 'title');
    if (!title) return toolFail('missing required argument: title');
    const issueRec: IssueRec = state.addIssue(repository, title, pickString(args, 'body'), []);
    return toolOk(JSON.parse(state.issueBody(repository, issueRec).toString('utf8')));
  }
  if (name === 'list_issues') {
    const stateFilter = pickString(args, 'state') || 'open';
    const list = repository.issueList.filter((i) => stateFilter === 'all' || i.state === stateFilter);
    return toolOk(list.map((i) => JSON.parse(state.issueBody(repository, i).toString('utf8'))));
  }
  if (name === 'create_pull_request') {
    const title = pickString(args, 'title');
    const head = pickString(args, 'head');
    const base = pickString(args, 'base');
    if (!title || !head || !base) return toolFail('missing required arguments: title, head and base');
    const headSha = repository.refs.get('refs/heads/' + head);
    const baseSha = repository.refs.get('refs/heads/' + base);
    if (!headSha || !baseSha) return toolFail('head or base branch not found');
    const existing = repository.pullList.find((p) => p.head === head && p.state === 'open');
    const pullRec: PullRec = existing ?? state.addPullRequest(repository, title, pickString(args, 'body'), head, base, headSha, baseSha);
    return toolOk(pullRequestJson(state, repository, pullRec));
  }
  if (name === 'merge_pull_request') {
    const numRaw = pickArg(args, 'pull_number');
    const num = typeof numRaw === 'number' ? numRaw : parseInt(String(numRaw ?? ''), 10);
    if (!Number.isFinite(num)) return toolFail('missing required argument: pull_number');
    const pullRec = repository.pullByNumber.get(num);
    if (!pullRec) return toolFail('Pull request not found');
    const r = squashMergePull(state, repository, pullRec);
    if (!r.ok) return toolFail(r.message);
    return toolOk({ number: pullRec.number, merged: true, state: pullRec.state, sha: r.sha });
  }
  return toolFail('Unknown tool: ' + name);
}

const OLD_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcOk(id: unknown, result: unknown): HttpResult {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcFail(id: unknown, code: number, message: string): HttpResult {
  return jsonResponse(200, { jsonrpc: '2.0', id, error: { code, message } });
}

export function serveMcp(context: RequestContext): HttpResult {
  const state = context.state;
  if (!context.authed) {
    return jsonResponse(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }
  if (context.jsonError) {
    return { status: 400, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'), type: 'application/json; charset=utf-8' };
  }
  const rpcRequest = context.json as Record<string, unknown> | null;
  if (!rpcRequest || typeof rpcRequest !== 'object' || Array.isArray(rpcRequest)) {
    return { status: 400, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'), type: 'application/json; charset=utf-8' };
  }
  const id = rpcRequest.id === undefined ? null : rpcRequest.id;
  const method = typeof rpcRequest.method === 'string' ? rpcRequest.method : '';
  const params = (rpcRequest.params ?? {}) as Record<string, unknown>;
  const isNotification = rpcRequest.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  if (isNotification) {
    return { status: 202, body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    return rpcOk(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = OLD_PROTOCOL_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return rpcOk(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
  }
  if (method === 'ping') {
    return rpcOk(id, {});
  }
  if (method === 'tools/list') {
    return rpcOk(id, { tools: TOOL_DEFS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const match = resolveToolName(toolName);
    if (!match) return rpcFail(id, -32602, 'Unknown tool: ' + toolName);
    try {
      const result = runTool(state, match, args);
      return rpcOk(id, result);
    } catch (e) {
      return rpcFail(id, -32602, e instanceof Error ? e.message : 'Tool call failed');
    }
  }
  return rpcFail(id, -32601, 'Method not found: ' + method);
}
