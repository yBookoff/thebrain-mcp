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

- **A malformed UUID in the path returns HTTP 200 with an HTML page** to a
  `GET`; a write with one is a 400 with no body. Validate before the request;
  sniff the body after.
- **An identifier in capitals is read, and every answer names it in lower
  case.** A tool takes each identifier argument through `identifier()` (or
  `identifierOrNull()`) from `src/server/identifier.ts`, never as a bare
  `z.string()`, a new instance at each use, or the JSON Schema gets a `$ref`.
  A plan's `parent`/`from`/`to` are lowered in `ingest()`, since only the
  whole plan says which are tempIds.
- **The status does not say which identifier was wrong.** A `brainId` that is
  no brain is a 401, `"Access to brain <id> is unauthorized."`, from every
  request, whatever else it names: `unknown_brain`, never `auth`, which is the
  key's. A thought nobody has is a bare 404 to its read and to a patch, the
  catch-all 403 to its graph, a 404 that names it to a create under it, a 400
  that names it to a link, and a 200 to a `DELETE`; its note reads as empty,
  and a note written to it is stored. The 403 names no cause and also answers
  requests that fail for reasons of their own, so only the read's 404 is taken
  for "no such thought" (`requireType`, `requireTag`, `requireParent`).
  `describeError()` keeps the API's words where they carry the identifier, and
  a message about one identifier never names another. The lookup of a link is
  the same 404 for a thought nobody has as for two thoughts with no link, so
  `brain_tag` reads the thought before it answers that a tag "was not on the
  thought".
- **`/types`, `/tags` and `/pins` answer an empty list with a 400** in a
  sentence that reads like a failure. `emptyOn400()` takes those three
  sentences for `[]` and passes any other 400 on; a list the API could not
  read, told in the same words, would still read as empty.
- **`notes/append` on a thought with no note is a silent no-op.** Read first.
- **A note is an attachment.** `graph.attachments` flags it with `isNotes`; its
  log events carry the attachment in `sourceId` and the thought in `extraAId`.
  Reading `sourceId` as the thought is what once kept notes out of the index.
- **The log does not list every thought.** Imported and old brains hold
  thoughts with no `created` event, so a rebuild also walks `graph`.
- **The log keeps only the newest `maxLogs` entries, even with `startTime`.**
  Read it through `brains.allModifications()` / `modificationPages()`. Log
  timestamps carry microseconds; never round-trip one through `Date`.
- **The log is ordered and filtered by `modificationDateTime`, not
  `creationDateTime`.** They are the same string 49 times in 50, then a
  microsecond apart, or milliseconds for a changed note. A bound taken from
  `creationDateTime` leaves its own entry out. Take an entry's time from
  `logTime()`.
- **The log is not append-only: a run of note changes is one `803`.** While
  that entry is the newest TheBrain has logged, the next change to the note
  files it again under the new time. Any other entry in between ends the run,
  one in another brain included: a parallel session or the user at work in
  TheBrain changes what a measurement here sees. Only the newest entry moves,
  so paging back and reading from a watermark both hold. Never count edits by
  entries, or expect an entry to stay where it was read.
- **A graph's `parents` holds every thought above, by whatever link.** A
  thought's type, the tag a tag carries (meaning 7) and the second of two
  types are all there. `getGraph()` keeps a parent only where the link the two
  share in the graph's `links` is ordinary; with none listed, only the type is
  set apart. The upper tag stays in `tags`, `type` is the one `typeId` names,
  and any other type is in `otherTypes`, which `neighbourIds()` follows.
- **A graph lists a thought once:** a sibling that is also a parent, child or
  jump is in that list, not in `siblings`.
