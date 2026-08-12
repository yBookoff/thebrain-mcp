# Contributing

Thanks for taking a look. This document covers how to get set up, what the code
expects of a change, and which decisions are settled.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first for anything beyond a typo fix —
it explains why the server is shaped the way it is, and several tempting
shortcuts are forbidden for reasons that are not visible from the code alone.

## Setup

```
npm install
npm test          # unit tests, no TheBrain needed
npm run typecheck
npm run build
```

Node 22 or newer — the vector store uses `node:sqlite`.

## Running against a live TheBrain

Get an API key from the desktop app: **Settings → User → Local API Key**. Pass it
through the environment; it must never appear in the repository.

```
THEBRAIN_API_KEY=… npm test                                  # + read-only contract tests
THEBRAIN_API_KEY=… THEBRAIN_TEST_BRAIN_ID=<uuid> npm test    # + write contract tests
```

**The write tests need a separate, throwaway brain.** `THEBRAIN_TEST_BRAIN_ID` is
required and is never inferred, and the suite refuses any brain holding more than
500 thoughts. Test thoughts are prefixed `zz-it-` and cleaned up afterwards,
including leftovers from earlier crashed runs.

## What a change is expected to carry

- **Tests.** Unit tests for logic; a contract test if you touch an endpoint whose
  behaviour is not obvious from the spec — which, on this API, is most of them.
- **Measurements instead of assertions.** If you document a claim about the API
  or the model, measure it. Two claims in this project's history — `nameExact`
  latency and q8 ranking quality — were confidently wrong until someone ran the
  numbers. Both corrections are recorded in `ARCHITECTURE.md` rather than quietly
  edited away.
- **English, everywhere.** Code, comments, tests, docs, skills, commit messages.
- **Comments that explain why.** The code says what it does. Comments are for the
  API quirk, the measurement, or the bug that shaped a line.

## Invariants

A change that breaks one of these is a bug, even with green tests:

1. **`brainId` is explicit on every tool.** Never infer the active brain.
2. **Bad input is `isError: true` in the result, never a JSON-RPC error.**
3. **Nothing irreversible without human consent**; a failed consent request means
   no.
4. **Notes are never truncated on read.**
5. **After a write, address thoughts by identifier, never by name.**
6. **No LLM calls inside the server.**
7. **No methodology in code** — that belongs in `skills/*/SKILL.md`.

## Where things go

| Change | Location |
|---|---|
| A new tool | `src/server/tools/{read,write}.ts` — Zod schema, `guard()`ed handler, `respond.ts` formatting |
| Logic bigger than parse-delegate-format | `src/operations/` |
| A new API call | `src/api/resources/` — typed, throws `TheBrainError` |
| Methodology, prompting, guidance | `skills/*/SKILL.md` — no rebuild required |

Dependencies flow one way: `server` → `operations` → {`semantic`, `api`}. Nothing
below the server layer may import from it.

## Tool descriptions

Tool descriptions are how the model decides what to call, so they are part of the
interface, not documentation. Write them to say **when** to reach for the tool,
not only what it does. Keep them tight — the seventeen descriptions together run
about 1050 tokens, and the whole `tools/list` payload with schemas about 3900.
That budget is spent on every request.

The same applies to a skill's frontmatter `description`: it drives routing.

## Settled decisions

Reopen these only with new evidence, not new preference:

- **TypeScript** over Python — [`docs/stack-evaluation.md`](docs/stack-evaluation.md).
- **stdio transport.** HTTP only if the server ever needs to run off-machine.
- **Embeddings are an optional peer dependency.** 380 MB is not a default.
- **Semantic tools, not an API mirror.** 17 tools, not 48.
- **Claude Code is the priority client.** Claude Desktop is supported on a
  best-effort basis; a capability that exists only in Code is still fair game.

## Releasing

Publishing is automated and tag-driven. From a clean `main`:

```
npm version patch    # or minor / major — writes package.json, commits, tags
git push --follow-tags
```

The tag push runs `.github/workflows/publish.yml`, which refuses to publish if
the tag and `package.json` disagree, then typechecks, tests, builds, publishes to
npm, and finally registers the release with the official MCP Registry.

`server.json` is the registry's metadata: it carries the version twice, and both
copies must match what reached npm. `npm version` keeps them in step through its
`version` lifecycle hook (`scripts/sync-server-json.mjs`), and the workflow
re-checks with `--check` so a hand-edited mismatch cannot slip through. That
script also refuses to run if the identities drift apart — `mcpName` in
`package.json` must equal `name` in `server.json`, and the npm entry's
`identifier` must equal the package name.

There are **no publishing secrets in this repository at all**. Both npm and the
MCP Registry authenticate over OIDC: GitHub Actions proves its identity, each
issues a token valid for that single run, and npm produces a provenance
attestation automatically. Nothing to rotate, nothing to leak, and no OTP prompt.

The package name (`thebrain-mcp-server`) differs from the repository name
(`thebrain-mcp`) because npm considers the shorter name too close to an
unrelated existing package.

## Reporting a bug in the TheBrain API

If you find behaviour that contradicts the spec, add it to the live-observations
table in [`docs/api-map.md`](docs/api-map.md) with the observation and its
consequence for the server, and add a contract test that pins the behaviour. That
table is the reason this server survives contact with the real API.
