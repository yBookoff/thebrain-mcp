# Architecture and operating principles

This document explains how `thebrain-mcp` is put together and, more importantly,
*why*. It is written for someone who wants to extend the server, port the idea to
another knowledge base, or argue with a decision.

The short version: the server is a **mechanism** — deterministic, testable
operations over TheBrain. The **policy** — how to break material into meanings,
when to reuse an existing thought, what belongs in a note — lives outside it, in
editable markdown skills. Everything below follows from that split.

---

## 1. What this server is for

TheBrain 15 ships a local HTTP API with 48 endpoints. Mirroring it as 48 tools
would be easy and nearly useless: the agent would spend its turns on plumbing —
create thought, read it back, create link, create link, set note — and the human
would get a pile of disconnected nodes.

The goal is different. The brain should work as **an extension of the agent's
context and a knowledge base that the human can see**. Hand the agent an article,
and it should read it, decompose it into meanings, work out where those meanings
belong in the graph that already exists, which existing thoughts to connect to,
which tags apply, and what each note should say.

That requires two things the raw API does not provide:

- **Search by meaning.** TheBrain's search is prefix-based. `OT` finds `OTGP`; a
  synonym or a typo finds nothing. An agent cannot avoid duplicates with a search
  that only matches prefixes.
- **Writes that are whole thoughts, not keystrokes.** A fifteen-thought
  decomposition must land in one call — atomic in intent, validated before the
  first write, and idempotent on re-run.

So: 17 tools instead of 48 endpoints, plus a local vector index, plus a batch
ingest operation.

---

## 2. Layers

```
                 MCP client (Claude Code, Claude Desktop, …)
                                  │  stdio, JSON-RPC
  ┌───────────────────────────────┴────────────────────────────────┐
  │  src/server/          tool definitions, schemas, formatting     │
  │    tools/{read,write,ingest}.ts   respond.ts   confirm.ts       │
  │    context.ts — shared client, embedder, per-brain indexes      │
  ├─────────────────────────────────────────────────────────────────┤
  │  src/operations/      multi-step semantic operations            │
  │    ingest.ts (plan → topological write)   traverse.ts (BFS)     │
  ├──────────────────────────────┬──────────────────────────────────┤
  │  src/semantic/               │  src/api/                        │
  │    store, embedder,          │    client (HTTP, errors),        │
  │    indexer, search, document │    resources/* (typed calls)     │
  └──────────────────────────────┴──────────────────────────────────┘
              node:sqlite                  TheBrain local API
        (+ optional transformers)          http://localhost:8001
```

The dependency rule is one-directional: `server` → `operations` → {`semantic`,
`api`}. Nothing below the server layer imports from the server, and nothing in
`api/` knows that MCP exists. That is what makes the lower layers testable
without a protocol harness.

### `src/api/` — the HTTP layer

Its whole job is to turn a hostile HTTP surface into typed calls that either
return data or throw a `TheBrainError` with a machine-readable `kind`
(`auth | forbidden | not_found | bad_request | server | route_miss |
invalid_uuid | network | malformed`).

"Hostile" is not an exaggeration — see §7 for the catalogue. The two defences
that matter most:

- **UUIDs are validated before the request.** A malformed UUID in the path makes
  the API return **HTTP 200 with a Blazor HTML page**. A client that trusts the
  status code will parse an error page as success.
- **The response body decides, not the declared content-type.** The layer sniffs
  for HTML even on 200, and parses JSON regardless of what the header claims.

`emptyOn400()` wraps the endpoints that answer 400 when a collection is empty
(`/types`, `/tags`) — an API quirk, not a caller error.

### `src/semantic/` — meaning-based retrieval

Five modules, each with one job:

| Module | Job |
|---|---|
| `store.ts` | `node:sqlite`, vectors as BLOBs, brute-force cosine. Lazy in-memory cache. Also holds index metadata (brain, model, dimensions, sync watermark) |
| `document.ts` | Builds the text that gets embedded: name, label, type, tags, first 1500 characters of the note. Hashes it so unchanged thoughts are skipped |
| `embedder.ts` | Dynamic import of the optional embeddings package; `EmbedderUnavailableError` carries install instructions |
| `indexer.ts` | Full rebuild and incremental sync |
| `search.ts` | Vector search, with lexical fan-out as the degraded mode |

