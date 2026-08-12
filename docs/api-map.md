# TheBrain Local API — endpoint map

Source: `http://localhost:8001/api/v1/docs.json` (OpenAPI 3.0.1, `TheBrain Local API v1.0`).
A copy of the spec: [`thebrain-local-api.openapi.json`](./thebrain-local-api.openapi.json).

- Base: `http://localhost:8001`
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
| GET | `/api/brains/{brainId}/modifications` | The brain's modification log; `maxLogs` (**required**), `startTime`/`endTime` (RFC 3339) |

## 3. Thoughts (13) — the core

| Method | Path | What it does |
|---|---|---|
| GET | `/api/thoughts/{brainId}/{thoughtId}` | Thought details (`ThoughtDto`) |
| PATCH | `/api/thoughts/{brainId}/{thoughtId}` | Update via **JSON Patch** (`name`, `label`, `typeId`, colours, `acType`, `kind`) |
| DELETE | `/api/thoughts/{brainId}/{thoughtId}` | Delete a thought |
| POST | `/api/thoughts/{brainId}` | Create a thought (`ThoughtCreateModel`) → `{id}` |
| GET | `/api/thoughts/{brainId}?nameExact=` | The first thought whose name matches exactly |
| GET | `/api/thoughts/{brainId}/{thoughtId}/graph` | **Thought + parents/children/jumps/siblings/tags/type/links/attachments**; `includeSiblings` |
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
| POST | `/api/links/{brainId}` | Create a link (`LinkCreateModel`: `thoughtIdA`, `thoughtIdB`, `relation`, `name`) → `{id}` |
| GET | `/api/links/{brainId}/{linkId}` | Link details |
| PATCH | `/api/links/{brainId}/{linkId}` | Update via JSON Patch |
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
| GET | `/api/attachments/{brainId}/by-location` | **Lookup by location** — URL or path. For URLs (type 3): case-insensitive, ignores the http/https scheme and a trailing `/`. Meant for web-clipper deduplication |

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

**ThoughtDto** — `id`, `brainId`, `name`, `cleanedUpName`, `label`, `typeId`, `kind`, `acType`,
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
| `relation` | 1 Child, 2 Parent, 3 Jump, 4 Sibling |
| `AttachmentType` | 2 ExternalFile, 3 ExternalUrl, 8 ExternalDirectory (the rest of `[0..15, 100]` are undocumented) |
| `EntityType` | -1 Unknown, 1 Brain, 2 Thought, 3 Link, 4 Attachment, 5 BrainSetting, 6 BrainAccessEntry, 7 CalendarEvent, 8 FieldInstance, 9 FieldDefinition |
| `ModificationType` | 101–105 generic (Created/Deleted/ChangedName/CreatedByPaste/ModifiedByPaste); 201–210 thought+link (colour, label, type, icons, fields); 301–304 thought (Forgot/Remembered/AccessType/Kind); 401–405 link (thickness/moved/direction/meaning/relation); 501–503 attachment; 601–602 brain; 701 access; 801–812 notes and assets; 900–903 calendar; 1001–1003 field definitions |
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

## Live observations (verified against localhost:8001, TheBrain 15)

Verified on the `brain-mcp` brain; test entities were deleted and the brain
returned to its original state.

### Divergences from the spec, and bugs

