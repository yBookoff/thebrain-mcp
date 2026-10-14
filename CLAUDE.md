# thebrain-mcp — working notes for Claude

An MCP server for TheBrain 15, built on its local API.

[`ARCHITECTURE.md`](ARCHITECTURE.md) carries the reasoning and the shortcuts
that are forbidden; [`docs/api-map.md`](docs/api-map.md) carries what the API
does, with the measurements (rows `L1`…). Read the first before a non-trivial
change. This file is the short form — the rules that bite.

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

## What it is built for

One agent; tool calls one after another, a few per message; `brain_ingest`
plans of up to about 200 thoughts; the user possibly editing in the app
meanwhile. Design for that, not for bursts of concurrent writes: what TheBrain
does under those is in `docs/api-map.md`, and nothing in the code guards it.

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

## API gotchas

Only those that produce silent wrong behaviour; why each is handled as it is
stands in ARCHITECTURE.md §4 and §7.

### Identifiers and failures
- **A malformed UUID in the path is a 200 with an HTML page, and a create takes
  the all-zero UUID for "none given".** `assertUuid()` refuses both before any
  request; zeros in an *answer* are `zero_id` (`createdId()`).
- **Identifiers come back in lower case**: a tool takes each through
  `identifier()` or `identifierOrNull()`, never a bare `z.string()`.
- **The status does not say which identifier was wrong.** A `brainId` that is
  no brain is a 401 (`unknown_brain`, not `auth`). A thought nobody has is a 404
  to its read, the catch-all 403 to its graph, a 200 to a `DELETE` or a note
  write. Only the read's 404 means "no such thought" (`requireType()`,
  `requireTag()`, `requireParent()`); `describeError()` keeps the API's words.
- **A failed read is not "nothing there".** Never `.catch(() => "")` or the
  like: keep the failure (`kept()` in `tools/read.ts`), fail the call when the
  read guards a write that erases, and name what was not read otherwise.
- **A write with no answer may have landed** (`mayHaveLanded()`): say so, never
  "failed". A tool that writes more than once runs its later writes through
  `inOrder()` and reports a partial result with `writtenInPart()`.

### Names and marks
- **White space is Unicode's `White_Space`, not what `trim()` drops.** A name
  of it alone is a 400 to a create and a rename that does nothing; a name is
  stored with tabs and line feeds as spaces, its ends trimmed, cut past 1,024
  UTF-16 units. Check with `nameRefusal()`; compare through
  `thoughtNameAsStored()` and `linkNameAsStored()`.
- **A name that does not show is stored, not refused**: print it through
  `shownName()`. A read result marks a thought that is not ordinary
  (`kindMark()`) and prints a label only where it is not the name (`labelOf()`).

### Types, tags and links
- **`typeId`, a tag's attach and a parent link take any thought, with a 200**:
  a tag gets attached, an ordinary thought becomes a parent, a type above sets
  the type. `thoughts.update()`, `create()`, `links.create()` and `attachTag()`
  read the kind first; a tool calls `links.requireParent()` before any write.
- **A graph's `parents` holds every thought above**: the type, the tag a tag
  carries, a second type. `getGraph()` keeps a parent only for an ordinary
  link; `removeType()` deletes every type link a thought has.
- **Tags attach through `POST /api/links` with `relation: 2` to a `kind=4`
  thought.** `detachTag()` deletes only the tag's own link; `links.hasTag()`
  looks before an attach. A create of a tag under a name that is there answers
  with that tag: make one through `thoughts.createTypeOrTag()`.
- **Two thoughts share one link, and a post over it replaces it.** Look first
  with `links.between()`, which is not behind a write; compare through
  `linkFound()`, never by the stored `relation`. A label goes on an ordinary
  link only (`isTagLink()`, `isTypeLink()`).
- **Nothing is written as a sibling** (`relation: 4`): the tools take `child`,
  `parent` and `jump`, and `links.update()` no relation (2 swaps the ends).
- **`null` through `replace` clears nothing**: `thoughts.update()` and
  `links.update()` send `remove`. A refused patch keeps the operations before
  it, so `brain_update_thought` sends a field a request, the type first.

### Notes
- **A note is an attachment** (`isNotes`); its log events carry the attachment
  in `sourceId` and the thought in `extraAId`. `notes/append` on a thought with
  no note is a silent no-op: `notes.append()` reads first.
