# TheBrain Local API — endpoint map

Source: `http://localhost:11522/api/v1/docs.json` (OpenAPI 3.0.1, `TheBrain Local API v1.0`),
as served by TheBrain 15.0.640.
A copy of the spec: [`thebrain-local-api.openapi.json`](./thebrain-local-api.openapi.json).

- Base: `http://localhost:11522`; builds from before the port moved listen on `http://localhost:8001` (L15)
- Auth: `Authorization: Bearer <apiKey>`; the key lives in the desktop app under **Settings > User > Local API Key**
- Total: **48 paths**, 29 schemas, 9 tags
- The local API ≈ the cloud API plus a unique **App Control** group (`/api/app/*`)

---

## 1. App Control (4) — local API only

| Method | Path | What it does |
|---|---|---|
| GET | `/api/app/state` | Application state: current brain/thought, `isLoggedIn`, `userId`, open tabs (`tabs`) |
| POST | `/api/app/brain/{brainId}/open` | Open a brain in a tab |
| POST | `/api/app/brain/{brainId}/close` | Close a brain's tab |
| POST | `/api/app/brain/{brainId}/thought/{thoughtId}/activate` | Activate (navigate to) a thought in the UI |

Returns 403 if the API key does not belong to the currently logged-in user.

## 2. Brains (6)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/brains` | The user's brains (`BrainDto[]`) |
| POST | `/api/brains` | Create a brain (multipart, field `brainName`) |
| GET | `/api/brains/{id}` | Brain details |
| DELETE | `/api/brains/{id}` | **Delete a brain** (destructive) |
| GET | `/api/brains/{brainId}/statistics` | Counts of thoughts/links/notes/files and byte sizes |
| GET | `/api/brains/{brainId}/modifications` | The brain's modification log; `maxLogs` (**required**), `startTime`/`endTime` (RFC 3339). Keeps the newest `maxLogs` entries, see L14. Not append-only: a note's newest entry can move, see L20 |

## 3. Thoughts (13) — the core

| Method | Path | What it does |
|---|---|---|
| GET | `/api/thoughts/{brainId}/{thoughtId}` | Thought details (`ThoughtDto`) |
| PATCH | `/api/thoughts/{brainId}/{thoughtId}` | Update via **JSON Patch** (`name`, `label`, `aliases`, `typeId`, colours, `acType`, `kind`). A value is cleared with `remove`, never with `null`, and a type not at all (L19) |
| DELETE | `/api/thoughts/{brainId}/{thoughtId}` | Delete a thought |
| POST | `/api/thoughts/{brainId}` | Create a thought (`ThoughtCreateModel`) → `{id}`. As the child of a type it is made one of that type, with no parent (L24). `relation` is 1, 2 or 3 and has no default: with 4, the spec's Sibling, or with none, the thought is linked to nothing (L25). A `sourceThoughtId` nobody has is a 404, one deleted a moment ago a 400, and neither makes a thought (L26) |
| GET | `/api/thoughts/{brainId}?nameExact=` | The first thought whose name matches exactly |
| GET | `/api/thoughts/{brainId}/{thoughtId}/graph` | **Thought + parents/children/jumps/siblings/tags/type/links/attachments**; `includeSiblings`. Answered from a copy once it has been read, up to 0.2 s behind a create (L27) |
| GET | `/api/thoughts/{brainId}/{thoughtId}/attachments` | A thought's attachments |
| POST | `/api/thoughts/{brainId}/{thoughtId}/pin` | Pin |
| DELETE | `/api/thoughts/{brainId}/{thoughtId}/pin` | Unpin |
| GET | `/api/thoughts/{brainId}/pins` | Pinned thoughts |
| GET | `/api/thoughts/{brainId}/types` | All of the brain's Types (also thoughts, with `kind=2`) |
| GET | `/api/thoughts/{brainId}/tags` | All of the brain's Tags (`kind=4`) |
| GET | `/api/thoughts/{brainId}/{thoughtId}/modifications` | A thought's history; `maxLogs` and `includeRelatedLogs` are **both required** |

> Routing trap: `/api/thoughts/{brainId}/{thoughtId}` has the same shape as
> `/api/thoughts/{brainId}/pins|types|tags`. Literal segments win — never pass
> those words as identifiers.

## 4. Links (6)

| Method | Path | What it does |
|---|---|---|
| POST | `/api/links/{brainId}` | Create a link (`LinkCreateModel`: `thoughtIdA`, `thoughtIdB`, `relation`, `name`) → `{id}`. A parent/child link with a type above sets the lower thought's type (L21, L24), with a tag above attaches the tag (L23). `relation` is 1, 2 or 3: 4, the spec's Sibling, is a 400, and so is leaving it out (L25) |
| GET | `/api/links/{brainId}/{linkId}` | Link details |
| PATCH | `/api/links/{brainId}/{linkId}` | Update via JSON Patch (`name`, `color`, `thickness`, `direction`, `relation`). Only a name and a colour can be cleared, with `remove`; `thickness` reads back a hundred times what was written (L22) |
| DELETE | `/api/links/{brainId}/{linkId}` | Delete a link |
| GET | `/api/links/{brainId}/{thoughtIdA}/{thoughtIdB}` | The link between two thoughts (404 if none) |
| GET | `/api/links/{brainId}/{linkId}/attachments` | A link's attachments |

> Same trap: `/{linkId}` (2 segments) versus `/{thoughtIdA}/{thoughtIdB}`
> (3 segments) — they differ only in segment count.

## 5. Notes (5)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/notes/{brainId}/{thoughtId}` | The note as **Markdown** |
| GET | `/api/notes/{brainId}/{thoughtId}/html` | As HTML |
| GET | `/api/notes/{brainId}/{thoughtId}/text` | As plain text |
| POST | `/api/notes/{brainId}/{thoughtId}/update` | Create or **replace** the note (`{markdown}`) |
| POST | `/api/notes/{brainId}/{thoughtId}/append` | Append to the end (`{markdown}`) |

All three GETs return the same `NotesDto` (fields `markdown`/`html`/`text`) —
only the populated field differs. Images inside notes are served through a
temporary token.

