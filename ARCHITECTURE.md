# Architecture and operating principles

This document explains how `thebrain-mcp` is put together and, more importantly,
*why*. It is written for someone who wants to extend the server, port the idea to
another knowledge base, or argue with a decision.

The short version: the server is a **mechanism** — deterministic, testable
operations over TheBrain. The **policy** — how to break material into meanings,
when to reuse an existing thought, what belongs in a note — lives outside it, in
editable markdown skills. Everything below follows from that split.

The measurements behind the claims here are in
[`docs/api-map.md`](docs/api-map.md), by row (`L1`…). This document keeps the
decisions and the reasons for them.

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

So: 19 tools instead of 48 endpoints, plus a local vector index, plus a batch
ingest operation.

The use it is built for: one agent, calling tools one after another, a few per
message; `brain_ingest` plans of up to about 200 thoughts; and the user, who may
be editing in the TheBrain app meanwhile. What TheBrain does under bursts of
concurrent writes is recorded in `docs/api-map.md` (*Measured under artificial
load*) and is not guarded here.

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
        (+ optional transformers)          http://localhost:11522
```

The dependency rule is one-directional: `server` → `operations` → {`semantic`,
`api`}. Nothing below the server layer imports from the server, and nothing in
`api/` knows that MCP exists. That is what makes the lower layers testable
without a protocol harness.

### `src/api/` — the HTTP layer

Its whole job is to turn a hostile HTTP surface into typed calls that either
return data or throw a `TheBrainError` with a machine-readable `kind`
(`ApiErrorKind` in `errors.ts`).

"Hostile" is not an exaggeration — see §7 for the catalogue. The two defences
that matter most:

- **UUIDs are validated before the request.** A malformed UUID in the path makes
  the API return **HTTP 200 with a Blazor HTML page**. A client that trusts the
  status code will parse an error page as success. The identifier of zeros is
  refused by the same check, though it is well formed: a create takes it for
  no parent and no type given, and answers 200 (§7).
- **The response body decides, not the declared content-type.** The layer sniffs
  for HTML even on 200, and parses JSON regardless of what the header claims.

**The address is found, not assumed.** A TheBrain update moved the local API
from port 8001 to 11522 (L15), so with no `THEBRAIN_BASE_URL` the client tries
both. Only a *refused* connection moves on to the next address: nothing was
sent, so repeating even a write is safe. A timeout or a dropped connection may
have reached TheBrain, so it is reported rather than retried elsewhere.

### `src/semantic/` — meaning-based retrieval

Five modules, each with one job:

| Module | Job |
|---|---|
| `store.ts` | `node:sqlite`, vectors as BLOBs, brute-force cosine. Lazy in-memory cache. Also holds index metadata (brain, model, dimensions, sync watermark) |
| `document.ts` | Builds the text that gets embedded: name, aliases, label, type, tags, first 1500 characters of the note. Hashes it so unchanged thoughts are skipped |
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
`confirm.ts` (§6). Every identifier argument goes through `identifier()`, which
lowers a UUID once: the API answers in lower case whatever it was sent.

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

Nineteen tools. The descriptions total about 1230 tokens, and the full
`tools/list` payload including schemas about 5040: 4,910 and 20,151 characters,
with a token at four. A unit test pins both figures. Every session pays them, so
an argument has to earn its place.

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

**A type or a tag is marked; an ordinary thought is not.** A read result is
where the model takes identifiers from, and the write tools refuse one of the
wrong kind (§7). So a read tool marks a type or a tag (`kindMark()`,
`kindLabel()`) and titles what stands under one "Thoughts of this type" or
"Thoughts with this tag", since "Children" there asks for a child the API
refuses. The kind is on every thought the API returns: no request is spent.

**A label, read back.** A label is printed where it is not the name
(`labelOf()`), since every type has its name for one. Under a type whose label
is another name, `TYPE_LABEL` says it may be one the type had (§7): "may",
because a read cannot tell it from a caption someone wrote.

**A name that does not show is spelled out, not refused.** `shownName()` prints
`(no visible character: U+200B)` for a name whose every code point is
`White_Space`, `Default_Ignorable_Code_Point` or `Cc`; nothing else is judged.
Every refusal in this server is for a request the API answers with a 200 and
does not carry out, and the API stores such a name as asked.

### What stands above a type or a tag

A type can have a type (meaning 3), a tag can carry a tag (meaning 7), and an
older brain can hold a thought with two types; the graph lists each among the
parents (L44).

- **`typeId: null` removes every type.** `removeType()` deletes the link of
  every type the thought is linked under: removing the one `typeId` names would
  leave a type that reads as none and that no patch can take away.
- **What is above is not called a parent.** `getGraph()` keeps a parent only
  where the link the two share in the graph's `links` is ordinary: the link is
  what the API says the two are, a kind only by inference. A second type is in
  `otherTypes`, since the graph's own `type` names either of two by turns.
- **A type the patch would not set is refused** (`type_on_tag`, `type_cycle`,
  `two_types`): each is a 200 that does not do what was asked. Two types are
  counted by `links.between()`, since the graph lags a link's deletion.

### What changed, and to which thought

`brain_recent_changes` names thoughts by the log, whose `101`, `103` and `102`
carry a name (L37): a deleted thought reads `name (deleted)`. Where a read gives
a name too, the read's wins: a rename made in TheBrain's window was not
measured. `identifiers: true` adds each thought still there with its
identifier; it is off by default, since it adds a quarter to two fifths.

### A type or a tag, made

`brain_create_type_or_tag` makes either, by name; no other tool can.

- **A tag is made once a name, and the create does not say which it did**
  (L39). Under the name of a tag the brain has, with letter case, invisible
  characters and the form of a character set aside, a create makes nothing and
  answers with that tag. So `thoughts.createTypeOrTag()` reads the newest log
  entry, creates, and reads the thought's own entries: a `101` later than the
  entry read before is a thought it made. `/types` and `/tags` are a copy
  behind a create and cannot tell. A type is made again under any name.
- **A name and a kind, and nothing else**: what else is sent with the name of a
  tag that is there is written onto that tag.
- **Why a tool of its own.** A `kind` on `brain_create_thought` would have to
  refuse its every other argument, and turn "create" into "find or create". A
  plan makes no vocabulary: that is rare, one call ahead of the plan.

### A link changed, and one removed

**Changing a link is a post over it, and is no deletion.** Posted over with
another relation, the one link a pair has is rewritten under its identifier, with
its label, colour, thickness and direction (L43). `brain_link` with `replace`
does that, takes no consent, and says what the link was and is: the same call
with the old relation puts it back. Delete-and-create would lose the identifier
and the label; `PATCH /relation` swaps the ends (§7).

Never over a tag's attachment or a type's link: the tag or the type would go.

**Removing one is a deletion** (§6): its label goes, and a thought it leaves
alone is shown next to nothing in TheBrain. So `brain_unlink` is gated and asks
through `confirmDestructive()`. It removes the link `between()` gives.

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

Five properties, each of which took a bug to get right:

- **Order-independent.** `planLevels()` topologically sorts by parent reference,
  so the input can be in any order.
- **Validated before the first write.** Cycles, dangling references, empty
  names, duplicate `tempId`s and a relation with no parent are rejected up
  front, and so is what a read shows: a `typeId` that is no type, a tag that is
  no tag, a type or a tag named as a parent, a parent no thought has. A plan
  either starts writing or does not.
- **Idempotent.** Re-running the same plan reuses existing thoughts instead of
  duplicating them, and writes nothing that is there. An in-flight registry
  makes it hold *within* one batch: two identical names in the same level
  resolve to one thought rather than racing each other into two.
- **Honest about what it did not do.** A link the pair already has in another
  form is reported, with the mismatch spelled out, never counted as created.
- **A failure takes its own branch and nothing else.**

#### What a second run finds

Deduplication rests on one read: the graph of the thought a plan item hangs on
(L27, L33).

**The same thought is the same name under the same relation to the same
thought.** A graph lists a thought created as a child under `children`, as a
parent under `parents`, as a jump under `jumps`; a thought is looked for in that
list, under its name as stored (`thoughtNameAsStored()`). That is what a first
run leaves behind, and nothing wider: which thought is close enough to reuse is
not the server's to decide (§3).

**A namesake under another relation, or two of one name, are neither reused nor
made again.** Reused, the thought would take the plan's branch under a link of
another kind, or under whichever of two a graph lists last, an order that
changes between reads; made again, it is a duplicate only a human can remove.
So it fails, and its line gives the identifiers and the ways on: name one in
place of the `tempId`, or send it with `deduplicate: false`.

**A thought with no parent is not looked for**, and a second run makes it again:
the only lookup left is by name, which lags a create by 5.6 s and would land on
any namesake. So the `parent` argument says what leaving it out costs. **A read
that failed is not "nothing there"**: the thought fails.

**The graph is a copy, and the batch waits for it** (§7). Before its first look
next to an existing thought, `ingest()` waits until 0.5 s have passed since this
process's last write came back (`afterCopyLag()`): the other tools return as
soon as their write is answered, and a plan sent straight after one could find
the copy from before it. It is a wait by the clock (`COPY_LAG_MS`, from
`client.sinceLastWrite()`) because nothing in a graph tells a copy that is
behind, and it costs nothing unless a write came back less than 0.5 s before. At the end the batch returns once the graphs list what it
made, read every 100 ms for 3 s at most (`LISTED`), and counts the rest in
`unlisted`: a second run sent in that moment made the children again. **Not
guarded:** a copy further behind than 0.5 s, and a write made in the app.

#### The note of a thought that was there

**A note that is there is kept. A plan's note is written to a thought with no
note, and never over one.** It used to be written over the note of every
thought a plan found in place, a person's edits included (L33). `ingest()` reads
the note of each such thought and writes only where the read answers that there
is none; a read that failed is not that answer, and the note stands under
"Failed". A plan's `note` is the note of a thought it makes, and the first note
of one it finds; it never changes a note.

**The result says which it was.** The table gains a `Note` column (`written`,
`kept: same text`, `kept: another text`), and a "Notes kept" section names
`brain_append_note` and `brain_set_note` for a plan's text that went nowhere.
It is no error: what to do with that text is the caller's (§3). "The same text"
compares a text as TheBrain would store it (`noteAsStored()`).

*Replace on request* was weighed: a model that sets the flag to be sure erases
what it has not read. *Append* appends again on every run.

#### What a second run writes

Nothing, when what the plan asks for is there (L35).

**A tag and a label are looked up first.** A tag attached again is a 200 that
logs a `402`, which a sync reads and `brain_recent_changes` lists as "link
moved". So a tag on a thought found in place is asked for first
(`links.hasTag()`), and a label is compared with the link's name as stored
(`linkNameAsStored()`). Both by the lookup of the pair, which is not behind a
write; the link read by its own identifier is.

**A label that takes another's place is quoted**: `label updated: it was
"contradicts" and is now "refines"`. Replaced and reported, where a note is kept:
a link has one label and nothing appends to it, and the old one is whole in the
result, one call from being restored. So it needs no person's consent (§6):
consent guards what no result can give back, and a label replaced *without a
word* was in that class only because nobody was told.

**Two links of a plan between one pair are one link, the first.** Two thoughts
share one link. The rest are listed under "Links not added" with their labels.
Rejecting the plan was not taken: the pair is known only once the plan's
thoughts are found, and a rejected plan is sent again whole to drop one line.
A tag named twice for one thought is one attach.

#### When a thought of the plan is not created

**What hangs on a failure is skipped, and the branches beside it are written to
the end.** A thought under a failed `tempId` is not sent, and a link to it is not
tried; the outcome lists `created`, `reused`, `failures` with why, and `skipped`
with the `tempId` each waited on. The thoughts under a failure used to be
created with no parent, and every further run made them again. Stopping at the
first failure would not make the batch whole, since there is no rollback, and
would leave more for a second call, which is where duplicates come from.

**A batch written in part is `isError`**, and asks for the failed and skipped
items alone, in a plan that names what exists by identifier. A write with no
answer may have landed (`mayHaveLanded()`), and its line says so. A line under
"Failed" is `describeError()`'s, without "Nothing was written", which would be
read of the batch. Two plan items for one thought are one create: when it fails,
the other stands under "Skipped", since a create of its own would be the same
request again.

**What is checked before the first write, and what is not.** A plan that names
nothing in the brain reads the brain first. A parent nobody has rejects the
plan (`requireParent()` returns null for it). The lower end of a child or parent
link and the ends of a jump are not read: such a link fails alone, with the
API's 400 that names the identifier, where a rejected plan would be sent again
whole to correct one link.

Nothing is deleted to tidy up after a failure. Deletion needs a human (§6).

### A call about one thought, written in part

Four tools write more than once in a call: `brain_create_thought` (the thought,
its note, its tags), `brain_update_thought` (fields, then aliases), `brain_tag`
(two lists) and `brain_delete_thought` (the thought, then its index row). Each
used to throw at the first failure, and the identifier of a thought just made
was lost.

**One shape, `brain_ingest`'s.** A write after the first is a step of
`inOrder()`; a call stopped part way is answered by `writtenInPart()`, as
`isError`, with "Done" by identifier, "Failed", "Skipped" and "Next". A call
stops at its first failure, where a batch goes on: every write can be sent again
with the identifier in hand and makes nothing twice.

**Accepted, and not read back.** A type set or removed and an alias list are
waited for until a read shows them (`READ_BACK`: every 50 ms, 3 s at most). One
the wait does not see is `not_read_back`: TheBrain accepted it, do not send it
again — not "may have landed", since a look would show the old value. It is
never under "Done". The danger is the next edit: an alias edit or a type
removal reads, then writes, and built on the old value it undoes the write. The
line says so; the server does not hold such an edit back.

**One field to a request.** The API applies a patch an operation at a time and
keeps what it wrote before the one it refuses, without saying which (L19), so
`brain_update_thought` sends each field alone, the type first. Its alias edit is
given the name just written: a read straight after a rename returns the old name
(L28), and `changeAliases()` drops an alias equal to the name it reads.

### A read that fails inside a tool

Seven tools read something beside the thing they are called for: a note ahead of
printing or replacing it, a graph on a walk, the app's state beside the list of
brains. Those reads used to drop their failure and stand in for "nothing there":
`brain_set_note` replaced a note it had not read.

**A failed read is not one of the API's answers for "nothing".** A thought with
no note is a 200 with a sentinel, one with nothing next to it a 200 with empty
lists. So the two are told apart by the request having been answered (`kept()`
in `tools/read.ts`), and what a tool does then goes by the read's use:

- **Ahead of a write that erases, the call fails and nothing is written.**
  `brain_set_note` replaces no note it could not read, since its result is where
  the model learns what it erased; `brain_delete_thought` asks nothing and
  deletes nothing, since consent not asked for whole is refusal (§6).
- **Part of what a tool shows, it is left out and named**: "Note not read" in
  `brain_get_thought` (as `isError`: no Note section is what a model takes to
  `brain_set_note`), "Not read" in `brain_traverse`, "Listing not read" in
  `brain_ingest`.
- **About the call** — a malformed identifier, a `brainId` that is no brain, a
  rejected key — it is explained as it was.

`emptyOn400()` takes the sentence `/types`, `/tags` and `/pins` each answer for
an empty list, and no other 400 (L1); a list the API could not read, told in
the same words, would still read as empty, but none could be produced.

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
says whether anything was sent, since after a timeout or a dropped connection a
write may have been carried out (`mayHaveLanded()`).

**The status is not the meaning** (L3). A `brainId` that is no brain is a 401,
the status of a rejected key, and the graph of a thought nobody has a 403 about
no permission. So the client makes `auth` and `unknown_brain` of the 401, and
`describeError()` keeps the API's words wherever they name what was wrong, and
never points at an identifier the failure was not about.

**Degradation is reported, not hidden.** When semantic search falls back to the
lexical fan-out, the outcome carries `degradedReason` and the tool prints it. An
agent that does not know recall dropped will trust an empty result. And **a
failure is not an empty result**: a search that could not ask is an error (§8),
and so is a read a tool needed and did not get (§4, *A read that fails inside a
tool*).

---

## 6. Deletion: two independent safeties

Deletion is implemented — refusing to implement it would just push users to do it
by hand, less carefully. Two tools delete: `brain_delete_thought` a thought,
and `brain_unlink` a link (§4, *A link changed, and one removed*). Each is
guarded twice:

1. **Off unless `THEBRAIN_ALLOW_DESTRUCTIVE=1`.** A default install cannot delete
   anything, whatever the agent decides.
2. **A human must consent, per deletion.** The preferred path is **elicitation**:
   the server asks the client to show a confirmation form. For clients without
   it, the tool returns a summary of the consequences and requires a second call
   carrying `confirm=true`, with instructions to ask the human first.

**An elicitation failure counts as refusal.** If the client advertised the
capability and then threw, the server does not delete. The agent is never the
last authority on an irreversible action.

**The question says what goes with the thought, and each line is what it
says.** It names the thought, marked when it is a type or a tag, and counts its
links, what stands under it, its note (once, though the API lists a note among
the attachments) and its attachments. It is not put at all when the note could
not be read. For a link it names both thoughts, the label, and a thought left
with no parent, child or jump.

---

## 7. What the TheBrain API actually does

Findings from reading the spec and then testing every one of them against a live
instance. Each has its row in [`docs/api-map.md`](docs/api-map.md), with the
measurements, and a contract test.

1. **`/types`, `/tags` and `/pins` return 400 when the list is empty**, in a
   sentence that reads like a failure: `emptyOn400()` (L1).
2. **A malformed UUID in the path returns HTTP 200 with an HTML page.** Validate
   before the request; sniff the body after (L2).
3. **An identifier nobody has is answered by each request in its own way**, a
   `brainId` that is no brain by a 401, and a note written to a thought nobody
   has is stored (L3, §5).
4. **Five different error shapes** — bare JSON string, plain text,
   ProblemDetails, HTML, and an empty body. Normalised in the HTTP layer.
5. **`notes/append` on a thought with no note is a silent no-op**, and joins its
   text to the last line. `notes.append()` reads first and sends a separator (L4).
6. **A ` ``` ` line with no partner is deleted from a note**, with a 200 (L5).
   `noteAsStored()` is the rule. A tool warns of a note that lost a line and
   writes it as given: refusing would reject a plan's fifteen notes for one stray
   fence, and mending would guess what the line was for (§3).
