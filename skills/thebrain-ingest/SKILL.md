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
