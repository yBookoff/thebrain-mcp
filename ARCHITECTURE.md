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

So: 19 tools instead of 48 endpoints, plus a local vector index, plus a batch
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
        (+ optional transformers)          http://localhost:11522
```

The dependency rule is one-directional: `server` → `operations` → {`semantic`,
`api`}. Nothing below the server layer imports from the server, and nothing in
`api/` knows that MCP exists. That is what makes the lower layers testable
without a protocol harness.

### `src/api/` — the HTTP layer

Its whole job is to turn a hostile HTTP surface into typed calls that either
return data or throw a `TheBrainError` with a machine-readable `kind`
(`auth | unknown_brain | forbidden | not_found | bad_request | server |
route_miss | invalid_uuid | not_a_type | not_a_tag | not_a_parent |
tag_as_parent | zero_id | network | malformed`).

"Hostile" is not an exaggeration — see §7 for the catalogue. The two defences
that matter most:

- **UUIDs are validated before the request.** A malformed UUID in the path makes
  the API return **HTTP 200 with a Blazor HTML page**. A client that trusts the
  status code will parse an error page as success. The identifier of zeros is
  refused by the same check, though it is well formed: a create takes it for
  no parent and no type given, and answers 200 (§7, item 21).
- **The response body decides, not the declared content-type.** The layer sniffs
  for HTML even on 200, and parses JSON regardless of what the header claims.

`emptyOn400()` wraps the endpoints that answer 400 when a collection is empty
(`/types`, `/tags`, `/pins`) — an API quirk, not a caller error. It takes the
sentence each of them answers for an empty list, and no other 400 (§7, item 1).

**The address is found, not assumed.** A TheBrain update moved the local API
from port 8001 to 11522, and `npx` hands every user the newest server whatever
build of TheBrain they run. So with no `THEBRAIN_BASE_URL` the client tries
11522, then 8001, and keeps to whichever answered last. Only a *refused*
connection moves on to the next address: nothing listened, so nothing was sent,
and repeating even a write is safe. A timeout or a dropped connection may have
reached TheBrain, so it is reported rather than retried elsewhere. An explicit
`THEBRAIN_BASE_URL` is used alone, with no fallback.

**The client knows when it last wrote.** `client.sinceLastWrite()` is when
its last write came back, answered or not, and `afterCopyLag()` waits out
what is left of `COPY_LAG_MS`, 0.5 s, since then. It is for a reader of a
copy that is behind a write: a thought's graph (§4, *What a second run
finds*) and its list of attachments (§7, item 13).

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

Nineteen tools. Measured on the built server: the descriptions total about 1230
tokens, and the full `tools/list` payload including schemas about 5040. That is
4,910 and 20,151 characters, with a token at four: the tools of `tools/list` as
JSON, asked for in process, which is the figure the sections below count their
own cost against.

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
A note is what its read returns: `""` is none, and so is a note of white space
alone, which TheBrain keeps in its file and reads as `""`. Anything else is
printed, spelled out by its code points when nothing in it shows.

**Output is formatted tables and sections, not raw JSON.** Cheaper in tokens and
easier for a model to read. `respond.ts` has the primitives (`table`, `bullet`,
`section`, `join`); empty sections are dropped so the model never has to skim
past "Tags: (empty)". No rows is `null` from `table` and `bullet`, and `section`
drops a body of `null` or `""` without reading it: it dropped the text
"(empty)", and a note or a thought's one tag of that name went with it.

**A type or a tag is marked; an ordinary thought is not.** The write tools
refuse an identifier of the wrong kind (§7, items 15, 17 and 18), and a read
result is where the model takes identifiers from. So wherever a read tool
names a thought that is not an ordinary one, it says which. `brain_get_thought`
and `brain_traverse` put `[type]` or `[tag]` after the identifier, where it
cannot pass for part of the name: on the thought itself and on every
neighbour. `brain_recent_changes` puts the mark after the name in its rows,
which is what tells a tag attached from a link created, and after the
identifier in the list it prints on request (*What changed, and to which
thought*, below).
`brain_search` gains a `Kind` column, there only when a hit is not ordinary:
for a type or a tag that takes `includeAuxiliary`. And `brain_get_thought`
gives a thought's type as name and identifier, the form a `typeId` takes. A
kind with no name here is shown as the API's number.

Only the exception is spelled out, so the common row costs nothing: a result
that holds ordinary thoughts alone is what it was, to the character. No
request is spent either. The kind is on every thought the API returns, in a
graph's lists and in a search hit (contract test); the index keeps it beside
the name; and `brain_recent_changes` marks a thought it has read for its name.
Measured on a brain of two types, two tags and five thoughts: a mark is 7 or
6 characters, the type's identifier 39, the column 6 a row. A thought with a
type and two tags went from 339 characters to 378, a search that asked for
types and tags from 1078 to 1138, a traversal that met three of them from 845
to 865. The descriptions say nothing of the marks, so `tools/list` is the
size it was.

What stands under a type or a tag is named for what it is. A type's graph
lists the thoughts of that type as `children`, and a tag's the thoughts it is
on (contract tests), and `brain_get_thought` printed both as "Children". On a
type the section is "Thoughts of this type", on a tag "Thoughts with this
tag", and on any other thought "Children" as before. A section's name is what
a model acts on: "Children" under a type or a tag asks for a child, and a
child added there is refused (§7, items 18 and 21), which is a call spent and
an error of some 300 characters to read. The names cost 13 characters on a
type and 14 on a tag, 191 to 204 and 189 to 203 for one with two thoughts,
and nothing on a thought that is neither.

Left as they were: a thought's tags are names still, because an identifier
each on every read of a tagged thought is paid far more often than a tag is
taken off, and `brain_list_types_and_tags` has them; and the active thought of
`brain_list`, whose kind would take a request of its own. In vector mode the
kind is the one the index recorded, as old as its last sync. A sync reads a
thought again when its kind changes and a rebuild compares the kind of every
row, and either gives the row its kind with nothing encoded (§8, *The kind is
beside the document*).

> **Since then** `brain_search` reads the thought of every hit before it
> lists it, to see that it is there (§8, *A hit for a thought that is gone*),
> and that read has the kind. So the `Kind` column, and the name beside it,
> are the thought's own in both modes, and no longer the search's copy or the
> index's. The mark still costs no request of its own. What the index's kind
> still decides is which rows a default search leaves out as types and tags.

**A label, read back.** `brain_create_thought` writes a thought's label and
`brain_update_thought` writes and clears one, and no read tool printed it:
what was written could not be read back. And a renamed type keeps the name
it had for a label, which TheBrain's search and the semantic index find it
by (§7, item 26), with nothing to show that it does. The label is on every
thought the API returns, in a graph's lists and in `/types` and `/tags`
(contract test), so printing it takes no request.

`brain_get_thought` prints the thought's label under `## Label`, right under
the title, and a neighbour's after its identifier and its mark, quoted as a
link's label is: `- Mercury — {id}, label "element"`. Two thoughts of one
name in one list are told apart by it, where it took a read of each.
`brain_list_types_and_tags` prints a type's and a tag's the same way. A label
that is the name is not printed: every type has one, its name, and it says
nothing the name does not, at the cost of a type's name twice wherever a
result names a type. A label with no character that shows is spelled out, as
a name is (below).

Under a type whose label is not its name, in `brain_get_thought`, and once
under the list of types in `brain_list_types_and_tags` when a type there has
such a label, a sentence follows: "A type's label may be a name it had, which TheBrain keeps there
through a rename and finds the type by. label null in brain_update_thought
clears it." A read cannot tell such a label from a caption someone wrote
(§8, *The label of a type*), so the sentence says "may", and whether to clear
it is the caller's.

Measured through the real handlers on 15.0.640, in a throwaway brain. A
thought with a type, two tags, a parent, four children, two jumps and a note
is 797 characters with no label anywhere, the same lines as before; with a
label on it and on two of its jumps, 850. A type renamed once, with two
thoughts of it, one of them labelled, went from 184 to 374, the sentence 149
of that. The list of two types, one of them renamed, and two tags went from
222 to 395. A result with no label in it, or only labels that are the name,
is what it was, to the character. `tools/list` did not change: no
description mentions the label.

Left as they were. The type and the tags of the thought read: a type's label
is the vocabulary's, and on the line of a renamed type it would be paid on
every read of every thought of that type, while `brain_get_thought` on the
type and `brain_list_types_and_tags` show it. `brain_traverse` and
`brain_search`: their nodes and hits carry no label as far as the tools, it
would take a field through `src/operations/` and `src/semantic/`, and the
index keeps none for a hit whose read failed; a thought chosen from either
is read with `brain_get_thought`. And a rename of a type does not say that
the type keeps its old name for a label: `brain_update_thought` reads
nothing before a rename, so it does not know that it renames a type, and a
sentence in the description of `name` would be paid by every session for a
call that is rare.

**A name that does not show is spelled out, not refused.** A thought can be
named with one zero width space, a byte order mark or a Hangul filler: the
API stores such a name as it stores any other (§7, item 23). Every tool
printed it as it is, which reads as no name: `# ` and an identifier, a row
with a cell missing, `name = ""` after a rename. And `table()` trims the end
of a row, so a byte order mark in the last cell went with the padding.

Refusing such a name on a write was the other way, and was left. Every
refusal in this server is for a request the API answers with a 200 and does
not carry out as asked; this one it carries out. A refusal would not reach
a thought named in the app or by another client, so the read tools need an
answer either way. It could not be whole: by its Unicode properties the
braille pattern blank (U+2800) is a symbol like any other, and a list of
characters that look empty would be a guess. And a blank name is something
a person can want.

So `shownName()` prints `(no visible character: U+200B)`, the name's code
points, in place of a name whose every code point has one of three Unicode
properties: `White_Space`, `Default_Ignorable_Code_Point`, or the general
category `Cc`. Nothing is judged: a name with one code point outside them
is printed as it is, which is an emoji, a single symbol, and a script the
runtime's tables do not know yet. Wrong one way, a name that is blank to
the eye and not by those properties prints as it did. Wrong the other way,
a name some font does draw is given by its code points, and those are the
name: nothing is lost, up to the eight that are spelled out. It is used by
`brain_get_thought`, `brain_traverse`, `brain_list_types_and_tags` and
`brain_recent_changes`, in the question a deletion puts, and in the result
of a create and of a rename, where the caller can still put it right.
`table()` does the same for any cell that holds something and shows
nothing, which covers a search hit and a batch's table. A name that shows
costs nothing: its result is what it was, to the character.

Three places were left out of that at first and printed the name as it is:
the active thought of `brain_list`, a refusal that quotes the name of a type
or a tag, and a batch's lines under "Failed" and "Skipped", where a thought
read `thought "" (t1)`. They go through `shownName()` now, and so do a
batch's warning about notes that lost a line, the thoughts `brain_index`
lists as not read, and the message for a create answered with an identifier
of zeros. A refusal is worded in the API layer and a batch's line in the
operation, both below the tools, so the function is defined beside
`codePoints()` in `src/api/names.ts`, and `respond.ts` passes it on to the
tools. That module imports nothing: `resources/kind.ts` words the refusals
and `resources/thoughts.ts` reads a kind through it, so with the function in
`thoughts.ts` the two imported each other. A test walks the imports under
`src/` and fails on a module that is loaded by way of itself.

### What stands above a type or a tag

A type can have a type, and a tag can carry a tag: a link of meaning 3 and
one of meaning 7 (§7, item 25). And a thought created under one type with
another for its `typeId` has two types, which the tools cannot make any more
(§7, item 18) and a brain made before can hold. In each the graph lists what
is above among the parents. Three things followed from that.

**`typeId: null` failed, or said more than it did.** On a type's type it
waited out the read-back and answered that the link was not found, with the
type in place: `detachType()` knew meaning 2 alone. On a thought with two
types it deleted the link `typeId` named and answered "Done": the thought
read `typeId: null` and kept the other type, in its graph and in TheBrain.
Now `isTypeLink()` takes 3, and `removeType()` reads the graph beside the
thought and deletes the link of every type the thought is linked under, each
only when it is a type's link with the type at its head. Two other answers
for two types were weighed. *Removing the one `typeId` names and saying the
other is there*: the thought is left with a type that reads as none, and
nothing takes the second away, since `typeId: null` again finds `typeId`
null and no patch does it (`docs/api-map.md`, L44). *Refusing, with a
sentence that says what is there*: the same thought, as it is, with nothing
the tools can do about it. The call asks for no type, and both links are the
type's: deleting them is what was asked, and deletes nothing that is not the
thought's type. The cost is the read of the graph, five requests where
`typeId: null` took four.

**What is above is not called a parent.** `getGraph()` filtered the type
alone out of the parents, by `typeId`. The tag a tag carries stood there, and
under "Tags" as well, marked `[tag]`, and `brain_traverse` walked to it as to
a parent; the second type stood there marked `[type]`. That is what the tools
say a type and a tag never are (§7, items 18 and 21), and a model that took
it for a parent would link under it and be refused. A parent is now the upper
end of an ordinary link, by the link the two share in the graph's own
`links`, where the API lists it for every thought above (contract tests). A
thought above with no link listed is kept unless it is the type, as before.
Filtering by kind would say the same of every graph measured, and was not
taken: the link is what the API says the two are to each other, and a kind
says it only by inference. The tag a tag carries is in `tags`, as a tag on a
thought is. A second type is in `otherTypes`, and `type` is the one `typeId`
names: the graph's own `type` named either of two, the type of the higher
identifier on the first read and one or the other after, changing from read
to read (L44). `neighbourIds()` follows `otherTypes`, so the indexer's walk
reaches what it reached through the parents, and a thought of two types is
indexed with the same type from read to read.

**What `brain_get_thought` prints.** A tag on a tag, where "Parents" followed:

```
# gotcha
922104f9-3793-4964-a091-7ebdc791a632 [tag]

## Tags
measured
```

A type with a type prints its type under "Type", as it did. A thought with
two types, `typeId`'s first:

```
## Types
- Pattern — 9e00b6a1-52c3-4f0e-9a7d-0c8f3e1d2b45
- Method — 35e1c2d4-7a8b-4c9d-8e0f-1a2b3c4d5e6f
TheBrain links this thought under both. typeId null in brain_update_thought removes both, and a type is set only once they are gone: to keep one, remove both, then set it.
```

The line is there because the obvious next call would go wrong, and is now
refused (below). It costs 168 characters on a thought of two types; a tag on
a tag is 68 shorter, and every other result is what it was, to the
character. `tools/list` did not change.

**A type the patch would not set is refused.** Three `typeId`s are a 200
that does not do what was asked (L44): on a tag it sets nothing; on a type
that is the named type's own type, nothing either; on a thought of two types
the other of the two, or `typeId` again, changes nothing, and a third comes
in beside one of the two. The tool answered the first two and the other of
the two once the read-back wait ran out, that the type had not read back
yet, and the rest
"Done". `update()` now reads the thought's graph after the type and ahead of
any write, and refuses each: `type_on_tag`, `type_cycle`, and `two_types`,
which names both types and says to send `typeId: null` first and the type
after. Doing both in the one call was not taken: it would take away a type
the caller may not know of, for a state the tools no longer make. The
graph's copy, read straight after two type links were deleted, listed both
19 times of 20 (after `removeType`, none of 20), so two types are counted by
`links.between()`, which is not behind. A type that reads as none beside
another's link is one type, which a third replaces (3 of 3), and is let
through. The cost is one read more on every type set, four requests at the
least; a refusal is two requests, four for two types, with no write and no
wait. A longer chain of types back to the thought is not looked for, and not
measured.

### What changed, and to which thought

`brain_recent_changes` printed names and no identifiers, and read the name of
at most sixty thoughts a call. The organize skill's hunt for orphans is that
call and then `brain_get_thought` on what it lists, and it stopped at the
second step: carried out through the real handlers on 15.0.640, the result
of the first call held 25 rows and not one identifier. The way from a name to
an identifier is a search, and `brain_search` by the exact name found neither
of two thoughts made a moment before: a name is found some five seconds after
a create (§7). Past sixty thoughts a row read `(name not read)`, and every row
about a deleted thought `(deleted)`, with nothing to say what had been
deleted.

**The log has the name.** A thought's own `101` carries the name it was
created with, its `103` the old name and the new, its `102` the name it had
when it was deleted (`docs/api-map.md`, row L37; over one brain's 159,451
entries, every one of 48,013, 639 and 48,012). Of the kinds of entry that log
holds, no other names a thought. A `101` says nothing of the thought's kind,
which the log has only where a kind was changed (`304`). The name is the first
140 UTF-16 code units of the thought's own.

So a row about a thought that is gone reads `name (deleted)`, by the name its
`102` kept: the name it had last, after a rename too. The log's word is taken
for it and the thought is not read. A thought that is read keeps the name and
the mark of its read. One that is not read, past the sixty or because its read
failed, has the newest name the log has for it, and `(name not read)` only when
the log has none. The reads go first to the thoughts the log has no name for,
so the cap falls on a mark before it falls on a name.

*The name then or the name now* does not come apart in the log. It is read
newest first with no gap, and a rename is in it when its request is answered,
20 of 20. So the newest name among the entries read is the thought's name as
of that read: a later rename would be a newer `103`, which was read too. Every
row about a thought shows that one name, as it did when the name came from a
read. A name as long as the log keeps one ends in `…`, and one with no
character that shows is spelled out as a read's is (`shownName()`, above).

Where there are both, the read's name is printed, not the log's, and that is
the older of the two for a moment: read straight after a rename, the thought
had its old name 18 times of 20, and the new one 31 to 197 ms later (row L28).
A call inside that moment shows the old name in every row about the thought,
the row `renamed` included, as it did before. The log's name would be right
there. It was not put first because a rename made in TheBrain's own window
was not measured: the log's name over the read's is wrong for good if some
rename logs no `103`, and the read's over the log's for 0.2 s.

What the log cannot give is the kind. A thought that was not read is unmarked
whatever it is, and `Totals` says how many there are: `thoughts not read: 2,
so a type or a tag among them is not marked`.

**Identifiers on request.** `identifiers: true` adds a section under the
table: each thought the rows name that is still there, once, in the form the
other read tools use. For instance:

```
## Changes since 2026-10-11 10:07
When (UTC)        What          Thought
────────────────  ────────────  ────────────────────────────────────
2026-10-11 10:07  deleted       Duplicate of Hybrid search (deleted)
2026-10-11 10:07  link created  gotcha [tag] ↔ Hybrid search
2026-10-11 10:07  created       Hybrid search

## Thoughts
- gotcha — 922104f9-3793-4964-a091-7ebdc791a632 [tag]
- Hybrid search — 3ffba89e-91b9-4caa-b45b-441b452cafc7

## Totals
events 3
```

The identifiers are the log's own, so the section costs no request, and it
lists a thought that was not read as well. A thought that is gone is left
out: nothing takes its identifier.

Measured on a week of work made for it in a throwaway brain, four articles
through `brain_ingest`, edits to fourteen older thoughts and two deletions, 77
thoughts, with a token at four characters:

| | 50 rows | 200 rows |
|---|---|---|
| Before | 4,006 characters (1,002 tokens), 27 requests | 15,915 (3,979), 61 requests, 9 names not read |
| Now | 4,138 (1,035), 25 requests | 16,154 (4,039), 61 requests, no name not read, 2 thoughts not read |
| Now, with `identifiers` | 5,737 (1,434), 24 thoughts listed | 20,176 (5,044), 62 listed |
| An identifier at every mention | 6,556 | 27,464 |
| An identifier at a thought's first mention | 5,074 | 18,572 |

The last two rows are worked out from the same results, not built. The week
was made three times. The 200 rows came to the same sizes each time; the 50
newest moved by up to 14 characters, by the order a batch's writes landed in,
and the differences between the rows of this table did not move.

The default is the table alone, because the section is a quarter to two
fifths on top of it, 400 and 1,000 tokens here, and a caller who only
narrates the period has no use for it. The argument is 173 characters of
`tools/list`, 43 tokens, which every session pays: 17,930 characters to
18,103. An identifier beside every mention is 58% and 70% on top of the
table. One at a thought's first mention is the cheapest of the three, and
leaves the model to find which row that was; the section is one place to
look, and its lines are the ones `brain_get_thought` prints.