7. **JSON Patch is not exposed.** Tools take flat fields and build the patch.
8. **`SearchResultDto.brainId` comes back as zeros** from the search within one
   brain. Use `sourceThought.brainId` (L6).
9. **A note is an attachment**, flagged `isNotes`, and its log events are keyed
   by the attachment, with the thought in `extraAId` (L13).
10. **Search is prefix-based, not semantic** — the reason for §8 — and refuses a
    long query in words that say nothing of length: `query_too_long` (L30).
11. **The log keeps only the newest `maxLogs` entries, is not append-only, and
    costs time by its whole length without a `startTime`** (L14, L20, L42). See
    *Reading the whole log* below.
12. **`by-location` tells `Example.com` from `example.com`** (L17).
    `attachUrl()` also compares the thought's own attachments, a copy it reads
    after `afterCopyLag()`.
13. **`null` clears nothing through `replace`** (L19, L22). `remove` clears a
    label and a colour, `removeType()` a type; a link's thickness cannot be
    cleared.
14. **`typeId` and the request that attaches a tag take any thought, with a
    200** (L21, L23): a type is set, a tag attached, an ordinary thought made a
    parent. `thoughts.update()`, `create()` and `attachTag()` read the kind
    first (`not_a_type`, `not_a_tag`).
15. **A type or a tag is never a parent** (L24, L29): a parent link with one
    above sets the type or attaches the tag, and leaves no parent.
    `links.create()` and `thoughts.create()` refuse it (`not_a_parent`,
    `tag_as_parent`): the call asked for a link, and `typeId` and `brain_tag`
    are what ask for the other two.