- **A name of white space alone is a 400 for a new thought and a 200 that
  renames nothing, and white space is Unicode's `White_Space`, not what
  `trim()` drops.** A next line (U+0085) is of it and a byte order mark is
  not. A name is stored with each tab and line feed as a space and without the
  white space at its ends, and past 1,024 UTF-16 units it is cut, each with a
  200. Ask `nameRefusal()` ahead of any write that carries a name, and compare
  and report a name through `thoughtNameAsStored()`: a plan thought looked for
  as it was sent was made again by every run. A name of characters that do
  not show is stored like any other and is not refused: print a thought's
  name through `shownName()`, which spells out one whose every code point is
  `White_Space`, `Default_Ignorable_Code_Point` or `Cc`. `table()` does that
  for a cell. A link's name is stored by the same rule, the cut at 1,024
  included: compare a label through `linkNameAsStored()`.
- **Aliases only replace as a whole list, and a read straight after the write
  usually returns the old one.** Add and remove through
  `thoughts.changeAliases()`, which waits for the write to read back: two
  read-modify-writes in a row left only the second alias. A read straight after
  a rename returns the old name too, and an alias equal to the name is dropped:
  a rename that kept the old name as an alias lost it. `changeAliases()` takes
  the name its caller has just written (`known.name`); pass it whenever a rename
  goes before an alias edit. Saving a brain's first
  alias raises the TheBrain version that brain requires, so `ALIAS_COST` stays
  on every tool argument that can write one.
- **`null` clears nothing through `replace`.** On a label it is a 403, on a
  colour a 400, and on `typeId` a 200 that leaves the type in place. Clear
  through `thoughts.update()`: it sends `remove`, and for a type deletes the
  link from every type the thought has and waits for it to read back with no
  `typeId`. On a
  link's name it is a 200 that leaves the name, on its colour a 400;
  `links.update()` sends `remove` for both. A link's thickness reads back a
  hundred times what was written, and nothing clears it.
- **A refused patch does not say how far it got.** The API applies a patch an
  operation at a time and keeps what it wrote before the one it refuses. So
  `brain_update_thought` sends a field to a request, the type first, and lists
  each as written, failed or not tried. `thoughts.update()` given several
  fields is still one patch.
- **`typeId` takes any thought, with a 200.** A tag gets attached, an ordinary
  thought becomes a parent, and the type stays as it was. `thoughts.update()`
  and `create()` read the kind first and throw `not_a_type`; keep new writes
  behind `requireType()`. A parent link towards a type sets the type as well.
  A type the patch would not set is a 200 too: on a tag, on a type that is
  the named type's own type, and on a thought of two types, where a third
  leaves one of the two beside it. `update()` reads the thought's graph ahead
  of the patch and throws `type_on_tag`, `type_cycle` or `two_types`; the
  graph lists type links deleted a moment ago, so two types are counted by
  `links.between()`.
- **A type on a type is a link of meaning 3, and a thought can have two
  types.** `isTypeLink()` takes 2 and 3 (`LinkMeaning.SubType`), and
  `detachType()` deletes only a type's link with the type at `thoughtIdA`. A
  create with a type for `sourceThoughtId` and another for `typeId` links
  both; deleting either reads back as `typeId: null` with the other still the
  thought's type, no patch takes one away, and the graph's own `type` names
  either, changing between reads. So `removeType()` reads the graph as well
  and deletes every type's link.
- **A type is never a parent.** A parent/child link with a type above, and a
  thought created under one, is a 200 that sets the lower thought's type and
  replaces the one it had. `links.create()` and `thoughts.create()` read the
  upper end first and throw `not_a_parent`; a tool calls
  `links.requireParent()` before its first write. A jump to a type is an
  ordinary link. A tag above is refused by the same read, with
  `tag_as_parent`: it would tag the thought and leave it with no parent, and
  `brain_tag` and `tagIds` are what attach a tag.
- **`POST /api/links` answers 200 with an identifier of zeros for a link it
  does not make**: a thought with itself under any relation, and a tag under a
  type. `createdId()` turns that into `zero_id` for both creates;
  `links.create()` and `planLevels()` refuse a thought linked to itself before
  anything is sent.