The default grew by 132 and 239 characters in that week, 3.3% and 1.5%: the
names of the two thoughts deleted and, at 200 rows, the nine names that had
not been read and the words about the two thoughts still not read. A deleted
name costs in proportion to the rows about deleted thoughts, and a period
that is nothing but those is twice the size it was. The 50 and 200 newest
rows of a brain where only this project's tests had run, every row about a
thought since deleted, went from 2,400 characters to 5,405 and from 9,091 to
18,983, and from 16 and 61 requests to one. Before, such a result was
`(deleted)` in every cell. Those are test names, some of them the full 140.

**Not known.** How a thought renamed or deleted in TheBrain's own window is
logged: all of it was measured through the API. What the kinds of entry that
log has none of carry, a thought pasted in (`104`) among them: only `101`,
`103` and `102` are read for a name. And whether a `102` is always the last
entry about its thought: in that log 14 entries, attachments made and
removed, name a thought after its `102`, which was not reproduced. Nothing
here goes by its being the last.

### A type or a tag, made

No tool could make a tag or a type. `brain_tag` said to "create a new tag via
brain_create_thought", which has no kind and makes an ordinary thought, and
since `brain_tag` refuses an identifier that is no tag (§7, item 17) the advice
led straight into a refusal. A plan of `brain_ingest` makes ordinary thoughts
alone as well. `brain_create_type_or_tag` makes either, by name.

**What the API does, measured on 15.0.640** (`docs/api-map.md`, row L39). A
create with `kind: 2` or `kind: 4` is answered with `{id}` and nothing else. A
type reads with its name for a label, a tag with none. Under the name of a
type the brain has, a second type is made, 95 pairs of names of 95 and the
same name 15 times of 15. Under the name of a tag the brain has, no tag is
made: the answer is that tag's identifier, the tag keeps its name, and nothing
of it changes or is logged. The names need not be the same. Of 95 pairs, each
tried two or three times with the same answer every time, these were taken for
one name: letter case, Greek final sigma for sigma, a capital sharp s; a
character and its canonical equivalent, decomposed or not; a ligature, a
superscript or circled digit, a digit of another script, a Roman numeral, a
mathematical bold letter, an ellipsis, or a sign such as ™, ㎏, № or the micro
sign, for what it stands for; a no-break, narrow, em, thin or ideographic
space for a space; and any character that does not show, a zero width space or
joiner, a byte order mark, a soft hyphen, a control, wherever it stands. These
were not: an accent, ß for ss, Turkish İ and ı for i, a long s, full width
letters and digits, hiragana for katakana, two spaces for one, a carriage
return, a next line or a line separator for a space, a Hangul filler or a
braille blank, a punctuation mark dropped, added or swapped for another, ½ for
1/2, œ for oe, another emoji or skin tone. Every name of characters that do
not show alone is one name. The rule looks like the platform's comparison of
text with case set aside; that is an inference, and this was measured on macOS
alone.

So the tool says which it was. "Created" for a tag that was there would be
untrue, and the name asked for need not be the name the tag has: asked for
`GOTCHA`, the brain has `gotcha`. The result reads `## Already there` with the
tag by its identifier and its own name, and a note that nothing was created,
that the name differs and why, and that the tag is as it was.

**The log tells the two apart.** The answer is an identifier either way. A
thought a create makes has its `101` among its own entries when the create
is answered, and later than every entry the log had before it, 30 of 30; one
that was there has its `101` earlier or not at all, 40 of 40, the call before
included. So `thoughts.createTypeOrTag()` reads the newest entry of the log,
creates, and reads the thought's own entries (`includeRelatedLogs=false`, so
that the entries of the thoughts a tag is on do not push its `101` out) and
then the thought. The lists cannot tell it: `/types` and `/tags` are a copy,
and listed a new one at the first read 10 times of 66, 417 ms later at the
latest. Four requests a call, where a create alone is one; a tool that makes
vocabulary is not called often, and a guess at the API's rule for names
would be wrong where the rule is not known.

**A name and a kind, and nothing else.** What else a create carries does
something of its own (row L39). A label or aliases sent with the name of a
tag that is there are written onto that tag. A source makes a link whose
meaning goes by the kinds at its two ends: a type created as the parent of a
thought becomes its type; a tag created as its parent is attached to it; a type under a type and a tag under a tag are the
catch-all 403 and make nothing; a tag created as a thought's child is an
ordinary link with a tag below. And a source with the name of a tag that is
there attaches that tag to the source. None of that is a parent in any sense
the tools have, and a type or a tag is reached from a thought by `typeId` and
`brain_tag`. A caption and colours are `brain_update_thought` afterwards, as
for any thought; the create takes no colour at all.

**Refusals before any write.** A name of white space or past 1,024 units is
refused by `nameRefusal()`, as for a thought: the API refuses the first and
cuts the second for a type and a tag too. An empty name and a kind that is
neither are refused by the schema. A `brainId` that is no brain stops at the
read of the log, which is the first request, with nothing written. A read of
the log that fails otherwise says that nothing was created and that the call
can be sent again. A create with no answer is hedged by kind: for a tag,
send the call again, since TheBrain makes no second tag of the name; for a
type, look in `brain_list_types_and_tags` first, since a second call makes a
second type. A read that fails after the create does not fail it: the result
is `writtenInPart()`'s, with the identifier under "Done" and what was not
read under "Failed".

**Why a tool of its own.** Two other ways were weighed.

- *A `kind` argument on `brain_create_thought`.* About 445 characters of
  `tools/list` where the tool costs 925, so some 120 tokens a session
  cheaper. But every other argument of that tool would have to be refused
  with a type or a tag, for the reasons above: `parentId`, `relation`, `note`
  beside them for one already there, `typeId`, `tagIds`, `label`, `aliases`.
  Its description tells the model always to give a parent. And a tag that
  was there turns "create" into "find or create", which a thought never is.
  One tool per intent (above): making vocabulary is not adding a thought.
- *Taking the advice out of `brain_tag` and saying that tags and types are
  made in TheBrain.* No new cost, and the server makes no vocabulary. But a
  model sent away mid-task either stops or does what this card began with:
  makes an ordinary thought to tag with, which `brain_tag` refuses.

The cost of the tool is 925 characters of `tools/list`, 231 tokens, which
every session pays: 18,103 to 19,028. `brain_tag` grew by four characters.

**Left as they were.** A plan cannot make a type or a tag: its `typeId` and
`tagIds` take identifiers of the brain's, checked before the first write. A
tag made inside a batch would be one more thing to report per line, its
"existed under another name" lost in a table, and a plan's writes run
several at a time, which is when a tag name is made twice. Making vocabulary
is rare and deliberate, so it is one call ahead of the plan. A type is not
deduplicated by the server: the API makes a second type of a name, the tool
does as asked, and the description and the result for a lost answer say so.
Finding a type by its exact name in `/types` first would keep a duplicate
out except within the copy's lag, and is a decision of its own. When to make
a type or a tag at all is the skills' (§3): the tool's description says only
to look in `brain_list_types_and_tags` first.

**The index.** A new type or tag is logged as a `101`, which a sync reads,
and its row has its kind: a default search leaves it out (contract test).
Nothing about the index changed.

**Not known.** What TheBrain's own window does with a tag name it has, and
whether the rule for names holds on Windows, where the comparison of text is
another library's. A type created as the parent of a thought that has a
type already.

### A link changed, and one removed

No tool could change what a link is or take one away. `brain_link` said what
joined two thoughts when it was not the link asked for, "the requested jump
was not added", and the model had nowhere to go from there. `brain_link`
takes `replace` now, and `brain_unlink` removes a link.

**What the API does, measured on 15.0.640** (`docs/api-map.md`, row L43).
Posted over with another relation, the one link a pair has is rewritten to
it under its identifier, its label, colour, thickness and direction kept,
144 times of 144 across every state a link can be in between an ordinary
thought and an ordinary thought, a type or a tag below it; the lookup of the
pair has the new kind at its first read, and the log a `402` and nothing
that names the relation. A jump keeps at `thoughtIdA` the end it was first
posted from. `DELETE` answers 200 with no body and logs a `102` with both
ends; the lookup has the link no more at its first read, and where the pair
had another has that one, from either end; the link's own read and a graph
read before are behind, a graph by 26–211 ms. Deleted again, a link is a 400
`Bad Request`.

**Changing a link is a post over it, and is no deletion.** With `replace`,
`brain_link` posts the relation asked for over an ordinary link of another
kind that joins the two, through `links.create()`, which reads an upper end
that is a type or a tag first and refuses it, as for any new link (§7, items
18 and 21). The result says what the link was and what it is: "## Link
changed", "identifier {id}: from jump to parent-child with toId above", and
"and keeps its label "…"", or the label replaced and quoted as a label
always is (*What a second run writes*). Over the link asked for it answers as
without `replace`, to the character, and with no link it links the two. It
takes no consent and no gate. Nothing is lost: the identifier, the label,
the colour, the thickness and the direction stay, and the same call with
the old relation puts the link back; only the end a jump was first posted
from may come back the other way round, which nothing shown here depends
on. A child it leaves with no parent is still linked to the other end.
Invariant 3 guards what a result cannot give back.

**Never a tag's attachment or a type's link.** Meanings 2, 3, 5 and 7, by
`isTagLink()` and `isTypeLink()`: posted over, the tag or the type would
go, which is what `brain_tag` and `typeId: null` are for and say so. Both
tools refuse them with nothing written, and point at those.

**Removing one is a deletion, and asks as deleting a thought does** (§6).
A link's label goes with it, a link made again is another link with another
identifier, and a thought it leaves with no link is shown next to nothing in
TheBrain, found by a search alone. So `brain_unlink` is off unless
`THEBRAIN_ALLOW_DESTRUCTIVE=1`, answers then with `brain_delete_thought`'s
sentence before any request, and puts its question through
`confirmDestructive()`: a form where the client has one, a call with
`confirm` where it has not, and a form that fails is a refusal. The question
names both thoughts, the link and its label, and a thought it leaves with no
parent, child or jump; the result says the same, and a warning for that
thought. A
deletion that got no answer is said to may have landed; a link gone between
the read and the deletion is the 400, told as that.

**The link is the lookup's.** `brain_unlink` is named by the two ends, and
removes the link `between()` gives, which is not behind a write. The two
graphs are read for the names and for a thought left alone, counted without
the pair's links, since a graph lists one removed a moment ago. Three reads
before the question, then the one `DELETE`.

**Why an argument and a tool.** Four other ways were weighed.

- *One tool for both, with a kind or "none".* One description where there
  are two, some 300 characters less. But a reversible change and a gated
  deletion would share a schema, `confirm` would mean nothing for one, and
  the gate would shut half a tool. And the change belongs where the model
  learns that the link is not the one it asked for: in `brain_link`.
- *Delete and create.* What a change would be if the post did not keep the
  link. It does, 144 times of 144, and the other way loses the identifier,
  the label and the rest, leaves a moment with no link, and needs the gate.
- *`PATCH /relation`.* 2 swaps the ends at every send and 4 does nothing
  (§7, item 19).
- *A link by its identifier alone.* No read tool prints one, and the two ends
  are what lets a tool refuse a tag or a type, and say which thought is left
  alone.

**Cost.** `tools/list` went from 19,028 characters to 20,318: 1,040 for
`brain_unlink` and 250 for `replace`, some 323 tokens every session pays.
`brain_unlink` without `linkId` brought it to 20,151. `brain_link` with
`replace` sends nothing more than without it.

**Left as they were.** `brain_link` without `replace` answers what it
answered, and so do the other tools. A plan of `brain_ingest` adds and never
changes or removes a link. `brain_unlink` refuses a tag's attachment and
says so.

**Not guarded.** Two thoughts joined by more than one link, which only posts
sent at once leave (`docs/api-map.md`, under artificial load): the lookup
may give none of them, and every post between the two is the bare 400,
passed on as it comes. Such a pair is mended in TheBrain. Not known: what
TheBrain's own window shows of two links between one pair, and of the end a
jump was first posted from.

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
- **Validated before the first write.** Cycles, dangling references, empty names,
  duplicate `tempId`s, a relation that is none of the three and a relation with
  no parent are rejected up front. So is what a read shows: a `typeId` that is
  no type, a tag that is no tag, a type or a tag named as a parent (§7, items
  15, 17 and 18), and a parent that no thought of the brain has (*When a
  thought of the plan is not created*, below). And the identifier of zeros
  for a parent or for an end of a link, which needs no read to be known for
  nobody's (§7, item 21). A plan either starts writing or does not — no
  half-written graph from a mistake that was visible in advance.
- **Idempotent.** Re-running the same plan reuses existing thoughts instead of
  duplicating them. Dedup is by `(parentId, relation, trimmed name)`: a thought
  is looked for where its relation puts it, see *What a second run finds*
  below. An **in-flight promise registry** makes it hold *within* one batch:
  two identical names in the same level resolve to one thought rather than
  racing each other into two. (This was a real bug, caught by a unit test.)
  A thought that is reused keeps the note it has, on every run: see *The note
  of a thought that was there*. And a tag or a label that is there is not
  written again: see *What a second run writes*.
- **Honest about what it did not do.** If a requested jump is between a thought
  and its own parent, the API would turn the hierarchy link into that jump, so
  the link is left as it is. The report carries a "Links that already existed"
  section with the mismatch spelled out, rather than counting it as created.
  A tag on one of the two, or its type, is no link that existed: it is left
  as it is too, and listed under "Links not added". `brain_link` answers in
  the same words (§7, item 21). So is the second of two links a plan asks for
  between one pair, and a label that takes another's place is quoted with
  the one it took (*What a second run writes*).
- **A failure takes its own branch and nothing else.** A thought that is not
  created leaves the thoughts under it unwritten and the links to them
  untried, and everything that does not hang on it is written to the end. See
  below.

#### What a second run finds

Deduplication is what makes a plan safe to send twice, and it rests on one
read: the graph of the thought a plan item hangs on. That read went wrong in
six ways, there is one thought it cannot find, and one case it does not
guard. Each was measured on a live TheBrain 15.0.640 through the real
handler.

**It looked among `children` alone.** A graph lists a thought created as a
child under `children`, one created as a parent under `parents`, and a jump
under `jumps`. A plan thought with `relation: "parent"` or `"jump"` was
therefore never found, and every run made it again: 24 of 24, half of them
next to an existing thought and half next to a `tempId`. Now a thought is
looked for in the list its relation puts it in, and **the same thought is the
same name under the same relation to the same thought**. That is what a first
run leaves behind, and nothing wider: which thought is close enough to reuse
is not the server's to decide (§3).

**A thought of that name under another relation is neither reused nor made
again.** The plan asks for a child and the parent has a jump of that name, or
the other way round. Before, a namesake among the children was taken for the
plan's parent or jump and listed as existing, with no word that the link was
another kind (4 of 4); a namesake among the parents or jumps was not seen, and
a second thought of the name was made (8 of 8). Neither is the server's call.
Reused, the thought gets the plan's children, tags, aliases and links. Made
again, it is a duplicate that only a human can remove (§6). So
the thought fails, with what hangs on it skipped, and its line gives the
namesake's identifier and both ways on: name that identifier in place of the
`tempId`, or send the thought with `deduplicate: false`. Two plan items of one
name under one thought with different relations are the same case: the first
in the plan is made and the other fails, on every run. Two thoughts share one
link, so one thought could not have been both.

**A thought with no parent is not looked for**, and a second run makes it
again with everything under it, 8 s later as 0.3 s later (2 of 2 each). There is
no graph to read for it. The only lookup left is by name, which lags a create
by 5.6 s (§7) and would land on any thought of that name anywhere in the
brain. So the `parent` argument says what leaving it out costs, and the skill
says to give the top of a plan a parent. The same name under two different
thoughts is two thoughts, each found again: one thought in two places is one
plan item and a link.

**A read that failed passed for "nothing there".** The error was swallowed,
and the thought was created though it might exist: with a 500, the generic
403 or a dropped connection put in on the way to the live API, beside the
one of its name that was there, 9 of 9. Now the thought fails, as one whose
create failed does: what hangs on it is skipped and the rest is written. One answer is not a failed read. The graph of an identifier nobody
has is a 403, in the words this API has for much else, a request dropped
under load included; the thought itself is a 404. When the thought says nobody
has it, there is nothing to look under, and the create goes out to be refused
in the API's own words. Such a thought was deleted after the plan was checked:
one nobody had by then rejects the plan (*When a thought of the plan is not
created*). A thought the batch created is not read at all:
nothing can be next to it yet, and a read that can find nothing could only
fail what goes under it.

**The graph is a copy, and the batch waits for it.** A graph that has been
read is answered from a copy, brought up to date about every 0.1 s (§7, item
20). Read straight after a create, it lacked the new thought 112 times in
120, and had it 10–205 ms later: as a rule, and not as a bound (below). A second run sent in that moment made the
children again too: 5 of 6. So `ingest()` returns once the graph of every
thought that was there before the batch lists what the batch made next to it,
read or not by this batch: the copy may be from an earlier read. It asks last,
after the notes and links, and gives up after 3 s. Then the outcome counts
what is still `unlisted`, and the result says to wait before sending the plan
again. The wait is 60–150 ms on a batch of one thought and nothing measurable
on one with notes and links: a plan of 20 thoughts and 10 links took 325–456
ms where it had taken 432–482, in 80 requests where it had been 86, since a
thought the batch created is no longer read.

**The other tools do not wait, so a plan that follows one does.**
`brain_create_thought`, `brain_link` and `brain_update_thought` return as
soon as their write is answered, and the graph a plan then looks in can be
the copy from before it. Through the real handlers, with the parent's graph
read beforehand, 20 times at each of 0, 25, 50, 100 and 150 ms after the
write: a plan naming the thought `brain_create_thought` had just made created
it again 8 times in 100, one naming a thought `brain_link` had just put under
the parent 14 times, and one naming a thought by the name it had just been
given 3 times. From 200 ms on, never (0 of 60). A create that got no answer
is the same case from inside a batch: there is no identifier to wait for, and
the plan sent again at once made the thought a second time, 6 times of 6.

Each of those tools could wait as a batch does. That puts a batch's 60–150 ms
and its three to six reads on every one of their calls, where
`brain_create_thought` takes 30 ms at the median in three requests and
`brain_link` 29 ms in four, and a rename would have to read the thought's
parents to learn which graphs to wait for. So the wait is where the read is.

**Before `ingest()` first looks next to an existing thought, it waits until
0.5 s have passed since this process last had a write come back**, answered
or not (`afterCopyLag()`), and then takes the graph at its word. It is a wait
by the clock, because nothing in a graph tells a copy that is behind from one
that is not. It costs no request, and no time unless a write came back less
than 0.5 s before, which a model's own turn never is: only calls sent in one
turn meet it. The batch's own writes are not waited for: what it makes next
to a thought it adds to what it read of that thought.

The wait was 300 ms, half as long again as the longest lag of one evening,
205 ms; after it 0 of 360 were made twice, and the plan after an unanswered
create found the thought 6 times of 6. The contract test behind it went red
in one run of ten on 2026-10-12 and in none of 160 the day after. Measured
that day after, 1,800 creates next to a thought whose graph had been read
0.3 s before: a reader polling every 10 ms first saw the thought more than
300 ms after its answer 7 times, 364 ms at the latest, all while the app was
slow to answer. Half a second is past that by more than a refresh of the
copy. Until BRMCP-75 the client also kept what each of its writes put into
the graphs, and read a graph until it showed that; it was sized for lags of
seconds under bursts of writes, which the server is not built for, and went.
With the graph read straight before the write, where the read straight after
it lacked the new thought 197 times in 200, and the plan sent the moment the
write came back, a plan found what a create under each relation, a link and
a rename had left, 8 of 8 (contract test). A second look before each create
was weighed and left: it is the clock again, one step on, paid by most plans.