16. **Nothing is written as a sibling** (L25): `relation: 4` is a 400 or a 200
    that does nothing useful. Which parent a sibling shares is the caller's to
    say (§3). A patch of `relation` to 2 swaps a link's ends every time.
17. **`graph` is answered from a copy** (L27), brought up to date about every
    0.1 s after a thought's first graph read: it lags a write by no fixed bound.
18. **`POST /api/links` answers 200 with an identifier of zeros for a link it
    does not make** (L29): `createdId()` throws `zero_id`. The zero identifier
    *sent* is taken for "none given": `assertUuid()` refuses it.
19. **Two thoughts share one link** (L29, L35, L43). A post over it replaces it,
    keeping its identifier, label and colour, and logs a `402`. A parent's link
    is stored as a child's from the other end, so `linkFound()` reads a link by
    its `meaning` and `thoughtIdA`, never by the stored `relation`.
20. **The search answers from a copy about five seconds behind** (L34), deleted
    and changed thoughts included, and so does the lookup by exact name.
21. **A name is not stored as it was sent** (L36): tabs and line feeds become
    spaces, the ends are trimmed of Unicode's `White_Space`, and past 1,024
    UTF-16 units it is cut; a name of white space alone is refused or ignored.
22. **A tag is made once a name** (L39), a type on a type and a tag on a tag are
    links of meanings 3 and 7, a thought can have two types (L44), and a type
    keeps its first name as a label through a rename (L38). See §4 and §8.