- **The all-zero UUID is well formed, names nothing, and a create takes it for
  none given.** A `sourceThoughtId` or `typeId` of zeros is a 200 and a thought
  with no parent or no type; a note written to it is a 200 that never reads
  back. `assertUuid()` refuses it with `invalid_uuid` before any request; in
  an *answer* it is `zero_id` (`createdId()`).
- **`ingest()` sends one post per pair**, and one attach per tag on a thought.
- **Asking for what is there is not free, and `between()` is how to look.** A
  link posted over the pair's own, a tag attached again included, is a 200
  with the same identifier and a `402` in the log; `PATCH /name` with the name
  a link has logs nothing. The lookup of a pair is not behind a write; the
  link by its own identifier is. Look first (`links.hasTag()`, `linkFound()`),
  and compare a label as it is stored (`linkNameAsStored()`). `brain_tag` add
  asks the lookup first and sends nothing for a tag that is there; a link of
  the pair that is not the tag's is refused, since the attach would rewrite it.
- **Two thoughts share one link, and no link reads back with `relation` 2.** A
  parent's link is stored as a child's from the other end, so `thoughtIdA` is
  the upper end, the tag or the type. Never compare a stored `relation` with
  the one asked for: use `linkFound()`. Nothing is posted over a link that is
  there, since it would replace it, except by `brain_link` with `replace`, and
  then over an ordinary link only (`isTagLink()`, `isTypeLink()` say which are
  not). A label goes onto an ordinary link
  whatever its relation, never onto a tag's attachment or a type's link.
- **Nothing is written as a sibling.** The spec's `relation: 4` is a 400 for a
  link, a 200 and a thought linked to nothing for a create, and a 200 that
  changes nothing for a patch. Siblings are thoughts with a parent in common;
  no link joins them. So the tools take `child`, `parent` and `jump`,
  `Relation` has no fourth, and `thoughts.create()` and `planLevels()` refuse
  any other relation before the first write. `links.update()` takes no
  relation either: a patch with 2 swaps the ends on every send. Change what a
  link is through `links.create()`, which rewrites the link two thoughts share
  and keeps its identifier, label, colour, thickness and direction (L43).
- **A link removed is a deletion; a link's kind changed is not.**
  `brain_unlink` is behind `THEBRAIN_ALLOW_DESTRUCTIVE=1` and
  `confirmDestructive()`, as `brain_delete_thought` is, and refuses a tag's
  attachment and a type's link; `brain_link` with `replace` asks no one, since
  the same call with the old relation puts the link back. Both act on the
  link `between()` gives. A `DELETE` of a link that is gone is a 400, not a
  thought's 200.