**Not guarded.** A copy further behind than 0.5 s is taken at its word, and
the thought is made a second time. A thought this process deleted can still
be in a copy, and a plan that names it is told it existed: which graphs a
deletion shows in, and when, was not measured. And a write made in the app
or by another process is not known here at all.

**Two runs at the same moment are not guarded.** Two `brain_ingest` calls
sent at once with a thought in common each made it, 6 times of 6: neither
sees what the other is about to make. One process could queue its batches,
which would cover the calls one client sends at once to one server. It would
not cover two clients, which are two processes, nor a batch beside one of the
other write tools, and nothing measured says that a client sends two plans at
once. So there is no lock, and the skill says to send one plan at a time.

**Two thoughts of one name in one list are neither of them the plan's.** A
thought can have two children of one name, or two parents, or two jumps. The
one the graph listed last was taken for the plan's, with the plan's children,
tags and aliases, and the result said nothing of the other: 8 times of 8.
Which is last is not the order they were made in (the first made was taken 5
times, the second 3), and not the same from one read to the next: over ten
reads of one graph the two changed places for 6 pairs of 14. A second run
could land on the other one. So the thought fails as a namesake under another
relation does, and for its reason: which of two thoughts a plan means is not
the server's to say, and what a plan hangs on the wrong one stays there,
since no tool moves a link. Its line gives both identifiers and the same two
ways on. Listing both and taking one was the other way: the batch goes
through, and the model reads of the second thought after the plan's branch
hangs on the first.

**A relation with no parent is refused**, by `planLevels()` before a plan's
first write, by `brain_create_thought` before any request, and by
`thoughts.create()`. It used to be left out of the request, and the thought
was created with no link and reported as created. The caller asked for a
link and named nothing to link to; a thought with no parent is also the one
a second run cannot find. All three relations are refused alike, `child`
included.

#### The note of a thought that was there

A plan's note was written to every thought of the plan with the request that
replaces a note. For a thought the batch creates that is all there is to it.
A thought the plan found in place lost the note it had. Through the real
handler on 15.0.640, six times each, and the same six of six on the second
run of each plan:

| The thought had | The plan had | The thought has after | The result said |
|---|---|---|---|
| a note | another text | the plan's text | "notes written: 1" |
| a note | the same text | that text, written again | "notes written: 1" |
| a note | no note | its note | "notes written: 0" |
| no note | a note | the plan's text | "notes written: 1" |

The first row is the same for a thought found as a parent or as a jump, six
of six each. And a note written by a first run, then changed by hand, was the
plan's text again after the second run, the change gone, six of six. No
result said that a note had been there. The plan need not be a second run for
it: one that names a thought which happens to exist under that parent lands
on it the first time.

**A note that is there is kept. A plan's note is written to a thought with
no note, and never over one.** `ingest()` reads the note of each thought it
found in place and has a note for, and writes only where that read answers
that there is none. A thought with a note now has it after the run in every
case above, the note changed by hand included, six of six; a thought with
none is given the plan's; and the result says what became of each note.

Two other ways were weighed.

- *Replace when the plan asks for it*, by a flag on the thought or on the
  plan. It keeps the old behaviour one argument away, in the tool that writes
  fifteen notes a call, and a model that sets it to be sure erases what it
  has not read. A replacement that is wanted has a tool that reads the note
  first and reports what it erased, `brain_set_note`, and the result names
  the thoughts to use it on. The cost is a second call for the caller who
  does want to replace.
- *Append the plan's text to the note.* Nothing is lost at once, but every
  further run of the plan appends again. Checking first whether the note
  holds the text stops working as soon as a person edits that part, and then
  the plan's text is in their note twice. A repeat run must leave a note a
  person changed alone, and this does not.

So a plan's `note` means the note of a thought the plan makes, and the first
note of one it finds. What it does not do is change a note, which is what
the argument and the skill now say.

**The result says, for each note, which it was.** When the plan has a note
for a thought it found in place, the table of thoughts gains a `Note` column:
`written`, `kept: same text`, `kept: another text`, `not written` for one
whose line is under "Failed", and `-` where the plan has none. "Also" counts
the notes kept. When one of them is another text, a "Notes kept" section says
that the plan's text for that thought was written nowhere, and names
`brain_append_note` for adding it and `brain_set_note` as the tool that
replaces, with what that loses. It is no error: nothing failed, the note is
where it was, and what to do with the plan's text is the caller's to decide
(§3). A second run of a plan reads `kept: same text` down the column and has
no such section. A plan that found nothing in place, or has no note for what
it found, reads as it did, to the character.

"The same text" sets aside line ends and the blanks around the text. A note
reads back as it was written, 19 samples of Markdown out of 19, and a
twentieth sent with `\r\n` came back with `\n` (contract test). It also
takes the plan's text as TheBrain would store it: a note with a code fence
left open is stored without that line (§7, item 5), and compared as it was
sent it read `kept: another text` on the run after the one that wrote it,
with the advice to append the plan's text to it.

**A note that could not be read is not written over.** A failed read is not
the answer that there is no note, which is a 200 (*A read that fails inside a
tool*, below). The note stands under "Failed" with the thought's identifier
and why, the batch is an error, and the run that follows reads again. Its
line says to read the thought before writing the note and to add to one it
has: the report's last section names `brain_set_note` for a note that failed,
which would replace the note the batch left alone.

**Two plan items that are one thought write one note.** Their notes used to
be sent at once. Now the first item's is written, and the second finds it
there: `kept: same text` when the plan gave both the same, `kept: another
text` when it did not.

**What it costs.** One read for each thought found in place that the plan has
a note for, and no write where the note is kept. A second run of a plan with
twenty notes sends twenty reads where it sent twenty writes: no note is
logged as changed, and the index has none to read again. A thought the batch
made is not read, so a plan that lands on nothing sends what it sent.

**The read is not taken too soon.** A first note reads back as no note for a
moment after it is written, where the note had been read before (contract
test). Polled, the read straight after the write was stale 33 times in 52 and
had the text within 102 ms; read once after a pause, it was still stale 2
times in 20 at 150 ms and never from 200 ms on (0 of 60). A note that
replaced another read back at once. `ingest()` reads a note only after the
wait that stands ahead of its first look, 0.5 s from this process's last
write, so a note this process has just written is seen.

**Not guarded.** A note written between this read and this write, a few
milliseconds apart, is written over. And a note is read once a batch: what
another call writes while the batch runs is not seen.

#### What a second run writes

Nothing, when what the plan asks for is there. That held for thoughts and,
since the section above, for notes. It did not hold for tags and for the
labels of links, and two links of one plan between one pair were written at
once. Each measured through the real handler on 15.0.640, and what the API
does is in `docs/api-map.md`, row L35.

**A tag and a label were sent again by every run.** A plan of three thoughts
with three tags and two labelled links, sent a second time: 16 requests, 5 of
them writes, an attach for each tag and a `PATCH` for each label, under "tags
attached: 3" and "label updated", 18 runs of 18. A label written again is a
200 that changes nothing and logs nothing. A tag attached again is a 200 too,
and logs a `402` against the attachment each time: three a run, each of
which a sync then reads both ends of (§8) and `brain_recent_changes` lists as
"link moved".

Now a tag on a thought the plan found in place is looked up first, with the
lookup that finds a link (`links.hasTag()`), and one that is there is counted
under "tags already attached" and not sent. A label is set against the name
the link has, as TheBrain stores a name (`linkNameAsStored()`: a tab and a
line feed a space each, the blanks at the ends dropped), and one that is
there reads `label already "motivates"`. The second run of that plan sends 11
requests, all of them reads, and logs nothing, 18 runs of 18.

What it costs: one read for a tag on a thought that was there, where there
were a read of the tag and an attach, so one request fewer when the tag is on
it and one more when it is not. A thought the batch made has no tag and is
not asked, so a first run sends what it sent, and reads as it did to the
character: 9 writes and 14 reads for that plan, beside the wait for the
graphs, before and after. The reads a plan makes ahead of its writes could
not answer instead. They read each tag for its kind, not for what it is on,
and the one read that lists a thought's tags is the graph of a thought the
plan hangs something on, which a leaf never is and which is a copy up to
0.5 s behind an attach. The lookup of a pair was not behind a write once in
80: straight after an attach, a detach, a link posted and a name patched, 20
times each. The read of a link by its own identifier is behind a patch, 20
of 20, which is why a label is read by the pair.

**A label that takes another's place is quoted.** A link has one label.
`brain_link` and a plan both wrote theirs over the one a link had and
answered "label updated", three times of three each, with no word of what it
had been. They still replace it, and say `label updated: it was "contradicts"
and is now "refines"`, the new one as it will be stored. A label written
where there was none reads "label updated", as it did.

Replaced and reported, where a note is kept. Two things are different. A note
can be added to, and the plan's text has `brain_append_note` to go to; a link
has one label and nothing appends to it, so a label kept is the plan's label
dropped, and the label is all a plan has to add to a link that is there (§7,
item 21). And what is lost is one line,
which is whole in the result: the call that set the new label can set the old
one back. A note's text would not fit in a result, which is why
`brain_set_note` reports its length and a plan does not replace one at all.

Whether this needs a person's consent (§6) was weighed, and it does not.
Consent guards what cannot be given back: a deleted thought takes its note,
its links and its attachments, and no result holds them. A label replaced
*without a word* was in that class, since the text was gone and nobody had
been told; quoted, it is one call from being restored. The tools that
replace a title or a caption ask nobody either. What changed is that this
one no longer does it silently.

**Two links of a plan between one pair are one link, the first.** Both used
to look up the pair, both saw no link, and both posted, at once. On the API
two posts sent together for a pair with no link are not one link rewritten:
they were two links 51 times in 60, each with its own identifier. Through
`brain_ingest`, 20 plans: 14 left two links under "links created: 2", 2 one
link under the same count, and 4 one link and a link under "Failed". Where
the two go the same way the lookup of the pair answers 404 from then on, so
the next run posted again and was refused, `Link could not be created.` for
both links, on every run. Where one link was left, the two labels were
written over each other on every run.

`ingest()` now groups the links of a plan by the two thoughts each joins,
after the references are resolved, whichever end is named first. The first
of a pair in the plan is looked up and written as before. Each other is
listed under "Links not added": `the plan has a link between the same two
thoughts ahead of this one, a -> b, and two thoughts share one link: this
one was not sent, and its label "y" was not written`. On every run, and
whatever became of the first: after a first that got no answer, a second
request can be the second link. 20 plans of 20 then left one link, the
first, on the first run and on the second.

Rejecting the plan before its first write was the other way, and it was
weighed for the same reasons as a link's end nobody has (*A parent nobody
has*, below). The pair is known only once the plan's thoughts are found: a
`tempId` can land on a thought the plan also names by its identifier, and no
look at the plan's references tells. A rule that rejects what it can see and
reports what it cannot would treat one mistake two ways. A plan rejected is
the whole plan sent again to drop one line. And it is what the module does
elsewhere: of two plan items of one name the first is made, of two notes for
one thought the first is written, and a plan thought's own parent link
beside a jump between the same two has always been reported, not refused.
What is left for the caller is the label, if it wanted the other one, which
is one `brain_link` call. It is no error, as a tag found between the two is
none.

The tags of a plan go the same way: one job for a tag on a thought, so a
tag named twice, in one list or by two plan items that are one thought, is
one attach. Two attaches of one tag sent at once left two attachments 11
times in 20.

**Not guarded.** Two calls at once for one pair, from this process, from
another or from TheBrain itself: each looks before either posts, and the
pair can be left with two links (`docs/api-map.md`, L47). A pair that
already has two links cannot be linked or labelled by any tool: the lookup
answers 404, so the tools post, and the post is refused. `brain_tag` asked
to add a tag that is on the thought looks first now, and sends nothing (§7,
*Tags: undocumented, but they work*).

#### When a thought of the plan is not created

The checks ahead of the first write leave a create few ways to fail: a plan
thought that deduplication lands on a type, so that `create` refuses the one
under it (§7, item 18); a parent deleted between the checks and the create; a
request that fails on the way. A parent identifier nobody has, which the API
answers with a 404, was one more, and the one that shows ahead of the first
write. It rejects the plan now: *A parent nobody has*, at the end of this
section.

The thoughts under the one that failed used to be created all the same. Their
parent resolved to nothing, so they were created with no parent, listed as
created, and followed by "Everything else was written". Nothing in the graph
leads to a thought with no parent, and deduplication looks next to a thought's
parent, so each further run of the plan made the same thoughts again.
Measured on a live TheBrain 15.0.640 with a parent nobody has: three batches,
two such thoughts each, and two more from every second run. A `tempId` that
read as a UUID was worse off: left unresolved it passed for the identifier it
spells, and its children went under whatever thought had it.

`ingest()` now keeps, for every `tempId` with no thought behind it, the
failure that is why. A thought whose parent is among them is not sent, and
joins them; a link with such an end is not tried; a note, a tag and an alias
go only to a thought that is there. The outcome has three lists: `created` and
`reused`, by identifier; `failures`, what was tried and why it failed;
`skipped`, what was not tried, each with the `tempId` of the failure it waited
on.

**The branches beside the failure are written to the end**, and the batch is
not stopped at the first failure. Stopping would not make it whole: there is
no rollback, up to five more creates of the same level are in flight when one
fails, and the thoughts already made would be left without their notes, tags
and links. It would only leave more for a second call, and a second call is
where duplicates come from: a thought is found again only next to its
parent, and one made with no parent is made twice. What is skipped is what
could not have been written where the plan put it. What is finished is what
the second call would have written.

**A batch written in part is `isError`**, though most of it may be there: read
as a success, its "Failed" section was one more section. The table of thoughts
gains a `tempId` column, and the last section asks for the failed and skipped
items alone, in a new plan that names what exists by identifier. That holds
whatever deduplication would have found. With no thought written there is
nothing to make twice, and it asks for the plan again. A batch written whole
reads as it did, to the character.

**A create with no answer is not a create that failed.** A timeout or a
dropped connection says nothing of what TheBrain did. With the answer to a
create dropped on its way back the thought was there, 3 times of 3, and the
batch reported it failed. `mayHaveLanded()` tells such a failure from a
refused connection, from an answer, and from a read that got none: a create
reads its parent and its type first, and a read wrote nothing whatever became
of it. The result says on that line that
the thought may exist and where to look before creating it again. A thought
with a parent is found by the next run, whatever its relation to it; one with
no parent is not.

**Nor is a note, a tag, an alias or a link that got no answer.** Only a
create was marked. A note whose write had its answer dropped stood under
"Failed" as `request exceeded 30000 ms`, like a write that was refused, with
the text in the note. Every write of a batch is now told from a refusal in
the same way, and its line says that it may have been carried out and to
read the thought before sending it again. The plan sent again finds such a
note there, and keeps it.

**Nor is a write whose answer broke off.** An answer whose body could not be
read after its status, a create's 200 among them, escaped the client as no
`TheBrainError` and read as a failure; it is a `network` failure now, with
the status kept. Each tool says which of the two it was (`landedWhy()`): no
answer, or an answer that broke off. The catch-all 403 to a write is a
refusal: a create carried out under it was seen only in bursts of concurrent
creates, which this server is not designed for (docs/api-map.md, L45).

**A line under "Failed" is explained as a call's own failure is.**
`describeError()` (§5) is what a call that fails whole is answered with, and
a batch's lines did not go through it. A create answered with the catch-all
403 read "An API key is required via the Authorization header", `Could not
create thought.` stood alone, and a 500 was its body and no more. `ingest()`
now returns what was thrown beside its own words for it, and each line is
what `describeError()` makes of that: the API's sentence where it names an
identifier, "Source Thought … could not be located", then what it means and
where to take identifiers from. Without "Nothing was written", which is true
of the write refused and would be read of the batch. A read that failed ahead
of a write keeps this module's sentence, with its cause explained the same
way.

**The report says each thing once, of the thought it is about.** Four places
where it did not, each seen through the real handler on 15.0.640, three times
of three.

*A line for a note, a tag or an alias named its thought by title.* Two plan
thoughts can share a title, and the tools that write a note or a tag afterwards
take an identifier. The line carries it now: `note for "Same" (<identifier>)`.
A thought that was not created has none, and is named by its `tempId` as it
was.

*Two plan items for one thought were two failures.* They are one create, by
the registry above. When it failed, the second item stood under "Failed" with
the first one's reason, though nothing had been sent for it. It is still not
sent on its own, and that is decided, not left over. A create of its own would
be the same request under another label: refused again while the cause lasts,
and a second thought when the first got no answer and was made all the same.
Made, it would leave one thought both failed and created, with what hangs on
the first item skipped. Whether to try again is the caller's to say, with the
reason in front of it (§3). So there is one request and one line under
"Failed", and the other item stands under "Skipped" as the same thought, with
what hangs on either. A namesake under another relation waits on the same
create to learn whether it is one, and is skipped the same way.

*The warning about code fences listed notes that were not written*, as notes
that "will be corrupted": the note of a thought that failed, and a note whose
own write failed. The outcome names the thoughts whose note was written, and
the warning goes by that. Of those it now names only the notes TheBrain did
not keep whole, each by identifier with the lines that went (§7, item 5): it
used to name every note with a fenced block.

*A `brainId` that is no brain was a failure a thought.* Every read ahead of
the writes is refused for such a brain, and the plan with it, in the words
`describeError()` has for it (§5). A plan that names nothing in the brain, no
parent, type or tag, sends none of those reads: each create at its top was
refused in turn, with the API's bare 401 on a line of its own and "Fix the
cause and send the plan again" under them. That plan reads the brain first,
which is one request for the plan that had none ahead of its writes. Any other
plan sends what it sent.

**A parent nobody has rejects the plan, before its first write.** A wrong
identifier in `parent` was the one way into all of the above that showed
ahead of the first write. Through the real handler on 15.0.640, three times
of three each: with a branch beside it that could be written, the batch wrote
that branch, 2 thoughts, a note and a link in 15–19 requests, and listed the
thought under "Failed" and what hung on it under "Skipped"; alone, it took 5
requests, four of them reads of the identifier nobody has, to say that no
thought was written. The read that checks a parent for a type or a tag (§7,
item 18) had the answer before the first write, a 404, and let it through for
the create to refuse. `requireParent()` hands back what it read, null for an
identifier nobody has, and `ingest()` refuses the plan by that, as it refuses
one with a reference to no `tempId`:

```
Plan rejected, nothing was written: thought "top" references parent <id>, and
no thought in this brain has that identifier. It may have been deleted, or be
another brain's. Take identifiers from brain_search or brain_get_thought. Fix
it and retry.
```

Every identifier nobody has is named, each with the first plan item that
names it. The two plans above are rejected in 2 requests and in 1, none of
them a write, in under 10 ms. A plan whose parents are there sends what it
sent: the read is the one already made.

What is read ahead of the writes, and what is not:

- *A thought's `parent` when the thought is its child, and the upper end of a
  child or parent link.* Read for its kind as before, at no request more.
- *A thought's `parent` when the thought is made its parent or its jump.* No
  kind is refused there, so nothing read it, and its branch was lost in the
  middle of the batch all the same: 3 of 3 each, one thought written beside
  it. It is read now for whether it is there. That is one read, 0.4 ms at the
  median, for each such thought the plan does not also name as a parent, and
  none for a plan that names no type, tag or parent besides, where it takes
  the place of the read of the brain.
- *The lower end of a child or parent link, and the ends of a jump.* Not
  read. Such a link fails at its turn, with the API's 400 that names the
  identifier, after everything else of the plan is written: 3 of 3 for each
  of the four. One read each would reject those plans too, and it is cheap:
  ten took 0.9 ms, and a plan of 10 thoughts and 10 jumps to existing thoughts
  would send 53 requests where it sends 43. It is left out for what each way
  leaves the caller to do. A link that fails takes nothing with it, and what
  is left is that one link, for `brain_link`. A plan rejected is the whole
  plan sent again, notes included, to correct one link.

The rule is the plan's, not `requireParent()`'s. `brain_create_thought` and
`brain_link` go on to their write when the parent reads as nobody's: it is
their first write, the API refuses it in words that carry the identifier,
and a refusal of their own would save one request.