### `src/operations/` — where multi-step behaviour lives

`ingest.ts` and `traverse.ts` are the two operations complex enough to deserve
their own module, their own tests, and no knowledge of MCP. If a third one
appears — merging duplicates, say — it belongs here, not in a tool handler.

### `src/server/` — the protocol edge

Tool definitions, Zod schemas, and output formatting. Handlers are thin: parse,
delegate, format. The interesting code in this layer is `respond.ts` (§5) and
`confirm.ts` (§6).

---

## 3. Mechanism and policy

This is the load-bearing decision of the project.

**The server contains no heuristics.** It does not decide how finely to split an
article, which thought is "close enough" to reuse, or what a note should say.
Given the same inputs it produces the same writes, which is exactly what makes it
testable end to end.

**The skills carry the methodology.** Four markdown files —
`thebrain-ingest`, `thebrain-research`, `thebrain-organize`, `thebrain-digest` —
say when to search before creating, how to name a thought so that future material
attaches to it, why concepts should hang off topical parents rather than off the
article, what makes a link label useful.

Why skills rather than MCP Prompts:

1. **Progressive disclosure.** A skill's body loads only when the task matches;
   it does not sit in context permanently.
2. **Editable without a release.** Users have their own ontologies. Adjusting
   methodology should not require republishing an npm package.
3. **The two halves come apart.** You can take the server and bring your own
   methodology, or keep the skills and point them at a different backend.

MCP Prompts remain the fallback for clients that do not support skills.

### The server never calls an LLM

Two reasons, and the second is the real one:

- It would need its own API key and its own billing.
- **An in-process model cannot see the conversation.** The calling agent already
  has the article, the user's phrasing, and the history of the session in
  context. Any judgement made inside the server would be made on strictly less
  information.

MCP *sampling* — the server asking the client to run inference — would have
solved the key problem but not the context problem, and it is **deprecated as of
protocol version `2026-07-28`**, slated for removal. `roots` is deprecated too.
**Elicitation is alive**, and deletion confirmation is built on it (§6).

So the agent thinks, and the server's job is to make that thinking *informed*
(reads return a map of the neighbourhood, not a flat list) and *cheap to act on*
(one call writes the whole graph).

---

## 4. Tool design

Seventeen tools. Measured against the published build: the descriptions total
about 1050 tokens, and the full `tools/list` payload including schemas about
3900.

**One tool per intent, not per endpoint.** `brain_get_thought` returns the
thought, its graph neighbourhood, and its note — three endpoints, one call,
because "look at this thought" is one intention. `brain_tag` both attaches and
detaches, because "manage the tags on this thought" is one intention.

**Descriptions say *when* to call, not just what the tool does.** Tool routing is
the model reading descriptions and choosing; a description that only states
mechanics leaves the choice underdetermined.

**`brainId` is required everywhere and never inferred.** The API can report the
currently open brain, and using it would be convenient. It is also the single
worst failure mode available: the user switches to a work brain in the desktop
app, and the agent writes there. Every tool takes an explicit `brainId`;
`brain_list` is how the agent learns which brains exist and which one is open.

**Notes are never truncated on read.** A truncated note silently corrupts the
agent's understanding of what is already recorded. If a note is long, it is long.

**Output is formatted tables and sections, not raw JSON.** Cheaper in tokens and
easier for a model to read. `respond.ts` has the primitives (`table`, `bullet`,
`section`, `join`); empty sections are dropped so the model never has to skim
past "Tags: (empty)".

### `brain_ingest` — the tool the product is built around

Input is a plan: thoughts with `tempId`s that reference each other and existing
UUIDs interchangeably, plus links between them.