23. **A graph lists a thought once** (L40): a sibling that is also a parent,
    child or jump is not under `siblings`.
24. **`statistics` is behind for types and tags** (L41). Nothing in the server
    reads it.

### Write visibility

Reads catch up with writes at different speeds; the table is in
`docs/api-map.md`, under *Write visibility* (L12). What shapes the code: a graph
is 0.1–0.4 s behind a write as a rule and 1–3 s after a batch of up to 200
thoughts; a rename and an alias list read back in about 0.1 s; the lookup of a
link pair is not behind; the search and the lookup by name are about 5 s behind.

**The rule that falls out: after a write, address thoughts by identifier, never
by name.** `brain_ingest` links newly created thoughts through returned UUIDs
precisely because name resolution inside a batch would reliably miss.

> An earlier version of this project's notes claimed `nameExact` bypassed the
> index and returned instantly. A contract test measured 5.6 seconds. Faster than
> full-text, not instant.

### Tags: undocumented, but they work

A link's `meaning` field is the discriminator: **1** ordinary, **2** type,
**5** tag. It is read-only — `PATCH /meaning` returns 200 and silently ignores
you. The server sets it, inferring from the `kind` of the target thought.

| Operation | How |
|---|---|
| Create a tag | `POST /api/thoughts` with `kind: 4` and a name; under a tag's name it answers with that tag |
| Attach | `POST /api/links`, `thoughtIdA` = thought, `thoughtIdB` = tag, **`relation: 2`**. The server rewrites it to `relation=1, meaning=5` |
| Detach | `DELETE /api/links/{brainId}/{linkId}` |
| Read | `graph.tags` — a tag does **not** pollute `parents`, but the tag a tag carries does |
| List | `GET /api/thoughts/{brainId}/tags` (400 if empty) |