- **A note keeps a code block that is closed; a ` ``` ` line with no partner
  is deleted.** Of the lines that begin with three backticks, whatever
  follows them, the last goes when their number is odd, whole, and a pair
  with no line between, the second of them bare, goes as an empty block:
  each with a 200. `\r\n` comes back as `\n`; nothing else changes. So a
  block left open loses its opening fence, and a line of prose that opens
  with a triple-backtick span goes with its sentence. An append is gone over
  as the whole note, and the bare request joins its text to the last line: a
  block appended so loses its closing fence, which `notes.append()` prevents;
  it returns the whole text. `noteAsStored()` is the rule: warn only of a
  note that lost a line (`linesNotKept()`), and set a text against a note as
  it would be stored. What the app's editor saves is not measured.
- **`by-location` compares the host by case, and a URL is stored as given.**
  `Example.com/p` does not find `example.com/p`. Attach through
  `attachments.attachUrl()`, which also checks the thought's own list with the
  host case set aside. That list is a copy, up to 0.2 s behind a write, so
  `attachUrl()` asks `by-location` for the spelling given, then waits out what
  is left of 0.5 s since this process's last write (`afterCopyLag()`) before it
  reads the list. The other spelling sent within the moment the list is
  behind may be attached twice; not guarded, nor another process or the app
  attaching one. The list is taken only as a source of spellings: each is
  asked of `by-location` before "Already there", since a list read right after
  a delete still showed the attachment 6 of 6. Compare a `sourceId` with a
  caller's thought id regardless of case: the API takes capitals and answers
  in lower case.
- **Tags attach via `POST /api/links` with `relation: 2` against a `kind=4`
  thought.** The server rewrites it to `relation=1, meaning=5`. Against a type
  the same request sets the thought's type and against an ordinary thought it
  adds a parent, each with a 200, and the lookup behind a detach returns
  whatever link the two share. `links.attachTag()` reads the kind first and
  throws `not_a_tag`, and `detachTag()` deletes only the tag's own link. A
  caller that writes something before the tag calls `links.requireTag()` ahead
  of that write.
- **A tag is made once a name, and a create does not say which it did.**
  `POST /api/thoughts` with `kind: 4` under the name of a tag that is there
  makes nothing and answers with that tag's `{id}`; names are matched with
  letter case, characters that do not show and the form of a character set
  aside (L39). A type is made again under any name. A label, aliases or a
  source sent with it are written onto the tag that is there. Make a type or
  a tag through `thoughts.createTypeOrTag()`: a name and a kind alone, and
  `created` from the log — the newest entry read before the create, the
  thought's own `101` after it. `/types` and `/tags` are a copy, up to 0.42 s
  behind a create: never decide by them what was just made.
- **In the log a tag is only a link.** Attaching one logs nothing against the
  thought: the link's `101` has the tag in `extraAId` and the thought in
  `extraBId`, the same as an ordinary parent link's. Renaming a tag or a type
  logs its own `103` and nothing about the thoughts that carry it. Sync reads
  both ends of a link event and the `children` of a renamed tag or type.
- **A kind change is one `304`, and it changes more than the kind.** `PATCH
  /kind` takes 1, 2 and 4 only. The `304` is against the thought, the kinds by
  name, and the last entry of the change. Each link under the thought turns
  with it and logs a `404`: children become the thoughts a tag is on or the
  instances of a type, with a `203` for a type gained or lost. A thought with
  no label is given its name for one when it becomes a type, and loses it
  with the kind only while it is still the name; a rename leaves it, so a
  renamed type reads, is found by TheBrain's search and is embedded under its
  old name too. No `202` says any of it; `label: null` clears it. The kind is
  beside the document, so the hash cannot see it: the indexer's `#write`
  compares it apart and `VectorStore.setKinds()` corrects the row with its
  vector kept. Never fold the kind into the hash or the document.
- **A write is in the log before it is in `graph`**, a tag by 0.1–0.5 s. Sync
  leaves its watermark `SYNC_OVERLAP_MS` behind so the next run reads that tail
  again; a watermark at the run's own start lost one tag in four.
- **A thought that is not created takes what hangs on it, and nothing else.**
  The thoughts under it used to be created with no parent and listed as
  created, and every run of the plan made them again. `ingest()` skips what
  depends on a failure, finishes the branches beside it, and returns
  `failures` and `skipped` apart; `brain_ingest` makes any of either an
  `isError` result that asks for the rest alone. A `tempId` is resolved as a
  `tempId` only: one that reads as a UUID is not an identifier. A create that
  timed out may have landed (`mayHaveLanded()`): say so, never call it failed.
  Two plan items for one thought are one create: when it fails the other
  stands under `skipped`. A plan that names nothing in the brain reads the
  brain before its first write, so a `brainId` that is no brain fails it once.
- **`requireParent()` returns null for an identifier nobody has, and does not
  throw.** `brain_create_thought` and `brain_link` leave such a parent to
  their write, which the API refuses by name. Only `ingest()` rejects by it,
  before its first write, and it reads a thought's `parent` under every
  relation. The lower end of a plan link and the ends of a jump are not read:
  that link fails alone.
- **A tool that writes more than once says what it wrote when a later write
  fails.** A write after the first is a step of `inOrder()` in
  `src/server/tools/write.ts`, never a bare `await`: thrown to `guard()`, its
  error was the whole result, and `brain_create_thought` lost the identifier
  of the thought it had made. The call stops at its first failure, and
  `writtenInPart()` makes an `isError` result with `brain_ingest`'s sections:
  "Done" by identifier, "Failed", "Skipped", "Next". Once something is under
  "Done" a step's reason is `describeError(error, false)`, so a refusal's
  "Nothing was written" is not read of the whole call. A write that got no
  answer may have landed (`mayHaveLanded()`, false for a `GET`), and its line
  says so.