```json
{
  "brainId": "…",
  "thoughts": [
    { "tempId": "art",   "name": "Article on RAG", "parent": "<uuid of an existing thought>" },
    { "tempId": "embed", "name": "Embeddings", "parent": "art", "note": "…" },
    { "tempId": "store", "name": "Vector store", "parent": "art" }
  ],
  "links": [{ "from": "embed", "to": "store", "name": "is written into" }]
}
```

Four properties, each of which took a bug to get right:

- **Order-independent.** `planLevels()` topologically sorts by parent reference,
  so the input can be in any order.
- **Validated before the first write.** Cycles, dangling references, empty names
  and duplicate `tempId`s are rejected up front. A plan either starts writing or
  does not — no half-written graph from a mistake that was visible in advance.
- **Idempotent.** Re-running the same plan reuses existing thoughts instead of
  duplicating them. Dedup is by `(parentId, trimmed name)`, and an **in-flight
  promise registry** makes it hold *within* one batch: two identical names in the
  same level resolve to one thought rather than racing each other into two. (This
  was a real bug, caught by a unit test.)
- **Honest about what it did not do.** If a requested jump is between a thought
  and its own parent, the API silently renames the existing hierarchy link
  instead of creating a jump. The report carries a "Links that already existed"
  section with the mismatch spelled out, rather than counting it as created.

---

## 5. Error philosophy

The rule that governs the whole server:

> A bad argument or a missing resource is `isError: true` **inside the result**,
> never a JSON-RPC error.

The distinction is not cosmetic. A result with `isError` is delivered to the
model, which can read it and fix its call. A JSON-RPC error is a protocol-level
failure the model never sees — from its point of view the tool simply stopped
existing. Getting this backwards turns a recoverable typo into a dead turn.

`guard()` in `respond.ts` wraps every handler so that no exception can escape as
a protocol error.

**Error text names the next step.** "No such thought" is a fact; it does not help.
Compare:

```
thoughtId must be a UUID, got "not-a-uuid".
Take identifiers from brain_list, brain_search or brain_get_thought — do not invent them.
```

`describeError()` maps each `TheBrainError.kind` to that kind of message: an
`auth` failure points at Settings → User → Local API Key; a `network` failure
points at the desktop app not running.

**Degradation is reported, not hidden.** When semantic search falls back to the
lexical fan-out, the outcome carries `degradedReason` and the tool prints it. An
agent that does not know recall dropped will trust an empty result.

---

## 6. Deletion: two independent safeties

Deletion is implemented — refusing to implement it would just push users to do it
by hand, less carefully. It is guarded twice:

1. **Off unless `THEBRAIN_ALLOW_DESTRUCTIVE=1`.** A default install cannot delete
   anything, whatever the agent decides.
2. **A human must consent, per deletion.** The preferred path is **elicitation**:
   the server asks the client to show a confirmation form. For clients without
   it, the tool returns a summary of the consequences and requires a second call
   carrying `confirm=true`, with instructions to ask the human first.

**An elicitation failure counts as refusal.** If the client advertised the
capability and then threw, the server does not delete. The agent is never the
last authority on an irreversible action.

---

## 7. What the TheBrain API actually does

Findings from reading the spec and then testing every one of them against a live
instance. Full detail in [`docs/api-map.md`](docs/api-map.md).

1. **`/types` and `/tags` return 400 when the list is empty.** Treat as `[]`.
2. **A malformed UUID in the path returns HTTP 200 with an HTML page.** Validate
   before the request; sniff the body after.
3. **Five different error shapes** — bare JSON string, plain text,
   ProblemDetails, HTML, and an empty body. Normalised in the HTTP layer.
4. **`notes/append` on a thought with no note is a silent no-op.** Read first,
   then write.