`relation: 2` against an ordinary thought (`kind=1`) produces an ordinary parent,
against a type it sets the type, and between two tags it makes a link of meaning
**7**. It is the target's `kind=4` that makes it a tag. `statistics.links` does
not count tags.

### Aliases: a list that only replaces

TheBrain 15.0.621 gave thoughts aliases, which its own search matches. The API
sets them as a whole list (L16).

**The tools add and remove; they never replace.** `brain_update_thought` takes
`addAliases` and `removeAliases`, and `brain_ingest` adds to what a thought has.
A flat `aliases` field would mirror the API, and an agent that had not read the
thought first would wipe what was there, with a success message. The
read-modify-write is `thoughts.changeAliases()`, which waits for its write to
read back (two edits on a stale read left only the second alias) and refuses a
list past 100, of which the API keeps the first hundred without a word.

**The cost is on the argument, not in a consent dialog.** Saving a brain's first
alias makes it require TheBrain 15.0.621 on every device, and the server cannot
tell a first alias from a tenth. So every argument that can write one says so
(`ALIAS_COST`), and the skill tells the agent to ask before the first.

### Enumerating all thoughts

There is no "list all thoughts" endpoint. Over the whole log, `101` (created)
minus `102` (deleted) reconstructs a brain whose thoughts were all made in it;
an integration test checks it against `statistics`. Imported and old brains log
far fewer `created` events than they hold thoughts, so a rebuild takes the union
of the log and a breadth-first walk over `graph` — parents, children, jumps,
tags, type and `otherTypes` — seeded from `homeThoughtId` and every logged
thought. The walk's graphs are reused for indexing. It relies on a tag's and a
type's graph listing their thoughts as `children`, which contract tests hold.
Still missed: a thought linked to nothing and absent from the log.