- **A plan thought is looked for where its relation puts it, in a graph that
  lags.** A graph lists a thought created as a child under `children`, as a
  parent under `parents`, as a jump under `jumps`; `ingest()` looked among
  `children` alone and made the other two again on every run. The same
  thought is the same name under the same relation to the same thought; one
  of that name under another relation fails with its identifier, neither
  reused nor made again. The graph is a copy (below): `ingest()` returns once
  the graphs list what it made, or after 3 s (`LISTED`), counting what they
  still lack then in `unlisted`. A read of that graph that fails fails the
  thought, never "nothing there". A thought with no parent is still made by
  every run, and a `relation` with no parent is refused before any write.
- **A read result marks every thought that is not an ordinary one, and only
  those.** `kindMark()` and `kindLabel()` in `src/server/respond.ts`: `[type]`
  or `[tag]` after the identifier, a `Kind` column in `brain_search`, nothing
  for an ordinary thought. A new read tool that names a thought prints its
  mark. It costs no request: every thought the API returns carries `kind`, in
  a graph's lists and in a search hit. In vector mode the kind is the index's
  own, as old as its last sync: a sync reads a thought again on a `304` and a
  rebuild compares every row's kind, and either corrects the row without
  encoding it. A write
  result marks a thought where the kind is already in what the tool read; the
  ends of a link are not marked.
- **A read result prints a label only where it is not the name.** Every type
  has its name for a label (L38), so `labelOf()` and `labelMark()` in
  `src/server/respond.ts` drop one equal to the name, and a thought with no
  other reads as it did, to the character. Under a type whose label is not
  its name, `TYPE_LABEL` says it may be a name the type had and that
  `label: null` clears it. It costs no request: the label is on every thought
  in a graph's lists and in `/types` and `/tags`.
- **The search refuses a long query without a word about length.** Past 8,192
  bytes of request line it is a 414 with no body, which 1,346 Cyrillic letters
  reach, and for 513 to 1,024 words it is the catch-all 403.
  `search.inBrain()` makes `query_too_long` of both; a shorter query to the
  same brain is answered.