It does not end failures in the middle of a batch. A parent can be deleted
between the plan's checks and the create under it, and a thought deleted a
moment ago still reads for up to 0.15 s (row L3). The thought under it fails
then, at the look next to its parent or at the create, and everything above
holds.

Nothing is deleted to tidy up after a failure. Deletion needs a human (§6).

### How long a batch waits, and for what

**Three seconds at the end.** The graphs a batch waits on at its end are
answered from a copy, 0.1–0.4 s behind a write as a rule and 1–3 s after
one batch of up to 200 thoughts (§7, *Write visibility*). So `LISTED` reads
each graph every 100 ms, about as often as the copy is brought up to date,
for three seconds at the most. It costs what the copy is behind and no more,
and all three seconds only where a graph never shows the write.

**Aliases accepted and not read back are said as that.** `ingest()` counted
a list that did not read back as written, and the batch read as done. Now
it is under "Aliases not read back", in `brain_update_thought`'s words
(*Accepted, and not read back*): accepted, do not send again,
`brain_get_thought` shows them once TheBrain catches up. The result is
`isError`, and "Next" says that every write was accepted. Each list is
written through `changeAliases()`, six at a time, with its own wait
(`READ_BACK`), which costs nothing where the list reads back.

**The longest call.** By its waits, one `brain_ingest` call takes at most
0.5 s by the clock before its first look and 3 s for the graphs at the end,
and the requests' own time; an alias list that does not read back adds its
own 3 s.

### A call about one thought, written in part

Four tools write more than once in a call. `brain_create_thought` makes the
thought and then writes its note and its tags; `brain_update_thought` patches
fields and then edits aliases; `brain_tag` works through two lists;
`brain_delete_thought` deletes and then takes the thought out of the index.
Each threw at the first failure, `guard()` made the exception the whole
result, and what had been written before it went unsaid. The other write
tools make one write a call.

Measured through the real handlers on 15.0.640, three times of three each. The
failure was caused on purpose where the API would give one: a tag deleted
between the check and its turn, a colour that is not `#rrggbb`, aliases past
the limit of a hundred. Elsewhere it was put in on the way to the live API: a
500, and an answer dropped on its way back.