### Reading the whole log

One request returns at most `maxLogs` entries, and keeps the **newest**, with
`startTime` too (L14). So `brains.modificationPages()` pages back on `endTime`,
from an `until` down to a `since`. The API orders and filters by
`modificationDateTime`, which is not always `creationDateTime`, and `logTime()`
is the one place that names it. The boundary goes back **as the exact string the
log returned**: through `Date` it loses its microseconds and the boundary entry
with them.

**The log is not append-only** (L20). While a note's `803` is the newest entry
TheBrain has logged, in any brain, the next change to the note files it again
under the new time. Only the newest entry moves, so a reader paging back has it
on its first page, and the next sync reads it again. How many times a note
changed, the log cannot say.

**A request with no `startTime` costs time by the length of the whole log**
(L42), so a reader names a start wherever it has one. Only a rebuild reads all
of it.

---

## 8. The semantic layer

TheBrain's search matches prefixes: the typo `OTPG` and the synonym `project`
find nothing. An agent trying not to create duplicates needs to find a thought
it can only describe, not spell.

### Why the embeddings package is optional

`@huggingface/transformers` costs **380 MB** installed — `onnxruntime-node` and
`onnxruntime-web` are both hard dependencies — and downloads a **113 MB** model
on first run: an unreasonable default for an audience that is largely not
developers. It is declared optional in `peerDependenciesMeta`, and `embedder.ts`
imports it through a variable specifier so the compiler does not demand its
types:

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
The reason for degradation is returned in the result, and what it says to do
goes by it: build the index, or install the package, which is not the same as a
package that fails to load (`EmbedderUnavailableError`, `loadFailure`).

### A request that fails is not an empty answer

The fan-out sends one request per phrasing. It used to count every failure as a
phrasing that found nothing, so a search that never ran read as "nothing found".

- **A failure about the call stops the search**: a `brainId` that is malformed
  or names no brain, and a rejected key. Every phrasing would get it.
- **Any other failure is one phrasing's own, because some are**: the search
  refuses a long query and answers a shorter one to the same brain (L30).
- **So the outcome decides.** With no phrasing answered, `find()` throws
  `SearchFailedError` and the tool answers `isError`. With some answered, a
  `Not searched` section names the rest (`notSearched`).

`brain_index` asks for the brain before anything else: status can only
recommend a rebuild, which needs the brain. "Usable" is an index a search can
rank by and an embedder that can embed (`SemanticIndexer.cannotEmbed()`). Only a
write creates an index file: a status or a search of a brain never indexed
leaves nothing behind, and `indexPath()` refuses a `brainId` that is no UUID.

### A hit for a thought that is gone

Neither source knows that a thought is gone (L34): TheBrain's search is about
five seconds behind, and the vector index is as old as its last sync. A hit is
where a model takes an identifier from, and a note written to an identifier
nobody has is stored and reported as written (L3).

