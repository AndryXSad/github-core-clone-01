# github-core-clone-01 — a GitHub-compatible git forge

A single-process GitHub-compatible forge written for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01), in TypeScript on
Node 22 using only the standard library. There are no dependencies to install,
no `git` binary at run time, and no network calls outside the harness env: the
whole forge — git smart HTTP, the REST v3 API, GraphQL v4, and an MCP endpoint —
is implemented from scratch in `app.ts`, and `main.ts` only handles the
entry-to-env lifecycle the harness drives.

What the server does:

- **git smart HTTP** (`/<owner>/<repo>.git/...`): `info/refs` (protocol v2
  advertisement, plus the v0 fallback), `git-upload-pack` (protocol v2 fetch
  with `ls-refs`, shallow/deepen, ack negotiation and pack generation, plus
  the v0 path) and `git-receive-pack` (protocol v0 push, including fast-forward
  checks and branch deletes). Packfiles, pkt-lines and side-band progress are
  built by hand; a real `git` client can clone, fetch and push against it.
- **REST v3** (`/api/v3/...`): repositories, branches, commits, contents,
  issues, comments, labels, pull requests, files and merges, with GitHub-style
  pagination (`Link` headers) and the JSON API root.
- **GraphQL v4** (`POST /api/graphql`): a hand-written parser, executor and
  introspection schema covering the documents `gh` and `github-mcp-server`
  send, including mutations.
- **MCP** (`POST /mcp`): Model Context Protocol over streamable HTTP —
  `initialize`, `tools/list` and `tools/call` for the six canonical tools.
- **Deterministic state**: the store exports byte-for-byte identical state on
  replay, so a grading run can be reproduced exactly.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own; the flag is harmless there and makes an older
local Node work too. There is nothing to install: the program imports
`node:http` and its own `app.ts` only, and the trial has no package manager
and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one;
   read it with `server.address().port`. Never bind 8080: that is the env's
   port, and on the one-pod layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with
   `{"port": <the port you bound>}`, as JSON. The env records the address the
   request came from plus that port as your base URL and dials it from then on.
   The first register wins: a later one is answered `409` and does not move
   the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with
   `{"done":false}` while the suite runs and `{"done":true}` once its export
   is written. Poll it with a short backoff; never hold a request open, and
   never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness
   stops the env afterwards, and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff (250 ms,
doubling, capped at 2.000 ms; each request times out after 30.000 ms). If
`MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts` exits 1
at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
(the same token is in your environment); `/healthz` is the boot probe and
takes none. Whether a missing or a wrong token is refused is part of the
protocol checks.

The score is `feature + agent + perf` (0..1000): the conformance checks over
that surface, the MCP checks again as the agent-native column, and four timed
workloads. The version of the suite the trial runs is in the kit under
`program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest
page: **https://make.fun/bounty/github-core-clone-01** (its Rules section). In
short: Node 22 only, no dependencies at run time, no internet and no `git`
binary in the trial; your repository is mounted read-only at `/bot` and you may
write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service you
answer; the model gateway, if your entry calls a model, is the only other
endpoint it can reach. The trial's CPU, memory and process limits are the
rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the entry lifecycle above — bind, register, wait for done, exit.
- `app.ts`: the whole forge. This is where the implementation lives.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Local grading

With the official kit, from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

Practice trial 0 grades 958/1.000 (feature 600/600 — all 120 conformance
checks — agent 200/200, perf 158/200), stable across repeated runs, with the
state hash identical on every run. The entry was also exercised end to end with
a real `git` client: clone, shallow clone with deepen, incremental fetch,
fetch with nothing new, non-fast-forward push rejected, and branch delete.

This entry is MIT licensed; a submitted entry must carry an OSI-approved
licence of its own.