## 6. Attachments (6)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/attachments/{brainId}/{attachmentId}/metadata` | Attachment metadata |
| GET | `/api/attachments/{brainId}/{attachmentId}/file-content` | Attachment bytes |
| DELETE | `/api/attachments/{brainId}/{attachmentId}` | Delete an attachment |
| POST | `/api/attachments/{brainId}/{thoughtId}/file` | Upload a file (multipart) |
| POST | `/api/attachments/{brainId}/{thoughtId}/url` | Add a URL attachment; `url` (required), `name` (empty → the page's `<title>` is used) |
| GET | `/api/attachments/{brainId}/by-location` | **Lookup by location** — URL or path. For URLs (type 3): ignores the http/https scheme and trailing `/`; the rest must match exactly, case included, the host too (measured, L17). Meant for web-clipper deduplication |

`type`: 2 = ExternalFile, 3 = ExternalUrl (default), 8 = ExternalDirectory.

## 7. Search (3)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/search/{brainId}` | Search within one brain |
| GET | `/api/search/accessible` | Search across all accessible brains |
| GET | `/api/search/public` | Search public brains; supports `excludeBrainIds` |

Shared parameters: `queryText` (**required**), `maxResults` (**required**),
`onlySearchThoughtNames`.
⚠️ Indexing of new content takes **up to 15 seconds**. This matters for the
"create it, then immediately search for it" scenario.
A query is refused for its size without a word about size: a 414 with no body
past 8,192 bytes of request line, the catch-all 403 for 513 to 1,024 words
(measured, L30).

## 8. BrainAccess (3) + Users (1)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/brain-access/{brainId}` | Access list (admin required) |
| POST | `/api/brain-access/{brainId}` | Grant access (`emailAddress` or `userId` + `accessType`) |
| DELETE | `/api/brain-access/{brainId}` | Revoke access |
| GET | `/api/users/organization` | Members of a TeamBrain organisation |

## 9. FileDownload / NotesImages (11) — internal plumbing

`/theme-wallpaper/{themeHash}`, `/file-display/{tempId}`, `/file-download/{tempId}`,
`/brain-thumb/{brainId}/{userId}/{dummyImageId}`, `/favicon/{filename}`,
`/stock-icons/{category}/{iconId}`, `/custom-icons/{category}/{iconId}`, `/custom-icons-root/{iconId}`,
`/notes-image-request/{brainId}/{filename}`, `/image-request/{tempId}/{size}`,
`/api/notes-images/{brainId}/{token}/{filename}` (no auth, expiring token).

They serve bytes addressed by internal temp-ids that the API never hands out.
**Not needed for MCP.**

---

## Data model

**ThoughtDto** — `id`, `brainId`, `name`, `cleanedUpName`, `label`, `aliases`, `typeId`, `kind`, `acType`,
`foregroundColor`, `backgroundColor`, `creationDateTime`, `modificationDateTime`,
`forgottenDateTime`, `linksModificationDateTime`, `displayModificationDateTime`.

**LinkDto** — `id`, `thoughtIdA`, `thoughtIdB`, `relation`, `direction`, `meaning`, `kind`,
`name`, `typeId`, `color`, `thickness`.

**ThoughtGraphDto** — `activeThought`, `parents[]`, `children[]`, `jumps[]`, `siblings[]`,
`tags[]`, `type`, `links[]`, `attachments[]`. The fattest and most useful response
in the API.

**AttachmentDto** — `id`, `sourceId`, `sourceType`, `type`, `name`, `location`, `dataLength`,
`isNotes`, `position`.

**SearchResultDto** — `sourceThought`, `sourceLink`, `searchResultType`, `entityType`,
`attachmentId`, `brainId`/`brainName`, `isFromOtherBrain`.

### Enumerations

| Enum | Values |
|---|---|
| `kind` (thought) | 1 Normal, 2 Type, 3 Event, 4 Tag, 5 System |
| `acType` | 0 Public, 1 Private |
| `relation` | 1 Child, 2 Parent, 3 Jump. The spec lists 4 Sibling as well, and nothing is written with it (L25) |
| `AttachmentType` | 2 ExternalFile, 3 ExternalUrl, 8 ExternalDirectory (the rest of `[0..15, 100]` are undocumented) |
| `EntityType` | -1 Unknown, 1 Brain, 2 Thought, 3 Link, 4 Attachment, 5 BrainSetting, 6 BrainAccessEntry, 7 CalendarEvent, 8 FieldInstance, 9 FieldDefinition |
| `ModificationType` | 101–105 generic (Created/Deleted/ChangedName/CreatedByPaste/ModifiedByPaste); 201–211 thought+link (colour, label, type, icons, fields, aliases); 301–304 thought (Forgot/Remembered/AccessType/Kind); 401–405 link (thickness/moved/direction/meaning/relation); 501–503 attachment; 601–602 brain; 701 access; 801–812 notes and assets; 900–903 calendar; 1001–1003 field definitions; 1101–1102 are in the enum with no description |
| `AccessType` | `[0,1,2,3,4]` — names not given in the spec |
| `SearchResultType` | `[0..7]` — names not given in the spec |
| `OperationType` (JSON Patch) | `[0..6]` — add/remove/replace/move/copy/test/invalid |

---

## Implications for tool scope

**The genuinely useful surface is 4 groups, roughly 30 endpoints.** The other 11
FileDownload paths plus BrainAccess/Users need no wrapper.

**Core (must have)**
- Search: `search/{brainId}`, `search/accessible`
- Graph reads: `thoughts/{brainId}/{thoughtId}/graph` — one call gives almost all
  of a thought's context
- Notes: read (markdown) plus `update`/`append`
- Writes: create thought, create link, PATCH thought/link

**App Control (the local API's killer feature)**
- `app/state` — where the user currently is, including which brain is open
- `activate` — the agent can highlight a result directly in the UI

**Valuable supporting endpoints**
- `thoughts/{brainId}/types` and `/tags` — the vocabulary needed for correct
  `typeId` values and tagging
- `attachments/by-location` — deduplication when saving links
- `modifications` (brain and thought) — "what changed since", for digests

### Things to account for when designing tools

1. **JSON Patch in the PATCH endpoints.** `ThoughtDtoJsonPatchDocument` is the raw
   operation format. That is a poor interface for an LLM: a tool should take flat
   fields (`name`, `label`, `color`) and assemble
   `[{op:"replace", path:"/name", value:...}]` internally.
2. **`brainId` everywhere.** `app/state` can supply a default, which is tempting.
   This project deliberately does not use it: writing into whichever brain the
   user happens to have open is the worst available failure. `brainId` is a
   required argument on every tool.
3. **No pagination.** Search takes `maxResults` (required), modifications takes
   `maxLogs` (required). Pick sensible defaults, or the model will invent them.
   The log can still be read in full by paging back on `endTime` (L14).
4. **No batch operations.** Creating a tree of N thoughts costs N+ calls — a
   candidate for a composite tool.
5. **Writes are not immediately visible.** "Create it and immediately find it"
   works through neither full-text search (up to 15 s) nor `nameExact`
   (~5.6 s, measured). Only reads by identifier are instant. Inside a batch write,
   link through returned UUIDs — see L12.
6. **No "list all thoughts" endpoint** and no traversal deeper than one hop —
   only `graph` for a single thought. Breadth-first traversal has to be built.
7. **No API for fields, calendar events, icons or brain settings** — even though
   `ModificationType` knows about them. They can only be observed indirectly
   through the modification log.
8. **Destructive operations**: DELETE brain / thought / link / attachment, and
   POST notes `update` (which replaces the whole note). These need to be marked
   or hidden behind a flag.
9. **Responses are content-negotiated** as `text/plain` / `application/json` /
   `text/json` — send `Accept: application/json` explicitly.

---

## Live observations (verified against a live TheBrain 15)

Verified on the `brain-mcp` brain; test entities were deleted and the brain
returned to its original state.

### Divergences from the spec, and bugs

| # | Observation | Consequence for MCP |
|---|---|---|
| L1 | **`/types` and `/tags` return `HTTP 400` when the list is empty.** Verified: 0 types → 400 `"Could not retrieve list of Types for brain ..."`; after creating a thought with `kind=2` the same request returned 200 and a list | The client must treat that 400 as an empty list, or the tool "crashes" on a clean brain |
| L2 | **A malformed UUID in the path → HTTP 200 plus the Blazor app's HTML page.** The route does not match and the request falls through to the SPA fallback. That is a `GET`, with the bad identifier in a thought's place or the brain's (7 paths, 5 of 5 each), and a `GET` of a path the API does not have answers the same. A `PATCH`, a `DELETE` and a `POST` with one are a 400 with an empty body (4 paths, 5 of 5 each). A well-formed identifier nobody has never gets the page (L3) | A naive client takes 200 for success and chokes on HTML. Validate UUIDs before the request and check the response `Content-Type` |
| L3 | **An identifier nobody has is answered by each request in its own way, and a `brainId` that is no brain by a 401 that reads like a key's.** For a well-formed UUID that no thought of the brain has: `GET /api/thoughts/{brainId}/{id}` and a `PATCH` of it are a 404, a ProblemDetails that says only `"Not Found"`; its `graph` is a 403 with the router's text, "To use the TheBrain API, make requests to /api…"; its `attachments` and `modifications` are a 200 with an empty list, and `GET /api/notes/…` a 200 with the "no note" sentinel; a `DELETE` of it is a 200 that deletes nothing. A write that names it answers in words of its own: `POST /api/thoughts` under it a 404 `"Source Thought <id> could not be located"`, and with it for a `typeId` a 400 `"Could not create thought."`; `POST /api/links` a 400 `"Could not get target thought <id>"`, or `"…source thought <id>"`, which is also the answer when both ends are nobody's; `POST /api/attachments/…/url` and a pin a 404 ``"Thought `<id>` not found."``. **A note is written to it all the same**: `notes/update` and `notes/append` answer 200 and store a note that hangs on no thought. The all-zero GUID, the identifier of a link or of the brain, a thought deleted earlier and a thought of another brain read through this one are answered like any identifier nobody has. **The 403 is the API's catch-all and says nothing of access.** It names no cause, and it is also what a patch the API cannot apply gets (L19, L21, L22), and the read of a note for up to 0.3 s after its attachment is deleted (12 of 12, six of them on a thought that is there). **A `brainId` no brain has** is a 401 `"Access to brain <id> is unauthorized."` from every request with a brain in its path, a read or a write, whatever else it names: 56 kinds of request, 810 sent. A rejected key is the other 401, `Invalid API Key`, and the key is asked about first. Each answer was the same every time it was asked for; the requests and the counts are in *An identifier nobody has, and a brain that is not there* below. Measured on 15.0.640 | The client tells the two 401s apart: `unknown_brain` for the brain, `auth` for the key. The tools used to answer a wrong `brainId` with "TheBrain rejected the key", and `brain_search` with an empty result. `describeError()` now says it is `brainId`, that the key was accepted and the other identifiers not looked at, and points at `brain_list`; `brain_search` passes that refusal on. For a 404 it keeps the API's words where they name the identifier, and where they do not it names the thought or the link the request's path addressed. For the 403 it says that no cause was given, names the request, and no longer says "Access denied". None of the three mentions `brainId`. The reads that decide a kind (`requireType`, `requireTag`, `requireParent`) take only the read's own 404 for "no such thought": a 403 taken for one would call a type that is there no type, and let a type through as a parent. **A tag taken off a thought nobody has** was answered "was not on the thought", in a result that was no error (3 of 3): the lookup of a link is the same 404 for such a thought as for two thoughts with no link. `brain_tag` now reads the thought before it gives that answer, once a call, and passes the read's 404 on; a removal that finds its tag reads nothing more. **Not guarded.** A note written to an identifier nobody has is reported as written by `brain_set_note` and `brain_append_note`; a parent nobody has is found out by the create and not ahead of the first write (L26). The 403 cannot be told from a request that failed for a reason of its own, so its message says what it most often means and no more. **For the read of a note it is never an identifier nobody has**, which that read answers with a 200: the tools that read a note take the 403 for a read that failed, never for a thought with no note, and its message says what it is (*A note whose attachment was deleted a moment ago*, below) |
| L4 | **`notes/append` on a thought with no note is a silent no-op**: HTTP 200, the note stays empty | An append tool must read the note first and fall back to `update` when there is none |
| L5 | **A Markdown round-trip loses the closing ` ``` ` of a code fence.** Sent a code block, got it back without the closing fence, with the rest of the document swallowed into the block | Notes containing code get corrupted. Either escape, or warn, or write through HTML |
| L6 | In `SearchResultDto` the `brainId` field comes back as zeros (`00000000-…`); the real id is in `sourceThought.brainId` | Take brainId from `sourceThought`, not from the result root |
| L7 | Dates arrive in inconsistent timezone formats: `app/state` with an offset (`+02:00`), `thoughts` naive (`2026-08-11T09:01:27.71436`), `search` with `Z`. Naive log timestamps are UTC (L14) | Normalise in the client |
| L8 | **Tags are attached through `relation: 2`** — the mechanism is undocumented, see the section below | The discriminator is a link's `meaning` field |
| L9 | **Search is prefix-based.** `OT` → finds `OTGP`; `OTPG` (a typo) → 0; `project` (a synonym) → 0 | Semantic proximity is unreachable through the API — a local vector layer is required |
| L10 | A thought's type arrives **both** in the `type` field **and** in the `parents` list | Filter it during traversal, or types end up in the tree as ordinary parents |
| L11 | 9–20 ms latency per request; 20 concurrent requests in 0.06 s | Indexing will not be bottlenecked by the API; parallelise freely |
| L13 | **A note is an attachment, and its log events are keyed by it.** `graph.attachments` carries `{isNotes: true, type: 1}` for a thought with a note and is empty without one. The log entry reads `{modType: 801/802/803, sourceType: 4, sourceId: <attachment>, extraAId: <thought>, extraAType: 2}` | Anything deciding "does this thought have a note" from `sourceId` silently sees nothing. Read `isNotes` from the graph; map log events through `extraAId` |
| L14 | **The log keeps the newest `maxLogs` entries, with or without `startTime`.** The spec says `maxLogs` counts "beginning from the `startTime`"; it does not. **It is ordered and filtered by `modificationDateTime`**, for the order of a response and for both bounds, and that is not always `creationDateTime`: it is never earlier, was a microsecond later for 258 of 11,205 entries (one write at a time as often as in a burst), up to 10 µs later for a type change, up to 56 µs for a note change, and 0.8–3.9 ms for five note changes in a working brain. A range ending at an entry's `creationDateTime` then leaves that entry out. Both bounds are inclusive to the microsecond. The timestamps are UTC with no offset and microsecond precision, trailing zeros trimmed (`…T13:48:59.61898`), and a bound without an offset is read as UTC. Concurrent writes share timestamps: 100 creates at once shared one in 57 bursts of 59, with 4 entries repeating another's at the median and 11 at the most | Read a long log in pages, passing the oldest entry's `modificationDateTime` back as `endTime` **in the exact string it arrived in**; `logTime()` names the field. Paging on `creationDateTime` lost one entry of 14,045 at page sizes of 1, 2, 7 and 25. A `Date` keeps milliseconds only, so the boundary entry would fall off the next page. Drop the repeated boundary entries by content, and grow a page that a single timestamp fills |
| L12 | **Writes become visible at different speeds.** `create`→`get(id)` instant; `rename`→`get` ~0.1 s; `set note`→`get note` ~0.2 s; `attachTag`→`graph.tags` ~0.1–0.5 s; **`create`→`findByName` ~5.6 s** | After a write, address thoughts **by identifier, never by name**. `nameExact` is not a workaround for "create it and immediately find it" |
| L16 | **Aliases are set as a whole list, and a write is not visible at once.** `aliases` is on every thought, `[]` when there are none, in `GET thought` and throughout `graph`. `PATCH` takes `replace` or `add` on `/aliases`, each setting the whole list, and `remove` to clear it; an element path such as `/aliases/0` is a 400. The API trims aliases, keeps the first of two spellings that differ only in case, drops one equal to the name in any case, and of a list longer than 100 keeps the first 100 with no error. After a `PATCH` a read usually still returns the old list: over 82 writes the new one showed up 50–100 ms later, 0.2 s at the most, and 7 times it was there at once. A thought created with aliases nearly always reads back with them, but not always: 3 of 60 came back without, for up to 0.15 s. The log entry is `{modType: 211, sourceType: 2, sourceId: <thought>}`, and creating a thought with aliases logs one too. TheBrain's own search finds a thought by an alias | Adding or removing one alias is a read-modify-write, and two in a row left only the second alias. `thoughts.changeAliases()` therefore waits for its write to read back, and refuses a list that would pass 100 rather than let the tail vanish. `brain_ingest` does not trust the read of a thought it has just created, and sends the aliases it was created with again. A 211 entry maps to its thought like any thought event, unlike a note (L13) |
| L15 | **The local API moved from port 8001 to 11522.** On 15.0.640 a connection to 8001 is refused and `http://localhost:11522` serves the same 48 paths. Settings shows the endpoint with its prefix, as `http://localhost:11522/api/` | With no address configured the client tries 11522, then 8001, and moves on only when the connection is refused — a request that may have been delivered is never repeated. A configured address ending in `/api` loses that suffix, since every path already carries it |
| L17 | **`by-location` compares the host by letter case, and a URL is stored as it was given.** The matching is what the spec says. The `http`/`https` scheme is ignored, absent or in capitals too, and so are the slashes at the very end; everything else is compared exactly. `Example.com/p` does not find `example.com/p`, nor `/Page` `/page`, nor `?Q=Abc` `?q=abc`; `ftp://` is another address, and so is a slash before the query. Not in the spec: `POST …/url` stores the location verbatim, capitals in the host included, and attaches a second copy of a URL the thought already has. `by-location` finds a new attachment on the first read (1,650 of 1,650). `GET thoughts/…/attachments` answers from a copy: made when a thought's attachments are first read, so that read is live (370 new thoughts of 370 listed their first attachment at once, and 1 of 60 whose empty list had been read before), and refreshed about every 0.1 s after that. Read straight after the write, the copy had the new attachment 16 times in 300, when a refresh fell in between; otherwise it came 7–214 ms later, at the next refresh or the one after | A lookup alone does not deduplicate links, and lower-casing the host before it does not help: the copy already stored may be the one in capitals. `attachments.attachUrl()` asks `by-location` first, which catches a repeat at once, then compares the thought's own URL attachments with the host case set aside (`urlKey`). It stores the URL as given. Only the host is folded, and only for http(s): a path has letter case, and so may whatever stands in the host's place in another scheme |
| L18 | **A label and a type are logged against the thought; a tag only as a link; a renamed tag or type only against itself.** Label: `{modType: 202, sourceType: 2, sourceId: <thought>}` with the old and new text, `null` when there is none. Type: `203`, keyed the same, with the type's *name* as the value; replacing a type logs two (old → `null`, `null` → new), and deleting a type logs one per instance. Tag attached: `{modType: 101, sourceType: 3, sourceId: <link>, extraAId: <tag>, extraBId: <thought>}`, both `extra` types 2, values `null`; detached, or the tag deleted: `102` with the same ends. An ordinary parent link logs the same entry with the parent in `extraAId`: nothing in it says which link is a tag. Moving a link's end (`PATCH /thoughtIdB`) logs `402` with the new ends only. A tag turned into an ordinary thought (`PATCH /kind`) logs `404` against each of its links, `oldValue: "HasTag"`, `newValue: "Normal"`, and each becomes a parent link. Renaming a tag or a type logs one `103` against it and nothing about the thoughts that carry it; their `graph` shows the new name ~0.1 s later. All of it measured on 15.0.640 through the API; a tag attached in TheBrain's own window could not be measured | Sync cannot tell a tag link from the log, so it reads both ends of every created, deleted, moved or re-meant link again and lets the document hash drop the ordinary ones (`linkEndIds`). For a renamed tag or type it marks the `children` of that thought's graph. The thought a tag link was moved away from is named nowhere and stays stale until a rebuild |
| L19 | **`replace` with `null` clears nothing, and no patch takes a type away.** Label: `replace` with `null` is a 403, the catch-all the graph of a thought that does not exist gets (L3); `remove` clears it, and so does `replace` with `""`. Colours, `foregroundColor` and `backgroundColor` alike: `replace` with `null` or `""` is a 400 `"Color format is malformed - should be like '#123456'."`; only `remove` clears. `remove` on a label or a colour that is not there is a 200. `typeId`: `replace` with `null` or `""` answers 200 and leaves the type where it was; `remove`, and `replace` with the all-zero GUID, are a 403. What takes a type away is deleting its link: `GET /api/links/{brainId}/{typeId}/{thoughtId}` returns it, with either end named first, as `thoughtIdA` the type, `relation: 1`, `meaning: 2`. After the `DELETE` the thought reads `typeId: null`, its graph has `type: null`, and the log holds a `102` against the link and a `203` against the thought with `newValue: null`. A cleared label or colour read back as `null` up to 0.2 s later (45 clears); a removed type 20–210 ms later (13 removals), and not once on the first read. A patch is applied one operation at a time: when one is refused, those before it stay written and those after it are not tried. Measured on 15.0.640 | `thoughts.update()` sends `remove` for a `null` label or colour. For a `null` type it calls `removeType()`, which deletes the link and returns once the thought reads back without a type; it throws when that never happens, so `brain_update_thought` cannot report a removal that did not take place. A `typeId` that is not a UUID, the empty string included, is refused before the request. An update that throws may have written the fields ahead of the one refused; sending it again is harmless. `brain_update_thought` used to answer such an update with the refusal alone: given a name, a caption and a colour by name it answered `"Color format is malformed…"` with the name and the caption changed (3 of 3; a colour that is not `#rrggbb` is that 400 whatever it is, 9 of 9 in three spellings). The API does not say which operation it refused, so the tool now sends a field to a request and lists each as written, failed or not tried (ARCHITECTURE §4). Fields patched one after another are all kept: 60 thoughts, four or five fields each, read back whole every time |
| L20 | **A changed note does not always add a log entry: while its `803` is the newest entry TheBrain has logged, in any brain, the next change files that entry again under the new time.** The first write of a note logs `801`, which never moves, and the first change after it adds an `803`. From then on a change, `update` or `append`, even one that writes the text already there, takes that `803` out of its place and files it at the time of the change: `creationDateTime` and `modificationDateTime` both move, a few microseconds apart as in any entry, and a request for the old time returns nothing. 8 appends 150 ms, 1 s and 3 s apart, 60 appends and 60 `update`s each left one `803`, and so did changes 5 s, 15 s and 61 s apart. Any entry logged in between ends the run: the next change adds a new `803`, and the earlier one stays where it was, as it was. Measured with a rename and a label of the same thought, another thought created or renamed, another note written for the first time or changed, and a pin, which logs an entry too. So the rule is not per note: two notes changed in turn log an entry for every change. Nor is it per brain: an entry logged in another brain ends the run as well. 43 changes added a new `803` with nothing of their own brain logged since the last, and each had an entry of another brain in between; 48 pairs of changes with no entry of any brain between them were all gathered. Reads in between end nothing, of the note itself, of other notes, thoughts, graphs and attachments, of the log, statistics, types, tags or a search (those 48 pairs), nor does a write that logs nothing, such as a rename to the same name. Deleting the note logs `802` and leaves its `801` and `803` in place; a note written afterwards is a new attachment with its own `801`. Renames and labels are not gathered: three of each logged three entries. Measured on 15.0.640 through the API. Three things were not measured. A pause longer than 61 s: ten were tried, 67 s to 600 s, and each ended the run, but a parallel session was writing to another brain through every one of them, so they show nothing about pauses. TheBrain's own editor, which the API cannot drive: the working brains hold ten `803` entries between them, none next to another of the same note, which neither shows the same rule nor rules it out. And a restart of TheBrain between two changes | The log is not append-only, and an `803` counts runs of changes, not changes: `brain_recent_changes` shows one "note changed" row for a run, dated by its last change. Nothing is lost to it. The entry always carries the time of the latest change, so a sync that read it under an earlier time finds it again after its watermark. And only the newest entry ever moves: a reader paging back (L14) has it from its first page, and the pages still to come do not change under it. What must not be done is to count on an entry staying where it was read, or to count edits by counting entries. Measuring any of this needs TheBrain to itself: a session writing to another brain, or the user at work in the app, ends runs here, and the contract tests check the other brains' logs before they blame the API |
| L21 | **`typeId` is not checked to be a type: it is a link from whatever thought it names, and that thought's `kind` decides what the link means.** The same in `PATCH /typeId` and in `POST /api/thoughts`. Named a type (`kind=2`), the link is `thoughtIdA` the type, `relation: 1`, `meaning: 2`, and the thought reads back with the `typeId`. Named an ordinary thought, the answer is still 200: the link is a parent's (`meaning: 1`), the thought has one more parent, and `typeId` is what it was, `null` or the type the thought already had. Named a tag, 200 again: the tag is attached (`meaning: 5`) and `typeId` is what it was. Ten of ten for each, in a patch and in a create, with a `sourceThoughtId` and without. An identifier nobody has is a 403 in a patch (L3) and a 400 `"Could not create thought."` in a create, which creates nothing. A thought named as its own type is a 200 that sets nothing, a type included. Only a type replaces a type, and the old one's link goes. **A link towards a type is a `typeId` in turn.** `POST /api/links` with `{thoughtIdA: <thought>, thoughtIdB: <type>, relation: 2}`, the request that attaches a tag (L8), or with `{thoughtIdA: <type>, thoughtIdB: <thought>, relation: 1}` makes that same link and sets the type, replacing one the thought had; so does creating a thought with a type as its `sourceThoughtId`. A jump to a type, and a type made a thought's child, are ordinary links. **Two thoughts share one link.** `POST /api/links` between two linked thoughts returns the `id` of the link that is there and rewrites it to the relation asked for: a jump posted between a child and its parent turns the child into a jump, and one posted to a thought's own type or tag takes the type or the tag away. A `typeId` set over a jump to that type turns the jump into the type's link. **Read-back.** A thought created with a type has it on the first read (340 of 340, 180 of them created six at a time). A type set by a patch shows 0–107 ms later, 92 ms at the median, and on the first read 24 times in 160. That is a quiet brain, and writes queue: the first patch after 150 thoughts created six at a time read back 0.6–0.8 s later (5 bursts); after thoughts created with a type, 0.5–0.8 s for 100 (10 bursts), 2.6 s for 300 and 5.3 s for 600 (one burst each); three seconds after a burst of 300, 0.1 s again. Measured on 15.0.640 | `thoughts.requireType()` reads the named thought ahead of the write and throws `not_a_type` unless it is a type. `update()` and `create()` both call it, and `brain_ingest` reads each distinct type of a plan before its first write, so one wrong `typeId` writes nothing. `update()` refuses a thought's own identifier with no request at all. Checking after the write would be too late: the parent or the tag is on the thought by then, and a created thought is left behind for a retry to duplicate. The cost is one read per write that carries a type: 0.5 ms at the median here, and 200 of them six at a time took 37 ms. `update()` then waits for the thought to read back with the type, because `removeType()` trusts its first read, which straight after a patch is usually the old one. It throws when 2 s are not enough, and the first patch after 300 thoughts created with a type took longer than that; the alias and type-removal waits have the same limit. `create()` does not wait. A link does what `typeId` does, and is refused where it would: a type named as a parent in L24, a type given for a tag in L23 |
| L22 | **A link's name and colour are cleared with `remove`, not with `null`; its thickness is not cleared at all, and reads back a hundred times what was written.** `PATCH /api/links/{brainId}/{linkId}`, path by path. `/name`: `replace` with `null` answers 200 and leaves the name where it was. `remove` and `replace` with `""` both leave `""`: an empty string, where a link never named has `null`, and a link never named reads `""` after a `remove` too. `/color`: `replace` with `null` or `""` is a 400 `"Color format is malformed - should be like '#fb5245'."`, and so is anything that is not `#rrggbb`; only `remove` clears it, to `null`. A colour reads back in capitals. `remove` on a name or a colour that is not there is a 200. `/thickness`: `replace` only. `remove` and `add` are a 400 `"Only 'replace' operations are allowed for 'thickness' path."`, `null` and `""` a 400 `"Link thickness not specified."`, and a fraction is a 403, the one of L3. A whole number is multiplied by a hundred: 3 reads back as 300. A new link reads `-1`, and no patch puts that back: `-1` reads back as `-100`, and `0` as `0`. `/direction`: `-1` on a new link as well; 0 to 7 read back as sent, and `-1` and 8 are a 400 `"Invalid 'direction' value provided."`. `/relation`: 3 makes a jump and 1 a child link, the ends staying as they are. 2 swaps the ends and reads back as 1, every time it is sent, so the same patch twice changes nothing. 4 answers 200 and changes nothing. **Read-back.** A patched link was not once there on the first read: 360 patches, thirty each of twelve kinds across the five paths. It showed 6–205 ms later, 72–102 ms at the median of each kind. A patch is applied one operation at a time and keeps what it wrote before the one refused, as a thought's is (L19). Thirty of thirty for each answer above; ten of ten for a link never named, the malformed colours, `add` and `""` on a thickness, the other directions and 8, and relation 3. Measured on 15.0.640 through the API alone: how TheBrain draws a thickness of 0 or below was not looked at | `links.update()` sends `remove` for a `null` name or colour. `UpdateLinkInput.thickness` has no `null`, since there is nothing to send for it, and `update()` refuses a thickness that is not a whole number before the request: the API would answer only after writing the fields ahead of it, and for a fraction with a 403 that says nothing of thickness. The number is in the units a patch takes, so a link's own `thickness` is a hundred times it. No tool sends a link anything but a name, and that a string. `update()` takes no `relation` and refuses one (L25). Not guarded: neither a direction nor a thickness goes back to `-1` once set |
| L23 | **The request that attaches a tag is not checked to name a tag, and the lookup that finds a tag's link returns any link.** `POST /api/links` with `{thoughtIdA: <thought>, thoughtIdB: <X>, relation: 2}` (L8) answers 200 whatever thought X is, and X's `kind` decides the link, as it does for a `typeId` (L21). X a type: the type's link (`meaning: 2`), and the thought's type is set, or replaced with the old type's link gone. X an ordinary thought: a parent's link (`meaning: 1`), one more parent. X nobody's: a 400 `"Could not get target thought <id>"`, and nothing is linked. X the thought itself: a 200 with an `id` of zeros and no link, for an ordinary thought, a tag and a type alike, and under any relation (L29). **A tag attached to a tag is a link of `meaning: 7`**, with `thoughtIdA` the tag attached and `relation: 1`, whichever end the request names first; the log calls that meaning `SubTagOf`. The lower tag's graph has the upper one in `tags` and in `parents` both, and the upper one's has the lower in `children`. Turned into an ordinary thought, the lower tag keeps the link, which becomes an ordinary tag's (`404`, `SubTagOf` to `HasTag`). **A thought and a tag can share a link that is not the tag's.** A jump between them, or the tag made the thought's child, is an ordinary link (`meaning: 1`) with the thought at `thoughtIdA`, and the thought's `graph.tags` is empty. The request that attaches the tag then turns either into the tag's link, under the `id` it had: one link per pair (L21). **`GET /api/links/{brainId}/{a}/{b}` returns that one link whatever it is**, with either end named first, and 404 when there is none. `GET /api/thoughts/{brainId}/{id}` for an identifier nobody has is a 404, where its `graph` is the 403 of L3. Ten of ten for each answer above; five of five for the 404 and for the tag attached over a child's link; the lower tag turned into a thought, and the graph's 403, once each. **Through the tools as they were**, ten of ten for each: `brain_tag` given a type or an ordinary thought to add, and `tagIds` naming one in `brain_create_thought` and in `brain_ingest`, set or replaced the type or added the parent and reported a tag attached. An identifier nobody has was an error only after `brain_create_thought` had created its thought, written its note and attached the tags ahead of it, with the new identifier nowhere in the answer; `brain_ingest` listed it under "Failed" beside a plan otherwise written, a `tempId` in `tagIds` likewise. `brain_tag` given the thought itself reported it attached. And `brain_tag` given a thought's type, parent, child or jump to remove deleted that link and reported a tag removed. Measured on 15.0.640 | `links.requireTag()` reads the named thought ahead of the write and throws `not_a_tag` unless it is a tag; given the thought the tag is for, it refuses that one with no request. `links.attachTag()` calls it. A tool reads its tags before its first write, not before the first tag: `brain_tag` every identifier it was given, to add and to remove; `brain_create_thought` its `tagIds` before it creates the thought; `brain_ingest` each distinct tag of a plan, once, before the plan's first write. A plan cannot make a tag, so its `tagIds` take no `tempId`, and one is refused with the rest. The refusal says what the identifier is instead and that nothing was written, and names `brain_list_types_and_tags`. `links.detachTag()` deletes only the link that carries the tag: `meaning` 5 or 7, with the tag at `thoughtIdA`. Any other link between the two it leaves, and reports the tag as not on the thought. The cost is one read per tag ahead of the writes and one more inside `attachTag()`, about a millisecond each here: `brain_tag` attaching one tag is three requests where it was one, removing one is three where it was two, `brain_create_thought` with one tag four where it was two. A refusal costs the reads up to the identifier refused: one request and 1–3 ms when it is the first, and nothing for the thought itself. Not guarded: the tag is read and then written to, so one deleted or turned into an ordinary thought in between is linked as whatever it has become, as with a type (L21); and attaching a tag the thought already jumps to, or has for a child, replaces that link with the tag's. `CleanGraph.parents` still lists the tag a tag is attached to |
| L24 | **A type is never a parent: a parent/child link with a type above is the lower thought's type, and the tools reported it as a link or a child.** The API facts are L21's: `POST /api/links` with a type for the upper end, written from either end, and `POST /api/thoughts` with a type as `sourceThoughtId` and `relation: 1`, answer 200 and set the type; the thought created that way has the type and no parent. Two more. **A thought created under one type with another for its `typeId` carries both**: two links of `meaning: 2`, `typeId` the one the request called so from the first read, and the other type left in `parents`. `graph.type` named the same one of the two types whichever was given as which, so in one arrangement it is not the thought's `typeId`. Deleting the link from `typeId`, which is how a type is taken away (L19), leaves `typeId: null` beside the other type's link. Five of five in each arrangement. **A tag linked under a type** is a 200 with an `id` of zeros and no link, from either end (3 of 3 each), like a thought named as its own tag (L23). **Through the tools as they were**, five of five for each unless said otherwise. `brain_link` with `relation: "parent"` towards a type, or `"child"` from one, set the thought's type, or replaced the one it had, and answered "link created"; given a tag to put under a type it answered "link created" with the identifier of zeros (3 of 3). Where the two were linked already, by the type's own link or by a jump, it wrote the label it was given and answered that the link existed. `brain_create_thought` with a type for `parentId` made a thought of that type with no parent and answered "created thought", and with another `typeId` beside it made the thought with both types. `brain_ingest` did the same with a `parent`; a link of a plan with a type above was counted under "links created", and replaced the type of a thought the plan had just created with one, and of a thought that was there before. A second run of a plan under a type found its thoughts among the type's instances, which a type's graph lists as `children`, and reported them as existing (once). A jump to a type, a type put under a thought, and a thought created above a type or beside it stayed ordinary links, as the API makes them (L21). **A plan thought can land on a type.** A type that is an ordinary child of a thought is what deduplication finds for a plan thought of its name under that thought, and what the plan put under it was created as one of that type (3 of 3). Measured on 15.0.640 | `links.requireParent()` reads the thought named as a parent ahead of the write and throws `not_a_parent` when it is a type. `links.create()` calls it for the upper end of a child or parent link, and `thoughts.create()` for a `sourceThoughtId` the new thought is to be the child of. `attachTag()` posts without it, having read its tag. A tool calls it before anything else it does, under its own name for the argument: `brain_link` ahead of the lookup for a link already there, so the answer does not depend on what joins the two and no label is written; `brain_create_thought` before the thought is made; `brain_ingest` once for each existing thought a plan names as a parent, in a thought's `parent` or at the upper end of a link, before the plan's first write. A `tempId` is not read, since a plan makes ordinary thoughts; one that lands on a type is refused at its own turn by `create()` and `links.create()`, and listed under "Failed"; the type it landed on stands in the table of thoughts as existing, marked `[type]` as a read result marks one. **Refused rather than carried out and reported.** The call asks for a link or a parent, and the API has neither to give under a type: all it can do there is set a type, which `typeId` asks for by name. Carried out, the call replaces a type before the model can be told. And a model that makes it either wants a thought of that type, which is what `typeId` is for, or does not know the identifier names a type: `brain_search` and `brain_get_thought` showed no thought's kind then, and mark a type or a tag now (ARCHITECTURE §4). The refusal names the type, says nothing was written, and gives both ways on: `typeId` of `brain_update_thought` or `brain_create_thought`, or an ordinary thought for the parent. The cost is one read of the upper end in the tool and one more in the resource method, 0.4 ms each at the median here. `brain_link` with a child or parent relation is four requests where it was two, `brain_create_thought` with a `parentId` three where it was one; a plan reads once more per thought with a parent, once per child or parent link, and once per existing thought named as a parent. A plan of 20 thoughts and 10 links went from 51 requests to 79, and took 248–339 ms where it had taken 255–337 (six runs each). A jump reads nothing. A refusal is one request and 1–5 ms from `brain_link` or `brain_create_thought`; a plan's comes after the reads of its types, tags and parents, 1–6 ms for the plans tried. **Not guarded.** A tag named as a parent went through when this was written, and the thought was tagged: `brain_link` reported a link created, and `brain_create_thought` and `brain_ingest` a thought created, the latter with "tags attached: 0" (5 of 5 each). It is refused since, as a type is, and so is the identifier of zeros of the tag under a type: L29. An identifier nobody has is left to the write, which answers as it did: a 400 for a link (L23), a 404 `"Source Thought <id> could not be located"` for a create. The parent is read and then written to, so a thought turned into a type in between is linked as one, as with L21 and L23 |
| L25 | **Nothing is written as a sibling: `relation: 4` is a 400 for a link, a thought linked to nothing for a create, and a 200 that changes nothing for a patch (L22).** The spec names `Sibling = 4` once, among the relations a new thought can have to its source, and gives a link's `relation` no values at all. **A link.** `POST /api/links` with `relation: 4` is a 400 `"Invalid link relation 4"`: from either end, between two children of one parent and between two thoughts with no parent (5 of 5 each), and between two thoughts linked already, by a jump or as parent and child, whose link stays what it was (3 of 3 each). A link takes 1, 2 or 3 and has no default: 0, 5 and -1 are the same 400 with their own number, and a request without `relation` is `"Invalid link relation 0"` (3 of 3 each). **A new thought.** `POST /api/thoughts` with a `sourceThoughtId` and `relation: 4` answers 200 with an `id`, like any create, and the thought it makes has no link: none to the source, none to the source's parent. The source with one parent, 5 of 5; with none, 5 of 5; with two, and with a child, a jump and a type of its own, 3 of 3 each. A `typeId` beside it is set, and that link is all the thought has (3 of 3). The source's graph and its parent's are as they were. No default here either, and no check: with `relation` 0, `null` or left out the thought is unlinked in the same way, and with 5 or -1 it gets a link from the source that carries that number for its `relation` and stands in neither thought's `parents`, `children` or `jumps` (3 of 3 each). **A sibling is not a link.** `graph` with `includeSiblings=true` lists under `siblings` the thoughts that share a parent with the active one; not asked, it sends `null`. Nothing joins two siblings: `GET /api/links/{brainId}/{a}/{b}` is a 404, and each has its own link from the parent. So two thoughts are siblings when they are given the same parent, and nothing else in the API says it. **A patch sets a type too.** `PATCH /relation` with 1 on a jump from a type to a thought, or with 2 on a jump from a thought to a type, answers 200 and turns the jump into the type's link (`meaning: 2`): the thought has that type, as from the same link posted (L21). 3 of 3 each. A patch takes the four numbers of the spec and no other: 0, 5 and -1 are a 400 `"Invalid 'relation' value provided."` (3 of 3 each). **Through the tools as they were.** `brain_link` with `relation: "sibling"` answered with the API's 400 as an error (5 of 5); given a label and two thoughts a jump joined, it wrote the label and answered that the link existed (3 of 3). `brain_create_thought` with it answered "created thought", wrote the note and attached the tag, and left the thought with the tag for its only link (5 of 5). `brain_ingest` listed a plan thought sent as a sibling as created, put the plan's thoughts under it and linked to it, and it had no parent (5 of 5); the same plan run again created it once more, since deduplication looks among its parent's children (3 of 3). A plan's link sent as a sibling was listed under "Failed" with the API's text, beside a plan otherwise written (5 of 5); between two thoughts linked already it was reported as a link that existed, with the label written (3 of 3). Measured on 15.0.640 | No tool offers `sibling`: the `relation` of `brain_create_thought`, of `brain_link` and of a plan's thoughts and links is `child`, `parent` or `jump`. Sent all the same, it is refused by the tool's schema, which the SDK (1.30) returns as an `isError` result naming the three values, with no request made: 3 of 3 through each tool, and a plan with it writes nothing. **Taken out, not kept and refused.** A value in the enum is offered on every `tools/list`, and a model picks from that list: one that can only be refused costs a call each time it is picked, whatever the description says of it. What is lost is a refusal in this server's own words. So the two arguments a sibling would be asked of say what to do instead: `relation` of `brain_create_thought` to pass the other thought's parent as `parentId`, and of `brain_link` that siblings are thoughts with a parent in common. Done that way through each of the three tools, the thoughts read back as siblings (3 of 3). **The server does not make a sibling itself**, by linking the thought under the source's parent: a source has none, one or several, and which of them is meant is the caller's to say (methodology stays in the skills). `Relation` has no `Sibling`. `thoughts.create()` refuses a `relation` that is none of the three before the request, because the API would create the thought; `links.create()` leaves a number forced past the type to the API's 400. `planLevels()` rejects a plan in which a thought or a link names a relation that is none of the three, before the first write: looked up, such a name gives no number, and `create` would send a child's. **`links.update()` takes no relation.** `UpdateLinkInput` has lost the field, and one forced past the type is refused before the request, with the fields beside it unwritten. No caller sent one. Kept, 4 would report a write that did not happen; 2 names the end that is to be the parent by its place in the link, which the patch itself changes, so the second send undoes the first; and 1 or 2 would need the read `links.create()` makes for a type above. What a link is, is changed by `links.create()` between the same two thoughts: it rewrites the link that is there (L21) and names both ends, so twice is the same as once. Sent twice with each of the three relations, it left the same link under the same `id`, its name kept (3 of 3). Not guarded: a patch sent past `update()` does all of the above |
| L26 | **A create that fails says so in three ways, one of them with the thought made; and `brain_ingest` created what was under a thought that failed, with no parent.** **A parent nobody has.** `POST /api/thoughts` with a `sourceThoughtId` no thought has is a 404 `"Source Thought <id> could not be located"` (L24), and no thought is made: `statistics.thoughts` was what it had been after 11 of 11, and the log had no entry for one after 8 of 8. **A parent deleted a moment ago** is refused in other words. Sent straight after the deletion of a thought that had lived 0.4 s or more, the create is a 400 `"Could not create thought."`, with no identifier in it: 15 of 15, whether or not the thought was read or given a child before it went. From 0.3 s after the deletion it is the 404 above (6 of 6), and for a thought deleted as soon as it was made it is that 404 at once (3 of 3 at 1 ms). Nothing is made either way. The deleted thought's `graph` is a 403 from the first request, while `GET` on it is still a 200 for a moment, and the 400 is the answer only while it is: counted again, with a read before each create, in *An identifier nobody has, and a brain that is not there* below. **No answer is not a refusal.** With the answer to a create dropped on its way back, which is all a timeout on the client's side knows, the thought was there under its parent (3 of 3), and the caller had no identifier for it. **Through `brain_ingest` as it was**, three batches each unless said otherwise, the failure caused on purpose: a parent nobody has; a plan thought landing on a type its parent holds, so that the one under it is refused (L24); the parent deleted between the plan's checks and the create; and, put in on the way to the live API, a 500, the generic 403 text of L3, a dropped connection and a lost answer. Every time the thoughts under the one that failed were created: the first of them with no parent, the rest under it, with their notes, tags and links to them, all listed as created and followed by "Everything else was written", in a result that was not an error. A link to the failed thought itself was listed under "Failed" as "one of the thoughts was not created". **A second run of the same plan** made those thoughts again while the failure lasted, two more each run with a parent nobody has (3 of 3): deduplication looks among a parent's children, and they had none. Once the failure was gone it created the failed thought and a second copy of everything under it, and left the first copies where they were (3 of 3 after a 500). After a lost answer it found the thought that had been made and put a second copy of its children under it (3 of 3). Measured on 15.0.640 | `ingest()` keeps, for each `tempId` with no thought behind it, the failure that is why. A thought whose parent is among them is not sent and joins them; a link with such an end is not tried; notes, tags and aliases go only to thoughts that are there. A `tempId` is resolved as a `tempId` alone: one that read as a UUID used to pass, unresolved, for the identifier it spells. The outcome lists `created` and `reused` by identifier, `failures` with the reason, and `skipped` with the `tempId` of the failure each item waited on. **The branches beside the failure are finished, not stopped.** Stopping at the first failure cannot make a batch whole: there is no rollback, up to five more creates of the level are in flight, and what was made would be left without notes, tags and links for a second call to add. A second call is where duplicates come from, so it is given less to do. **The result is `isError`** whenever something failed or was skipped: read as a success, "Failed" was one more section. Its table gains a `tempId` column and its last section asks for the failed and skipped items alone, in a new plan naming what exists by identifier; that is right whatever deduplication would find, and a thought made with no parent is made again by a whole plan sent twice. With no thought written the last section asks for the plan itself. A batch written whole reads as it did. **A create with no answer is marked** (`mayHaveLanded()`: a timeout or a dropped connection, not a refused one, nor any answer): its line says the thought may exist and to look next to its parent first. `brain_create_thought` says the same of its own create, which used to be the network's message alone over a thought that was there (3 of 3). **The 400 that names nothing** is explained by `describeError()`: what the API answers it for, that nothing was created, and to read the parent and the type before the call is sent again; in a batch it stands under "Failed" in the API's words. **What the report got wrong after that**, 3 of 3 each: a failed note, tag or alias was named by its thought's title, which two plan thoughts can share, and carries the thought's identifier now; two plan items for one thought that failed were two lines under "Failed", and are one, the other item being skipped as the same thought and not sent on its own; the warning about code fences listed notes that were not written; and a `brainId` that is no brain was a 401 a thought for a plan that names nothing in the brain, which now reads the brain ahead of its writes and is refused once (L3). The next run finds such a thought when it has a parent. With the same seven failures, once each, the batches left no thought without the parent the plan gave it, a second run added nothing while the failure lasted, and finished the plan with no second copy once it was gone. **Not guarded.** A parent nobody has is still found out by the create, not ahead of the first write, though the read that checks it for a type has the answer. A thought made with no parent by a create that got no answer is found by no later run. A 5xx is taken for an answer, and so is the generic 403 (L3): whether a create refused that way was carried out is not known. Nothing is deleted after a failure: deletion needs a human |
| L27 | **A thought created with a relation is listed where that relation puts it, in a graph that is answered from a copy; `brain_ingest` looked among `children` alone, and at once.** **Where.** `POST /api/thoughts` with a `sourceThoughtId` and `relation` 1, 2 or 3 puts the new thought among the source's `children`, `parents` or `jumps`, and in no other of the three. The source is in the matching list of the new thought: `parents`, `children`, `jumps`. One link joins the two, `meaning: 1`: a child's and a jump's with the source as `thoughtIdA`, `relation: 1` and `relation: 3`; a parent's with the new thought as `thoughtIdA` and `relation: 1`, the parent link it is. Ten of ten for each relation. **When.** `graph` answers from a copy, as a thought's attachment list does (L17): made when the graph is first read, so that read is live, and brought up to date about every 0.1 s after that. Next to a thought whose graph had been read, a thought was created and the graph read straight after the answer: it lacked the new thought 112 times in 120 (child 37 of 40, parent 36, jump 39), and had it 10–205 ms after the answer, 72 and 87 ms at the median of the two runs of 60. Read once and not polled, it lacked it 12 of 12 times up to 20 ms after the answer, 8 of 18 at 40–80 ms, 3 of 18 at 100–150 ms, and never from 200 ms on (12 of 12). The age of the copy does not matter: read 0.5, 2, 10, 30 and 60 s before the create, the graph lacked the thought straight after it 19 times in 20. It is one copy per thought, whatever `includeSiblings` was (4 of 5 lacked it after a read with the other value), and reading the thought itself, or another thought's graph, makes none (5 of 5 listed at once each). Next to a thought whose graph nothing had read, the read straight after the create had the new thought 60 times of 60, and so did the first read after 60 and after 150 thoughts created six at a time next to one that had been read (one burst each). `GET /api/links/{brainId}/{a}/{b}` returned the link at once while the graph still lacked the thought (5 of 5). **Through `brain_ingest` as it was**, the same plan sent twice, three times each unless said otherwise. A thought with `relation: "parent"` or `"jump"` was created again by the second run: 24 of 24, twelve next to an existing thought and twelve next to a `tempId`, sent at once and 0.3 s later. A child was found 0.3 s later (6 of 6) and created again by a run sent at once (5 of 6): that run read the copy. A thought with no parent was created again, and what the plan put under it with it, 0.3 s later and 8 s later (2 of 2 each). Where the parent already had a thought of the name under another relation (2 of 2 for each of the six pairs): one there as a child was listed as "existed" for a plan that asked for a parent or a jump, with no word of the difference; one there as a parent or as a jump was not seen, and a second thought of the name was made, and a third by the next run when the plan asked for a parent or a jump. Two plan items of one name under one thought, a child and a jump, gave one thought and one "existed" on the first run, and on the second another thought in 3 of 4, leaving twice a child and a jump of the name and once two jumps. One name under two thoughts, as a child of one and a jump of the other, gave two thoughts and a third on the second run (2 of 2). A read of the parent's graph that failed was taken for "no children": with a 500, the generic 403 of L3 or a dropped connection put in on the way to the live API, the thought was created beside the one of its name, in a result that was no error (9 of 9). **A relation with no parent**, in a plan thought and in `brain_create_thought` with no `parentId`: the thought was created with no link, and the result said "created" and was no error, for each of the three relations (1 of 1 each, six calls); `thoughts.create()` left the relation out of the request. Measured on 15.0.640, 2026-10-10 20:47–21:22, while another session's contract tests may have been writing to a second brain in the same app | `ingest()` looks for a plan thought in the list its relation puts it in, in the graph of the thought it hangs on: the same thought is the same trimmed name under the same relation to the same thought. That graph is read once per thought, and what the batch makes is added to what was read. **A namesake under another relation fails**, with what hangs on it skipped: it is neither reused, which would write the plan's note over its own and hang the plan's children on it, nor made a second time, which leaves a duplicate that needs a human to remove. Its line gives the identifier and both ways on: that identifier in place of the `tempId`, or `deduplicate: false`. Two plan items of one name under one thought with different relations are that case, and the first in the plan is the one made. Whether a namesake is the plan's thought is the caller's to say, not the server's. **A failed read fails the thought**, as a failed create does (L26). The graph of an identifier nobody has is a 403 in the words of L3, which a dropped request gets too, so `ingest()` asks for the thought itself: on its 404 there is nothing to look under, and the create goes out to be refused as in L26; on anything else the read has failed. With the same nine failures put in, nothing was created, and the next run found the thought that was there. A thought the batch created is not read: nothing is next to it yet. **The batch waits for the copies.** Before it returns, `ingest()` reads the graph of each thought that was there before the batch and got something next to it, every 25 ms until it lists what was made, for 2 s at the most; what is still missing is counted in `unlisted`, and the result then says to wait before sending the plan again. It waits whether or not it read that graph, since the copy may be older than the batch. The cost, five runs each: a batch of one thought 98–190 ms where it was 36–45, in 7 requests where it was 4; a plan of 20 thoughts with notes and 10 links, four of the thoughts next to existing ones, 325–456 ms where it was 432–482, in 80 requests where it was 86. Sent again at once, that plan now creates nothing, in 143–197 ms and 50 requests; it had created 14 of the 20 again. **A relation with no parent is refused**: by `planLevels()` before a plan's first write, by `brain_create_thought` before any request, and by `thoughts.create()`. The caller asked for a link and named nothing to link to, and a thought with no parent is the one a second run cannot find. `child` is refused like the other two. **Not guarded.** A thought with no parent is still created by every run: the only lookup left is by name, 5.6 s behind a create (L12) and blind to where the thought hangs. Two runs at the same moment each miss what the other is making. Of two thoughts of one name in one list, the one found is whichever the graph lists last. A plan thought can still land on a type or a tag that its parent holds under the same relation (L24), and the `parents` of a tag hold a tag it is attached to (L23) |
| L28 | **A read straight after a rename still returns the old name, and an alias equal to it was taken for the name's own.** `PATCH /name` followed at once by a `GET` of the thought returned the old name 19 times of 20 (L12 gives the lag as ~0.1 s). The API does not go by that read: `replace /aliases` with the old name in it, sent straight after the rename, was kept 20 times of 20, and the thought read back with the new name and the old one for its alias. What the API drops is an alias equal to the name the thought has (L16). **Through `brain_update_thought` as it was**, a call that renamed a thought and added its old name as an alias answered "aliases unchanged: nothing new to add" and wrote none, 10 times of 10, in a result that was no error. With a `typeId` in the same call the alias was kept, 10 of 10: the wait for the type's read-back stood between the patch and the read. Measured on 15.0.640 | `thoughts.changeAliases()` takes the name its caller has just written (`known.name`) and compares with that in place of the name it reads: the old name is kept, and the new one is what an alias cannot repeat. `brain_update_thought` passes the name of the call. 10 of 10 kept, with a type and without. It mattered more once the tool began to send a field to a request with the type first (L19), which takes the type's wait out from between the rename and the read. The read that waits for a write also no longer throws when it fails: a failed read has not shown the write, and its error used to pass for the write's own, so that aliases that were written stood under "Failed" |
| L29 | **`POST /api/links` answers 200 with an identifier of zeros for a link it does not make; a tag above is its attachment and no parent; and two thoughts share one link, which the tools reported as the one asked for whatever it was.** **Zeros.** A thought linked to itself is `{"id": "00000000-0000-0000-0000-000000000000"}` and no link, under each of the three relations and for an ordinary thought, a type and a tag alike (9 of 9; L23 had relation 2). So is a tag under a type, written from either end (L24). No other pair of kinds is: of the 27 ways to write a link between an ordinary thought, a type and a tag, those two were answered with zeros and the other 25 made a link, on fresh thoughts and again on thoughts already linked to others. What the 25 are, by the kind above and the kind below in a parent/child link: a thought above anything is an ordinary link (`meaning: 1`); a type above a thought is its type (2), and above a type a link of `meaning: 3`; a tag above a thought or a type is its attachment (5), and above a tag 7 (L23). A jump is `meaning: 1` between any two kinds. **No link reads back with `relation` 2**: one written as a parent's is stored as a child's from the other end, so `thoughtIdA` is the upper end of a parent/child link, as it is the tag of an attachment and the type of a type's link. **`POST /api/thoughts` was not seen to answer with zeros**, in 28 creates picked to make it. A tag created under a type, and a type created above a tag, come back with an identifier of their own and no link. Of the writes the client makes, the spec gives a response body to these two alone, each an `{id}` it calls `nullable`. **A tag named as a parent, through the tools as they were**, five of five each: `brain_link` with `relation: "parent"` towards a tag, or `"child"` from one, answered "link created" and attached the tag, with the label it was given on the attachment; `brain_create_thought` with a tag for `parentId` answered "created thought" for a thought tagged and with no parent; `brain_ingest` listed a thought with a tag for its `parent` as created, and a link with a tag above under "links created", beside "tags attached: 0". A second run of that plan, sent at once, listed the thought as existing: a tag's graph has the thoughts it marks among `children`, which is where the plan's thought was looked for, and where the first run had waited for it (L27), 72–194 ms for the whole batch. **A thought linked to itself, through the tools**, three of three each: `brain_link` answered "link created — 00000000-0000-0000-0000-000000000000" for each relation, and `brain_ingest` counted a plan's link from a thought to itself under "links created". **A link already there, through the tools**, three of three each. `brain_link` answered "Link already existed" whatever joined the two, and wrote the label it was given onto it: onto a jump where a parent was asked for, onto a tag's attachment and onto a type's link. `brain_ingest` compared the stored `relation` with the one asked for, and that is 1 for every parent/child link: a parent's link that was there exactly as asked, the one the plan's own thought had just been created with included, was reported as "already existed as parent-child, the requested parent-child was not added"; a link the other way up, a tag's attachment and a type's link passed for the child link asked for; and a tag or a type the plan asked to jump to was "parent-child", with the label written onto it. Measured on 15.0.640, 2026-10-10, while another session's contract tests were writing to a second brain in the same app | **A tag above is refused**, as a type is (L24), by the same read: `requireParent()` throws `tag_as_parent` for a tag, so `links.create()`, `thoughts.create()`, `brain_link`, `brain_create_thought` and a plan's parents and links all refuse one before their first write, and `brain_link` before it looks at what joins the two. Refused, not carried out and reported as a tag attached: the call asks for a parent, the thought would be left with none, and `brain_tag` and `tagIds` are the arguments that ask for a tag by name. Nothing is lost by attaching a tag, which is why L24 let it through; what is wrong is the answer, and a thought with no parent where one was asked for. The refusal names the tag, says nothing was written, and gives both ways on: `brain_tag` or `tagIds`, or an ordinary thought for the parent. It costs no request: the read was there for the type. A jump to a tag, a tag put under a thought, and a thought created above a tag or beside it are ordinary links and go out as before; `attachTag()` posts without the check. **Zeros are an error, in one place.** `createdId()` takes the answer of both creates and throws `zero_id` for an identifier of zeros: `links.create()` and `attachTag()` reach it through the one private request, and `thoughts.create()` is checked though no case was found, since zeros handed on as a parent are taken for none. The message says no link was made and nothing was written; `brain_link` returns it as an error, and `brain_ingest` lists the link under "Failed". Both known causes are refused sooner: the tag under a type by L24, and a thought linked to itself by `links.create()`, with no request, and by `planLevels()` for a plan link whose two ends are one reference. Two references that come to one thought are found at the link's turn, and listed under "Failed". **What joins two thoughts is said.** `linkFound()` sets the link `GET /api/links/{a}/{b}` returns against the one asked for, by `meaning` and by which end is `thoughtIdA`, and both tools use its words. The link asked for: "the link already existed". An ordinary link of another kind, or the other way up: "the link already existed as jump, the requested parent-child with toId above was not added", the ends named as the caller named them. A tag's attachment or a type's link: "toId is a tag on fromId, and two thoughts share one link: the requested jump was not added in its place", under "No link added" from `brain_link` and "Links not added" from `brain_ingest`, apart from the links that existed. Nothing is posted in any of these: it would replace what is there (L21). **A label goes onto an ordinary link whatever its relation, and onto nothing else.** It says how the two relate and that link is the one place it can be kept, so `brain_link` writes it as `brain_ingest` always has, and both say "only the label was updated". A tag's attachment and a type's link are not links between two thoughts and get none: "and no label was written". None of this is an error: nothing is there to put right, and the result says what is. No request is added anywhere, and a tag or a type found between the two is one request fewer when a label came with the call. **Not guarded.** The label written over an ordinary link replaces the one it had, and the result does not say what that was. A plan thought that deduplication lands on a tag is refused at its own turn, like one that lands on a type (L24), unless the tag already marks a thought of the name asked for under it: a tag's graph lists it among `children`, and it is taken for the plan's (2 of 2 each). An answer with no `id` at all, which the spec allows, has not been seen and is not checked for |
| L30 | **The search refuses a query for its size in two ways that say nothing of size, and `brain_search` with no index read every failed request as nothing found.** All of it is `GET /api/search/{brainId}`. **A field missing.** A `queryText` that is absent, empty or only white space is a 400, a ProblemDetails with `"The queryText field is required."` under `errors`. **414.** A request line of more than 8,192 bytes, its line ending counted, is a 414 with no body: 8,190 bytes of line are taken and 8,191 are not. With this path and its two other parameters that leaves the query 8,075 bytes as the URL carries it: 8,075 Latin letters, 1,345 Cyrillic ones at 6 bytes each, 897 CJK characters at 9. The 414 comes before the key and the brain are looked at: a wrong key with such a query is the 414 and not the 401 of L3, and so is a `brainId` no brain has. **403.** A query of more than 512 words of two characters or more, and of no more than 1,024 words in all, is the catch-all 403 of L3, "To use the TheBrain API, make requests to /api…": 512 words are a 200, 513 and 1,024 the 403, and 1,025 a 200 again. A word of one character is not counted among the 512 and is among the 1,024: 600 words of one letter are a 200, 600 of two letters with 300 of one the 403, and with 500 of one a 200. It is the same for words that are all alike and all different, and parted by one space, two, or a line break. A key that is wrong or a brain nobody has is asked about first there: the 401. **Not refused.** Odd characters: 57 queries of quotes, brackets, wildcards, operators (`AND`, `a~2`, `[a TO b]`), a NUL, a zero-width space, an emoji, CJK and Cyrillic were each a 200, three times over. Each answer was the same every time it was asked for: the edges of the 414 bisected in three scripts, the edges of the 403 5 of 5, the rest 3 of 3. **Through the tools as they were**, the key on the live API and the rest with a local socket or a faked fetch: `brain_search` with no index, or with one and no embeddings package, answered a rejected key, nothing listening, a dropped connection, a timeout, a 500 and a 503 with no error and no hit, only its warning that semantic search is unavailable, and so it answered the 414 and the 403; with one phrasing of several failing it gave the hits of the others and said nothing of the one. A query of spaces sent no request and answered the same. With an index and an embedder it made no request under any of them and returned its hits. `brain_index` with `action: "status"` made no request either, and for each of those failures and for a `brainId` no brain has answered "built: no" and "Call this tool with action=rebuild"; after a rebuild that had failed it answered "built: yes", "usable: yes" and no thought indexed. Measured on 15.0.640 | `search.inBrain()` makes `query_too_long` of the 414 and of the 403 for a query in that range of words, with the size in its message; a 403 for a shorter query stays the catch-all. The fan-out behind `brain_search` passes on at once a failure that is about the call (`invalid_uuid`, `unknown_brain`, `auth`) and takes any other for one phrasing's own, since the 414 and the 403 are. With no phrasing answered it is an error, "Nothing was searched, and this is no answer about what the brain holds", with the reason once or per phrasing; with some answered the result has a `Not searched` section that names each phrasing left out and why. A query that is empty with every variant empty is refused in both modes, and a fan-out that found nothing says so in words. `brain_index` asks for the brain before it opens the index, for every action (one `GET /api/brains/{id}`, 0.3 ms at the median), and fails with what that fails with; its status calls built only a build that finished, and usable what `brain_search` would rank by. `indexPath()` refuses a `brainId` that is no UUID: the index file is named by it, and `status` for `x/../../name` made a file outside the data directory. **Not guarded.** Vector mode answers from the index whatever TheBrain would say, as before. A rebuild and a sync still skip a thought whose graph cannot be read, whatever the reason: with the log answered and every graph a 500 they reported the index built or refreshed with nothing encoded (ARCHITECTURE §8) |
| L31 | **`PATCH /kind` turns an ordinary thought into a tag or a type and back, and what is under it turns with it; the log has one `304` for the thought, and the semantic index did not read it.** All of it is `PATCH /api/thoughts/{brainId}/{thoughtId}` with `replace` on `/kind`. **What it takes.** 1, 2 and 4, each from either of the other two: a 200 with no body, and the same for the number sent as a string. 0, 3 (the spec's Event), 5 (System), 6, 99 and -1 are a 400, `"'kind' value is not valid."`; `null`, a fraction, a word and `true` are the catch-all 403 of L3; `remove` and `add` are a 400, `"Only 'replace' operation is allowed for 'kind' path."`. `POST /api/thoughts` with kind 3 or 5 is a 400 too, `"Invalid 'Kind' value: 3."`, so no request makes an Event or a System thought. The kind a thought already has is a 200 that logs nothing. Each of these 3 of 3. **The thought.** It keeps its name, its note and a label it was given (3 of 3). With no label of its own it reads with its name for a `label` while it is a type and with `null` before and after, and no `202` is logged either way: 5 of 5 for each change, from a thought born as each of the three kinds. Turned into a tag it loses its type: the type's link is deleted (`102`) and a `203` is logged against the thought, the type's name → `null`. Turned into a type it keeps it, and the link's meaning goes from 2 to 3 (`404`, `InstanceOf` → `TypeOf`). A tag it carries stays in `graph.tags` throughout, and while the thought is a tag itself that link has meaning 7 (`404`, `HasTag` ↔ `SubTagOf`, L23). Its parents and jumps stay ordinary links (one sample of each change). **What is under it.** Every link with the thought above changes meaning with it, and each logs a `404` with both ends and the meanings by name, `Normal`, `HasTag` or `InstanceOf`: the children of an ordinary thought are the thoughts a tag is on and the instances of a type, and one becomes the other. A child that becomes an instance has a `203` straight after its link's `404`, `null` → the type's name; one that had a type of its own loses that first (`102` for its link, `203`), and its second `203` has the old type's name for the old value. Instances that stop being ones have their `203`, the name → `null`, ahead of every `404`. A child of a thought turned into a tag keeps its own type. Children are logged in no fixed order. **The log.** The last entry of the change is `{modType: 304, sourceType: 2, sourceId: <thought>}`, both `extra` types -1, with the kinds by name in `oldValue` and `newValue`: `"Normal"`, `"Type"`, `"Tag"`. For a thought with nothing under it and no type it is the only entry. Every entry of one change is stamped apart. The `304` is in the log when the patch is answered (240 of 240); `GET` of the thought and its `graph` show the kind 13–234 ms after that, and a `graph` that had been read before still showed the old kind at the first read after the answer, every time (L27). All of this 12 of 12 for each of the six changes, on a thought with nothing on it and on one with a parent, a child, a jump, a tag and, where its kind lets it have one, a type; 4 of 4 with three children. **Through the tools as they were**, `brain_index` and `brain_search` over an index of the live brain, what made each thought older than the sync's overlap, three runs: a sync left the row of a thought with nothing under it as it was after every one of the six changes. A rebuild corrected it only where the document had changed as well: to or from a type for a thought with no label of its own, and into a tag for one that had a type to lose. Between an ordinary thought and a tag otherwise, and for a thought with a label, the row kept its kind through both: the new tag was returned by a default search with no `Kind`, and the thought that had been a tag was left out of it. A thought with something under it was read by a sync as an end of its links' `404`s, and skipped by hash all the same. Measured on 15.0.640 through the API; a kind changed in TheBrain's own window could not be measured | `304` is one of the entries after which sync reads a thought again (`REEMBED_MOD_TYPES`), for the row's kind and for the label a type reads with. The kind is compared apart from the document's hash where sync and rebuild both index (`#indexThoughts`): a row that differs in kind alone is given the new kind by `VectorStore.setKinds()` and keeps its vector, with nothing encoded. `brain_index` counts it apart, "kind updated, nothing to encode", only when there is one. After one sync, and after a rebuild alone, all twenty cases measured read right: the row's kind, a default search, the `Kind` column (3 of 3 each). What is under the thought needed nothing new: both ends of a `404` and the thought of a `203` were read again already (L18). `DOCUMENT_FORMAT` did not move, so an existing index is kept; a row whose thought changed kind before this keeps the old kind until a rebuild, because its `304` is behind the watermark. The API cannot make kind 5, so what the index does with a thought turned into a System one is not measured: its row stays as it is |

### Aliases — what could not be measured

L16 is measured on 15.0.640 and each claim in it has a contract test. Two things
about aliases are not, and are taken on trust:

- **The version requirement.** The spec says: "Saving the first alias in a brain
  makes the brain require TheBrain 15.0.621 or later on every device." Checking
  it would take a second device on an older build. The tools repeat it on every
  argument that can write an alias.
- **Builds before 15.0.621.** They have no aliases, so a thought arrives without
  the field, and reads treat that as an empty list. What such a build does with
  `aliases` in a create request is unknown; a field ignored in silence would be
  reported as written. So before sending aliases the client reads the brain's
  home thought, and refuses when the field is absent.

### Tags — the undocumented mechanism

`LinkDto`'s **`meaning`** field discriminates the kind of link. The spec says only
`integer` and describes no values. Found empirically:

| `meaning` | What the link is |
|---|---|
| 1 | ordinary (child / parent / jump) |
| 2 | a type binding (created by `PATCH /typeId`) |
| 5 | a tag binding |
| 7 | a tag bound to another tag (L23) |

The field is **read-only**: `PATCH /meaning` returns 200 and silently ignores the
value, `PATCH /kind` returns 400 `"Invalid 'kind' specified."`. The server sets
it, inferring from the `kind` of the target thought.

```
Attach a tag:  POST /api/links/{brainId}
               { "thoughtIdA": <thought>, "thoughtIdB": <tag, kind=4>, "relation": 2 }
               -> the server creates relation=1, meaning=5

Detach:        DELETE /api/links/{brainId}/{linkId}
Read:          graph.tags   (the tag does not appear in parents)
```

`relation: 2` against a thought with `kind=1` produces an ordinary parent — it is
the target's `kind=4` that flips the behaviour, not the `relation` value.

**Visibility delay of 0.1–0.5 s.** Immediately after the `POST`, the graph returns
a stale tag list; three tags attached in a row all appeared only after ~1 s.
Detachment shows up after ~0.5 s. This is not the 15-second search-index delay —
it is a different mechanism.

`statistics.links` does not count links with `meaning=5`.

### An identifier nobody has, and a brain that is not there

The requests behind L3, measured on 15.0.640 against a throwaway brain. `{id}`
is a random UUID, new for every request, that nothing in the brain has; `{b}`
is the brain. Every answer was the same each time it was asked for, so the
last column is how many times.

| Request | Answer | Times |
|---|---|---|
| `GET /api/thoughts/{b}/{id}` | 404, ProblemDetails `"Not Found"` | 20 |
| `GET /api/thoughts/{b}/{id}/graph`, with siblings and without | 403, plain text: `To use the TheBrain API, make requests to /api (e.g. /api/brains). An API key is required via the Authorization header.` | 40 |
| `GET /api/thoughts/{b}/{id}/attachments`, `…/modifications` | 200, `[]` | 20 each |
| `PATCH /api/thoughts/{b}/{id}`: a name, a label removed, aliases | 404 `"Not Found"` | 30 |
| `PATCH` of a thought that exists, with `{id}` for its `typeId` | 403, the same text | 10 |
| `DELETE /api/thoughts/{b}/{id}` | **200**, no body, and the brain's counts are as they were | 10 |
| `POST /api/thoughts/{b}` with `{id}` for `sourceThoughtId`, relation 1, 2 or 3 | 404 `"Source Thought {id} could not be located"` | 30 |
| `POST /api/thoughts/{b}` with `{id}` for `typeId`, under a thought that exists or under none | 400 `"Could not create thought."` | 20 |
| `POST` and `DELETE /api/thoughts/{b}/{id}/pin` | 404 ``"Thought `{id}` not found."`` | 10 each |
| `GET /api/links/{b}/{id}`, and a `PATCH` of it | 404 `"Not Found"` | 20, 10 |
| `GET /api/links/{b}/{id}/attachments` | 200, `[]` | 20 |
| `GET /api/links/{b}/{a}/{b2}` with either end nobody's, or both | 404 `"Not Found"`, as for two thoughts with no link | 60 |
| `POST /api/links/{b}` with `{id}` for `thoughtIdB`, relation 1, 2 or 3 | 400 `"Could not get target thought {id}"` | 30 |
| the same with `{id}` for `thoughtIdA`, or with both ends nobody's | 400 `"Could not get source thought {id}"` | 60 |
| `DELETE /api/links/{b}/{id}` | 400, ProblemDetails `"Bad Request"` | 10 |
| `GET /api/notes/{b}/{id}` | 200, the "no note" sentinel: `markdown: ""`, `modificationDateTime: "0001-01-01T00:00:00"` | 20 |
| `POST /api/notes/{b}/{id}/update`, `…/append` | **200, and the note is written** | 5 each |
| `POST /api/attachments/{b}/{id}/url` | 404 ``"Thought `{id}` not found."`` | 10 |
| `GET /api/attachments/{b}/{id}/metadata`, `…/file-content` | 404 `"Not Found"` | 20 each |
| `DELETE /api/attachments/{b}/{id}` | 400 `"Could not delete attachment {attachmentId}"`, the placeholder as it is sent | 10 |

**The note written to nobody.** It reads back from `GET /api/notes/{b}/{id}`
a moment later, 0.1–0.2 s after an append.
`GET /api/thoughts/{b}/{id}/attachments` lists it,
`{isNotes: true, sourceId: {id}, sourceType: 2}`, and `statistics.notes` counts
it; the log, read once, had its `801` with `{id}` in `extraAId` (L13). No
thought comes of it: the read of `{id}` stays a 404 and its graph a 403. A
`DELETE` of the thought answers 200 and leaves the note. What removes it is
`DELETE /api/attachments/{b}/{attachment}`.

**Other identifiers that name no thought of the brain** get the read's 404
and the graph's 403 like a random one, 5 of 5 each: the all-zero GUID, one of
all `f`, the identifier of a link, the brain's own, a thought deleted half a
second before, and the home thought of another brain. A thought is found only
through its own brain. An identifier in capitals, the brain's too, reads the
thought as usual.

**A `brainId` that is no brain.** Every request above was sent again with a
random UUID for `{b}`, and with it `GET /api/brains/{b}`, its `statistics`
and `modifications`, `/types`, `/tags`, `/pins`, `?nameExact=`,
`GET /api/search/{b}`, a create with no source, and the reads and writes of a
thought and a link that exist in another brain. Each of the 56 was a 401 with
the bare JSON string `"Access to brain {b} is unauthorized."`: 20 times each
read and 10 each write, 810 requests. So `/types` is not the 400 of an empty
list there (L1), and nothing about the other identifiers is learnt. The
all-zero GUID for a brain is the same 401. A key that is wrong is
`401 Invalid API Key`, in plain text, whether the brain is there or not (5 of
5 each): the key is asked about first. Not measured: a brain that is another
account's, and the `/api/app/brain/{b}/…` paths, which act on the user's
window.

**A thought deleted a moment ago** is half there until a refresh that comes
within 0.2 s. 96 thoughts that had lived half a second were deleted, and 0 to
300 ms after the `DELETE` returned each was sent a read, its graph and a
create under it. The graph was a 403 every time, the first included. The read
was still a 200 for 34 of them, the last at 150 ms, and a 404 for the other
62, all 24 sent at 200 ms or later among them. While the thought read, the
create under it was the 400 `"Could not create thought."` of L26, 27 times,
or already the 404, 7 times; once the read was a 404 the create was the 404,
62 of 62. Of the 12 creates sent within a few milliseconds of the deletion 2
were the 404 already, so the 400 cannot be pinned to "straight after": the
contract test pins the graph's 403, and that a create is not the 400 once
the read is a 404. While it reads, the deleted thought takes writes too (8
deletions): a `PATCH` of its name was a 200 each time, a link to it a 200
with an `id` of zeros each time, the answer for a link that is not made
(L23), and a URL attached to it a 200 that stored the attachment 7 times, the
eighth being the 404 above.

**A note whose attachment was deleted a moment ago** reads as the 403, on a
thought that is there. 12 thoughts were each given a note, and half a second
later the note's attachment was deleted; the note, the thought and its graph
were then read together about every 20 ms for 0.7 s. The first read of the
note was the 403 every time, the last 403 came 0 to 162 ms after the
deletion, and every read after it was the "no note" sentinel. The thought and
its graph were a 200 in all 356 reads. So this 403 is no answer about the
thought or its identifier, and `describeError()` says that of a note's read
where it used to say that an identifier names nothing in the brain. Called
straight after such a deletion, 3 times of 3 each, `brain_get_thought`
printed the thought with no Note section and no error, `brain_set_note` wrote
the note and answered "note created", `brain_delete_thought` put its question
with no line for a note, and `brain_append_note` answered that an identifier
named nothing. Each takes it for a read that failed now (ARCHITECTURE.md §4,
*A read that fails inside a tool*). The contract test accepts the sentinel
for the first read as well, since the moment can be over by then, and pins
that the thought and its graph read.

**Through the tools as they were**, 3 of 3 each. With a `brainId` that is no
brain, every tool that makes a request answered "TheBrain rejected the key.
Check THEBRAIN_API_KEY…", the checks of a `typeId`, a tag and a parent
included; `brain_search` with no index answered an empty result and a note
that the index is not built. With a thought identifier nobody has:
`brain_get_thought`, `brain_traverse` and `brain_delete_thought` answered
"Access denied. On the local API this usually means no object with that
identifier exists in this brain."; `brain_update_thought`,
`brain_create_thought` given it for `parentId` and `brain_attach_url`
answered "Resource not found. It may have been deleted, or the identifier
belongs to a different brain.", the last two dropping the API's sentence with
the identifier in it; `brain_link` and `brain_tag` passed on the API's 400
with the end named, and `brain_ingest` the API's text under "Failed".
`brain_set_note` answered "note created" and `brain_append_note` "text
appended to the note", each leaving a note on no thought, and `brain_tag`
asked to remove a tag answered that it "was not on the thought". The two
notes are as they were (L3, "Not guarded"); `brain_tag` reads the thought
before it gives that answer, and answers with the read's 404.

### Enumerating all thoughts through the log — not enough on its own

There is no "list all thoughts" endpoint and no traversal beyond one hop. But
`/api/brains/{id}/modifications` with no date range returns the history up to
`maxLogs` entries (when there are more, it keeps the newest and returns them
newest first; the rest is reached by paging back on `endTime`, L14), and
replaying `modType 101` (created) minus `modType 102` (deleted) over the whole
log reconstructs the current population.

Cross-checked against an independent source — an exact match:

| | log | `statistics` |
|---|---|---|
| `kind=1` (ordinary) | 38 | `thoughts` = 38 |
| `kind=2` (types) | 5 | `thoughtTypes` = 5 |

Note that `statistics.thoughts` counts **only** `kind=1`; types and tags are
separate fields. A discrepancy with the log by exactly that amount is expected,
not an error.

> **Correction.** The exact match above was on a brain whose thoughts were all
> created in it. Imported and old brains log far fewer `created` events than
> they hold thoughts: on a live TheBrain 15, 0 of 56, 1 of 44 and 125 of 187. A
> rebuild therefore takes the union of the log and a breadth-first walk over
> `graph`; see ARCHITECTURE.md §7. The walk relies on two graph facts, both
> contract-tested: a tag's graph lists the thoughts it marks as `children`, and
> a type's graph lists its instances there too.

The same log supplies the signals for incremental sync: `101` add, `102` remove,
`103` re-embed the name, `211` the aliases, `202` the label, `203` the type,
`801`/`802`/`803` the note. Mind L13 for the last group: those entries are keyed
by the note's attachment, and the thought is in `extraAId`. And L20: changes to a note with
nothing else logged between them, in any brain, are one `803`, which carries
the time of the last of them, so reading from a watermark still finds it. A tag has no thought
event at all (L18): it comes and goes as a link, so both ends of a link's
`101`/`102`/`402`/`404` are read again. And a `103` against a tag or a type also
marks the thoughts its graph lists as children, because the log does not. A
`304` marks the thought whose kind changed (L31): the index keeps the kind
beside the document, and a type reads with a label the log says nothing of.

### Error formats — there are five of them

```
400  "Could not retrieve list of Types for brain ..."   ← a bare JSON string
400  (no body)                                           ← a write with a malformed identifier in its path
401  Invalid API Key                                     ← plain text
401  API Key was not provided. (Using the 'Authorization' header)
401  "Access to brain <id> is unauthorized."             ← a bare JSON string: the brain, not the key
403  To use the TheBrain API, make requests to /api ...  ← plain text with no content type: the catch-all
404  {"type":"https://tools.ietf.org/html/rfc9110#...","title":"Not Found","status":404,"traceId":"..."}
404  "Source Thought <id> could not be located"          ← a bare JSON string
200  <!DOCTYPE html> ...                                 ← a routing miss
```

There is no single error envelope. Normalising in the HTTP layer is mandatory.
One status is not one meaning either: a 401 is the key or the brain, a 404
names what it did not find or does not, and the 403 names nothing (L3).

### What works as expected

- `POST /api/thoughts/{brainId}` with `{name, sourceThoughtId, relation:1, kind, acType}` → `{"id": "..."}`
- `PATCH` accepts a plain JSON Patch array: `[{"op":"replace","path":"/name","value":"..."}]`
  with `Content-Type: application/json-patch+json`. Works for `/foregroundColor` too
- `notes/update` replaces the whole note; `notes/append` concatenates **without a
  separator** (`"AAA"` + `"BBB"` → `"AAABBB"`) — add the newline yourself
- `GET /api/notes/{...}` on a thought with no note → 200 with `markdown: ""` and
  `modificationDateTime: "0001-01-01T00:00:00"` (the "no note" sentinel)
- `graph` on an isolated thought returns empty arrays and `type: null`, no error
- `app/state.tabs[]` lists every open brain with its active thought, not just the
  current one
- No races reproduced on rapid sequential writes (update followed immediately by
  append behaved correctly)
