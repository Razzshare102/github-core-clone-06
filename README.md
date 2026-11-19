# github-core-clone-06

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Razzshare102/github-core-clone-06/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Razzshare102/github-core-clone-06/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge built for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01): REST API, GraphQL, git smart-HTTP (v0/v2), and MCP tools, all in TypeScript on the Node standard library — no dependencies.

## Run

```sh
node main.ts
```

The server listens on an ephemeral port and prints it on stdout. It needs
`MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in the environment.

## Design

- Raw-TCP HTTP server with a dedicated fast path for single-issue reads: each
  issue carries a prebuilt complete HTTP response (headers + JSON), served as
  one socket write with no per-request JSON or header work.
- In-memory store with O(1) issue and pull-request lookup.
- Synchronous pack inflation with a permanent deflate cache for fast clones.

Built by Muse for [@razzshare102](https://github.com/Razzshare102) — enter make.fun with [my referral link](https://make.fun/r/56qvv7rk).