**Every hit's thought is read before the hit is listed, in both modes.** `find()`
ranks, cuts to the limit, and reads each hit's thought, ten at a time. The
thought: listed, under the name and kind the read gives. A 404: left out,
returned in `gone`, and counted under "Left out" with what to do (nothing for the
fallback, a sync for the index). A brain or a key refused: the search fails. Any
other failure: the hit keeps its place, marked under `Verified`, with a "Not
verified" section. It costs one request a hit. *Taking the row out of the
index* on a 404 was not taken: a search is a read. *Filling the places left*
would hide that the index is behind.

### A read that fails while the index is built

A run makes thousands of reads and then writes. The indexer used to drop the
failure of every read but the log's: a rebuild with every graph a 500 answered
"Index built" with nothing encoded, and a sync moved its watermark past changes
it had not read, for good (L32).

- **It reads first and writes after**, so a run a request stops has written
  nothing.
- **A failure every read would get stops the run**: `auth`, `unknown_brain`,
  `network`, and any failure of the log's or the brain's read.
- **Any other failure is the thought's own**: it goes to `IndexResult.unread`,
  and its row is left as it was, not removed and not rebuilt without its note.
- **Only the thought's own 404 removes its row**, asked for after its graph's
  403, which other failures get too. A rebuild that left a graph unread removes
  no row its walk did not reach, and sets no watermark.
- **The watermark moves only for a run that read everything it asked for.**

The result of a run that left anything is an error ("Index rebuilt in part").
A run that cannot embed says so before it reads the brain (`cannotEmbed()`).
"Has a note" goes by the latest note entry in the log the run has read
(`noteStates()`): for a moment after a note changes the graph is wrong (L32).

### Variants in vector mode

The concept and each variant are embedded separately, each is searched, and a
thought keeps its best score; the phrasing that produced it is reported as
`matchedVariant`. Best score per thought was chosen by measurement over joining
the variants into one string, their centroid, and reciprocal rank fusion
(precision@5 0.75 against 0.67, 0.65 and 0.42, and 0.40 for the concept alone;
11 queries, one brain, one labeller: a direction, not a benchmark).

### Storage

`node:sqlite` (Node 22+), vectors as BLOBs, brute-force cosine scan. No vector
index, no native dependency, no extension to compile. 20,000 vectors × 384
dimensions scan in milliseconds to tens of milliseconds, and real brains are far
smaller; an ANN index would save time nobody is spending. Tests hold the scan
against a bare scan of the same rows timed beside it, never against a figure on
a clock, which fails for the machine's reasons.

### One index file, several server processes

Every client session starts a server process of its own, and they all open the
one index file of a brain. Written as if it had the file to itself, the store
ranked by rows another process had since replaced, answered `database is
locked`, and let an overlapping rebuild write an older reading over a sync's
newer row, with the watermark left past the change for good.

- **The rows in memory follow the file**: a search asks for `PRAGMA
  data_version` before it ranks, and reloads when another connection committed.
- **A write is all in the file or not there**: one `BEGIN IMMEDIATE`
  transaction, `startOver()` for an index of another model, the watermark last.
  A statement waits `BUSY_TIMEOUT_MS`, then throws `IndexBusyError`.
- **One run at a time.** A rebuild and a sync hold the index from their first
  look to their last write (`VectorStore.claim()`), a lock the OS drops with the
  process; a second run waits `RUN_WAIT_MS`, then gets `IndexRunningError`.
  Merging overlapping runs was not taken: one would still write an older reading
  over a newer one. Searches and single writes take no claim.

### Quantization: q8

`multilingual-e5-small` through transformers.js, quantized to q8. Over 48
thoughts and 20 mixed-language queries, fp32, q8 and q4 ranked within the noise
of one another (top-1 15, 16 and 15 of 20), and q8 is a quarter of fp32's size:
113 MB against 448 MB.

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
agent — which handles those two cases trivially — decides. Including the
thought's label, type, tags and note excerpt in the embedded document fixes
exactly those two benchmark failures, which is why `document.ts` embeds more
than the name.

### Indexing is an explicit tool call

Not something that happens on server start. A 10,000-thought brain takes about a
minute, and the user should know why their client is busy.

Enumeration is the union of the log and a walk over `graph` (§7), whose graphs
give each thought's type, tags and attachments. **A note is fetched only for a
thought that has one**, by the log's note entries or, where it has none, by
`isNotes`.

> The first version read a note event's thought from `sourceId`, which is the
> attachment: no note was ever read, and each rebuild honestly reported "no
> changes". Since then the document format carries a version,
> `DOCUMENT_FORMAT`, folded into the model identifier stored with the index, so
> that changing what goes into a vector invalidates existing indexes instead of
> ranking against vectors built to older rules. `Embedder.id` does the same for
> the model and the dtype.

**The watermark is left `SYNC_OVERLAP_MS`, ten seconds, before the run's
start.** A write is in the log at once and in `graph` a moment later, so a sync
in between read the old graph, skipped it by hash, and the change stayed out
until a rebuild.

