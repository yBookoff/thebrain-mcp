---
name: thebrain-ingest
description: >
  Lay material into TheBrain as a connected graph rather than a pile of notes.
  Use when asked to "put this article in my brain", "save this", "add it to the
  knowledge base", "break this down and record it" — about an article, a
  document, a discussion, a research result or the user's own thinking. Covers:
  how finely to split into thoughts, when to attach to something existing
  instead of creating new, where to graft onto the current structure, what
  belongs in a note, how to label links.
---

# Breaking material down into TheBrain

The job is not "store the text" but **graft meaning into the existing graph** so
that six months from now it can be found, and is already connected to whatever
arrives later.

Fifteen thoughts dangling under a single article is a bad outcome, even if every
one of them is accurate.

## Order of work

### 1. Find out where you are landing

```
brain_list                      → which brain, is the index ready
brain_list_types_and_tags       → the conventions this brain already uses
```

If the index is not ready, `brain_search` will say so. Tell the person — without
an index, finding existing material works worse and the risk of duplicates goes up.

### 2. Extract the concepts, then search for each one

Read the material and write out the concepts — what it is actually about. Then
search for **each** of them:

```
brain_search { query: "<concept>", variants: ["synonym", "translation", "broader term"] }
```

Variants are mandatory. Without an index, search runs on them alone; with an
index, they still raise recall.

If something close turns up, **do not create a new thought**. Extend the existing
one and link to it. This is the whole difference between a second brain and a
folder of files.

### 3. Look at the neighbourhood of your attachment points

```
brain_traverse { thoughtId: "<what you found>", depth: 2 }
```

This shows which area has already taken shape and what naming conventions hold
there. Graft into the existing structure, not alongside it.

### 4. Assemble a plan and write it in one call

```
brain_ingest { thoughts: [...], links: [...] }
```

Do not create thoughts one at a time. Fifteen thoughts means fifteen calls plus
links plus notes — minutes of work, and a failure halfway through.

Give the top thought of the plan a `parent`. Sent a second time, a plan finds
each thought next to its parent and creates nothing twice; a thought with no
parent it cannot find, and creates again with everything under it.

**If the call comes back as an error**, read which kind before doing anything.

An error that says nothing was written means the plan had a mistake that
showed before the first write. Fix it and send the plan again.

An error with a "Failed" section means the batch was written in part. When a
thought could not be created, everything that hangs on it was left out and is
listed under "Skipped": the thoughts under it, the links to them. The rest of
the plan is in the brain, with its identifiers in the table.

- Do not send the same plan again while the table lists any thought. A thought
  the plan created with no parent would be created a second time.
- Fix the cause, then send a new plan holding only the failed and skipped
  items. Where one of them refers to a thought from the table, put that
  thought's identifier in place of its tempId.
- With no table, no thought was written: fix the cause and send the plan as
  it was.
- A note or a tag that failed on a thought from the table: write it with
  `brain_set_note` or `brain_tag`. Its line gives the thought's identifier.
- A line under "Skipped" saying a thought is the same thought as another: the
  plan named one thought twice, and it was sent once. What stopped it is on
  the other item's line under "Failed".
- A line saying that no answer came: the thought may exist all the same. Look
  at its parent with `brain_get_thought` before creating it again.
- A line saying that the parent already has a thought of this name under
  another relation, with its identifier: the tool did not decide whether that
  is your thought. Read it with `brain_get_thought`. If it is the same concept,
  use its identifier in place of the tempId. If it is another concept, send
  your thought and what hangs on it in a plan with `deduplicate: false`, or
  give it a name that tells the two apart.
- Nothing is rolled back, and tidying up by deletion is not yours to decide.
  Tell the person what is in the brain and what is not.

**The tools that write one thought answer the same way.** An error from
`brain_create_thought`, `brain_update_thought` or `brain_tag` that has a
"Failed" section stopped part way: what is under "Done" is written, the call
stopped at the line under "Failed", and what is under "Skipped" was not tried.
Do not send the call again as it was. A thought listed under "Done" exists,
and created again it is a duplicate. Write only the rest, to the identifier
the result gives, with the tool its last section names. An error with no
"Failed" section wrote nothing unless it says otherwise. One that says no
answer came may have made the thought: look for it where the result says
before creating it again. A note is the same: when `brain_append_note` says
no answer came, read the thought before sending it again, or the text may
land in the note twice.

### 5. Show the result

```
brain_activate { thoughtId: "<root thought>" }
brain_index { action: "sync" }
```

The person sees the structure in the app. Syncing the index makes the new
material immediately findable.

## How finely to split

**A thought is something you will want to link to from another context.**

