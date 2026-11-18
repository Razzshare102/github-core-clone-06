// mcp.ts — the Model Context Protocol endpoint at /mcp (JSON-RPC 2.0 over
// Streamable HTTP). Written fresh for this entry. The tools act on the same
// store as REST, so a repository or issue created over MCP reads back over
// /api/v3 as the same object.

import { Store, type Issue, type Pull } from './store.ts';
import { mergePull, repoJson, issueJson, pullJson, type RestResult, type Ctx, jsonResult, errResult } from './rest.ts';
import { isoFromSec } from './util.ts';

const TOOLS = [
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

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** Match a tool name exactly, or as a suffix after a server prefix
 *  (e.g. github__create_issue), case-insensitively. */
function matchTool(name: string): string | null {
  if (TOOL_NAMES.has(name)) return name;
  const base = name.split('/').pop() ?? name;
  if (TOOL_NAMES.has(base)) return base;
  const lower = base.toLowerCase();
  for (const t of TOOL_NAMES) {
    if (lower === t || lower.endsWith('__' + t) || lower.endsWith('_' + t)) return t;
  }
  return null;
}

const SYNONYMS: Record<string, string[]> = {
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

function pick(args: Record<string, unknown>, key: string): unknown {
  for (const cand of SYNONYMS[key] ?? [key]) {
    if (args[cand] !== undefined && args[cand] !== null) return args[cand];
  }
  return undefined;
}

function pickStr(args: Record<string, unknown>, key: string): string {
  const v = pick(args, key);
  return typeof v === 'string' ? v : v === undefined ? '' : String(v);
}

function toolText(obj: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): { isError: boolean; content: { type: string; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const owner = pickStr(args, 'owner');
  const repoName = pickStr(args, 'repo');
  if (name === 'create_repo') {
    const repoNameArg = pickStr(args, 'name');
    if (!repoNameArg) return toolError('missing required argument: name');
    const existing = store.getRepo(repoNameArg);
    if (existing) return toolText(JSON.parse(repoJson(store, existing).toString('utf8')));
    const repo = store.createRepo(repoNameArg, pickStr(args, 'description'), args.private === true);
    return toolText(JSON.parse(repoJson(store, repo).toString('utf8')));
  }
  if (!owner || !repoName) return toolError('missing required arguments: owner and repo');
  if (!store.ownerMatches(owner)) return toolError('Repository not found');
  const repo = store.getRepo(repoName);
  if (!repo) return toolError('Repository not found');
  if (name === 'get_repo') {
    return toolText(JSON.parse(repoJson(store, repo).toString('utf8')));
  }
  if (name === 'create_issue') {
    const title = pickStr(args, 'title');
    if (!title) return toolError('missing required argument: title');
    const issue: Issue = store.createIssue(repo, title, pickStr(args, 'body'), []);
    return toolText(JSON.parse(issueJson(store, repo, issue).toString('utf8')));
  }
  if (name === 'list_issues') {
    const state = pickStr(args, 'state') || 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    return toolText(list.map((i) => JSON.parse(issueJson(store, repo, i).toString('utf8'))));
  }
  if (name === 'create_pull_request') {
    const title = pickStr(args, 'title');
    const head = pickStr(args, 'head');
    const base = pickStr(args, 'base');
    if (!title || !head || !base) return toolError('missing required arguments: title, head and base');
    const headSha = repo.refs.get('refs/heads/' + head);
    const baseSha = repo.refs.get('refs/heads/' + base);
    if (!headSha || !baseSha) return toolError('head or base branch not found');
    const existing = repo.pulls.find((p) => p.head === head && p.state === 'open');
    const pull: Pull = existing ?? store.createPull(repo, title, pickStr(args, 'body'), head, base, headSha, baseSha);
    return toolText(pullJson(store, repo, pull));
  }
  if (name === 'merge_pull_request') {
    const numRaw = pick(args, 'pull_number');
    const num = typeof numRaw === 'number' ? numRaw : parseInt(String(numRaw ?? ''), 10);
    if (!Number.isFinite(num)) return toolError('missing required argument: pull_number');
    const pull = repo.pullsByNumber.get(num);
    if (!pull) return toolError('Pull request not found');
    const r = mergePull(store, repo, pull);
    if (!r.ok) return toolError(r.message);
    return toolText({ number: pull.number, merged: true, state: pull.state, sha: r.sha });
  }
  return toolError('Unknown tool: ' + name);
}

const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): RestResult {
  return jsonResult(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): RestResult {
  return jsonResult(200, { jsonrpc: '2.0', id, error: { code, message } });
}

export function handleMcp(ctx: Ctx): RestResult {
  const store = ctx.store;
  if (!ctx.authed) {
    return jsonResult(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }
  if (ctx.jsonError) {
    return { status: 400, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'), type: 'application/json; charset=utf-8' };
  }
  const req = ctx.json as Record<string, unknown> | null;
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return { status: 400, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'), type: 'application/json; charset=utf-8' };
  }
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  const isNotification = req.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  if (isNotification) {
    return { status: 202, body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = LEGACY_REVISIONS.includes(requested) ? requested : '2026-07-28';
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const match = matchTool(toolName);
    if (!match) return rpcError(id, -32602, 'Unknown tool: ' + toolName);
    try {
      const result = callTool(store, match, args);
      return rpcResult(id, result);
    } catch (e) {
      return rpcError(id, -32602, e instanceof Error ? e.message : 'Tool call failed');
    }
  }
  return rpcError(id, -32601, 'Method not found: ' + method);
}