| # | Observation | Consequence for MCP |
|---|---|---|
| L1 | **`/types` and `/tags` return `HTTP 400` when the list is empty.** Verified: 0 types → 400 `"Could not retrieve list of Types for brain ..."`; after creating a thought with `kind=2` the same request returned 200 and a list | The client must treat that 400 as an empty list, or the tool "crashes" on a clean brain |
| L2 | **A malformed UUID in the path → HTTP 200 plus the Blazor app's HTML page.** The route does not match and the request falls through to the SPA fallback | A naive client takes 200 for success and chokes on HTML. Validate UUIDs before the request and check the response `Content-Type` |
| L3 | **A nonexistent (but valid) thought → HTTP 403** with the text "To use the TheBrain API, make requests to /api…", not 404 | 403 cannot be read as "no permission" alone |
| L4 | **`notes/append` on a thought with no note is a silent no-op**: HTTP 200, the note stays empty | An append tool must read the note first and fall back to `update` when there is none |
| L5 | **A Markdown round-trip loses the closing ` ``` ` of a code fence.** Sent a code block, got it back without the closing fence, with the rest of the document swallowed into the block | Notes containing code get corrupted. Either escape, or warn, or write through HTML |
| L6 | In `SearchResultDto` the `brainId` field comes back as zeros (`00000000-…`); the real id is in `sourceThought.brainId` | Take brainId from `sourceThought`, not from the result root |
| L7 | Dates arrive in inconsistent timezone formats: `app/state` with an offset (`+02:00`), `thoughts` naive (`2026-08-11T09:01:27.71436`), `search` with `Z` | Normalise in the client |
| L8 | **Tags are attached through `relation: 2`** — the mechanism is undocumented, see the section below | The discriminator is a link's `meaning` field |
| L9 | **Search is prefix-based.** `OT` → finds `OTGP`; `OTPG` (a typo) → 0; `project` (a synonym) → 0 | Semantic proximity is unreachable through the API — a local vector layer is required |
| L10 | A thought's type arrives **both** in the `type` field **and** in the `parents` list | Filter it during traversal, or types end up in the tree as ordinary parents |
| L11 | 9–20 ms latency per request; 20 concurrent requests in 0.06 s | Indexing will not be bottlenecked by the API; parallelise freely |
| L13 | **A note is an attachment, and its log events are keyed by it.** `graph.attachments` carries `{isNotes: true, type: 1}` for a thought with a note and is empty without one. The log entry reads `{modType: 801/802/803, sourceType: 4, sourceId: <attachment>, extraAId: <thought>, extraAType: 2}` | Anything deciding "does this thought have a note" from `sourceId` silently sees nothing. Read `isNotes` from the graph; map log events through `extraAId` |
| L12 | **Writes become visible at different speeds.** `create`→`get(id)` instant; `rename`→`get` ~0.1 s; `set note`→`get note` ~0.2 s; `attachTag`→`graph.tags` ~0.1–0.5 s; **`create`→`findByName` ~5.6 s** | After a write, address thoughts **by identifier, never by name**. `nameExact` is not a workaround for "create it and immediately find it" |

### Tags — the undocumented mechanism

`LinkDto`'s **`meaning`** field discriminates the kind of link. The spec says only
`integer` and describes no values. Found empirically:

| `meaning` | What the link is |
|---|---|
| 1 | ordinary (child / parent / jump / sibling) |
| 2 | a type binding (created by `PATCH /typeId`) |
| 5 | a tag binding |

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

### Enumerating all thoughts through the log — it works

There is no "list all thoughts" endpoint and no traversal beyond one hop. But
`/api/brains/{id}/modifications` with no date range returns **the entire
history**, and replaying `modType 101` (created) minus `modType 102` (deleted)
reconstructs the current population.

Cross-checked against an independent source — an exact match:

| | log | `statistics` |
|---|---|---|
| `kind=1` (ordinary) | 38 | `thoughts` = 38 |
| `kind=2` (types) | 5 | `thoughtTypes` = 5 |

Note that `statistics.thoughts` counts **only** `kind=1`; types and tags are
separate fields. A discrepancy with the log by exactly that amount is expected,
not an error.

The same log supplies the signals for incremental sync: `101` add, `102` remove,
`103` re-embed the name, `801`/`802`/`803` re-embed the note. Mind L13 for the
last group: those entries are keyed by the note's attachment, and the thought is
in `extraAId`.

Caveat: log completeness has not been verified for imported or synced brains.

### Error formats — there are five of them

```
400  "Could not retrieve list of Types for brain ..."   ← a bare JSON string
401  Invalid API Key                                     ← plain text
401  API Key was not provided. (Using the 'Authorization' header)
403  To use the TheBrain API, make requests to /api ...  ← plain text
404  {"type":"https://tools.ietf.org/html/rfc9110#...","title":"Not Found","status":404,"traceId":"..."}
200  <!DOCTYPE html> ...                                 ← a routing miss
```

There is no single error envelope. Normalising in the HTTP layer is mandatory.

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