The test: imagine material on an adjacent topic arriving six months from now. If
it would naturally attach to this thought, the thought is the right size. If the
thought only makes sense inside this one article, it is a line in a note, not a
thought.

| Bad | Good | Why |
|---|---|---|
| "Chapter 3: methodology" | "Two-stage reranking" | A chapter is the source's structure, not a meaning |
| "What the author thinks about RAG" | "Retrieval-augmented generation" | Next year another author will use the same concept |
| "Interesting point about embeddings" | "Asymmetric prefixes in e5" | The name has to say what is inside |
| One thought, "The whole article" | 5–12 thoughts, one per concept | Nothing to link to |
| 40 thoughts for one article | 5–12 | Splitting for its own sake |

**Name a thought after the concept itself, not after its relation to the source.**
"RAG", not "The approach to RAG from Ivanov's paper" — then the next piece of
material attaches to the same place.

## Aliases

A thought has one name and can carry alternate ones. TheBrain's own search
matches them, and the semantic index includes them.

Use an alias when the same concept goes by another name that someone will type:
an abbreviation and its expansion ("RAG" and "Retrieval-augmented generation"),
the term in the person's second language, a former name. The title stays short,
and the next piece of material still lands on the same thought.

Not an alias: a broader or narrower concept, a related one, a description. Those
are thoughts of their own, joined by links.

**Ask before the first one.** Saving the first alias in a brain makes that brain
require TheBrain 15.0.621 or later on every device that opens it. If
`brain_get_thought` has shown you no alias anywhere in this brain, tell the
person and wait for a yes. A brain that already has aliases has paid that price.

`brain_ingest` and `brain_create_thought` take `aliases`. On a thought that
already existed, `brain_ingest` adds them to the ones it has. Afterwards, change
them with `brain_update_thought`: `addAliases` and `removeAliases`.

## Where to attach

The temptation is to hang every concept as a child of the article thought. That
is easier, but ten articles later the brain is a list of sources with one concept
scattered across ten branches.

**Instead:**

- **A source thought** (article, talk, discussion) — yes, create it. Its note holds
  a summary, the link to the original, the date, and why it is useful.
- **Concepts attach to topical parents** that already exist in the brain. Found
  "Vector databases"? Hang the new "Hybrid search" concept there.
- **The source connects to the concepts through jumps** (`relation: "jump"`),
  labelled with something like "analyses" or "worked example".

If no topical parent exists, create one. A single shared node beats concepts
dangling under an article.

## Notes

A note carries what would not fit in the name: the substance in two or three
paragraphs, the specifics, the numbers, the caveats. Not a retelling of the
whole material.

- Write so that six months later it makes sense **without the original**.
- Numbers and measurements are mandatory — they are the most valuable part.
- In your own words, not copy-paste. Copy-paste is not understood while reading.
- **Do not use triple-backtick code fences** — TheBrain loses the closing fence
  and swallows the rest of the note into the block. Indent code by four spaces
  instead.

## Links

Links are the whole point of the exercise. Be generous with them and **label them**.

Good labels state a relation: "motivates", "contradicts", "special case of",
"solved by", "precedes", "refutes". Bad ones: "related", "see also".

Hierarchy (`child`) is for "part of something". A jump (`jump`) is for meaning
that runs across the tree. Jumps are what make a graph a graph.

**Caveat:** you cannot create a jump between a thought and its own parent — a link
between them already exists, and the call merely renames it. The tool reports this
under "Links that already existed".

## Types and tags

Take them from `brain_list_types_and_tags`. Do not invent new ones when a suitable
one exists — five nearly identical types are worse than one general one.

In a traversal and among a thought's neighbours, a type or a tag is marked
`[type]` or `[tag]` after its identifier, and a search asked to include them
says which in a `Kind` column. A thought with no mark is an ordinary one.
`brain_ingest` marks a thought it found in place the same way: a plan thought
that "existed" as a `[type]` or a `[tag]` landed on one of that name under its
parent, and nothing can be put under it.
`brain_get_thought` shows a thought's own type with its identifier, ready to
reuse.

Through the API a tag can only be attached by the identifier of an existing tag.
If you need a new one, first create it as a thought of kind tag, then use it.

## What not to do

- Do not create a thought without searching first. Duplicates are the disease of
  a brain like this.
- Do not hang everything under one article. See "Where to attach".
- Do not retell the whole material in the root thought's note.
- Do not create thoughts one by one instead of using `brain_ingest`.
- Do not delete or rewrite someone else's notes unasked. Extend them with
  `brain_append_note`.

## What to tell the person at the end

Briefly: how many thoughts were created, how many existing ones were reused, what
they were attached to, which links were laid. If something did not work, say so
plainly.

If something was missing for a decision (no obvious parent turned up, unclear
whether to split a concept) — say so rather than choosing silently.
