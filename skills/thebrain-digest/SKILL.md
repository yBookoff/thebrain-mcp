---
name: thebrain-digest
description: >
  Report what happened in the brain over a period, and what deserves going back
  to. Use when asked "what did I add this week", "show me a digest", "what have
  I been working on", "what is new in the brain", and at the start of a session
  when the context of previous work needs recalling. Covers: how to read the
  modification log and how to turn it into a narrative rather than a list of
  events.
---

# A digest of the brain

The modification log is unreadable on its own: a hundred lines of "note changed".
The job is to turn it into an account of what the person was doing.

## How to gather it

```
brain_recent_changes { since: "2026-08-04T00:00:00Z", limit: 200 }
```

Without `since` it takes a week. The tool already decodes the numeric codes into
readable phrasings and resolves thought names.

**Limit:** names are resolved for at most sixty thoughts. Over a long period some
lines will have no names — that is not lost data, it is saved requests. If you
need a full breakdown, take a shorter period.

## How to narrate it

Do not retell the log line by line. Group by theme and say what was going on.

**Bad:**

```
11 August 13:24 created — API layer
11 August 13:24 note created
11 August 13:24 created — Semantic layer
11 August 13:24 note created
```

**Good:**

```
The week was mostly the "Implementation" branch: four layers appeared
(API, semantics, operations, server), each with a note carrying measurements.

Separately, the tools area was extended: entries about brain_ingest and the
race condition found in it.

Old entries were revised: "Search indexing takes up to 15 seconds" was renamed
to "Writes are not immediately visible" — the earlier phrasing turned out to be
wrong.
```

To narrate like that, look at which thoughts changed:

```
brain_get_thought { thoughtId: "<from the log>" }
```

A few key ones are enough, not every single one.

## What to pay attention to

- **Edits to old entries.** The person rethought something — more interesting than
  what is new.
- **Bursts around one area.** That is where real work was happening.
- **Things created with no notes and no links** — probably abandoned halfway.
  Worth mentioning.
- **Deletions.** If a noticeable amount was deleted, say what is gone.

## What to propose at the end

One or two concrete suggestions, not a general "keep it up":

- something unfinished worth returning to;
- an area with a lot of new material that could use tidying (`thebrain-organize`);
- a question that the accumulated material begs.

## A caveat about dates

The API returns dates in mixed formats: some with an offset, some with no zone.
Do not build exact arithmetic like "in the last 47 hours" — say "this week",
"yesterday", "early this month".