- **A ` ``` ` line with no partner is deleted, with a 200.** `noteAsStored()`
  is the rule: warn only of a note that lost a line (`linesNotKept()`).
- **`notes/update` replaces**: a plan writes its note only where a read
  answered that there is none, and changes no note.

### Lag and read-back
- **A graph is a copy, behind any write by 0.2 s as a rule.** `ingest()` waits
  `afterCopyLag()` before its first look and, at its end, until the graphs list
  what it made (`LISTED`); new code that reads a graph after a write waits too.
- **Aliases replace as a whole list, and a read straight after a write returns
  the old one**, as after a rename. Edit through `thoughts.changeAliases()`,
  given the name just written; `ALIAS_COST` stays on every alias argument.
- **A type set or removed and an alias list are waited for (`READ_BACK`)**;
  past it they are `not_read_back`: accepted, not to be sent again.

### The log
- **It does not list every thought**: imported and old brains hold some with
  no `created` event, so a rebuild also walks `graph`.
- **It returns the newest `maxLogs` entries, even with `startTime`.** Read it
  through `brains.modificationPages()`, take a time from `logTime()`, never via
  `Date`, and name a start: with none a request costs the whole log's length.
- **It is not append-only**: a run of note changes is one `803`, filed again
  at each change while it is the newest entry. Never count edits by entries.
- **A tag is only a link in it, a renamed tag or type names only itself, and a
  kind change is a `304`.** Sync reads all three, and leaves its watermark
  `SYNC_OVERLAP_MS` behind: a write is in the log before it is in `graph`.

### Search
- **TheBrain's search is prefix-based** — why `src/semantic/` exists — and
  refuses a long query in words that say nothing of length (`query_too_long`).
- **A hit is the search index's copy, about 5 s behind**: `SemanticSearch.find()`
  reads each hit's thought, and so must new code that takes an id from a search.

### `brain_ingest`
- **A plan thought is the same name under the same relation to the same
  thought**, looked for in that relation's list. A namesake under another
  relation, or two of the name, fail it; one with no parent is made every run.
- **A failure takes what hangs on it, and nothing else** (`failures`,
  `skipped`, either one `isError`). A parent nobody has rejects the plan before
  its first write. Of two plan links between one pair the first is the link.

## Semantic layer

`@huggingface/transformers` is an **optional peer dependency** — 380 MB
installed plus a 113 MB model. Without it, search degrades to a lexical fan-out
over agent-supplied variants and reports why. Do not make it required, and do
not let its absence throw. Why: ARCHITECTURE.md §8.

- **Top-k only, never absolute similarity thresholds.** e5 scores sit in
  0.74–0.92, and correct-versus-wrong can differ by 0.001.
- **The model, the dtype and `DOCUMENT_FORMAT` make an index what it is.**
  Change what goes into a document and bump `DOCUMENT_FORMAT`. The kind is
  beside the document (`VectorStore.setKinds()`): never fold it into the hash.
- **A request that fails is not an empty answer.** The fan-out throws
  `SearchFailedError` when no phrasing was answered, and lists the rest in
  `notSearched`.
- **A rebuild and a sync read everything before they write anything.** A
  failure every read would get stops the run with the index as it was; any
  other leaves the thought in `IndexResult.unread`, its row and the watermark
  untouched. "Has a note" goes by the log (`noteStates()`), not the graph.
- **Every client session runs a server over the same index file.** A search
  checks `PRAGMA data_version`, and a rebuild or a sync holds `store.claim()`:
  code that reads the index, awaits, and writes by what it read belongs inside.

## Tests

```
npm test                                                     # unit only
THEBRAIN_API_KEY=… npm test                                  # + read-only contract
THEBRAIN_API_KEY=… THEBRAIN_TEST_BRAIN_ID=<uuid> npm test    # + write contract
```

Write tests demand an explicit throwaway brain and refuse any brain over 500
thoughts; suites skip cleanly without the variables. Tests search no other
brain. A run sweeps what it made by identifier from the log (`test/sweep.ts`);
read the log from the run's start (`newestLogs()`), and poll a read-back with
`eventually()`. Tests of bursts of concurrent writes run only with
`THEBRAIN_LOAD_TESTS=1`, in the `describe.runIf(LOAD_TESTS)` block of
`test/resources.integration.test.ts`. A claim about the API that goes into a
document needs a test behind it.

## Local development

The API key lives in TheBrain under Settings → User → Local API Key. Pass it
through the environment; never commit it.

```
http://localhost:11522/api/v1/docs.json   # OpenAPI
http://localhost:11522/api/index.html     # Swagger UI
```
