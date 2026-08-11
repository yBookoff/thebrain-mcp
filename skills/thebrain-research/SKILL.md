---
name: thebrain-research
description: >
  Use TheBrain as a knowledge base when answering a question: look at what is
  already known first, and only then reason. Use when asked "what do I know
  about X", "what do I have on this topic", "have we discussed this already",
  "remind me what we concluded", and before any substantive answer on a topic
  that might be in the user's brain. Covers: how to search so that you actually
  find things, how to separate their knowledge from general knowledge, what to
  do with contradictions you uncover.
---

# The brain as a source of knowledge

A brain holds what its owner has already worked out. Answering from general
principles while their own conclusion sits right there throws away the main value.

## When to look

Always, if the question touches a topic where the person may have accumulated
something: their projects, decisions, research, observations. A redundant search
is cheaper than a generic answer laid over a ready-made specific one.

Not needed for common-knowledge questions unrelated to their work.

## How to search so that you find things

A single query is almost never enough. The ceiling for semantic search here is
around 75–80% top-1 hits, and the misses are substantive ones.

**Break the question into concepts and search for each**, with variants:

```
brain_search { query: "<concept>", variants: ["synonym", "translation", "broader", "narrower"] }
```

Found a foothold? Look around it — the answer is often in the neighbours:

```
brain_get_thought { thoughtId: "<what you found>" }   → note plus one hop of links
brain_traverse { thoughtId: "<what you found>", depth: 2 }  → the whole area
```

If a search returns little, try other phrasings before concluding the brain has
nothing. Absence of results is weak evidence.

## How to answer

**Separate what came from the brain from what is yours.** The person needs to know
which part is their own conclusion and which is general knowledge:

> Your brain records that q8 quantization does not hurt ranking — with
> measurements over 48 thoughts. My own addition: on larger models the picture is
> usually the same.

Refer to thoughts by name so the person can find them.

## Contradictions

If what you find in the brain disagrees with what you know, **do not paper over it
and do not silently substitute your version**. Say it plainly: the brain records
this, but there are grounds to think otherwise, and here is why.

The brain can also contradict itself — an old entry against a new one. Show both
and say which is more recent (`brain_recent_changes`, or dates in the notes).

## Gaps

If you notice that part of a topic is covered and the area next to it is empty,
say so. "You have A and B worked out, but there is nothing on C" is more useful
than silently answering about A and B only.

## Do not write without being asked

This skill is about reading. If something worth saving comes up along the way,
offer it — do not do it yourself. Writing is what `thebrain-ingest` is for.