- `brain_create_thought` answered the note's 500 alone, `boom (POST
  …/update)` as a 5xx read then, for a thought that existed, and the same
  call sent again made a second one. With a tag deleted in between it
  answered "tagId … is not a tag … Nothing was written", over a thought with
  its note and one tag.
- With the answer to its create dropped it answered that the request had
  exceeded 30000 ms and to check that the desktop app is running, and the
  thought was there.
- `brain_update_thought` given a name, a caption and a colour by name answered
  the colour's 400, with the name and the caption changed. Given a name and
  aliases that would pass a hundred, it answered the limit's sentence, with
  the name changed.
- `brain_tag` given three tags, the second deleted in between, answered
  "Nothing was written" with one tag attached.

**One shape, `brain_ingest`'s.** A call that stopped part way is `isError`,
so that it is not read as done, and it is not the error alone, which was read
as nothing done. "Done" lists what was written, the thought by its
identifier; "Failed" the step that failed, with why; "Skipped" the steps
after it, which were not tried; "Next" says that nothing is rolled back and
what to call for the rest: `brain_set_note` and `brain_tag` with the new
thought's identifier, and never a second create. The reason under "Failed" is
`describeError()`'s. Once something stands under "Done" it is given without
its "Nothing was written", which is true of the step refused and would be
read of the call.

**"Failed" is hedged, and a step is listed there only when its write was.**
A step can fail after its write went through. A write that got no answer may
have been carried out, and its line says so. A type or aliases can be
accepted and not read back in time, and the line says that. A 5xx says nothing of what it
wrote, and its line, in `describeError()`'s words, says to check what the
write left. So "Next" says that what is under "Failed" was not done *unless
its line says otherwise*. And the read that
waits for a write no longer fails the write: a read-back that threw used to
pass its error on as the step's, and aliases that were in the brain stood
under "Failed". A failed read has not shown the write, and no more: the wait
goes on to its end, and the write is then told as accepted.

**Accepted, and not read back.** A type set or removed and an alias list
are waited for until a read of the thought shows them (`READ_BACK`): a read
every 50 ms, for 3 s at the most. A read is 0.1–0.4 s behind a write as a
rule, and 1–3 s after one batch of up to 200 thoughts (§7, *Write
visibility*). A write the wait does not see is `not_read_back`: "TheBrain
accepted …, and the thought did not read back with it within 3 s … Do not
send it again". That is no write that may have landed, which says to look
first: this one landed, and a look would show the old value. It stands under
"Failed", or is the whole result, and never under "Done": aliases listed
there read as a list to build on. It stops `brain_update_thought` as any
failure does; the fields after it are under "Skipped", and "Next" says that
they are safe to send.

The danger is the next edit. The alias list and the removal of a type are a
read, then a write, and one built on a read from before the unread write
undoes it: the second alias edit wrote the old list with its own alias, and
a removal found no type and passed for done. The aliases' line says so. The
server does not hold such an edit back: a write that has not read back in
3 s is out of the ordinary, and what it costs is an alias or a removal sent
again.

**A call stops at its first failure, where a batch goes on.** A batch's
writes are in flight together, and what it leaves for a second call can be
made twice, so it finishes what it can. Here the writes follow one another on
one thought, and with the identifier in the result every one of them can be
sent again and makes nothing twice. What fails after a write that went
through is most often the connection, and each further try could wait out the
timeout with the identifier still untold: a client that gives up on the call
first would lose it after all. One line under "Failed" is also the cause, and
not the same refusal once a tag.

**A call with one thing to do fails as it did**, to the character: its error
is the whole of the result. So does a create that is refused, since nothing
hangs on a thought that was not made, and the call is its own retry. The
first of several writes failing is given the shape, with nothing under
"Done": its error alone says nothing of the writes that were not sent after
it. The result of a call written whole is what it was, which tests pin for
all four tools.

**A create with no answer** is told as `brain_ingest` tells it: the thought
may be there with no identifier to give, and the result says where to look
before creating it again, next to its parent or, for a thought made with
none, by name.

**One field to a request.** `brain_update_thought` sent its fields in one
patch. The API applies a patch an operation at a time, keeps what it wrote
before the one it refuses (`docs/api-map.md`, row L19), and does not say which
that was, so a refused patch cannot be reported field by field. A field sent
alone is written or it is not. Sixty thoughts patched a field at a time, four
or five fields each, read back whole every time. It costs a request a field
past the first: 22 ms for four fields where one patch took 18, and nothing
measurable for two. The type goes first, since what refuses a `typeId`
refuses it ahead of the write, and that has to be ahead of every write of the
call. A type takes the wait for its read-back either way: 164 ms at the
median with four other fields, where the one patch took 182.

**The alias edit is told the name the call has just written.** An alias
equal to the thought's name is not one, so `changeAliases()` drops it, going
by the name it reads. Straight after a rename that read still returns the old
name, 19 times of 20. So a call that renamed a thought and kept the old name
as an alias, which is what the organize skill suggests for a rename, lost it
and answered "aliases unchanged", in a result that was no error: 10 times of
10 as the tool was. With a type in the same call it kept the alias, 10 of 10,
only because the wait for the type came between the patch and the read, and
the type going first would have ended that. The API has no such trouble: it
kept the old name as an alias sent straight after the rename, 20 times of 20.
`changeAliases()` takes the name the caller has just written and compares
with that: 10 of 10 kept, with a type and without.

**"Was not on the thought" is said of a thought that is there.** The lookup
behind a removal is the same 404 for a thought nobody has as for a tag that
is not on one (`docs/api-map.md`, row L3), and `brain_tag` gave that answer
for both, in a result that was no error. It reads the thought before it gives
it, and passes the read's 404 on. A removal that finds its tag reads nothing
more, so the check costs one request on the answer it protects and none
anywhere else. Read ahead of the first write it would have cost that request
on every call, to refuse an attach the API refuses by itself, naming the
thought.

**A write result marks a type or a tag where it has the kind in hand.**
`brain_ingest` lists a thought it found in place with `[type]` or `[tag]`
after its identifier, as a read result does: a type or a tag can hang under a
thought as an ordinary child, the plan's thought of that name lands on it (§7,
item 18), and what the plan put under it is refused. The kind is in the graph
that found it. `brain_delete_thought` marks the thought in its question and
in its answer, from the graph it reads for the question: a type or a tag is
not one thought's own, and the person asked should see which it is. An
ordinary thought is unmarked, and what a call created is ordinary. Not marked:
the ends of a link, in `brain_link` and in a plan's links. The upper end of a
parent or child link is read, and refused unless it is ordinary; the lower end
and both ends of a jump are not read at all. A mark there would cost a read an
end on every call, against the rule above that a mark costs no request.

### A read that fails inside a tool

Seven tools read something beside the thing they are called for: a note ahead
of printing or replacing it, a graph on the way through a walk, the app's
state beside the list of brains. Six of those reads dropped their failure,
`.catch(() => "")` on a note and `.catch(() => null)` on a graph and on the
state, and what they put in its place is what the API answers when nothing is
there: no note, nothing next to a thought, no brain open.

Measured through the real handlers on 15.0.640, with a 500, an answer dropped
on its way back, a dropped connection and the catch-all 403 each put in on the
way to the live API, once each, and all four the same:

- `brain_get_thought` printed the thought with no Note section, in a result
  that was no error.
- `brain_set_note` answered "note created" and replaced a note of 18
  characters it had not read.
- `brain_delete_thought` put its question with no line for the note, and with
  `confirm` deleted the thought and the note with it.
- `brain_traverse` listed the thought whose graph had failed like any other,
  with nothing under it: 4 thoughts and 3 links where there were 6 and 5.
- `brain_ingest`, at the wait for the graphs (above), read the failing graph
  74 to 78 times over its two seconds and answered "TheBrain does not yet
  list 1 of the new thoughts", and to wait a few seconds.
- `brain_list` marked no brain open and printed no active thought.
- `brain_append_note` wrote nothing when the read ahead of its write failed,
  and answered with the read's error alone. With the answer to its write
  dropped it answered that the request had exceeded 30000 ms; the text was in
  the note, and the same call sent again put it there twice, with a note to
  begin with and without one.

One of these needs nothing put in. The read of a note answers the 403 for a
moment after the note's attachment is deleted, on a thought that is there
(`docs/api-map.md`, L3): each tool called straight after such a deletion met
it, 3 times of 3, and answered as above.

**A failed read is not one of the API's answers for "nothing".** A thought
with no note is a 200 from the note's read, with a sentinel, an identifier
nobody has included (L3), and a thought with nothing next to it is a 200 with
empty lists. So the two are told apart by the request having been answered,
and no read's failure is turned into a value now. What a tool does then goes
by what the read was for.

**A read ahead of a write that erases fails the call, and nothing is
written.** `brain_set_note` does not replace a note it could not read: its
result is where the model learns what it erased, and a note written over is
lost. Going on, and saying that the previous note was not read, would say it
after the fact. `brain_append_note` appends nothing, as before: its read
decides between an append and a first write, which replaces. Both now say
that nothing was written and which read failed, and `brain_set_note` to read
the thought before sending the call again. `brain_delete_thought` puts no
question and deletes nothing, with `confirm` as without: a question that
cannot say whether a note goes with the thought is not the question the
person answers, and consent that could not be asked for whole is refusal
(§6). A line "note: not read" in the question was the other way, and leaves
the person to decide on less than the tool is able to find out a moment
later.

**A read that is part of what a tool shows is left out, and named.**

- `brain_get_thought` prints the thought as read and, where the note goes, a
  "Note not read" section: that the read failed, why, that the result does
  not say whether there is a note, and to call again before relying on the
  note or replacing it. The result is `isError`. Read as a success, that
  section would be one more section, as "Failed" was in a batch written in
  part, and no Note section is what a model takes to `brain_set_note`.
  Failing the call whole was the other way: it throws away a graph that was
  read, and for the moment after a note is deleted it would hide a thought
  that is there. The graph's own failure is the call's, as it was.
- `brain_traverse` walks on. A "Not read" section names each thought whose
  graph could not be read, by identifier, with the reason, once when it is
  the same for all, and "Totals" says how many. It is not an error: like a
  search that some phrasings failed (§8), the rest is a result, and what is
  missing from it is named. The starting thought's graph failing is still
  the call's own failure. `traverse()` returns them as `unread`.
- `brain_list` lists the brains and adds "Open brain not read". It is not an
  error either: the list is whole, and `brainId` is never taken from which
  brain is open.

**The read that waits for a write names the graph it could not read.**
`ingest()` still asks to the end of its wait, since the next read may
be answered. When the last one failed too, the thought is returned in
`listingUnread` and not counted in `unlisted`, and the result has "Listing not
read" for it: the thought, how many new thoughts are next to it, why, and to
read it with `brain_get_thought` before sending the plan again. "Not listed
yet" is a statement about TheBrain, and stays for a graph that answered. The
batch is no error for it: what the plan asked for is written.

A graph that failed is asked again a step later, as one that answered, every
100 ms to the end of the three seconds. A read the app does not answer is
waited for to the request's own limit.

**A failure that is about the call is explained as it was**: an identifier
that is malformed, a `brainId` that is no brain, a key TheBrain rejects. The
write after the read would be refused in the same words.

**A note write with no answer may have been carried out**, and both note
tools say so, in the shape a create with no answer has: the failure's own
sentence, then "Next". `brain_append_note` says that the text may be in the
note and to read the note with `brain_get_thought` before sending the call
again, since sent again after an append that went through the text would be
there twice. `brain_set_note` says that the note may have been replaced, what
it held before the call, in characters or "no note", and that the call sent
again writes the same text. A write that is answered with a refusal is the
error it was, and the result of a call that succeeds is what it was, to the
character: tests pin both for the two tools.

**The 403 a note's read gets is no longer explained as an identifier that
names nothing.** `describeError()` said that of every 403, and the note of an
identifier nobody has is a 200. For the read of a note it now says that the
answer comes for a moment after the note is deleted and says nothing of the
thought or of its identifier. Within that moment `brain_set_note` now refuses
where it used to write and answer "note created", which was right by
accident. Measured over 12 deletions: the last 403 came 0 to 162 ms after the
deletion, and the thought and its graph read throughout.

No request is added anywhere: each of these reads was being made. The
descriptions say nothing of it, so `tools/list` is the size it was.

**An empty list is told from a 400 in other words, and from no more than
that.** `emptyOn400()` took any 400 from `/types`, `/tags` and `/pins` for an
empty list: with a 400 in other words put in, `brain_list_types_and_tags`
answered "This brain has no types or tags yet". It takes the three sentences
measured for an empty list now, one for each (row L1), and passes any other
400 on. What stays is that those sentences are the words of a failure, "Could
not retrieve list of Types for brain …", and name no cause: a list the API
could not read for a reason of its own, told so, would still be an empty
list here. No such failure could be produced, so it is a limit that is
known and not one that was seen.

**Left as they are.** `supportsAliases()` answers
yes when it cannot ask, and the write goes ahead (§7, on aliases). The read
that waits for an alias or a type to read back takes a failure for "not yet"
(above). `brain_recent_changes` prints the name the log kept for a thought
whose read failed, or "(name not read)" when the log has none, and counts it
among the thoughts not read. The indexer's own reads are in §8, *A read that fails while the
index is built*. And one thing about notes that is no read: a note written to
an identifier nobody has is stored, and reported as written (L3).

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

A `network` failure is one of three facts, and the client words them apart:
nothing listened at any address (`could not reach … — is TheBrain
running?`), no answer came in time (`request exceeded 30000 ms`), or the
connection failed before an answer came, with `fetch`'s own words for it in
brackets (`read ECONNRESET`, `other side closed`). After the first nothing
was sent. After the other two a write may have been carried out, which is
the line `mayHaveLanded()` draws (§4), and a connection that was there and
dropped used to be worded as the first. A fourth keeps the status: the answer
came and its body broke off (`TheBrain answered 200, and the connection
failed before the rest of the answer came`), and a write may have been
carried out after it too.

**The status is not the meaning.** The API answers a `brainId` that is no
brain with a 401, the status of a rejected key, in other words. It answers
the graph of a thought nobody has with a 403 that is about no permission, and
the other requests that name such a thought with a 404 that sometimes carries
the identifier and sometimes says only "Not Found". Read by status, a wrong
`brainId` sent the model to check its key, and a parent
nobody has was "Resource not found", with the API's sentence and the
identifier in it dropped. So the client makes two kinds of the 401, `auth`
and `unknown_brain`, and `describeError()` keeps the API's words wherever
they name what was wrong, names the thought or the link a bare 404 is about
from the request's path, and for the 403 says that no cause was given and
what that most often means: an identifier of the call that names nothing.
Not so for a request that carries no identifier, the app's state and the
list of brains, which was told the same.
A message never points at an identifier the
failure was not about: the one for a brain that is not there sends the model
to `brain_list` and says the other identifiers were not looked at; the ones
for an identifier nobody has do not mention `brainId`. And a refusal about
the brain is not turned into an answer: `brain_search` with no index used to
drop it and report nothing found. What each request answers is in
`docs/api-map.md`, row L3.

One answer names nothing at all: the 400 `"Could not create thought."`, which
a create gets under a parent deleted a moment ago and for a `typeId` nobody
has (rows L3 and L26). It was passed on as it came. `describeError()` now says
that no cause was given, which two it is the answer for, that nothing was
created, and to read the parent and the type before sending the call again.
It names both because the API names neither, and still not `brainId`.

And one that names what was wrong was passed on with nothing after it: the
400 a link gets for an end no thought has, `Could not get target thought
<id> (POST /api/links/<brain>)`, where a create under such a thought had its
404 explained. It is the line a model reads for a wrong identifier in a link,
from `brain_link` and under "Failed" in a batch, a plan's links being left to
fail alone (§4). It is told as that 404 is: the API's sentence, then that the
thought may have been deleted or be another brain's, and where identifiers
are taken from. Without the request, whose path has the brain alone in it.
"Source" and "target" are the link's first and second end, which is what
`fromId` and `toId` are described as.

**Degradation is reported, not hidden.** When semantic search falls back to the
lexical fan-out, the outcome carries `degradedReason` and the tool prints it. An
agent that does not know recall dropped will trust an empty result.

**A failure is not an empty result.** A search that could not ask is an
error, and one that asked with some of its phrasings names the ones it left
out. An index is not described before TheBrain has answered for the brain.
The rule and what it was measured on are in §8. The reads a tool makes beside
its own go by it too: a note that could not be read is not shown as no note,
nor written over, and a walk names the thoughts it could not look around (§4,
*A read that fails inside a tool*).

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
says.** It is what a person agrees to. It names the thought, marked when it
is a type or a tag, and counts its links, what stands under it, its note and
its attachments. Under a type that count is of "thoughts of this type" and
under a tag of "thoughts with this tag", in the words `brain_get_thought`
titles them with (§4): it said "children" of both, which a type and a tag
have none of. And the note is counted once, on its own line. The API lists
a note among its thought's attachments (`isNotes`), so "attachments: 1"
used to stand under "note: 18 characters" for a thought with a note and
nothing attached. `brain_get_thought` leaves the note out of its
Attachments section for the same reason: it stood there as "(unnamed) —
Notes.md", beside the Note section. The question is not put at all when the
note could not be read (§4, *A read that fails inside a tool*).

**The question for a link names both its thoughts.** By name, marked when one
is a type or a tag, with what the link is and its label, the links of the
pair that stay, and a thought the removal leaves with no parent, child or
jump. A change of a link's kind is not put to anyone: it keeps the link, and
the same call puts the old kind back.

---

## 7. What the TheBrain API actually does

Findings from reading the spec and then testing every one of them against a live
instance. Full detail in [`docs/api-map.md`](docs/api-map.md).

1. **`/types`, `/tags` and `/pins` return 400 when the list is empty**, each in
   a sentence of its own that reads like a failure. Treat that sentence as
   `[]`, and any other 400 as the error it is (row L1).
2. **A malformed UUID in the path returns HTTP 200 with an HTML page.** Validate
   before the request; sniff the body after.
3. **Five different error shapes** — bare JSON string, plain text,
   ProblemDetails, HTML, and an empty body. Normalised in the HTTP layer.
4. **`notes/append` on a thought with no note is a silent no-op.** Read first,
   then write.
5. **A code block that is closed is kept; a fence with no partner is
   deleted.** A note is stored as it was sent, but for `\r\n` and for the
   lines of two rules, each with a 200. Of the lines that begin with three
   backticks, whatever follows them there, the last is deleted when their
   number is odd; and a pair of them with no line between, the second of them
   bare, is deleted as a block with nothing in it. So a block left open
   loses the fence that opened it, and a line of prose that opens with a
   triple-backtick code span goes with its sentence. An append is gone over
   as the whole note, and the bare request joins its text to the note's last
   line: a closed block added so loses its closing fence, which
   `notes.append()` prevents with the blank line it sends first.

   This item used to say that a round trip loses the closing fence of a
   block, and the tools warned of it under every note with one, with the
   advice to indent code by four spaces. It came with the first commit, from
   a build that was not written down, and had no contract test. Measured on
   15.0.640, a closed block read back to the character 2,070 times of 2,070.
   The warning was untrue of nearly every note it stood under: it cost its
   words on each, taught a reader of results to pass over warnings, and its
   advice changed how a person's notes look.

   `noteAsStored()` is the rule, checked against 600 random notes of 600. A
   tool now warns of a note that lost a line and of no other, names the line
   by its number and by what it held, and says to write the note again. The
   note is written as it was given. *Refusing it* was weighed: the text is a
   200 that is not stored as asked, which is what this server refuses
   elsewhere. But nothing is lost that the caller does not hold, the line is
   quoted back, and a refusal in `brain_ingest` would reject fifteen notes
   for one stray fence. *Mending it* ahead of the write, by closing the
   block or by dropping the fence, would be a guess at what a line was meant
   for (§3). *Reading the note back* to see what was kept costs a request on
   every note written and meets the lag of a first note (§4); the rule costs
   none. `ingest()` sets a plan's note against a thought's as it would be
   stored, so a note that lost a line is "the same text" on the next run.

   Not measured: what the app's editor writes when a person edits a note.
   The API shows what the editor is given, the HTML form, and nothing of
   what it saves (docs/api-map.md, *A note's Markdown*).
6. **JSON Patch is not exposed.** Tools take flat fields and build the patch.
7. **Writes are not immediately visible** — see the table below.
8. **`SearchResultDto.brainId` comes back as zeros** from the search within
   one brain, and `brainName` as `null`. Use `sourceThought.brainId` (row L6).
9. **A thought's type appears both as `type` and as a parent** in `/graph`
   responses. Filter it, or types pollute every traversal. So do the tag a tag
   carries and the second type of a thought made with two, and `getGraph()`
   keeps a parent only for an ordinary link (item 25).
10. **A note is an attachment.** It shows up in `graph.attachments` with
    `isNotes: true`, and its log events are keyed by that attachment rather than
    by the thought.
11. **Search is prefix-based, not semantic.** This is the entire reason for §8.
    It also refuses a long query in two ways that say nothing of length: a 414
    with no body past 8,192 bytes of request line, and the 403 that names no
    cause for 513 to 1,024 words. The search resource makes `query_too_long`
    of both (§8, *A request that fails is not an empty answer*).
12. **The log keeps only the newest `maxLogs` entries**, with or without
    `startTime`. Reading all of it means paging back on `endTime` — see
    *Reading the whole log* below.
13. **`by-location` tells `Example.com` from `example.com`**, and a URL is
    stored as it was given, so the lookup alone cannot deduplicate links.
    `attachUrl` also compares the thought's own attachments, host case aside.
    That list is a copy, and the other spelling attached straight after was
    attached twice, 18 times in 20. So `attachUrl` reads the list only once
    0.5 s have passed since this process's last write (`afterCopyLag()`),
    after asking `by-location` for the spelling given; the list was 214 ms
    behind at the most, and the other spelling was then found 6 of 6.
    What the list has is asked for by `by-location` too before it counts:
    the list still had an attachment deleted 4 ms before, 6 times in 6.
    Another process, or the app, is still not seen while the list is behind.
14. **`null` clears nothing through `replace`.** A label and a colour are
    cleared with `remove`. A type is not cleared by any patch: `replace /typeId`
    with null answers 200 and leaves the type where it was, so
    `thoughts.update()` deletes the link from the type instead, and reads the
    thought back before it calls the type removed. Every type's link goes, a
    type's type of meaning 3 and both of two types among them (item 25). A
    link's name and colour go the same way, and on a name `replace` with null is
    another 200 that changes nothing. A link's thickness cannot be cleared, and
    reads back a hundred times what was written.
15. **`typeId` takes any thought, with a 200.** It is a link from whatever it
    names: a type becomes the type, a tag is attached, an ordinary thought
    becomes one more parent, and the last two leave the type as it was. So
    `update()` and `create()` read the kind before they write, and `update()`
    waits for the type to read back. A parent link towards a type sets it too.
16. **The log is not append-only.** A run of changes to a note is one `803`:
    while that entry is the newest TheBrain has logged, in any brain, the next
    change files it again under the new time. Only the newest entry ever moves
    — see *Reading the whole log* below.
17. **A tag's identifier is not checked to be a tag either.** The request that
    attaches a tag sets the thought's type when it names a type and adds a
    parent when it names an ordinary thought, each with a 200; and the lookup
    that finds a tag's link returns whatever link two thoughts share. So
    `attachTag()` reads the kind first, `detachTag()` deletes only the link
    that carries the tag, and a tool reads every tag it was given before its
    first write.
18. **A type is never a parent.** A parent or child link with a type above is
    the lower thought's type, set or replaced with a 200, and a thought created
    under a type has that type and no parent. `brain_link`,
    `brain_create_thought` and `brain_ingest` reported each as a link or a
    child. So `links.create()` and `thoughts.create()` read the upper end
    first and refuse a type with `not_a_parent`, and a tool reads what it was
    given for a parent before anything else it does. It is refused, not done
    and reported: the call asked for a link, the API can only set a type
    there, and `typeId` is the argument that asks for one. A jump to a type
    stays an ordinary link. That read is a 404 for an identifier nobody has,
    which is left to the write: only a plan is rejected by it (§4).
19. **Nothing is written as a sibling.** The spec lists a fourth relation,
    `Sibling = 4`. A link sent with it is a 400; a thought created with it is
    a 200 and a thought linked to nothing; a patch with it is a 200 that
    changes nothing. Siblings are thoughts with a parent in common: a graph
    lists them when asked, and no link joins them. The tools offered the word
    all the same. `brain_create_thought` answered "created thought" for one
    left with no link, and `brain_ingest` listed it as created and made it
    again on the next run. So the tools take `child`, `parent` and `jump`, and
    `Relation` has no fourth: a value that cannot work is not in a schema to
    be picked from, and one sent anyway is refused there, as an error the
    model reads, before any request. The server does not make a sibling by
    linking under the source's parent, because which parent is the caller's
    to say (§3); the arguments say to pass it. `thoughts.create()` and
    `planLevels()` refuse a relation that is none of the three, and
    `links.update()` takes no relation at all: patched to 2 a link swaps its
    ends on every send, and to 1 under a type it sets one (item 18).
    `links.create()` is what changes a link: it rewrites the one two thoughts
    share.
20. **`graph` is answered from a copy.** It is made when a thought's graph is
    first read, so that read is live, and brought up to date about every
    0.1 s after that. A thought created next to one whose graph had been read
    was missing from the read that followed 112 times in 120, and listed
    10–205 ms later; next to one whose graph nothing had read it was there at
    once, 60 of 60. How often it is missing went with how lately the graph
    had been read, when it was measured again: 355 times in 400 for a graph
    read straight before the create, 37 in 600 for one read 0.3 s before, and
    none in 36 for one read a second before, where the first count had 19 in
    20 for a copy up to a minute old. And the lag has no bound: of 1,800
    creates next to a thought read 0.3 s before, 7 were first seen in its
    graph more than 300 ms after their answer, 364 ms at the latest, all of
    them while the app was slow to answer. `ingest()` looks for a thought in
    its parent's graph, so it waits for the graphs to list what it made, and
    before it looks, for this process's last write to be 0.5 s old (§4).
21. **A tag is no parent either, an identifier of zeros is no link, and two
    thoughts share one link.** Three ways the tools reported a link that was
    not there, or not the one asked for, each measured through the real
    handlers.

    *A tag above.* A parent or child link with a tag above, and a thought
    created under one, is a 200 that attaches the tag: the thought is tagged
    and has no parent for it. `brain_link` answered "link created", and
    `brain_create_thought` and `brain_ingest` a thought created, with "tags
    attached: 0" beside it. It is refused as a type is (item 18), by the read
    that was there for the type, with `tag_as_parent`. Refused, not done and
    reported as a tag attached: nothing is lost by a tag, but the call asked
    for a parent and the thought would have none, and `brain_tag` and
    `tagIds` are what ask for a tag by name. A jump to a tag, and a tag put
    under a thought, stay ordinary links.

    *Zeros.* `POST /api/links` answers a link it does not make with a 200 and
    `00000000-…`: a thought linked to itself, under any relation, and a tag
    under a type. `brain_link` answered "link created" with the zeros after
    it. `createdId()` throws `zero_id` for such an answer, to a link and to a
    thought alike, and `links.create()` and `planLevels()` refuse a thought
    linked to itself before anything is sent.

    *Zeros sent.* The same identifier where a caller puts one. A create with
    it for a source is a 200 and a thought linked to nothing, under each of
    the three relations, and with it for a type a 200 and a thought with no
    type: the API takes it for none given, where any other identifier nobody
    has is a 404 or a 400. A note written to it is a 200, and a note that no
    read returns. Elsewhere it is an identifier nobody has. So
    `brain_create_thought` with it for `parentId` answered "created thought"
    for a thought with no parent, and the note tools that a note was written,
    three times of three each. `assertUuid()` refuses it now, with a
    malformed identifier and for the same reason, a 200 for what was not
    done. That is the one place every identifier of every request goes
    through, a plan's references and the indexer's reads included, which a
    check in the tools' schemas would leave out; and its kind is
    `invalid_uuid`, which the indexer already takes for a thought that is
    gone and the note tools for a failure of the call, not of a read.
    Nothing that carries it is sent, a read included. `brain_create_thought`
    and `brain_link` check their own arguments first, so the refusal names
    `parentId` or `toId` and not the API's field, and a plan is rejected for
    it with the plan item named (§4). An identifier of zeros in an *answer*
    stays `zero_id`: that one comes after a request, and says a write was not
    carried out.

    *The link that is there.* `GET /api/links/{a}/{b}` returns the one link a
    pair has, and a link posted over it replaces it. So the tools post
    nothing there, and used to say "already existed" whatever it was.
    `linkFound()` reads it by its `meaning` and by which end is its
    `thoughtIdA`, since the stored `relation` is 1 for a parent's link as for
    a child's, and both tools use its words: the link asked for; another
    ordinary link, named, with which end is above; or a tag's attachment or a
    type's link, which is no link between two thoughts. A label goes onto an
    ordinary link whatever its relation, as `brain_ingest` always wrote it:
    it says how the two relate, and that link is the one place to keep it.
    It does not go onto a tag's attachment or a type's link, where both
    tools used to write it. One that takes another's place is quoted with
    it, and one the link has already is not sent (§4, *What a second run
    writes*).

    *One link, when the posts come one after another.* Posted over the link
    a pair has, a link answers that link's identifier and logs a `402`,
    changed or not. Two posted at once for a pair with none were two links
    51 times in 60, and from then on the lookup of the pair answers 404 where
    both go the same way and a further post is a 400. `ingest()` wrote a
    plan's links six at a time, so two between one pair did exactly that. It
    sends one link a pair now, and one attach for a tag on a thought (§4).
22. **The search answers from a copy that is behind, and a hit is that
    copy.** The search of a brain has an index of its own, refreshed about
    every five seconds. Until the next refresh it returns a thought that was
    deleted, the hit the same to the last field as before the delete, and a
    thought that was renamed or given another caption, alias or note by its
    old text, with the old name in the hit. The lookup by exact name answers
    from the same index. A thought deleted within some tens of milliseconds
    of a neighbour of its own stayed in it for good 7 times of 720, and six
    such thoughts were still returned hours later, the oldest seventeen.
    `brain_search` listed every hit as it found it. It reads the thought of
    each hit now, and `findByName` its answer (§8, *A hit for a thought that
    is gone*).
23. **A name of white space alone is refused for a new thought and ignored
    for a rename, and a name is not stored as it was sent.** White space is
    Unicode's `White_Space`, 25 code points, which is not what `trim()`
    drops: a next line (U+0085) is of it, and a byte order mark is not. A
    create with nothing else for a name is a 400. A rename to it is a 200
    that changes nothing and logs nothing, and `brain_update_thought`
    answered "Done" and `name = ""`. A name is stored with each tab and each
    line feed as a space and without the white space at its ends, and one
    past 1,024 UTF-16 units is cut there, each with a 200. So a plan thought
    sent as `"a\tb"` was looked for under a name no thought has, and made
    again by every run. `nameRefusal()` refuses a name of white space and one
    too long to keep, in the resource, in the two tools ahead of their first
    read, and in `planLevels()`, where a next line used to pass and a byte
    order mark did not. `thoughtNameAsStored()` is the name a plan thought is
    looked for under and the name a result gives. A name of characters that
    do not show is none of this: the API stores a zero width space as it
    stores a letter (§4, *A name that does not show*). A link's name is
    stored by the same rule, to the code point and to the cut, and
    `linkNameAsStored()` follows it: it went by `trim()`, and a plan patched
    a label that ended in a next line on every run.
24. **A tag is made once a name, by a rule of its own, and a create says
    nothing of it.** A create with `kind: 4` under the name of a tag the
    brain has makes nothing and answers with that tag's identifier, as it
    answers for a new one; the names are matched with letter case,
    characters that do not show and the form of a character set aside. A
    type is made again under any name. And what a create carries beside the
    name is written to the tag that is there, or makes a link the kinds at
    its ends decide. So `brain_create_type_or_tag` sends a name and a kind
    alone, and tells a tag it made from one it was answered with by the log
    (§4, *A type or a tag, made*).
25. **A type on a type is a link of meaning 3, a tag on a tag one of 7, and
    a thought can have two types.** A type set on a type, by a patch, a link
    or a kind change, is a link the log calls `TypeOf`, and `detachType()`
    took it for a link that is not the type's: `typeId: null` waited two
    seconds and failed with the type in place. A thought created under one
    type with another for its `typeId` has a type's link from each; deleting
    either reads back as no `typeId`, the other staying its type, and no patch
    takes one away. `typeId: null` deleted the one `typeId` named and answered
    "Done". And the graph lists the upper end of each among the lower one's
    parents: the type of a type, which `typeId` filtered, the tag a tag
    carries, which is in `tags` as well, and the second type, which is nowhere
    else and which the graph's `type` names now and then in place of the first.
    `isTypeLink()` takes meaning 3, `removeType()` deletes every type's link
    the thought has, and `getGraph()` keeps a parent only for an ordinary link,
    with a second type in `otherTypes` (§4, *What stands above a type or a
    tag*; `docs/api-map.md`, L44). A type set on a tag, on the type's own
    type, or over two types is a 200 that does not do it, and `update()`
    refuses each ahead of the patch, by the thought's graph.
26. **A type is given its name for a label, and a rename leaves the label
    where it was.** A thought with no label reads with its name for one
    while it is a type, and with none again when it stops being one, as
    long as the label is still its name. A rename does not move it: a
    renamed type reads with the name it became a type under, keeps that as
    an ordinary thought after, and is found by it in TheBrain's own search.
    `remove` clears it. None of the giving and taking is in the log. The
    index embeds the label as it reads (§8, *The label of a type*), and the
    read tools print it where it is not the name (§4, *A label, read back*).
27. **A graph lists a thought once.** A sibling that is also the thought's
    parent, child or jump is under that list and not under `siblings`. So
    `siblings` is not every thought that shares a parent, and nothing here
    takes it for that (row L40).
28. **`statistics` is exact for thoughts, links, notes and web links, and
    behind for types and tags**: 0.04–0.9 s after one is made or deleted,
    and 2.8–6.6 s after a burst of writes. Nothing in the server reads it;
    the contract tests do, and wait for the two counts or leave them out
    (row L41).
29. **A log request with no `startTime` costs time by the length of the
    whole log**, however few entries it asks for: 135 ms for the newest 50
    of 170,000, and 15 ms with a `startTime` an hour back. Every reader
    here that can name a start does (row L42, and *Reading the whole log*
    below).
30. **A link posted over with another relation keeps the rest of it.** The
    post rewrites the one link a pair has under its identifier, with its
    label, colour, thickness and direction (144 of 144), which is what
    `brain_link` with `replace` sends. A `DELETE` takes a link away at once
    for the lookup, and a graph read before lists it for 26–211 ms more.
    `brain_unlink` removes the link the lookup gives (row L43, §4).

### Write visibility

Measured against a live API by polling until the result appeared:

| Operation | Delay |
|---|---|
| `create` → `get(id)` | instant |
| `rename` → `get(id)` | ~0.1 s, 102 ms at the most of 40; 130 ms beside another contract run. Behind what else the app was given to write: 1–30 s beside bursts of 300 creates in another brain, longer with each burst (24 renames in four minutes) |
| `set aliases` → `get(id)` | ~0.1 s, 0.2 s at the most |
| `create` with aliases → `get(id)` shows them | usually instant, up to 0.15 s |
| clear a label or a colour → `get(id)` | up to 0.2 s |
| delete a type's link → `get(id)` without `typeId` | 20–210 ms |
| set a type by `PATCH` → `get(id)` | ~0.1 s, 107 ms at the most |
| delete a link → the lookup of the pair | instant: the other link of two, from either end, or none |
| delete a link → `get(link)`, and a graph read before | 4–216 ms; 26–211 ms for a graph, which lists both of two links till then |
| a link posted over with another relation → the lookup | instant |
| `PATCH` a link → `get(link)` | 10–368 ms, 85–173 ms at the median of five spacings; there at the first read 12 times in 300. Behind bursts of writes to another brain up to 4.7 s, and once more than 5 s |
| `create` with a type → `get(id)` shows it | instant |
| the first `PATCH` after a burst of creates → `get(id)` | 0.6–0.8 s after 150, 2.6 s after 300 with a type |
| `set note` → `get note` | ~0.2 s |
| first note → `get note` | up to 0.15 s when the note had been read before: 8 first reads of 30 had none. At once when it had not |
| first note → the thought's `graph` lists it | up to 0.15 s for a graph read before: a copy, 10 first reads of 50 without it. Live on its first read |
| a note changed → the thought's `graph` | lists no Notes attachment at one read within 0.2 s of the change, then lists it again; the note itself reads at once |
| a note deleted → the thought's `graph` | still lists it for up to 0.2 s, while the note's read is a 403 |
| `attachTag` → `graph.tags` | ~0.1–0.5 s |
| a type or a tag created → `/types` or `/tags` lists it | 2–417 ms: a copy; at the first read 10 times of 66 |
| a type or a tag created → its own `101` in its log, later than the newest entry before the create | at once, 30 of 30 |
| a tag attached or detached, a link posted, a link's name patched → the lookup of the pair (`GET /api/links/{a}/{b}`) | at once, 20 times of 20 each, the lookup having been answered before the write |
| `create` next to a thought → that thought's `graph` lists it | 10–205 ms, about 80 ms at the median: a copy refreshed about every 0.1 s. First seen past 300 ms 7 times in 1,800 while the app was slow to answer, 364 ms at the latest: there is no bound. Live on its first read |
| `attach URL` → `by-location` | instant |
| `attach URL` → the thought's attachment list | up to 0.2 s: a copy refreshed about every 0.1 s. Live on its first read |
| delete a URL attachment → `by-location` | instant, 6 of 6; a list read before still had it at the first read 2 of 3, up to 75 ms, and within 4 ms of the delete's answer 6 of 6 |
| **`create` → `findByName`** | **~5.6 s** |
| `create` → full-text search | 3.7–5.5 s, at the next refresh of the search's index (13 runs). The vendor's documentation says up to 15 s, which was not once seen |
| a thought, a link, a note or a URL made or deleted → `statistics` | at the first read, every time measured |
| a type or a tag made or deleted → `statistics.thoughtTypes`, `.tags` | 0.04–0.9 s on a quiet app; 2.8–6.6 s after a burst of 100 creates |
| `delete` → `get(id)` is a 404 | 30–206 ms: the thought still reads at first, 80 times of 80 |
| `delete` → the search and the lookup by name stop returning it | 4.5–5.2 s, at that refresh; never for about one in a hundred deleted 9 to 38 ms after a neighbour |
| a new name, caption, alias or note → the search finds it by the new text | up to 5 s, at that refresh; by the old text, and under the old name, until then |

**The rule that falls out: after a write, address thoughts by identifier, never
by name.** `brain_ingest` links newly created thoughts through returned UUIDs
precisely because name resolution inside a batch would reliably miss.

> An earlier version of this project's notes claimed `nameExact` bypassed the
> index and returned instantly. A contract test measured 5.6 seconds. Faster than
> full-text, not instant.

### Tags: undocumented, but they work

A link's `meaning` field is the discriminator: **1** ordinary, **2** type,
**5** tag. It is read-only — `PATCH /meaning` returns 200 and silently ignores
you. The server sets it, inferring from the `kind` of the target thought. A
link's own `kind` is another field and no way to its meaning: a patch of it
takes 1, refuses 2 for a link with no `typeId` and does not keep it for one
that has, and refuses every other number (docs/api-map.md, *Tags*).

| Operation | How |
|---|---|
| Create a tag | `POST /api/thoughts` with `kind: 4` and a name. Under the name of a tag that is there it answers with that tag (§7, item 24) |
| Attach | `POST /api/links`, `thoughtIdA` = thought, `thoughtIdB` = tag, **`relation: 2`**. The server rewrites it to `relation=1, meaning=5` |
| Detach | `DELETE /api/links/{brainId}/{linkId}` |
| Read | `graph.tags` — a tag does **not** pollute `parents`, but the tag a tag carries does (§7, item 25) |
| List | `GET /api/thoughts/{brainId}/tags` (400 if empty, see #1) |

`relation: 2` against an ordinary thought (`kind=1`) produces an ordinary parent.
It is the target's `kind=4` that flips the behaviour. Against a type the same
request sets the thought's type, and between two tags it makes a link of
meaning **7**, which puts the upper tag among the lower one's tags and its
parents; `getGraph()` takes it out of the parents (§7, item 25).
`attachTag()` therefore reads the target and refuses anything but a tag, and
`detachTag()` deletes a link only when it is the tag's: meaning 5 or 7, from
the tag (§7, item 17). And `links.create()` refuses a tag above, so
that a tag is attached by the call that asks for one and by no other (§7,
item 21).

Attached a second time, a tag is a 200 with the identifier of the attachment
that is there, and a `402` in the log against it. `links.hasTag()` asks first,
with the lookup `detachTag()` uses, and a plan does not attach a tag that is
on its thought (§4, *What a second run writes*). `brain_tag` add asks the
same lookup and answers "was on the thought already" with nothing sent; a
link of the pair that is not the tag's is refused, since the attach posted
over it would make it the tag's attachment (`docs/api-map.md`, L23, L46),
and `brain_unlink` is named. `brain_tag` remove deletes the attachment the
lookup gives, and otherwise reads the thought before it says the tag was not
on it. Cost: add of a new tag one lookup more (4 requests), add of one that
is on 2 and no write.

**A tag attached twice**, which only attaches sent at once leave
(`docs/api-map.md`, under artificial load), is mended by no tool: the lookup
has neither attachment, add gets the bare 400, and remove says the tag was
not on the thought. It is taken off in TheBrain.

`statistics.links` does not count tags — links with `meaning=5` are excluded.

### Aliases: a list that only replaces

TheBrain 15.0.621 gave thoughts aliases: alternate names its own search
matches. The API sets them as a whole list and refuses element paths, so
"add this one" is a read followed by a write. That shaped three decisions.

**The tools add and remove; they never replace.** `brain_update_thought` takes
`addAliases` and `removeAliases`, and `brain_ingest` adds a plan's aliases to
the ones an existing thought has. A flat `aliases` field meaning "the whole
list" would mirror the API, and an agent that had not read the thought first
would wipe what was there, with a success message. The read-modify-write lives
in `thoughts.changeAliases()`.

**That method waits for its write to read back.** After a `PATCH` a read
usually still returns the old list: measured over 82 writes, the new one showed
up 50–100 ms later, 0.2 s at the most. Two edits in a row built on that stale
read left only the second alias. `changeAliases` polls until the list it wrote
is the list it reads, and says so when three seconds were not enough (§4,
*Accepted, and not read back*). It also
refuses a list that would pass 100: the API keeps the first hundred of a longer
one and says nothing.

Creation has the same delay, only rarely: of 60 thoughts created with aliases,
3 read back without them for a moment. One try had said "at once", and the
first version of the contract test asserted it. `brain_ingest` meets this when
a plan names the same new thought twice: the second item's aliases are added
to the first's, and the first's are taken from the plan, not from the read.

**The cost is on the argument, not in a consent dialog.** Per the spec, saving
the first alias in a brain makes it require TheBrain 15.0.621 or later on every
device. That is the user's call, and the server cannot tell a first alias from
a tenth: there is no way to ask whether a brain has any. So every argument that
can write one says what it costs, and the skill tells the agent to ask before
the first. A test checks that the sentence is on all three.

Builds before 15.0.621 send thoughts without the field; reads take that as no
aliases, and writes are refused before anything is sent, because what such a
build does with the field could not be measured.

### Enumerating all thoughts

There is no "list all thoughts" endpoint. The workaround: over the whole
modification log (read page by page, see below), `modType 101` (created) minus
`modType 102` (deleted) reconstructs the current population.

Cross-checked against an independent source: the log gave 43 live thoughts, 38
with `kind=1` and 5 with `kind=2`; `statistics.thoughts` = 38,
`statistics.thoughtTypes` = 5. Exact match. This check runs as an integration
test, so drift will be caught.

Caveat: log completeness has not been verified for imported or synced brains.

> **Correction.** The caveat was warranted: the log alone is not enough. On a
> live TheBrain 15 with brains created over years, three of eight brains logged
> far fewer thoughts than they hold:
>
> | `statistics.thoughts` | `created` events in the log | Found by walking the graph |
> |---|---|---|
> | 56 | 0 | 56 |
> | 44 | 1 | 46 (+2 types) |
> | 187 | 125 | 184 (3 thoughts linked to nothing) |
>
> A rebuild now takes the union of the log and a breadth-first walk over
> `graph` — parents, children, jumps, tags and type — seeded from the brain's
> `homeThoughtId` and from every logged thought, so islands cut off from home
> survive as long as the log knows one of their thoughts. The walk's graphs are
> reused for indexing, so a thought still costs one `graph` request. With the
> union, those three brains index 56, 46 and 199 entries; the last reconciles as
> 187 thoughts + 7 forgotten + 2 types + 3 tags. Forgotten thoughts were indexed
> before this change as well, through their `created` events.
>
> Still missed: a thought linked to nothing and absent from the log. There is no
> endpoint that could reveal it. The walk relies on a tag's graph listing the
> thoughts it marks, and a type's graph its instances, both as `children`; both
> have contract tests.

### Reading the whole log

One request returns at most `maxLogs` entries, and when the range holds more it
keeps the **newest**, newest first. That holds with `startTime` too, although
the spec says `maxLogs` counts "beginning from the `startTime`". Until this was
fixed, both consumers lost the oldest end: a rebuild over a log longer than
10,000 entries missed old `created` events, which the graph walk makes up for
except for unlinked thoughts; and a sync with more than 10,000 changes since its
watermark dropped the oldest of them and moved the watermark past them anyway.
View settings (`601`) made up 45–82% of the logs measured, so the limit comes
sooner than the size of a brain suggests.

**What a request costs goes by the log, not by what is asked of it.** With no
`startTime` the API takes time by the length of the whole log: on two brains
with 165,000 and 171,000 entries the newest 50 took 135 ms and the newest one
45 ms, where the newest 50 from an hour back took 15 ms (row L42). The whole
of such a log is 3.5 s in pages of 10,000. So a reader names a start wherever
it has one: a sync its watermark, `brain_recent_changes` its `since`. A
rebuild reads all of it, which it has to. The contract tests polled the
newest entries with no start in some twenty places, read the whole log in
three more and ran seven rebuilds that read it again; they read from the
start of their own run now (§10).

`brains.modificationPages()` pages back on `endTime` instead. It takes a
`since` to stop at and an `until` to start from, so a stretch in the middle of
a long log is read at the cost of that stretch. What it rests on,
measured on a live TheBrain 15, each point with a contract test:

| Question | Answer |
|---|---|
| Which of an entry's two timestamps does the API go by? | `modificationDateTime`: the response is ordered by it, and `startTime` and `endTime` are both compared with it |
| How far apart are the two? | `modificationDateTime` is never the earlier. Of 11,205 entries 258 were filed a microsecond after their creation and the rest at it, one write at a time as often as in a burst. A type change was up to 10 µs late, a note change up to 56 µs, and five note changes in a working brain 0.8–3.9 ms |
| Is `endTime` inclusive? | Yes, to the microsecond; `startTime` too |
| What zone are the timestamps in? | UTC, with no offset, microsecond precision and trailing zeros trimmed: `2026-09-30T13:48:59.61898` |
| Does the API read an offsetless bound the same way? | Yes, as UTC. An explicit offset is honoured |
| Can two entries share a timestamp? | Yes, under concurrent writes: 100 creates at once shared one in 57 bursts of 59, with 4 entries repeating another's at the median and 11 at the most. A single request that logs several entries stamps each one apart |
| Does an entry stay where it was filed? | Not a note's `803` while it is the newest entry TheBrain has logged, in any brain: the next change to that note files it again under the new time, both timestamps, and leaves nothing at the old one. An entry with another above it never moves, nor one that an entry in another brain has followed |

Each page asks for everything up to the oldest `modificationDateTime` of the
one before; `logTime()` is the one place that names the field. The entries at
that boundary come back again and are dropped by content. The boundary goes
back **as the exact string the log returned**: through `Date` it would lose its
microseconds and fall just before the boundary entry, and the entry with it. A
page filled by one timestamp cannot move the boundary, so the page doubles
until it can. Writes made meanwhile land above the boundary and do not disturb
it.

One kind of write also takes an entry away. A changed note does not always add
an `803`: while the note's `803` is the newest entry TheBrain has logged, the
change files that entry again under the new time, so sixty appends in a row
leave one entry, stamped at the last. Any other entry ends such a run, about
that thought or any other, and in any brain: the app keeps one "newest entry"
for all of them, so a write to another brain ends a run in this one. The `803`
a run leaves behind stays where it is for good. That is what keeps both readers
right. Only the newest entry ever moves, and a
reader paging back has it from its first page: the pages still to come do not
change under it. It holds the entry under the old time, and the entry in the
log carries the time of the latest change, which is after any watermark set
before that change, so the next sync reads it again. What the log cannot tell
is how many times a note was changed: `brain_recent_changes` shows one "note
changed" row for a run, dated by its last change.

The first version paged on `creationDateTime`, the same string 49 times in 50.
The fiftieth time the boundary fell short: a range that ends at an entry's
creation holds neither that entry nor anything else filed up to its
`modificationDateTime`, and the pager, having moved on, never asked for them
again. On a live log of 14,045 entries it lost one at page sizes of 1, 2, 7 and
25 and none at 3, 100 and 1,000; a changed note on the boundary would have
widened the step from a microsecond to milliseconds. The contract test that
sent a fresh entry's `creationDateTime` back as `endTime` failed now and then
for the same reason, and that is how it was found.

Paging on offset or on `startTime` would not work: the API has no offset, and
`startTime` alone still returns the newest page. For the same reason
`brain_recent_changes` reads pages newest first and stops once it has one
event more than the caller's limit, rather than asking for the limit.

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

What the tool says to do goes by the reason. With no index to rank by, or
one of another model, it is to build the index. With an index that is there
and an embedder that cannot embed, it is the package: "Build the index" was
said of that too, and sent the model to a rebuild the same package refuses.
A package that fails to load is not one that is not installed, either.
`EmbedderUnavailableError` used to say "is not installed" of every failure
of the import, with the cause printed nowhere. It tells the two apart by
what the import said, Node's `Cannot find package
'@huggingface/transformers'` and the words Vite has for it, and anything
else is "failed to load" with the import's own words (`loadFailure`). That
reason reaches a rebuild, a sync and status through
`Embedder.whyUnavailable()`.

Ranking by vectors has a best row for any query, so in vector mode a result
lists nothing in one case only: the index holds no row a search ranks,
which by default is an index of types and tags alone. That was a result
with no text in it. It says so now, and what to call: `includeAuxiliary`
for the types and tags, a sync for a thought added since.

### A request that fails is not an empty answer

> **Correction.** The fan-out dropped every failure of a request and counted
> the phrasing as one that found nothing. Through the real tool, with no
> index: a rejected key, nothing listening on the port, a dropped connection,
> a timeout, a 500 and a 503 each came back as the note about the index and
> nothing else, not an error, from a search that never ran. (The key was
> rejected by the live API; the other five were a local socket or a faked
> fetch.) `brain_index` with `action: "status"` had the same fault from the
> other side: it described a local file and made no request, so with the same
> failures, and with a `brainId` that names no brain, it answered "built: no"
> and "Call this tool with action=rebuild".

The fan-out sends one request per phrasing, and what a failure means depends
on whether another phrasing could have got past it.

- **A failure about the call stops the search**: a `brainId` that is
  malformed or names no brain, and a key TheBrain rejects. Every phrasing
  would get the same answer, so the first is the search's, and it is explained
  as any tool explains it (§5).
- **Any other failure is taken for one phrasing's own, because some are.**
  Measured on 15.0.640 (`docs/api-map.md`, L30): the search answers a 414 with
  no body to a query that takes the request line past 8,192 bytes, which is
  8,076 Latin letters or 1,346 Cyrillic ones, and the 403 that names no cause
  to a query of 513 to 1,024 words, while a shorter phrasing to the same brain
  is answered. A model that gives a pasted passage for a phrasing gets either.
  Neither answer says a word about size, so the search resource makes
  `query_too_long` of both, with the size in it. A connection that fails, a
  timeout and a 5xx are not sorted ahead of time into "this request" and
  "every request": one failure does not say what the next request would get.
- **So the outcome decides.** With no phrasing answered there is no result,
  empty or otherwise: `find()` throws `SearchFailedError`, and the tool
  answers `isError` with "Nothing was searched, and this is no answer about
  what the brain holds", then the reason, once when every phrasing failed
  alike and per phrasing when they did not. With some answered, their hits
  are the result, and a `Not searched` section names each phrasing left out
  and why, so that "not found" is not read as certain. A fan-out that found
  nothing now says so in words, and of how many phrasings: it used to print no
  section at all, which is also all a search that had failed printed.
- **Nothing to search for is refused**, in both modes: a query that is empty
  with every variant empty sent no request and answered the same empty
  result, and with an index was embedded as it came.

**Vector mode asks TheBrain nothing**, so none of this reaches it. Measured
with an index built: with a rejected key, with nothing listening and with a
5xx, `brain_search` made no request and returned its hits. That is left as it
is. The answer comes from the index, which is as old as its last sync
whether the app runs or not; `brain_index` with `action: "status"` gives that
time.

> **Since then** it is the ranking alone that asks nothing. A search reads
> the thought of every hit before it lists it, in vector mode as in the
> fallback, and those three come out otherwise: a rejected key fails the
> search, and with nothing listening or a 5xx the hits are listed as not
> verified. See *A hit for a thought that is gone*, below.

**The reads inside the other tools go by the same rule.** `brain_get_thought`,
`brain_set_note`, `brain_append_note`, `brain_delete_thought`,
`brain_traverse`, `brain_list` and the wait at the end of `brain_ingest` each
read something beside what they are called for. A failure of that read used
to stand for a thought with no note, a thought with nothing next to it, or an
app with no brain open. What each does now, and the reads outside the index
that still take a failure for an answer, are in §4, *A read that fails inside
a tool*.

**`brain_index` asks for the brain first**: one `GET /api/brains/{id}`, 0.3 ms
at the median here, for every action and ahead of the index file. The other
way was to keep status a look at the file and have it say that no brain was
looked at. It was not taken: all that status can recommend is a rebuild, a
rebuild needs TheBrain and the brain, and "not checked" would leave the model
to find that out by calling it. What fails there fails the call, with the
failure's own message. Status also reported a build that never finished as
"built: yes, usable: yes" with no thought in it, because a rebuild wrote its
metadata before its first request: after a rebuild that failed on the missing
embeddings package, for one. Built is now a build that finished, and usable
is what `brain_search` asks of an index before it ranks by it.

> **Since then** usable takes an embedder as well. A model reads the word as
> "brain_search ranks by this index", and status said it from the index
> alone: without the embeddings package it was "usable: yes" of an index
> every search fell back from. Status asks the embedder now
> (`SemanticIndexer.cannotEmbed()`, which is also what refuses a run), and
> says "usable: no — the embeddings package is not installed", or "does not
> load". What to do is then the package first, whatever the index, and the
> rebuild after it where there is one to make: "Call this tool with
> action=rebuild" alone sent the model to a call that fails. The cost is an
> import of the package where it is installed, once a process, which the
> next search would have made. The `Semantic` column of `brain_list` still
> goes by the index alone: it is a look at a file for every brain listed.

The index file is named by `brainId`, and it used to be opened, and so
created, before any request could refuse the identifier: `status` for
`my-brain` made `index-my-brain.sqlite`, and for `x/../../name` a file outside
the data directory. `indexPath()` refuses what is not a UUID.

A well-formed identifier that names no brain still left an index behind:
`brain_search` opens the store before the request that says so, and opening
created the file, three with the journal's. So did `brain_list` for every
brain it listed, and `brain_delete_thought` for a brain never indexed. A
store now makes its file at its first write, and reads as an empty index
until then (`VectorStore`): nothing is created to be looked at.

### A hit for a thought that is gone

> **Correction.** A hit was listed as its source returned it, and neither
> source knows that a thought is gone. Measured on 15.0.640
> (`docs/api-map.md`, L34), through the API and then through the real tool:
>
> - **TheBrain's search answers from an index of its own**, refreshed about
>   every five seconds. A deleted thought was returned until the next
>   refresh, 4.5 to 5.2 s after its delete in six runs of 6 to 30 thoughts,
>   with its own read a 404 from 0.2 s on. The lookup by exact name answers
>   from the same index, and returned the deleted thought as long.
> - **Now and then a deleted thought stays there for good.** Six thoughts the
>   contract tests had deleted were still returned 2 to 17 hours after
>   their delete, each with its read a 404. By the log each had been deleted
>   3 to 13 ms after a neighbour of its own. Made on purpose: of 720
>   thoughts deleted 9 to 38 ms after their parent, their type or the
>   thoughts a tag was on, 7 stayed; of 720 deleted 120 to 330 ms after,
>   none, and none of 2,340 deleted with no neighbour just before. A second
>   `DELETE` does not take one out.
> - **Nothing in a hit tells.** The hit for a deleted thought is the one it
>   was before the delete, to the last field.
> - **A changed thought is found by what it used to say.** After a rename, a
>   new caption, a new alias and a new note it was found by each old text
>   for 4.4 s more, and the hit by its old name had the old name in it.
> - **The vector index is as old as its last sync.** A thought deleted since
>   was the first hit of a vector search 12 times of 12. Its row left at the
>   next sync 12 times of 12, and at a rebuild 5 of 5.
>
> So `brain_search` printed the identifier of a thought that was gone, in
> the row of a thought to use: for five seconds after a delete with no
> index, now and then for good, and with an index until someone called a
> sync. Through the tool as it was, a search for the name of a thought
> deleted the day before answered with its row.

A hit is where a model takes an identifier from. The next call with one that
is gone is a write refused, or worse: a note written to an identifier nobody
has is stored and reported as written (§7, `docs/api-map.md`, L3).

**Every hit's thought is read before the hit is listed, in both modes.**
`find()` ranks, cuts to the limit, and asks for each hit's thought by its
identifier, ten at a time (`#verify`). That read is the one thing that tells:
it is a 404 once no thought of the brain has the identifier (L3). What it
answers decides.