- **A read that failed is not the API's answer for "nothing".** A thought with
  no note is a 200 with a sentinel, and a note's read answers the catch-all 403
  for up to 0.2 s after the note's attachment is deleted, on a thought that is
  there. Never `.catch(() => "")` a read in a tool: keep the failure (`kept()`
  in `tools/read.ts`), fail the call when the read is ahead of a write that
  erases (`brain_set_note`, `brain_delete_thought`), and name what was not
  read when the tool only shows it ("Note not read", "Not read", "Listing not
  read").
- **A write reads back late, by no fixed time, and past the wait it is
  accepted, not failed.** A type set or removed and an alias list are waited
  for up to `READ_BACK` (3 s, a read every 50 ms); past it they are
  `not_read_back`, "accepted… do not send it again", never under "Done", and
  `brain_update_thought` stops there as at any failure. Nothing holds back
  the next edit of that thought: built on the old value it would undo the
  write, which the aliases' line says.
- **A note of white space alone is kept in its file and read as `""`**, by
  .NET's rule, not `trim()`'s: U+0085 is white space to it and a byte order
  mark is not. A note is what its read returns: `""` is none, anything else is
  printed, through `shownName()` when nothing in it shows. `section()` drops
  only `null` and `""` and never reads a body; `bullet()` and `table()` return
  `null` for no rows.
- **A note write with no answer may have landed, and an append sent again
  lands twice.** Both note tools say so under "Next" when `mayHaveLanded()`.
- **For a moment after a note changes, its thought's `graph` is wrong about
  it.** After a change it lists no Notes attachment at one read within 0.2 s;
  after a deletion it still lists the note for up to 0.2 s, while the note's
  read is a 403; a first note shows up to 0.15 s late where the graph or the
  note was read before. The indexer takes "has a note" from the latest note
  entry in the log it has read (`noteStates()`), and from `isNotes` only where
  the log has none.
- **`notes/update` replaces, and a plan's note goes only where there is
  none.** `ingest()` reads the note of a thought it found in place and writes
  the plan's only when that read answers that there is none; a read that fails
  is not that answer. A found thought used to lose its note on every run.
  Changing a note is `brain_set_note` or `brain_append_note`, never a plan.
- **A graph is behind any write, not a batch's own alone, and by no fixed
  time.** The single-thought tools return at once. The copy has a new thought
  within 0.2 s as a rule; with the app slow to answer it was first seen 364 ms
  after the create's answer. `ingest()` waits out what is left of
  `COPY_LAG_MS`, 0.5 s, since `client.sinceLastWrite()` before its first look
  (`afterCopyLag()`), and then takes the graph at its word. Anything new that
  decides by a graph read straight after a write of this process waits the
  same way. A copy further behind than that, or behind a write made in the
  app or by another process, is not guarded.
- **Two thoughts of one name in one list of a graph are in no order to rely
  on.** They change places from read to read. `ingest()` fails a plan thought
  with two candidates and names both.
- **`statistics` counts thoughts, links, notes and web links at the first
  read; `thoughtTypes` and `tags` lag**, by up to about two seconds. Never
  compare those two at one read.
- **A log request with no `startTime` costs time by the length of the whole
  log**, however few entries it asks for: 135 ms for the newest 50 of
  171,000, 15 ms from an hour back. Name a start wherever there is one;
  `modificationPages()` takes `since` and `until`. In contract tests read
  through `newestLogs()`, fill an index with `indexedSince()`, and call
  `caughtUp()` before the write a sync test is about: a thought seconds old is
  reread for its own `101`.
- **Search is prefix-based.** This is why `src/semantic/` exists.
- **A search hit is the search index's copy, not the thought, and that index
  is about five seconds behind.** Until its next refresh `search/{brainId}`
  and `?nameExact=` return a thought that was deleted, the hit the same to the
  last field, and a changed one by its old text under its old name.
  `SemanticSearch.find()` reads every hit's thought before it returns: a 404
  goes to `gone`, any other failure to `unverified`. Anything new that takes
  an identifier from a search or from `findByName` needs that read.

## Semantic layer

`@huggingface/transformers` is an **optional peer dependency** — 380 MB installed
plus a 113 MB model. Without it, search degrades to a lexical fan-out over
agent-supplied variants and reports why. Do not make it required, and do not let
its absence throw.

Constraints to respect in any new code:

- **Top-k only, never absolute similarity thresholds.** e5 scores sit in
  0.74–0.92, and correct-versus-wrong can differ by 0.001.
- **Changing the model or dtype invalidates the index.** Check compatibility
  explicitly rather than silently ranking against stale vectors.
- **Changing what goes into a document means bumping `DOCUMENT_FORMAT`.** It is
  folded into the stored model id, so old indexes rebuild instead of ranking
  against vectors built to different rules. The content hash cannot catch this:
  it only sees the document you already know how to build.
- **A request that fails is not an empty answer.** The fan-out passes on
  `invalid_uuid`, `unknown_brain` and `auth`, throws `SearchFailedError` when
  no phrasing was answered, and returns the phrasings it left out in
  `notSearched`, which `brain_search` prints. Never end a request with
  `.catch(() => [])` where the model will read the emptiness as "nothing there".
- **An index is a local file, and only a write creates it.** A `VectorStore`
  with no file reads as an empty index, so `brain_list`, `brain_search`, a
  status and `ctx.store(id).remove()` leave nothing behind. `brain_index` asks
  `brains.get()` first, for every action; `indexPath()` refuses a `brainId`
  that is no UUID. Ranking by vectors makes no request, but `find()` then
  reads the thought of each hit: with TheBrain closed a vector search lists
  its hits as not verified, and with a rejected key or a `brainId` that is no
  brain it fails. A rebuild or a sync also leaves an empty
  `index-<id>.sqlite.lock` beside the file, even when it wrote nothing.
- **The index file is shared: every client session runs a server process of
  its own over it.** A search asks `PRAGMA data_version` before it ranks and
  reads the rows again when another connection has committed; anything else
  kept in memory from that file needs the same check. Every write of
  `VectorStore` is one `BEGIN IMMEDIATE` transaction that waits
  `BUSY_TIMEOUT_MS` (2 s) and then throws `IndexBusyError`, a sentence:
  SQLite's `database is locked` must not reach a result. A rebuild and a sync
  hold `store.claim()` from before their first look at the index to their
  last write, so two runs never overlap; a second one waits `RUN_WAIT_MS`
  (10 s) and is then refused with `IndexRunningError`, having read and written
  nothing. Code that reads the index, awaits, and writes by what it read
  belongs inside a claim; a single write, like `remove()` after a deletion,
  does not. An index of another model is replaced through `startOver()`, in
  one transaction; `clear()` is gone.
- **A rebuild and a sync read everything before they write anything, and a
  read that fails is not an answer.** `auth`, `unknown_brain` and `network`
  stop the run, and so do the log's and the brain's reads whatever they fail
  with: the index is as it was. Any other failure leaves the thought in
  `IndexResult.unread`, its row untouched; only the 404 of the thought's own
  read, asked for after its graph's 403, removes a row. With anything unread
  the watermark does not move, a rebuild removes no row its walk did not
  reach, and `brain_index` answers `isError`. Never `.catch(() => null)` a
  graph or `.catch(() => "")` a note there. Both runs ask
  `SemanticIndexer.cannotEmbed()` before their first request
  (`Embedder.isAvailable?.()`, then `whyUnavailable?.()` for the reason), and
  `brain_index` status asks it too: usable is an index a search can rank by
  and an embedder that can embed.

## Tests

```
npm test                                                     # unit only
THEBRAIN_API_KEY=… npm test                                  # + read-only contract
THEBRAIN_API_KEY=… THEBRAIN_TEST_BRAIN_ID=<uuid> npm test    # + write contract
```

Write tests demand an explicit throwaway brain and refuse any brain over 500
thoughts. Suites skip cleanly when the variables are absent. They read no
other brain, only the list of brains: a run of note changes cut short is told
by the test brain's own log, which must show nothing in between, and the
read-only tests that need a brain read the one `THEBRAIN_TEST_BRAIN_ID` names
and skip without it. A run sweeps what it made by identifier from the log, and the
next run sweeps for one that died (a per-brain file in the OS temp directory).
The sweep starts past the newest entry the brain logged before the run's first
write, never deletes the home thought, and deletes in rounds a second apart
with no two thoughts that share a link in one round (`test/sweep.ts`). A test
that a read is behind a write writes until one first read is behind, forty
tries at most; never "stale > 0 of N". A read-back is polled, not given a
fixed pause. A contract test with no bound of its own has `DEFAULT_TEST_MS`
(20 s), not vitest's 5 s; a read-back polls with `eventually()`'s default of
5 s, and TheBrain's search, about five seconds behind, is waited for with a
bound of its own. Tests of bursts of writes sent at once, which the server is
not built for, run only with `THEBRAIN_LOAD_TESTS=1` as well, in the
`describe.runIf(LOAD_TESTS)` block of `test/resources.integration.test.ts`;
a new test under load goes there.

When a claim about the API goes into a document, it should have a test behind it.
Two documented claims in this project's history turned out to be wrong precisely
because they were asserted rather than measured.

## Local development

The API key lives in TheBrain under Settings → User → Local API Key. Pass it
through the environment; never commit it.

```
http://localhost:11522/api/v1/docs.json   # OpenAPI
http://localhost:11522/api/index.html     # Swagger UI
```