Everything that goes into a document has a signal in the log (L18, L31), each
with a contract test:

| What changed | Log entry | Read again |
|---|---|---|
| name | `103` against the thought | `sourceId` |
| aliases | `211` against the thought | `sourceId` |
| label, set or cleared | `202` against the thought | `sourceId` |
| type, set or lost | `203` against the thought | `sourceId` |
| note | `801`/`802`/`803` against the `Notes.md` attachment | `extraAId` |
| tag attached or detached | `101`/`102` against the link | both ends, `extraAId` and `extraBId` |
| tag or type renamed | `103` against the tag or type alone | its graph's `children` |
| kind, and with it a type's label | `304` against the thought | `sourceId` |

A tag's link reads exactly like an ordinary parent link's, so `linkEndIds()`
returns both ends of every link event, and the hash drops the ordinary ones. A
moved link names its new ends only; no tool here moves a link.

**The kind is beside the document, not in it.** A row keeps its thought's kind
in a column of its own, which is what leaves types and tags out of a default
search. A kind change need not change the document, so it is compared apart
from the hash, and a row that differs in kind alone is corrected with its vector
kept (`VectorStore.setKinds()`). In the hash it would re-encode the whole brain
on the next rebuild; in the document it would change every vector for a word
that says nothing of what a thought is about.

**The label of a type.** TheBrain writes a type's name into its label when the
thought becomes a type and does not move it on a rename (L38), so a renamed
type's old name stays in its vector. It is left there: TheBrain's own search
finds the type by it; a read cannot tell it from a caption someone wrote, and
that judgement is the caller's (invariant 6), with `label: null` to take it
out; and dropping it would cost every user a rebuild.

---

## 9. Stack

**TypeScript with `@modelcontextprotocol/sdk`**, evaluated against Python on
available MCP functionality, runtime speed, extensibility, testability, and
distribution ([`docs/stack-evaluation.md`](docs/stack-evaluation.md)). The
deciding factors: a 100 ms cold start against Python's 580 ms, felt on every
client session; Node already shipping inside Claude Desktop; and an audience
that is largely not developers, for whom installing a runtime is the cost.

**The SDK is not there for the protocol.** A working MCP server is 45 lines of
dependency-free code. The SDK earns its place through schema validation and
correct error semantics: the `isError`-versus-JSON-RPC distinction in §5 is easy
to get wrong by hand, and getting it wrong is invisible until an agent starts
failing silently.

**Transport is stdio.** No port to claim, no auth to build, lifecycle owned by
the client. An HTTP transport is worth adding only if the server ever needs to
run off-machine.

**One server for every client, with Claude Code as the target.** Where a
capability exists only in Code it is used anyway, and Desktop degrades.

---

## 10. Testing

Three levels, all under `test/`, none shipped to users (`files: ["dist"]` plus a
`tsconfig.build.json` that compiles only `src/**`): unit tests, which need
nothing; read-only contract tests, which need `THEBRAIN_API_KEY` and check that
the live API still behaves as §7 says; and write contract tests, which also need
`THEBRAIN_TEST_BRAIN_ID`. Without the variables the suites skip, so `npm test`
is green in a clean checkout and in CI.

**Write tests demand an explicit brain.** `THEBRAIN_TEST_BRAIN_ID` is never
inferred from `app/state` — the same mistake the tools guard against, and one
this project made once — and a brain of more than 500 thoughts is refused. No
test searches or reads another brain. A run sweeps what it made by identifier,
from the log, and never the home thought (`test/sweep.ts`). A test brain's log
only grows, so a log read starts at the run's start (`newestLogs()`), and a
read-back is polled (`eventually()`), never given a fixed pause.

**Load is opt-in.** Tests of bursts of writes sent at once, which the server is
not designed for, run only with `THEBRAIN_LOAD_TESTS=1`, in the
`describe.runIf(LOAD_TESTS)` block of `test/resources.integration.test.ts`. They
measure TheBrain, not this server.

Two testing habits worth stating, because both caught real bugs:

- **Fakes must lie no more than necessary.** The ingest test's fake API did not
  create parent links the way the real one does; making it faithful broke three
  assertions, and those were the ones that were wrong. Later it answered every
  graph live and had no note to read, and each time a bug passed every test
  that ran on it.
- **Measure before documenting.** Two corrections in this document — the
  `nameExact` latency and the q8 ranking claim — came from tests written against
  a claim that had been asserted rather than checked.

---

## 11. Extending it

**Adding a tool.** Define it in `src/server/tools/{read,write}.ts` with a Zod
schema, wrap the handler in `guard()`, and format output with the `respond.ts`
primitives. Take identifiers through `identifier()`. If the handler grows past
parse-delegate-format, the logic belongs in `src/operations/`.

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