- **The thought.** The hit is listed, under the name and the kind the read
  gives. A hit carries its source's copy of both: the search's, five seconds
  old or older, or the index's, as old as its last sync.
- **A 404.** The hit is left out, and returned in `gone`. `brain_search`
  counts it under "Left out" and does not print it: an identifier nobody has
  is of no use. The section says what there is to do, which goes by the
  source. For the fallback, nothing: "Its search goes on returning a deleted
  thought for about five seconds, and now and then for good." For the index,
  one call: "The index holds a deleted thought until its next sync: call
  brain_index with action=sync." With every hit gone the first section reads
  "Nothing that is still there: each of the 3 hits was a thought that is
  gone", and not that nothing matched, which the fallback would have said
  and which is false.
- **A `brainId` that is no brain, or a rejected key.** The search fails with
  it, as the fan-out does. With an index nothing was asked before these
  reads, so this is where a brain deleted since its index was built is found
  out: it used to be answered from the index.
- **Any other failure.** A read that failed is no answer about the thought
  (*A request that fails is not an empty answer*, above), so the hit is
  neither left out nor passed for a thought that is there. It stays in its
  place in the ranking, with `no` under a `Verified` column that is there
  only when some hit has it, and a "Not verified" section says how many of
  the thoughts above could not be read, why, once when the reason is the
  same for all, and to read a thought with `brain_get_thought` before using
  its identifier. The catch-all 403 is such a failure: it is what the graph
  of a thought nobody has gets, and its own read gets the 404.
