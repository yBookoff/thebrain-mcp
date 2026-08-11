---
name: thebrain-organize
description: >
  Tidy up TheBrain: find duplicates, thoughts with no links, empty stubs,
  scattered branches about the same thing. Use when asked to "clean up my
  brain", "find duplicates", "what is dangling with no links", "sort this out",
  "the structure has drifted". Covers: how to hunt for disorder, what you may
  fix yourself, and what you may only propose.
---

# Tidying up a brain

A brain accumulates disorder quietly: duplicates born of different phrasings,
orphan thoughts, stubs with no notes, two branches about the same thing under
different names.

The governing rule: **propose, do not act silently.** The structure is authored,
and what looks like a duplicate may be a deliberate distinction.

## What to look for

### Duplicates

Search for one concept through several phrasings and see whether different
thoughts about the same thing come back:

```
brain_search { query: "<concept>", variants: ["synonym", "translation", "acronym"], limit: 20 }
```

A duplicate candidate is a pair of semantically close thoughts with different
identifiers and overlapping notes. Before proposing a merge, read both in full:
the difference may be substantive.

### Orphans

Thoughts with no links get lost: traversal cannot reach them, only search can.

```
brain_recent_changes { limit: 200 }
```

Take the thoughts it mentions and check their neighbourhood:

```
brain_get_thought { thoughtId: "<id>" }
```

Empty in every link section means an orphan. Propose where to attach it, based on
a search for something similar.

### Stubs

The thought exists, the note does not, and there are one or two links. Either a
forgotten placeholder or a deliberate rubric node. Tell them apart by context: a
rubric usually has children.

### Drifted branches

Two areas about the same thing under different names. Visible through traversal:

```
brain_traverse { thoughtId: "<root of the area>", depth: 3 }
```

## What you may do yourself

Safe and reversible, after showing the person the list:

- **Link** things that are clearly about the same subject (`brain_link` with a
  meaningful label).
- **Extend** a note with missing context (`brain_append_note`).
- **Attach an orphan** to a suitable parent (`brain_link` with `relation: "child"`).

## What you may only propose

- **Merging duplicates.** Requires deciding which thought is primary and what
  happens to both notes. Describe the option, wait for agreement.
- **Renaming.** The name is an authorial choice.
- **Deleting.** Even with deletion permitted, ask separately for each thought,
  never as a list — "shall I delete all of these?".
- **Restructuring the hierarchy.** Mass-moving branches is almost always a bad
  idea without an explicit request.

## How to report

As a list, most important first, with identifiers so the person can open and look:

```
Duplicates (2 pairs)
  "Vector databases" — abc123  and  "Vector DB" — def456
     both about embedding stores, notes do not overlap
     proposal: keep "Vector databases", append the other's content

Orphans (3)
  "Hybrid search" — ghi789
     proposal: attach to "Vector databases"
```

Do not dump a hundred items. A dozen of the most important ones is more useful
than a complete list nobody will read.

## After changes

```
brain_index { action: "sync" }
```

Otherwise the edits will not reach search.
