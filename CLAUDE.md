# thebrain-mcp — working notes for Claude

An MCP server for TheBrain 15, built on its local API.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before making non-trivial changes: it
carries the reasoning, the measurements, and the reasons certain obvious-looking
shortcuts are forbidden. This file is the short form — the rules that bite.

## Invariants

These are not preferences. Breaking one is a bug even if the tests pass.

1. **`brainId` is explicit on every tool.** Never infer the active brain from
   `app/state`. Writing into whichever brain the user happens to have open is the
   worst failure this project can produce.
2. **Bad input is `isError: true` inside the result, never a JSON-RPC error.**
   The model sees the former and can recover; the latter is invisible to it.
   `guard()` in `src/server/respond.ts` enforces this — keep handlers inside it.
3. **Nothing irreversible without human consent**, and a failed consent request
   counts as refusal. Deletion is additionally gated behind
   `THEBRAIN_ALLOW_DESTRUCTIVE=1`.
4. **Notes are never truncated on read.** A truncated note silently corrupts the
   agent's picture of what is already recorded.
5. **After a write, address thoughts by identifier, never by name.** `findByName`
   lags creation by ~5.6 s.
6. **No LLM calls inside the server.** Judgement belongs to the calling agent,
   which can see the conversation. The server stays deterministic and testable.
7. **The server holds no methodology.** Heuristics about how to decompose
   material belong in `skills/*/SKILL.md`, not in code.

## Layout

```
src/api/          HTTP client, error normalisation, typed resource calls
src/semantic/     vector store, embedder, indexer, search, document builder
src/operations/   ingest (plan → topological write), traverse (BFS)
src/server/       tool definitions, schemas, formatting, confirmation
skills/           methodology as markdown, installed into ~/.claude/skills
test/             unit + contract tests, never shipped
```

Dependencies point one way: `server` → `operations` → {`semantic`, `api`}.

## API gotchas that keep biting

Full catalogue in [`docs/api-map.md`](docs/api-map.md). The ones that produce
silent wrong behaviour rather than a loud failure:

- **A malformed UUID returns HTTP 200 with an HTML page.** Validate before the
  request; sniff the body after.
- **`/types` and `/tags` return 400 when empty.** Wrap in `emptyOn400()`.
- **`notes/append` on a thought with no note is a silent no-op.** Read first.
- **A thought's type also appears in `parents`.** Filter it in traversal.
- **Markdown round-trip eats the closing ` ``` `.** Warn; suggest indented code.
- **Tags attach via `POST /api/links` with `relation: 2` against a `kind=4`
  thought.** The server rewrites it to `relation=1, meaning=5`.
- **Search is prefix-based.** This is why `src/semantic/` exists.

## Semantic layer

`@huggingface/transformers` is an **optional peer dependency** — 380 MB installed
plus a 113 MB model. Without it, search degrades to a lexical fan-out over
agent-supplied variants and reports why. Do not make it required, and do not let
its absence throw.

Two constraints to respect in any new code:

- **Top-k only, never absolute similarity thresholds.** e5 scores sit in
  0.74–0.92, and correct-versus-wrong can differ by 0.001.
- **Changing the model or dtype invalidates the index.** Check compatibility
  explicitly rather than silently ranking against stale vectors.

## Tests

```
npm test                                                     # unit only
THEBRAIN_API_KEY=… npm test                                  # + read-only contract
THEBRAIN_API_KEY=… THEBRAIN_TEST_BRAIN_ID=<uuid> npm test    # + write contract
```

Write tests demand an explicit throwaway brain and refuse any brain over 500
thoughts. Suites skip cleanly when the variables are absent.

When a claim about the API goes into a document, it should have a test behind it.
Two documented claims in this project's history turned out to be wrong precisely
because they were asserted rather than measured.

## Local development

The API key lives in TheBrain under Settings → User → Local API Key. Pass it
through the environment; never commit it.

```
http://localhost:8001/api/v1/docs.json   # OpenAPI
http://localhost:8001/api/index.html     # Swagger UI
```