- **No answer at all.** The same, and it is the last read asked for: the
  ones in flight are waited for, and every hit not yet read is unverified
  for that reason. Against an app that hangs, each further read would wait
  out its thirty seconds.

Such a result is no error. Like a search that some phrasings failed and a
walk that could not look around every thought (§4), the rest is a result and
what it does not say is named. With TheBrain not running, a vector search
still lists what the index ranks, every row marked.

**What it costs.** One request a hit, 15 by default and 50 at the most, and
none when nothing was found. Measured on 15.0.640, 30 runs of each: reading 25
thoughts took 0.9 ms at the median ten at a time, 2.6 ms at the most, and
2.7 ms one after another. Through the real tool with no index, a search of
one phrasing that found 25 thoughts took 8.3 ms where the search request
alone took 5.7, and one that found 15 took 4.9 ms against 3.3. With an index
and a stand-in for the embedder, a search of three hits took 0.6 to 1.2 ms,
its three reads included. A result with nothing gone and every read answered
is what it was, to the character: tests pin that for both modes. The
description says nothing of it, so `tools/list` is the size it was.

**What was weighed and not taken.**

- *Leaving it, and saying so on every result or in the description.* Every
  search would pay for it in tokens, and the model would be left to read
  each hit itself before using it: the same reads, at a call each.
- *Keeping the hit in the table with a mark.* A row with an identifier is
  what a model picks up, and a thought that is gone has nothing to offer the
  one reading. The mark is kept for the hit of which nothing is known.
- *Leaving it out in silence.* A result shorter than its limit, or empty
  where TheBrain matched, would say nothing of why, and with an index
  nothing would say that the index is behind and which call brings it up.
- *Filling the places left.* The hits are cut to the limit and then read,
  so a result can be shorter than `limit`. With an index a sync is what
  makes it whole; a loop that asked the index for more and read again would
  hide that it is behind. With no index it would mean reading every
  candidate of every phrasing, 550 at the most, where the hits that are gone
  are few: five seconds' worth, and the rare one that stayed.
- *Taking the row out of the index when its thought reads 404.* It is the
  answer a sync removes a row for (*A read that fails while the index is
  built*, below). But a search is a read: the index is written by
  `brain_index` and by `brain_delete_thought`, and the result names the call
  that takes the rows out. Until it is made the row is read and left out
  again, at one request.
- *Asking the log what was deleted since the watermark*, one request in
  place of one a hit. It serves the index alone, the log since an old sync
  can be thousands of entries, and a row can be stale for another reason.
- *`GET /api/search/accessible`*, which returned no deleted thought past the
  moment its read turned 404, nor any of thirteen the brain's own search
  still held. It searches every brain the key opens, and they share
  `maxResults` between them.
- *Leaving vector mode to ask nothing.* It answered with TheBrain closed,
  and that is all it had over this. Of the two modes it is the one that
  holds a thought that is gone the longest: until a sync, which is a call
  somebody has to make.

**`findByName` reads its answer too.** The lookup by exact name returned the
deleted thought for those five seconds, and a renamed one under its old name
with the old name in the answer. Nothing in the server calls it, since a
thought is never resolved by name (§7, *Write visibility*); it reads the
thought by its identifier now and returns that read, null for a 404 and for
another name. Its null is "the lookup's one answer is not such a thought",
which is less than "no thought has this name": of two namesakes the lookup
gives the newer, and went on giving it for 5.1 s after it was deleted, 8
times of 8.

**Not guarded.** A thought still reads for 30 to 206 ms after its `DELETE`
is answered, 80 times of 80, and one deleted in that moment is listed. Which
rows a default search leaves out as types and tags still goes by the kind
the index recorded. And none of this finds what the search does not return:
a thought made in the last five seconds, which is why a thought is
addressed by identifier after a write (§7). Two things were not measured:
whether a restart of TheBrain clears the thoughts that stayed in its index,
since the app was in use; and whether thoughts deleted together in
TheBrain's own window, a parent with its children, stay there the same way.
The API cannot drive that window, and the deletes that did leave one were a
neighbour's and then the thought's, a few milliseconds apart.

### A read that fails while the index is built

> **Correction.** The indexer dropped the failure of every read but the
> log's: `.catch(() => null)` on a thought's graph and on the brain,
> `.catch(() => "")` on a note. Measured through `brain_index` on 15.0.640,
> over a brain of seven thoughts, the log and the brain answered by the live
> API and the failures put in on the way to it:
>
> - **A rebuild with every graph failing** (a 500, the catch-all 403, a
>   dropped connection, a timeout, once each) answered "Index built",
>   `thoughts encoded: 0`, no error, after asking for each graph twice, and
>   set its watermark. Status then said "built: yes, usable: no", and
>   `brain_list` "index: 0".
> - **With one thought's graph a 500** it answered "Index built" with six
>   encoded and the seventh nowhere, and no sync would come back for it:
>   nothing in the log says it changed.
> - **With that thought's note a 500** the thought was encoded from its name
>   alone, and over an index that had it right the row was replaced.
> - **A sync** was given a new thought, a rename and a changed note, each
>   eleven seconds old. With every graph a 500, the 403 or a dropped
>   connection it answered "Index refreshed", nothing encoded, and moved its
>   watermark on: the sync after it, with nothing in its way, made two
>   requests and found nothing to do. None of the three was in the index.
>   With the note's read a 500, or the 403 it gets for a moment after a note
>   is deleted, the thought's row was replaced by one built from its name,
>   and the next sync left it so.
> - **With the same changes half a second old** the next sync read them
>   again, inside the watermark's overlap. That is why a test that changes a
>   thought and syncs at once never showed any of this.
> - Read from the code and shown with a fake, since every thought of the
>   test brain is in its log: with the brain's own read failing, a rebuild of
>   a brain the log does not list walked nowhere, removed every row as stale
>   and answered "Index built"; with one graph failing it removed the rows of
>   the thoughts that are reached through that graph alone.

A run makes thousands of reads and then writes. What it does with a read that
fails goes by the same question as in the fan-out, whether the next request
could have got past it, and by one thing more: what it is about to write.

- **It reads first and writes after.** The log, the brain, every graph and
  every note are read before the index is touched: the metadata of a build,
  a row, a removal, the watermark. So a run that a request stops has written
  nothing, and the tool says so: the failure's own message, then "The rebuild
  stopped at that request and wrote nothing: the index is as it was." A
  rebuild used to clear an index of another model and write a build's
  metadata before its first request.
- **A failure every read would get stops the run at once**: a key TheBrain
  rejects, a `brainId` that is no brain, and TheBrain not answering, which is
  a refused or dropped connection and a timeout. The log's read and the
  brain's stop it whatever they fail with: there is no thought to leave for
  later. A dropped connection or a timeout may be one request's, and stops
  the run all the same. Going on costs a request per thought against an app
  that is gone, thirty seconds each against one that hangs, and stopping
  costs nothing: the next run starts where this one did. `mapWithConcurrency`
  starts no item after one has thrown; its other runners used to go on to
  the end of the list.
- **Any other failure is the thought's own, and leaves it for the next
  run**: a 5xx, the catch-all 403, an answer that does not parse. The thought
  is returned in `unread` with the read that failed, and its row is left as
  it was: not removed, and not replaced by a document built without its
  note. The rest are read and written.
- **Only a read that says the thought is gone removes its row.** The graph
  of an identifier nobody has is the catch-all 403, which a request that
  failed for a reason of its own gets too (`docs/api-map.md`, L3). So after
  that 403 the indexer asks for the thought itself: a 404 is a thought that
  is not there, and its row goes, in a sync as in a rebuild. Any other answer
  leaves the thought unread, a 200 included: the graph of a thought deleted a
  moment ago is a 403 while the thought still reads. The cost is one request
  per 403.
- **A rebuild that left a graph unread removes no row for what its walk did
  not reach.** The thoughts the log does not list are found through graphs
  alone (§7), so with one unread the walk is not whole, and "not reached" is
  not "gone". Rows of thoughts read as gone still go. A note that failed to
  read leaves the walk whole.
- **The watermark moves only for a run that read everything it asked for.**
  A sync that left a thought unread keeps the watermark it had, so the next
  one reads the same changes again and the hash skips what was written. That
  holds for a renamed tag or type whose graph was not read: its carriers are
  not known, and the rename has to be read again. A rebuild that left a
  thought unread sets no watermark: over no index it is a build that did not
  finish, which status says and which makes the next sync a rebuild; over a
  built index the old watermark stays.
- **A run that read no thought writes nothing at all**, the deletions the log
  names included: they are read again next time.

**The result of a run that left anything is an error**, and its title does
not say built or refreshed: "Index rebuilt in part" or "Index refreshed in
part", and "Index not rebuilt" or "Index not refreshed" when no thought was
read. Each title goes by what ran, and so does that of a run that read
everything: a sync with no finished index to refresh is a rebuild, and
answered "Index refreshed" while the title went by the action asked for.
It gives the counts of what was written, a "Not read" section, and
"What to do". "Not read" names each thought by identifier, with its name
where a read had given one, the read that failed and what TheBrain answered,
once when it is the same for all; the first twenty are listed and the rest
counted. The 403's own text is about the key and is not passed on. "What to
do" is the same action again, and why the other would not do: after a
rebuild over a built index, that a sync reads only what changed since the
watermark, which the run did not move. Read as a success, "Not read" would
be one more section under "Index built".

With the same failures put in again, all sixteen runs were errors. Four
stopped at the request, on a dropped connection, a timeout and the brain's
own read, and said the index was as it was; twelve named the thoughts they
had not read. A rebuild with nothing read left "built: no" and `brain_list`
"no index", and after each of the six syncs all three changes were in the
index once the next one had run with nothing in its way.

**A rebuild that cannot embed says so before it reads the brain.** Without
the optional package it read the whole log and walked the whole graph, 13
requests on a brain of one thought and minutes on a real one, and failed at
its first document with a build's metadata written. `Embedder` has an
optional `isAvailable()`, which the local one answers by looking for the
package (`isLocalEmbedderAvailable()`), and both runs ask it first: the
refusal is `EmbedderUnavailableError`, in the result as any error is, after
the one request `brain_index` makes for the brain. The package stays
optional, and nothing else asks.

**A note is read on the log's word where the log has one.** The indexer
took "has a note" from the graph alone, and for a moment the graph is wrong
both ways. Measured on 15.0.640 (`docs/api-map.md`, L32): after a change to a
note that is there, one read of the graph within 0.2 s lists no Notes
attachment, after 44 of 60 `update`s and 27 of 60 `append`s watched every 10
ms, while the note's own read had the new text at its first read 200 times
of 200. Under bursts of a hundred creates it was 8 single reads of 150. Read
then, a thought with a note was embedded as its name alone: that is the
contract test that once failed with "expected 'zz-it-note-run-sync' to
contain 'word0'", and it needs no second session to happen. And for up to
0.2 s after a note is deleted the graph still lists it, while its read is the
403: 30 deletions of 30, both at the first read. So the latest note entry
about a thought in the log the run has read decides (`noteStates()`): written
or changed, the note is read whatever the graph lists; deleted, it is not
asked for. With no entry there the graph decides, as before.

**What the overlap already covered, and what it does not.** A note written
for the first time reads as no note for up to 0.15 s where the note had been
read before (8 first reads of 30), and the graph of a thought read before
lacks the attachment as long (10 of 50). A run that meets that indexes the
thought without its note. Its watermark is ten seconds before its own start
and its reads come after its start, so an entry that a read is less than ten
seconds behind is after the watermark, and the next sync reads it again: a
unit test pins that. The limit is a read more than ten seconds behind its
entry in the log. None was measured: the longest lags are 0.2 s for a note,
0.5 s for a tag and 5.3 s for the first patch after 600 creates (§7). Such a
change would stay out of the index until the thought changes again or a
rebuild.

**Left as they are.** A thought that never reads keeps a build unfinished
and a sync's watermark where it was, and every run says so by name: nothing
measured reads that way for good, and passing over it in silence is what
this replaced. Status has no memory of a rebuild over a built index that
left a thought unread: the run's own result is where that is said. Nor does
status say that a row indexed before kinds were compared may hold a stale
one (below): it cannot tell which index has such a row, so it would send
every index built before then to a rebuild, and it is read when a search
complains of no index, which is not when a stale kind shows. `isAvailable()`
looks for the package and not for the model, whose download can still fail
at the first document, with the build's metadata written.

### Variants in vector mode

> **Correction.** Vector mode used to embed the concept alone and drop the
> variants, although the tool description and the skills both promised they
> raised recall. They now do: the concept and each variant are embedded
> separately, each is searched, and a thought keeps its best score. The
> phrasing that produced it is reported as `matchedVariant`.
>
> The fusion was chosen by measurement: 11 conversational Russian queries with
> agent-style variants, over a 199-entry brain whose thoughts are mostly
> titles of two to five words, relevance labelled by hand.
>
> | Fusion | precision@5 | recall@10 | MRR |
> |---|---|---|---|
> | Concept alone (before) | 0.40 | 0.45 | 0.47 |
> | Variants joined into one string | 0.67 | 0.67 | 0.88 |
> | Centroid of variant vectors | 0.65 | 0.65 | 0.95 |
> | **Best score per thought** | **0.75** | **0.73** | **0.95** |
> | Reciprocal rank fusion (k=60) | 0.42 | 0.43 | 0.85 |
>
> Small sample, one brain, one labeller: read it as a direction, not a
> benchmark. Scores are only compared with each other, never against a
> threshold, so the top-k rule still holds.

### Storage

`node:sqlite` (Node 22+), vectors as BLOBs, brute-force cosine scan. No vector
index, no native dependency, no extension to compile.

Measured: **20,000 vectors × 384 dimensions scans in under 200 ms**: in 7 ms
on a performance core of an Apple M4 and in 20–66 ms on an efficiency core,
with nothing else running. A test holds the store's scan under three times a
bare scan of the same rows, which is what a test can hold on any machine (the
correction under the next heading). Real brains are far smaller than that. An
ANN index would add build complexity and a dependency to save time nobody is
spending.

### One index file, several server processes

> **Correction.** Every client session starts a server process of its own,
> and they all open the one index file of a brain. The store was written as
> if it had the file to itself. Measured with two and three real server
> processes over one scratch data directory: the server as `src/index.ts`
> starts it, over stdio, with a deterministic embedder in place of the
> package, which was not installed, and a local stand-in for TheBrain, so
> that the brain could be changed between calls and one session's requests
> held back. Node 22.15, SQLite 3.49.1, the journal in WAL mode.
>
> - **A process ranked by the rows it had loaded.** A built, B searched, and
>   A's sync then added two thoughts, renamed one and removed one. B's status
>   said "thoughts indexed: 7" and B's search ranked its six old rows: no hit
>   for a thought that was new, the renamed one found by its old text and
>   listed under its new name at 1.000, the removed one left out only by the
>   read behind every hit. So it stayed three seconds later, and after a sync
>   of B's own that had nothing to encode. B read the file again when B
>   itself wrote a row, or was started again.
> - **A process that searched while another built the first index kept the
>   first batch**: 64 rows of 2,001, under a status of "built: yes, usable:
>   yes, thoughts indexed: 2001".
> - **Of two runs started together, one answered `database is locked`**,
>   SQLite's words and the whole `isError` result: in 6 pairs of 6 with the
>   writes back to back (3,000 thoughts renamed, both sync), and in 5 of 7
>   with 20 ms of encoding ahead of each batch. A status asked for at the
>   moment another process was making the file got the same answer.
> - **A sync that ran inside a rebuild's reads was written over.** The
>   rebuild had read a thought; the thought was renamed; another process's
>   sync wrote the new name; the rebuild then wrote the name it had read over
>   it, and put the watermark back to before its own start, so that the next
>   sync read the rename again. That much mended itself. When the rebuild had
>   left one other thought unread it moved no watermark: the one the sync had
>   set stayed, a second past the rename, the sync having started eleven
>   seconds after it, and the next sync encoded nothing. With a third
>   process's sync started before the rebuild wrote and ended after it, all
>   three runs read everything and answered "Index built" and "Index
>   refreshed", and the row was left old under a watermark past its change. A
>   new session's search for the new name scored that row 0.516.
> - **A writer killed at its tenth batch of 32 left nothing that reads
>   wrong.** A first build read as "built: no — a build was started and did
>   not finish", 576 rows; a rebuild over a built index left its 2,001 rows,
>   576 of them new, under the old watermark, and the next sync wrote the
>   rest; a rebuild by another model read as not finished for that model and
>   as no index for the first. `PRAGMA integrity_check` was `ok` each time.
>   Read from the code and not reached by a kill: `clear()` deleted the rows
>   and the metadata as two statements, and the new metadata went in as
>   three more. Stopped after the first, the file held the old model's
>   metadata, watermark included, over no rows. (`clear()` had no caller
>   left once `startOver()` took its place, and is gone.)

**The rows in memory follow the file.** A search asks SQLite for `PRAGMA
data_version` before it ranks, and reads the rows again when the number has
changed. It is SQLite's own count of the commits other connections have made,
another process's among them; the store's own writes drop the rows
themselves, as before. The candidates, each timed over 20,000 calls against a
file of 20,000 rows that a second connection had open:

| Asked with each search | Median | Moves when another process commits |
|---|---|---|
| `PRAGMA data_version` | 0.9 µs, 1.3 µs prepared each time | yes; for a checkpoint with no write as well |
| a counter row of the store's own | 1.0 µs | only where every writer adds to it, which a server of an older version does not |
| `stat` of the file and of its `-wal` | 1.8 µs | the file: no, a commit goes to the journal beside it; the `-wal`: its time, its size only while the journal grows, and it is gone when the last connection closes |