5. **Markdown round-trip loses the closing ` ``` `**, swallowing the rest of the
   note into the code block. The server warns; the skills tell agents to indent
   code by four spaces instead.
6. **JSON Patch is not exposed.** Tools take flat fields and build the patch.
7. **Writes are not immediately visible** — see the table below.
8. **`SearchResultDto.brainId` comes back as zeros.** Use `sourceThought.brainId`.
9. **A thought's type appears both as `type` and as a parent** in `/graph`
   responses. Filter it, or types pollute every traversal.
10. **A note is an attachment.** It shows up in `graph.attachments` with
    `isNotes: true`, and its log events are keyed by that attachment rather than
    by the thought.
11. **Search is prefix-based, not semantic.** This is the entire reason for §8.

### Write visibility

Measured against a live API by polling until the result appeared:

| Operation | Delay |
|---|---|
| `create` → `get(id)` | instant |
| `rename` → `get(id)` | ~0.1 s |
| `set note` → `get note` | ~0.2 s |
| `attachTag` → `graph.tags` | ~0.1–0.5 s |
| **`create` → `findByName`** | **~5.6 s** |
| `create` → full-text search | up to 15 s (per the vendor docs) |

**The rule that falls out: after a write, address thoughts by identifier, never
by name.** `brain_ingest` links newly created thoughts through returned UUIDs
precisely because name resolution inside a batch would reliably miss.

> An earlier version of this project's notes claimed `nameExact` bypassed the
> index and returned instantly. A contract test measured 5.6 seconds. Faster than
> full-text, not instant.

### Tags: undocumented, but they work

A link's `meaning` field is the discriminator: **1** ordinary, **2** type,
**5** tag. It is read-only — `PATCH /meaning` returns 200 and silently ignores
you, `PATCH /kind` returns 400. The server sets it, inferring from the `kind` of
the target thought.

| Operation | How |
|---|---|
| Create a tag | `POST /api/thoughts` with `kind: 4` |
| Attach | `POST /api/links`, `thoughtIdA` = thought, `thoughtIdB` = tag, **`relation: 2`**. The server rewrites it to `relation=1, meaning=5` |
| Detach | `DELETE /api/links/{brainId}/{linkId}` |
| Read | `graph.tags` — a tag does **not** pollute `parents` |
| List | `GET /api/thoughts/{brainId}/tags` (400 if empty, see #1) |

`relation: 2` against an ordinary thought (`kind=1`) produces an ordinary parent.
It is the target's `kind=4` that flips the behaviour.

`statistics.links` does not count tags — links with `meaning=5` are excluded.

### Enumerating all thoughts

There is no "list all thoughts" endpoint. The workaround:
`/api/brains/{id}/modifications` with no date range returns the full history, and
`modType 101` (created) minus `modType 102` (deleted) reconstructs the current
population.

Cross-checked against an independent source: the log gave 43 live thoughts, 38
with `kind=1` and 5 with `kind=2`; `statistics.thoughts` = 38,
`statistics.thoughtTypes` = 5. Exact match. This check runs as an integration
test, so drift will be caught.

Caveat: log completeness has not been verified for imported or synced brains.

---

## 8. The semantic layer

### Why it exists

TheBrain's search matches prefixes. `OT` finds `OTGP`; the typo `OTPG` and the
synonym `project` find nothing. An agent trying not to create duplicates needs to
find a thought it can only describe, not spell.

### Why the embeddings package is optional

`@huggingface/transformers` costs **380 MB** installed — `onnxruntime-node`
(210 MB) and `onnxruntime-web` (130 MB) are both hard dependencies and cannot be
pruned — and downloads a **113 MB** model on first run. That is an unreasonable
default for a tool whose audience is largely not developers.

It is therefore declared in `peerDependenciesMeta` as optional. The published
package itself is under 0.3 MB, and a clean consumer install with all runtime
dependencies measures **23 MB** — verified with `npm pack` followed by an install
into an empty project, which also confirmed that transformers is not pulled in. `embedder.ts` imports it through a variable specifier so the
TypeScript compiler does not demand its types:

```ts
const TRANSFORMERS = "@huggingface/transformers";
async function loadTransformers(): Promise<TransformersModule> {
  return (await import(TRANSFORMERS)) as TransformersModule;
}
```

### Degradation, not a switch

Without the package, semantic search does not turn off — it **degrades to a
lexical fan-out**. The agent supplies the concept together with synonyms,
translations, broader and narrower terms; the server runs all of them through
TheBrain's own search and merges the results. A thought found by several
phrasings ranks above one found by a single phrasing.

This works better than it sounds, because vector search is not perfect either
(see the ceiling below) and the skills already train agents to supply variants.
The reason for degradation is returned in the result so the tool can show it.

### Storage

`node:sqlite` (Node 22+), vectors as BLOBs, brute-force cosine scan. No vector
index, no native dependency, no extension to compile.

Measured: **20,000 vectors × 384 dimensions scans in under 200 ms** — a test
enforces it. Real brains are far smaller than that. An ANN index would add build
complexity and a dependency to save time nobody is spending.

### Quantization: q8

`multilingual-e5-small` through transformers.js. Benchmarked over 48 thoughts and
20 queries with mixed-language content:

| dtype | top-1 | top-3 | model size |
|---|---|---|---|
| fp32 | 15/20 (75%) | 18/20 (90%) | 448 MB |
| **q8** | **16/20 (80%)** | 17/20 (85%) | **113 MB** |
| q4 | 15/20 (75%) | 17/20 (85%) | ~60 MB |

The differences are inside the noise, so q8 wins on size: a quarter of fp32 for
the same quality.

> An earlier conclusion in this project said q8 broke ranking. It was based on
> four queries and did not survive a proper set. The lesson, recorded because it
> generalises: do not characterise a model from a handful of examples.

### Two limits to design around

**Absolute similarity thresholds are unusable — top-k only.** e5 has a high
similarity floor: the observed range is 0.74–0.92, and the gap between a correct
and an incorrect answer can be 0.001. Any code that filters on "score > 0.8" will
be wrong in both directions.

**The quality ceiling is 75–80% top-1, and the misses are substantive.** "a
three-dimensional game engine" does not retrieve Unity; "how to write queries for
a language model" does not retrieve prompt engineering. This is *why the
architecture puts judgement in the agent*: vectors produce candidates, and the
agent — which handles those two cases trivially — decides.

Including the thought's label, type, tags and note excerpt in the embedded
document fixes exactly those two benchmark failures (Unity 0.863, prompt
engineering 0.904), which is why `document.ts` embeds more than the name.

### Indexing is an explicit tool call

Not something that happens on server start. A 10,000-thought brain takes about a
minute, and the user should know why their client is busy.

Enumeration goes through the modification log. Data is collected via `graph`,
which returns the thought, its type, its tags and its attachments in one request.
**A note is fetched only when that graph reports an attachment flagged
`isNotes`** — so the extra request is spent exactly on the thoughts that have a
note, and never on the ones that do not.

> The first version of this decided which notes to fetch from the modification
> log, looking for `801`/`802`/`803` events. That was wrong in a way that
> produced no error at all. A note is stored as a `Notes.md` attachment, so its
> log entry names the attachment in `sourceId` (`sourceType` 4) and the thought
> only in `extraA`. The filter `sourceType !== 2` therefore discarded every note
> event, no note was ever read, and every vector was built from name, type and
> tags alone. Because the document never changed, its hash never changed either,
> and each rebuild honestly reported "no changes" — a silent failure of the one
> feature the semantic layer exists for. Found by using the product, not by the
> tests: the benchmark that validated `buildDocument` fed it notes directly, so
> it exercised the formula while the pipeline that fills it stayed broken.
>
> Two things changed as a result. Note detection now comes from the graph, which
> cannot go stale the way a log window can. And the document format carries a
> version (`DOCUMENT_FORMAT` in `document.ts`) that is folded into the model
> identifier stored with the index, so that changing what goes into a vector
> invalidates existing indexes instead of leaving them ranked against vectors
> built to older rules.

Incremental sync takes its watermark at the moment the run starts. A small
overlap is harmless: unchanged documents are skipped by content hash. Mapping a
log entry to its thought goes through `logThoughtId()`, which reads `sourceId`
for ordinary events and `extraAId` for note events — otherwise an edit that
touches only a note leaves the thought unmarked and its vector stale.

Measured on a live 45-thought brain: first index 1.5 s, second run 0.1 s
(everything skipped by hash), empty sync 0.1 s.

Changing the model or the dtype changes `Embedder.id`, which makes the existing
index incompatible. This is checked explicitly and reported, rather than silently
producing garbage rankings.

---

## 9. Stack

**TypeScript with `@modelcontextprotocol/sdk`**, evaluated against Python on the
five axes that were actually asked for — available MCP functionality, runtime
speed, extensibility, testability, and distribution. Full analysis with
measurements in [`docs/stack-evaluation.md`](docs/stack-evaluation.md).

The deciding factors: **100 ms cold start against Python's 580 ms** — a stdio
server starts once per client session, so this is felt on every session — Node
already shipping inside Claude Desktop, and the MCPB packaging documentation
recommending Node over Python specifically to lower the install barrier.
TheBrain's audience is largely not developers, so the cost of installing a
runtime dominates.

**The SDK is not there for the protocol.** A working MCP server is 45 lines of
dependency-free code, and an official client connects to it — that was tested.
The SDK earns its place through schema validation and correct error semantics:
the `isError`-versus-JSON-RPC distinction in §5 is easy to get wrong by hand, and
getting it wrong is invisible until an agent starts failing silently.

**Transport is stdio.** No port to claim, no auth to build, lifecycle owned by
the client. An HTTP transport is worth adding only if the server ever needs to
run off-machine.

**One server for every client, with Claude Code as the target.** Claude Desktop,
Cursor, Zed and VS Code all speak the same stdio server; there are no per-client
builds. Where a capability exists in both Code and Desktop it is used; where it
exists only in Code it is used anyway, and Desktop degrades.

---

## 10. Testing

Three levels, all under `test/`, none shipped to users (`files: ["dist"]` plus a
`tsconfig.build.json` that compiles only `src/**`).

| Level | Requires | Covers |
|---|---|---|
| Unit | nothing | Error normalisation, response parsing, vector arithmetic and storage, ingest planning, degradation logic |
| Read-only contract | `THEBRAIN_API_KEY` | That the live API still behaves as documented in §7 |
| Write contract | `THEBRAIN_API_KEY` + `THEBRAIN_TEST_BRAIN_ID` | Create/update/link/tag/note round-trips against a real brain |

Without the environment variables the corresponding suites skip, so `npm test` is
green in a clean checkout and in CI.

**Write tests demand an explicit brain.** `THEBRAIN_TEST_BRAIN_ID` is required and
is never inferred from `app/state` — the same mistake the tools guard against, and
one this project actually made once. A second safety refuses any brain with more
than 500 thoughts. Test thoughts are prefixed `zz-it-`; `afterAll` removes both
this run's and leftovers from previous crashed runs.

Two testing habits worth stating, because both caught real bugs:

- **Fakes must lie no more than necessary.** The ingest test's fake API did not
  create parent links the way the real one does. Making it faithful immediately
  broke three assertions that were indexing `links[0]` — and those assertions
  were the ones that were wrong.
- **Measure before documenting.** Both corrections in this document — the
  `nameExact` latency and the q8 ranking claim — came from tests written against
  a claim that had been asserted rather than checked.

---

## 11. Extending it

**Adding a tool.** Define it in `src/server/tools/{read,write}.ts` with a Zod
schema, wrap the handler in `guard()`, and format output with the `respond.ts`
primitives. If the handler grows past parse-delegate-format, the logic belongs in
`src/operations/`.

**Adding an API call.** It goes in `src/api/resources/`, returns typed data or
throws `TheBrainError`, and gets a contract test if it touches an endpoint whose
behaviour is not obvious from the spec — which, on this API, is most of them.

**Changing the methodology.** Edit `skills/*/SKILL.md`. No rebuild, no release.
The frontmatter `description` drives routing, so it matters as much as the body.

**Swapping the embedding model.** Set `THEBRAIN_EMBEDDING_MODEL`. The index will
be reported as incompatible and will need a rebuild — by design.

Two invariants to preserve in anything added:

1. **`brainId` is always explicit.** Never infer the active brain.
2. **Nothing irreversible happens without human consent** — and a failure to
   obtain consent means no.