Against that, the scan of 20,000 vectors takes 6.0 ms as a bare loop and 7.4
ms through the store, before and after. The count is asked for ahead of the
rows: a commit that lands between the two is read once more for nothing,
where the other way round it would never be read. What it costs is the
search after another process's write, which reads the rows again: 41 ms more
for 20,000. During another session's rebuild that is every search, a batch
of rows having been committed since the last one.

> **Correction.** Those are the figures of a performance core of an Apple
> M4 with nothing else to do. On an efficiency core, which is where a
> process at background priority runs, the scan took 20–66 ms and the search
> that reads the rows again 130–330 ms. For a quarter of an hour of the
> measuring a process at ordinary priority got the same, on battery and with
> another application busy; what set it off was not found. With two more
> runs of the test suite going then, the best of five scans took up to 233
> ms and the best of five such searches 831 ms. The two tests of these
> figures each timed one search, once, and held it under 200 ms. That bound
> failed for the machine's reasons, and where the cores are fast it did not
> tell a store that had gone wrong: one that read the rows again for every
> search scanned in 38 ms, and one with a query to the database for every
> row in 49–82 ms. No figure on a clock does both.
>
> The tests now hold a search against a bare scan of the same rows, written
> out in the test and timed straight after it, so as fast or as slow as the
> machine is at that moment. Each does it five times and asserts the least
> of the five ratios. The store's scan is held under 3 bare scans: it was
> 1.05 at the most on a performance core left alone and 1.2 under any load
> tried, background priority with two more runs of the suite included. The
> search that reads the rows again is held under 40: it was 5–7, and 11 at
> the most under any load tried. What the bounds tell: the rows read again
> for every search, 5.0–6.9 bare scans; a dot product by way of plain
> arrays, 17–24; a query to the database for every row of the scan, 3.9–11
> in a file and 3.0–7.6 in a store in memory, where one run of seven came
> out at 2.98; the rows read again a hundred at a time by `OFFSET`, 55–72.
> What they do not tell from a busy moment: the rows read again one
> statement a row, 9–17 bare scans where it is 5–7, and in a store in memory
> a query for every row from a statement prepared once, 2.4–2.5.

**A write is all in the file or not there.** Each write of the store is one
`BEGIN IMMEDIATE` transaction, and an index of another model is replaced in
one, rows, metadata and watermark together (`startOver`). So a process killed
part of the way leaves the rows of the batches it had finished and nothing of
the one it was in. What a killed run leaves is then one of two things: an
index with no watermark, which status calls a build that did not finish, or
the index as it was with some rows newer, under the watermark it had, from
which the next sync reads on. Never a watermark over rows that are not there:
the watermark is the last thing a run writes.

**A statement waits for another connection's write**, two seconds
(`BUSY_TIMEOUT_MS`); SQLite's default is not to wait at all. A reader is not
kept waiting by a writer, and sees the rows as they were before the write
began. No write is longer than a batch, a few milliseconds, so the two
seconds are for a process that hangs with a write open. Waited out, it is
`IndexBusyError`, whose message is a sentence: "Another server process had
the semantic index of this brain locked, and had not let go of it after 2 s.
Every client session runs a server process of its own, and they share one
index file. This write to the index was not made." The wait blocks the
process, which is why it is not longer. A look that finds the file half made
waits the same way.

**One run at a time over an index.** A rebuild and a sync hold the index
from before their first look at it to their last write (`VectorStore.claim`,
taken in `SemanticIndexer`). The other ways were weighed against the three
runs above, and neither was built. Letting both runs write needs every run's
writes in one transaction at its end, decided against the index as it then
is, and a rule for the watermark when it is not the one the run started
from; a run would still write an older reading over a newer one, and count
on the next sync to read it again. Refusing a run whose index changed under
it throws away minutes of reading, and a rebuild would lose to every sync
that ends inside it. With one run at a time the three cases cannot arise,
and what a run does is what it did with the file to itself, which is what
every test of it was written against.

- **A second run waits ten seconds** (`RUN_WAIT_MS`), asking every 50 ms,
  with the process free meanwhile. The run in its way is most often a sync
  after an ingest, a tenth of a second to a few seconds. It then reads the
  index as that run left it, and its own start, which its watermark is taken
  from, is counted from when it got the index. Of thirteen pairs of runs
  started together all 26 got through, the second of each pair 0.3 to 0.8 s
  behind the first and encoding nothing.
- **Still waiting after that, it is refused**, as `isError`: "Another rebuild
  or sync of this brain's semantic index is running, and had not finished
  after 10 s of waiting. Every client session runs a server process of its
  own, and they share one index file, which one run writes at a time. This
  sync read nothing and wrote nothing. brain_search ranks by the index as it
  stands meanwhile. Call this tool with action=sync again once that run is
  done." It read nothing, so there is nothing of it to undo. That is what a
  sync started inside another session's rebuild now gets, and the sync after
  the rebuild reads from the rebuild's watermark, which is before anything
  the rebuild did not see.
- **What is held is a lock on a file beside the index**, `<index>.lock`,
  taken through SQLite (`BEGIN EXCLUSIVE`, the journal in memory) because
  that is the lock Node has without a native module. The operating system
  drops it when the process dies: after a `SIGKILL` of the holder the next
  run started at once. Nothing is written to that file. The first run makes
  it and it stays, empty; a look makes none. A refused attempt costs 4 µs.
- **Reads and single writes do not ask for it.** A search, a status and
  `brain_list` are answered while a run holds the index, and so is the row
  `brain_delete_thought` removes. A rebuild that had read that thought
  before it was deleted writes the row back, with a watermark before the
  deletion, so the next sync takes it out; a search meanwhile leaves the hit
  out by the read behind every hit.

**What is not guaranteed.**

- A server from before this change takes no claim and does not wait. Next to
  a current one it is the one that fails: `database is locked` 7 times of 7,
  the current server through each time. Two of them are as they were.
- A run that never ends, on an embedder that hangs, holds the index until
  its process does: every other session's rebuild and sync is refused, with
  the sentence above, and searches go on.
- During a run's writes a search ranks by the rows written so far: a mix of
  old and new, each a row some run read whole, and for a first build the
  part of the brain that is in yet, which status calls not finished.
- Sessions with different models take the index from each other: each finds
  it "built with a different model" and is told to rebuild.
- A run that stops before its first write leaves the empty lock file, and
  the data directory if it made it.
- `took` in a result is the run's own time, without the wait for the index.
- None of this was run on Windows or over a network file system, where
  SQLite's locks are another matter.

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

Enumeration takes the union of the modification log and a breadth-first walk
over `graph`: the log alone misses thoughts in imported and old brains (see
*Enumerating all thoughts* in §7). Data is collected via `graph`, which returns
the thought, its type, its tags and its attachments in one request; the walk
has already fetched it, so collecting reuses it.
**A note is fetched only when that graph reports an attachment flagged
`isNotes`** — so the extra request is spent exactly on the thoughts that have a
note, and never on the ones that do not.
Where the log the run has read has a note entry about the thought, that entry
is taken over the graph, which is wrong for a moment after a note changes
(*A read that fails while the index is built*, above).

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

The format went to 3 when aliases joined the document, on the line after the
name and with no prefix: they are other titles for the same thought. An index
built before that reports itself incompatible and wants a rebuild. No retrieval
benchmark has been run for aliases; that they belong in the vector is an
argument, not a measurement.

Incremental sync reads every change since its watermark, page by page (§7,
*Reading the whole log*): one request would keep only the newest changes and
drop the oldest, while the watermark moved past them regardless.

The watermark is left ten seconds before the moment the run starts, so the next
run reads the tail of this one again. A write is in the log at once and in
`graph` a moment later, a tag after 0.1–0.5 s. A sync in between reads the
entry, fetches the old graph and skips it by hash; with the watermark at the
run's own start, that change then stayed out of the index until a rebuild.
Measured: of four tags each followed at once by a sync, one was lost. Reading
the tail twice costs a graph request per thought, and the hash drops the rest.
The watermark is moved only by a run that read every thought it asked for.

Everything that goes into a document has a signal in the log. Each row was
measured and has a contract test:

| What changed | Log entry | Read again |
|---|---|---|
| name | `103` against the thought | `sourceId` |
| aliases | `211` against the thought | `sourceId` |
| label, set or cleared | `202` against the thought | `sourceId` |
| type, set or lost | `203` against the thought, the type's name as the value | `sourceId` |
| note | `801`/`802`/`803` against the `Notes.md` attachment | `extraAId` |
| tag attached or detached | `101`/`102` against the link | both ends, `extraAId` and `extraBId` |
| tag or type renamed | `103` against the tag or type alone | its graph's `children` |
| kind, and with it the label a type reads with | `304` against the thought, the kinds by name as the values | `sourceId` |

`logThoughtId()` covers the first five: it reads `sourceId` for a thought event
and `extraAId` for a note event — otherwise an edit that touches only a note
leaves the thought unmarked and its vector stale.

A tag is a link, so attaching one logs nothing against the thought. The link's
entry has the tag in `extraAId` and the thought in `extraBId`, and reads
exactly like an ordinary parent link's: same types, values null in both. So
`linkEndIds()` returns both ends of every link that was created, deleted, moved
(`402`) or changed meaning (`404`: a tag turned into an ordinary thought), and
the hash drops the ordinary ones at a graph request each. That request is the
whole cost of not knowing which links are tags.

A renamed tag or type sits in the document of every thought that carries it,
while the log names the renamed thought alone. Sync fetches the graph of each
renamed thought, which indexing needs anyway, and when it is a tag or a type
marks its `children`: that is where a graph lists the thoughts a tag marks and
the instances of a type (§7).

One gap is left. A moved link names its new ends only, so the thought a tag
link was moved away from keeps its vector until a rebuild. No tool here moves a
link.

> Until this was fixed, sync re-embedded on a rename, an alias change and a
> note event only. A label, a type or a tag changed the document and left the
> vector as it was. A rebuild repairs an index synced that way: it compares
> hashes, and these documents differ.

**The kind is beside the document, not in it.** A row holds its thought's
kind in a column of its own: that is what leaves types and tags out of a
search, and what `brain_search` prints (§4). `PATCH /kind` turns an ordinary
thought into a tag or a type, either of those into the other, and both back;
no request makes kind 3 or 5. The log gains one `304` against the thought,
the kinds by name in its values, and it is the last entry of the change.
Ahead of it come the entries for what is under the thought: a `404` against
each link there, whose meaning turns with the thought, and a `203` against
each thought that gains or loses it for a type. The children of an ordinary
thought are the thoughts a tag is on and the instances of a type, and one
becomes the other. Measured 12 times out of 12 for each of the six changes,
on a thought with nothing on it and on one with a parent, a child, a jump, a
tag and, while its kind lets it have one, a type (`docs/api-map.md`, L31).

So what is under the thought was read again already, both ends of a `404` by
`linkEndIds()` and a `203` by `logThoughtId()`, and its document followed.
The thought itself was not. `304` is now among the entries a sync reads, on
two counts:

- **The row's kind.** An ordinary thought turned into a tag has the document
  it had, so its hash is the one stored and the thought was skipped. The kind
  is compared apart from the hash, in the one place a sync and a rebuild
  share. A row that differs in kind alone is given the new kind and keeps its
  vector: nothing is encoded, so correcting it costs the graph request the
  run makes anyway.
- **The label.** A thought with no label of its own reads with its name for a
  label while it is a type, and with none before and after. No `202` is
  logged for that: the document gains or loses a line, and the `304` is the
  only entry to say so.

> Until this was fixed, no sync read a `304` and both runs compared hashes
> alone. Measured through `brain_index` and `brain_search` on a live brain,
> three runs of each change, with what made the fixture out of the sync's
> reach. A sync left the row of a thought with nothing under it as it was,
> whatever the change. A rebuild corrected the kind only where the document
> had changed too, which is to or from a type for a thought with no label of
> its own. Between an ordinary thought and a tag nothing corrected it unless
> the thought had a type to lose, and nothing did for a thought with a label:
> the new tag stayed in a default search, the thought that had been a tag
> stayed out of it, and the `Kind` column said what the thought used to be.
> With the change, all twenty cases read right after one sync and after a
> rebuild alone, three runs of three.

The kind did not go into the hash or into the document. In the hash it would
make a miss of every hash stored, and the next rebuild would encode the whole
brain again, minutes on a real one, for what one integer says. In the
document it would change every vector and take a new `DOCUMENT_FORMAT`, for a
word that says nothing of what a thought is about. So `DOCUMENT_FORMAT` stays
at 3 and an index built before this is used as it is. A row whose thought
changed kind before the upgrade keeps the old kind until a rebuild: its `304`
is behind the watermark, and a sync reads the thought only when something
else touches it.

The graph shows a new kind up to a quarter of a second after the log has the
`304`, 234 ms at the most in 280 changes. That is a tag's race over again,
and the watermark's overlap covers it the same way.

`brain_index` counts such a row apart, as "kind updated, nothing to encode",
and prints the line only when there is one: the row is neither encoded nor
unchanged, which is what it used to be reported as.

**The label of a type.** The label a type reads with while nobody has given
it one is not its name of the moment. TheBrain writes the name there when
the thought becomes a type and does not move it when the type is renamed
(row L38): the document of a type nobody renamed is its name twice, and of a
renamed one `new name\nold name`. The old name therefore stays in the vector
of a renamed type. It is left there, and `DOCUMENT_FORMAT` stays at 3:

- **It is what TheBrain has.** The label is stored, it outlives the kind,
  and TheBrain's own search returns the type for the old name. An index that
  dropped it would say less of a type than the app does.
- **A read cannot tell it from a caption.** A label someone wrote on a type
  reads the same way, and that one belongs in the document. Only the log
  tells them apart, by a `202` that is not there, and a thought's log is its
  newest entries. The server does not guess: the judgement is the
  caller's (invariant 6).
- **Dropping it costs every user a rebuild.** It changes the document of
  every type, which takes a new format. An index of another format is
  reported as unusable: `brain_search` answers from TheBrain's own search,
  and says why, until `brain_index` with `action=rebuild` has run, about a
  minute for 10,000 thoughts. That is the price of a line in rows a search
  returns only with `includeAuxiliary`.

What takes the old name out is the label's removal, `label: null` through
`brain_update_thought`: the `202` it logs is among the entries a sync reads,
and the row is the new name alone after it. No tool printed a thought's
label then, so nothing showed a caller that a type had one to remove;
`brain_get_thought` and `brain_list_types_and_tags` print it now, with what
clears it (§4, *A label, read back*). Should the
format change for another reason, whether a type's label equal to a name it
no longer has belongs in the document is worth asking again then.

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
| Read-only contract | `THEBRAIN_API_KEY`; `THEBRAIN_TEST_BRAIN_ID` for the tests that read a brain | That the live API still behaves as documented in §7 |
| Write contract | `THEBRAIN_API_KEY` + `THEBRAIN_TEST_BRAIN_ID` | Create/update/link/tag/note round-trips against a real brain |

Without the environment variables the corresponding suites skip, so `npm test` is
green in a clean checkout and in CI.

**Write tests demand an explicit brain.** `THEBRAIN_TEST_BRAIN_ID` is required and
is never inferred from `app/state` — the same mistake the tools guard against, and
one this project actually made once. A second safety refuses any brain with more
than 500 thoughts. Test thoughts are prefixed `zz-it-`; `afterAll` removes both
this run's and leftovers from previous crashed runs.

**They keep to that brain, and to their own run.** No test reads another
brain: of the others they read only the list of brains, for one home
thought's identifier that is then asked of the test brain alone, and
`app/state`, which names the thought open in the app. The
read-only suite reads the test brain too, and without `THEBRAIN_TEST_BRAIN_ID`
skips what needs a brain. `GET /api/search/accessible`, which searched every
brain the key opens, is gone, and what it showed stands in row L34 as a
measurement made once. A run of note changes cut short is no longer
explained from the other brains' logs: the test checks that its own brain
logged nothing in between and tries again. So that an entry in another brain
ends a run stands in L20 as measured, and a run cut for some other reason is
tried again, not failed, unless every try is cut.

A test brain's log only grows, by about 2,800 entries a run, and a test must
give the same verdict on a brain made today and on one used for a month. A
log read is bounded by the start of the run (`newestLogs()`). An index a test
needs for its own thoughts is filled from the test's start
(`indexedSince()`) where the claim is not about a rebuild. The whole log is
read only where a claim is about all of it. On the two old test brains the
tests both versions have took 208 s where they took 247 s, and 194 s where
they took 234 s; the new tests of this change add some 22 s. A test that looks for something
rare in the log, an entry filed between another's creation and its filing,
looks through the newest 250,000 entries and says so when it skips.

**A sync rereads the last ten seconds, and a test's thoughts are seconds
old.** Every sync reads the log from ten seconds before its own start, so a
thought made just before is read again for its own `101`, whatever else the
log says of it. With a sync that passed over every label, type, kind and
note entry, the test of what a sync reads a thought again for passed all the
same, and the test of a kind seen late failed only because the rebuild ahead
of it took more than ten seconds on a long log: with an index filled in a
second it passed too. A test about one entry puts the index past
everything logged before the write that makes it (`caughtUp()`). The two
tests about the ten seconds themselves do not, and fail when a sync leaves
its watermark at its own start (2 runs of 2).

**What a run made is swept by identifier, before the next run and after its
own.** A run notes its start in a file outside the repository, one for each
brain, and takes it off once it has swept up. Its sweep reads the log from
that start and deletes every thought created since and still there, whatever
it is called: a prefix did not find a thought a test renamed to `ZZ-IT-…`, a
type named with characters that do not show, or the thought of a create
answered with the 403 of a busy app. A run that finds a start left in the
file sweeps from it before its first test, because a tag an earlier run left
is what a create of a tag of that name answers with (row L39), in the state
it was left in. Before its first test it also deletes the tags and types
whose names are the tests', in the way the API compares a tag's name; and
after its last it still reads the whole log for thoughts made or named so,
for debris from before the file or from another machine. Tag names are not
made unique to a run: a tag or a type is made under a fixed name in some
sixty places, tests compare those names and the documents that hold them,
and a brain swept before the run has nothing for a name to meet.

**The start is past the brain's newest entry, and the sweep keeps a second
between neighbours.** The start used to be a minute before the run's first
request, and a brain made in that minute lost its home thought to the
sweep: two did, on 2026-10-14, and with no thought left a brain's
`statistics` is the catch-all 403. A run now reads the newest entry the
brain logged before it writes anything and starts at the next millisecond,
and no sweep deletes the home thought. The sweep went one thought after
another, a parent a few milliseconds before its children, which is what
leaves a thought in TheBrain's search for good (§8, *A hit for a thought
that is gone*). It deletes in rounds now, no two thoughts that share a link
by the log in one round, a second after the round before: four or five
rounds, four or five seconds a run. `test/sweep.ts` holds the rules and
`test/sweep.test.ts` holds them to it.

**A burst is not a promise of 100 answers.** Now and then one create of a
burst is answered with the catch-all 403, and its thought is made all the
same (4 of 4: the log had a `101` for every request; docs/api-map.md, L45).
A test that needs a burst counts such an answer and says it aloud
(`makeInBurst()`); it fails for what it is about. It is not made to fail on
the 403 itself: that is the app's, under a load the server is not designed
for, and a test of the log that went red on it would go red about one run in
forty for nothing the test checks.

Two testing habits worth stating, because both caught real bugs:

- **Fakes must lie no more than necessary.** The ingest test's fake API did not
  create parent links the way the real one does. Making it faithful immediately
  broke three assertions that were indexing `links[0]` — and those assertions
  were the ones that were wrong. It lied twice more: it kept one `parent`
  whatever the relation, and answered every graph live. Six tests that ran a
  plan twice passed on it while the live API made the thoughts again. And
  once more: it returned a link in its own shape, with the `relation` it was
  written with, where the API stores a parent's link as a child's from the
  other end. The report compared that number with the one asked for, and no
  test saw that it called every parent link a mismatch. And it had no note to
  read: a thought was set up without one, so no test saw that a plan's note
  was written over the note of every thought the plan found.
- **Measure before documenting.** Two corrections in this document — the
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
