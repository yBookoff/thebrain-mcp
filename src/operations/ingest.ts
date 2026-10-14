/**
 * Batch graph write in a single call.
 *
 * Without it, decomposing an article into 15 thoughts, 25 links and 15 notes
 * means 55 API round trips, minutes of work and a near-certain break halfway.
 *
 * Two rules follow from TheBrain's behaviour:
 *
 *  1. Thoughts inside a batch are linked **only by returned UUIDs**. Resolving
 *     by name would miss: measurement showed 5.6 seconds between creating a
 *     thought and its appearance in exact-name lookup.
 *  2. There is no rollback — the API offers no transactions. On a mid-batch
 *     failure a manifest of what was created is returned, so the agent can
 *     continue rather than start over.
 *  3. A thought that fails takes with it whatever hangs on it, and nothing
 *     else. The thoughts under it are not created and the links to them are
 *     not tried: with no parent to go under they used to be created as roots
 *     and listed as created, and each further run made them again. The
 *     branches beside it are written to the end, since a second call would
 *     only write them then.
 *  4. A thought is looked for where its relation puts it. A graph lists a
 *     thought made as a child under `children`, one made as a parent under
 *     `parents` and a jump under `jumps`. Looked for among `children` alone,
 *     the last two were made again by every run of the plan.
 *  5. A graph that has been read is answered from a copy, which is behind a
 *     create, by 0.2 s as a rule. So the batch returns once the graphs list
 *     what it made: a second run sent straight after it used to make the
 *     children again too.
 *  6. Two plan items for one thought are one create. When it fails the other
 *     item is not sent on its own, and is listed as skipped, not as failed:
 *     it would be the same request again, under another label.
 *  7. A brain that is not there fails the plan once, ahead of its writes. A
 *     plan that names nothing in the brain used to read nothing first, and
 *     each of its creates was refused in turn.
 *  8. A thought that was there keeps its note. The plan's note is written to
 *     a thought with none, and never over one: the note of every thought a
 *     plan found in place used to be replaced by the plan's, on a first run
 *     as on a second, and what a person had written there was gone.
 *  9. Two thoughts of one name in one list are not one thought to land on.
 *     The last the graph listed used to be taken, without a word of the other.
 * 10. A parent nobody has fails the plan, ahead of its writes. It used to
 *     fail its own thought in the middle of the batch, with the branches
 *     beside it written and what hung on it skipped, though the read that
 *     checks a parent's kind had the answer before the first write.
 * 11. What is there already is not written again. A second run of a plan
 *     used to attach every tag once more, which logs a `402` against the
 *     attachment each time, and to send every label, which changes nothing.
 * 12. One write to a pair of thoughts at a time. Two posts sent at once for a
 *     pair with no link made two links, 51 times in 60, where two thoughts
 *     share one: so two links of a plan between the same two thoughts are not
 *     both sent, and the first in the plan is the link.
 * 13. A label that takes another's place is reported with the one it took.
 * 14. A thought is looked for under its name as TheBrain stores it: a tab and
 *     a line feed a space each, the white space at the ends dropped. Looked
 *     for under the name as the plan had it, such a thought was made again
 *     by every run.
 * 15. A graph is not taken at its word while it lacks what this process
 *     wrote. The wait by the clock ahead of the first look is 0.3 s, and a
 *     copy can be further behind: the thought another call had made a moment
 *     before is then made again. What the process's own writes put next to
 *     a thought is known (`RecentWrites`), so the graph is read until it
 *     shows that, and a thought fails when it never does.
 */

import {
  ALIASES_UNSUPPORTED,
  TheBrainError,
  ZERO_UUID,
  isStructuralLink,
  isTagLink,
  isTypeLink,
  linkNameAsStored,
  lowerUuid,
  mayHaveLanded,
  nameRefusal,
  normalizeAliases,
  noteAsStored,
  shownName,
  thoughtNameAsStored,
  type CleanGraph,
  type TheBrainApi,
  type WrittenFact,
} from "../api/index.js";
import { Relation, ThoughtKind, type LinkDto } from "../api/types.js";
import { mapWithConcurrency } from "../semantic/indexer.js";

export type RelationName = "child" | "parent" | "jump";

export const RELATION_BY_NAME: Readonly<Record<RelationName, number>> = {
  child: Relation.Child,
  parent: Relation.Parent,
  jump: Relation.Jump,
};

/** The list of a thought's graph that holds what was made with each relation to it. */
const LIST_OF = {
  child: "children",
  parent: "parents",
  jump: "jumps",
} as const satisfies Record<RelationName, keyof CleanGraph>;
const RELATION_NAMES = Object.keys(LIST_OF) as RelationName[];

/**
 * What a thought has next to it: for each relation, the thoughts of each
 * name as it is stored, each with its kind as the graph gave it. A plan makes
 * ordinary thoughts, and the one it finds there may be a type or a tag. One
 * list can hold two thoughts of a name, and a map of names to one thought
 * each used to keep the last of them alone.
 */
type Neighbours = Record<RelationName, Map<string, Array<{ id: string; kind?: number }>>>;

/**
 * How long a batch waits for the graphs to list what it made, and how long a
 * look next to a thought waits for its graph to show what this process wrote
 * there. Measured on a quiet brain: about 80 ms at the median, 205 ms at the
 * most. A graph that answers and does not show it yet is asked again a step
 * later; one whose read failed after twice the pause before, up to
 * `maxStepMs`.
 */
const LISTED = { stepMs: 25, maxStepMs: 400, timeoutMs: 2000 };

/**
 * How long after this process's last write a graph is read to look for a
 * thought. It is for the writes that leave nothing to look for in a graph: a
 * create that got no answer, and whatever `RecentWrites` keeps no mark of.
 * The copy a graph is answered from was 205 ms behind a create at the most
 * when this was set, and a plan sent 200 ms after a write made nothing twice
 * (0 of 60). It is no bound: see `graphShowingWrites`.
 */
const COPY_LAG_MS = 300;

export interface IngestThought {
  /** Local label within the batch, for referencing before creation. */
  tempId: string;
  name: string;
  /**
   * Written to a thought the batch creates, and to one that was there with
   * no note. A thought that has a note keeps it: see `notesKept`.
   */
  note?: string | undefined;
  typeId?: string | undefined;
  /** UUIDs of tags the brain has: a plan makes none, and takes no `tempId` here. */
  tagIds?: readonly string[] | undefined;
  label?: string | undefined;
  /**
   * Alternate names. A new thought is created with them; one that already
   * existed keeps its own and gains these.
   */
  aliases?: readonly string[] | undefined;
  /** A `tempId` from this batch, or the real UUID of an existing thought. */
  parent?: string | undefined;
  relation?: RelationName | undefined;
}

export interface IngestLink {
  from: string;
  to: string;
  relation?: RelationName | undefined;
  name?: string | undefined;
}

export interface IngestPlan {
  thoughts: readonly IngestThought[];
  links?: readonly IngestLink[] | undefined;
  /**
   * Skip creating a thought when the thought it hangs on already has one of
   * that name under the same relation, reusing the existing one. Makes a
   * repeat run safe. One of that name under another relation is neither
   * reused nor made again: it fails, with the identifier. So do two of that
   * name under the same relation. A thought with no parent is not looked for.
   */
  deduplicate?: boolean | undefined;
}

export interface IngestOutcome {
  created: Array<{ tempId: string; thoughtId: string; name: string }>;
  /**
   * `kind` is what the thought that was there is, as its neighbour's graph
   * gave it: it can be a type or a tag that the parent holds as an ordinary
   * child. Absent for one this batch made a moment before.
   */
  reused: Array<{ tempId: string; thoughtId: string; name: string; kind?: number }>;
  linksCreated: number;
  /**
   * Links of the plan between two thoughts that a link joined already.
   * Nothing is posted for one: two thoughts share one link, and the API would
   * turn the one that is there into the one asked for, a parent's into a
   * jump. The note says what was found when it is not what the plan asked
   * for: see `linkFound`.
   */
  linksReused: Array<{ from: string; to: string; note: string }>;
  /**
   * Links of the plan between two thoughts joined by what is no link between
   * thoughts: a tag on one of them, or its type. Nothing is posted here
   * either, since it would take the tag or the type away, and no label is
   * written. The note says which of the two it is.
   *
   * And each link of the plan between two thoughts that a link earlier in
   * the plan joins: two thoughts share one link, so only the first is sent.
   * The note names that first one, and the label that went unwritten.
   */
  linksNotAdded: Array<{ from: string; to: string; note: string }>;
  notesWritten: number;
  /** The `tempId` of each plan thought whose note was written: what `notesWritten` counts. */
  notesWrittenFor: string[];
  /**
   * The plan's notes that were not written, because the thought has a note:
   * the one it had before the batch, or, for the second of two plan items
   * that are one thought, the first item's. `same` says that the note it
   * has is the plan's text, as a second run of a plan finds it. A note that
   * could not be read is not here but among `failures`, and not written
   * either.
   */
  notesKept: Array<{ tempId: string; thoughtId: string; same: boolean }>;
  tagsAttached: number;
  /**
   * Tags of the plan that were on their thought already, as a second run of
   * a plan finds them. Nothing is sent for one.
   */
  tagsAlreadyThere: number;
  /** Thoughts whose alias list was written, at creation or by adding to it. */
  aliasesWritten: number;
  /**
   * What was tried and failed. `of` is what the write was to make. `reason`
   * is the failure in the API's words or this module's, and `error` what was
   * thrown, for a caller that explains failures in its own. `unanswered`
   * marks a write that may have been carried out (`mayHaveLanded()`): it got
   * no answer, one that broke off, or the catch-all 403, and a thought may be
   * there with no identifier to report.
   */
  failures: Array<{
    of: "thought" | "note" | "tag" | "aliases" | "link";
    what: string;
    reason: string;
    error: unknown;
    unanswered?: true;
  }>;
  /**
   * What was not tried, because a thought it needs was not created: the
   * thoughts under one that failed, with their notes, tags and aliases, and
   * the links to any of them. And a plan item that stands for the same
   * thought as one that failed. The reason names the thought that failed.
   */
  skipped: Array<{ what: string; reason: string }>;
  /**
   * Thoughts created here that the graph of the thought they hang on did not
   * list by the time the batch gave up waiting. A run sent now would not find
   * them, and would make them again.
   */
  unlisted: number;
  /**
   * Thoughts that were there before the batch whose graph could not be read
   * when the wait ran out, each with how many thoughts the batch made next to
   * it. Whether TheBrain lists those yet is not known, so they are not among
   * `unlisted`: a read that failed used to be counted there, as a graph that
   * had answered and listed nothing.
   */
  listingUnread: Array<{ thoughtId: string; made: number; error: unknown }>;
}

export class IngestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

/**
 * A plan that names, for a thought to hang something on, an identifier no
 * thought of the brain has. A plan error like the others, thrown before the
 * first write, and a class of its own for a caller that says where
 * identifiers are taken from. `ids` are the ones nobody has.
 */
export class IngestMissingError extends IngestValidationError {
  readonly ids: readonly string[];

  constructor(message: string, ids: readonly string[]) {
    super(message);
    this.name = "IngestMissingError";
    this.ids = ids;
  }
}

/**
 * A write that was not sent because a read ahead of it failed. `context` is
 * the sentence without the cause, for a caller that explains the cause in its
 * own words; the message has both.
 */
export class IngestReadError extends Error {
  readonly context: string;

  constructor(context: string, cause: unknown) {
    super(`${context}: ${describe(cause)}`, { cause });
    this.name = "IngestReadError";
    this.context = context;
  }
}

/**
 * A thought that was not looked for, and so not created, because the graph
 * it would be looked for in was still behind a write of this process when
 * the wait for it ran out. `behind` is what the graph did not show.
 *
 * The message is whole as it is: what was read, for how long, what was
 * missing from it, and what to do.
 */
export class IngestBehindError extends Error {
  readonly thoughtId: string;
  readonly behind: readonly WrittenFact[];

  constructor(thoughtId: string, behind: readonly WrittenFact[], waitedMs: number) {
    const lacking = behind.map((f) =>
      f.of === "listed"
        ? `${f.thoughtId} among its ${f.list}`
        : `${f.thoughtId} under the name ${JSON.stringify(f.name)}`,
    );
    super(
      `${thoughtId} was read for ${waitedMs} ms to look for a thought of this name next to ` +
        `it, and its graph still does not show what this server wrote a moment ago: ` +
        `${lacking.join(", ")}. TheBrain answers a graph from a copy, and this one is ` +
        "behind, so a thought of this name may be there unseen: nothing was created. Send " +
        "this thought again in a few seconds",
    );
    this.name = "IngestBehindError";
    this.thoughtId = thoughtId;
    this.behind = behind;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The plan with each reference to an existing thought in lower case
 * (`lowerUuid()`): a `parent`, `from` or `to` that is no `tempId`. A tool
 * lowers the identifiers it takes, but these are a `tempId` or a UUID, and
 * which is known only from the whole plan. One in capitals was another
 * thought to what keys by it: a thought under it and one under its lower
 * case, of one name, were each made. A `tempId` stays as sent, whatever it
 * looks like.
 */
function referencesLowered(plan: IngestPlan): IngestPlan {
  const tempIds = new Set(plan.thoughts.map((t) => t.tempId));
  const lowered = (ref: string): string => (tempIds.has(ref) ? ref : lowerUuid(ref));
  return {
    ...plan,
    thoughts: plan.thoughts.map((t) =>
      t.parent === undefined ? t : { ...t, parent: lowered(t.parent) },
    ),
    ...(plan.links !== undefined
      ? { links: plan.links.map((l) => ({ ...l, from: lowered(l.from), to: lowered(l.to) })) }
      : {}),
  };
}

/**
 * Validates the plan and lays thoughts out in dependency levels.
 *
 * Plan errors surface before the first write: a half-created graph caused by a
 * typo in a `tempId` is the worst possible outcome.
 */
export function planLevels(plan: IngestPlan): IngestThought[][] {
  const { thoughts } = plan;
  if (thoughts.length === 0) {
    throw new IngestValidationError("the list of thoughts is empty");
  }

  const byTempId = new Map<string, IngestThought>();
  for (const t of thoughts) {
    if (t.tempId.trim() === "") {
      throw new IngestValidationError("a thought has an empty tempId");
    }
    if (byTempId.has(t.tempId)) {
      throw new IngestValidationError(`tempId "${t.tempId}" appears twice`);
    }
    // By the API's rule, not by `trim()`: a next line (U+0085) is white
    // space to it, and a name of that alone went on to be refused in the
    // middle of the batch; a byte order mark is none, and was refused here.
    // A name too long to keep is cut with a 200, and was made again by
    // every run, the plan's name never being the one stored.
    const noName = nameRefusal(t.name, `the name of thought "${t.tempId}"`);
    if (noName !== null) throw new IngestValidationError(noName);
    requireRelation(t.relation, `thought "${t.tempId}"`);
    // It used to be dropped without a word, and the thought created with no
    // link and listed as created.
    if (t.relation !== undefined && t.parent === undefined) {
      throw new IngestValidationError(
        `thought "${t.tempId}" has the relation "${t.relation}" and no parent: a relation ` +
          "says how a thought is linked to its parent, so name the parent or leave the " +
          "relation out",
      );
    }
    byTempId.set(t.tempId, t);
  }

  for (const t of thoughts) {
    if (t.parent === undefined) continue;
    if (!byTempId.has(t.parent) && !UUID_RE.test(t.parent)) {
      throw new IngestValidationError(
        `thought "${t.tempId}" references parent "${t.parent}", ` +
          "which is not in the batch and does not look like an existing thought's UUID",
      );
    }
    // No request is needed to know that nobody has this one, and the API
    // does not say so: a create under it answers 200 and makes the thought
    // with no parent. `assertUuid` refuses it at the read below; here it is
    // named with the plan item, as a reference to no `tempId` is.
    if (!byTempId.has(t.parent) && t.parent === ZERO_UUID) {
      throw new IngestMissingError(
        `thought "${t.tempId}" references parent ${ZERO_UUID}, the all-zero UUID, ` +
          "which names no thought",
        [ZERO_UUID],
      );
    }
  }

  for (const link of plan.links ?? []) {
    requireRelation(link.relation, `the link ${link.from} -> ${link.to}`);
    for (const [side, ref] of [
      ["from", link.from],
      ["to", link.to],
    ] as const) {
      if (!byTempId.has(ref) && !UUID_RE.test(ref)) {
        throw new IngestValidationError(
          `a link references "${ref}" in its ${side} field, ` +
            "but no such tempId is in the batch and it does not look like a UUID",
        );
      }
      // The same for a link: it would be refused at its own turn, after
      // everything else of the plan is written.
      if (!byTempId.has(ref) && ref === ZERO_UUID) {
        throw new IngestMissingError(
          `the link ${link.from} -> ${link.to} references ${ZERO_UUID}, the all-zero UUID, ` +
            `in its ${side} field, and it names no thought`,
          [ZERO_UUID],
        );
      }
    }
    // The API answers such a link with a 200 and an identifier of zeros, and
    // makes none. It used to be counted under links created.
    if (link.from === link.to) {
      throw new IngestValidationError(
        `the link ${link.from} -> ${link.to} joins a thought to itself, ` +
          "and no such link can be made",
      );
    }
  }

  // Topological layout: a parent must be created before its child.
  const levels: IngestThought[][] = [];
  const placed = new Set<string>();
  let remaining = [...thoughts];

  while (remaining.length > 0) {
    const ready = remaining.filter(
      (t) =>
        t.parent === undefined || !byTempId.has(t.parent) || placed.has(t.parent),
    );
    if (ready.length === 0) {
      const stuck = remaining.map((t) => t.tempId).join(", ");
      throw new IngestValidationError(
        `the parent references contain a cycle and cannot be ordered: ${stuck}`,
      );
    }
    for (const t of ready) placed.add(t.tempId);
    levels.push(ready);
    remaining = remaining.filter((t) => !placed.has(t.tempId));
  }

  return levels;
}

export async function ingest(
  api: TheBrainApi,
  brainId: string,
  sent: IngestPlan,
): Promise<IngestOutcome> {
  const plan = referencesLowered(sent);
  const levels = planLevels(plan);
  const dedupe = plan.deduplicate !== false;

  // Asked before the first write, like the rest of validation: a build without
  // aliases would otherwise take the thoughts and lose their aliases.
  if (
    plan.thoughts.some((t) => planAliases(t).length > 0) &&
    !(await api.thoughts.supportsAliases(brainId))
  ) {
    throw new IngestValidationError(ALIASES_UNSUPPORTED);
  }

  // Types too are read before the first write, once each. The API takes a
  // typeId that is no type and makes a parent or a tag of it, and a thought
  // refused in the middle of a batch leaves the plan written in part, with
  // nothing under it. `create` reads its type again: 200 such reads took 37 ms.
  const typeIds = new Set(plan.thoughts.flatMap((t) => (t.typeId === undefined ? [] : [t.typeId])));
  await mapWithConcurrency([...typeIds], 6, (typeId) => api.thoughts.requireType(brainId, typeId));

  // And tags: the request that attaches one makes a type or a parent of
  // anything else, and it goes out after the thoughts are written. A plan
  // cannot make a tag, so each one it names is there to be read now.
  // `attachTag` reads its tag again, as `create` does its type.
  const tagIds = new Set(plan.thoughts.flatMap((t) => t.tagIds ?? []));
  await mapWithConcurrency([...tagIds], 6, (tagId) => api.links.requireTag(brainId, tagId));

  // And whatever a thought or a link of the plan names as a parent: under a
  // type a thought is given that type, with a 200, and loses the one it had,
  // and under a tag it is tagged and has no parent. Only a UUID can name a
  // type or a tag, since a plan makes ordinary thoughts. A `tempId` is
  // checked at its own turn, by `create` and `links.create`: it can land on
  // one its parent holds as an ordinary child.
  const ends = parentEnds(plan);
  /** Named by the plan, and read as no thought's. */
  const missing = new Set<string>();
  await mapWithConcurrency([...ends], 6, async ([id, { field }]) => {
    if ((await api.links.requireParent(brainId, id, field)) === null) missing.add(id);
  });

  // That read also says whether anybody has the identifier. One nobody has
  // used to be let through for the create to refuse: in the middle of the
  // batch, with the branches beside it written and what hung on it skipped.
  // The plan is refused by it now, at no request more. The thought a plan
  // thought is made a parent or a jump of was not read, having no kind to be
  // refused by. Its branch is lost the same way, so it is read too, for
  // that alone. The lower end of a link and the ends of a jump still are
  // not: a link that fails takes nothing with it, and what is left to send
  // is that link, where a plan refused is the whole plan again.
  const beside = besideEnds(plan, ends);
  await mapWithConcurrency([...beside.keys()], 6, async (id) => {
    await api.thoughts.get(brainId, id).catch((error: unknown) => {
      if (!(error instanceof TheBrainError && error.kind === "not_found")) throw error;
      missing.add(id);
    });
  });
  if (missing.size > 0) {
    const named = [...ends, ...beside].filter(([id]) => missing.has(id));
    throw new IngestMissingError(nobodyHas(named), named.map(([id]) => id));
  }

  // Each of those reads is refused for a `brainId` that is no brain, and the
  // plan with it. A plan that names nothing in the brain has sent none of
  // them, and every one of its creates used to be refused in turn, each with
  // the 401 on a line of its own. So that plan reads the brain itself.
  if (typeIds.size + tagIds.size + ends.size + beside.size === 0) await api.brains.get(brainId);

  const outcome: IngestOutcome = {
    created: [],
    reused: [],
    linksCreated: 0,
    linksReused: [],
    linksNotAdded: [],
    notesWritten: 0,
    notesWrittenFor: [],
    notesKept: [],
    tagsAttached: 0,
    tagsAlreadyThere: 0,
    aliasesWritten: 0,
    failures: [],
    skipped: [],
    unlisted: 0,
    listingUnread: [],
  };
  // Any write that got no answer is marked, not a create alone: a note, a
  // tag, an alias and a link may have been carried out as well, and used to
  // stand among the failures as if they had been refused.
  const failed = (
    of: IngestOutcome["failures"][number]["of"],
    what: string,
    error: unknown,
  ): void => {
    outcome.failures.push({
      of,
      what,
      reason: describe(error),
      error,
      ...(mayHaveLanded(error) ? { unanswered: true as const } : {}),
    });
  };

  /** Thoughts given aliases. A set: one thought can be reached by two plan items. */
  const aliased = new Set<string>();
  /** What each thought created here was created with. */
  const bornWith = new Map<string, string[]>();

  /** tempId or real UUID -> real UUID. */
  const resolved = new Map<string, string>();
  // A tempId stands for its own thought alone. One that reads as a UUID used
  // to pass, unresolved, for the identifier it spells.
  const tempIds = new Set(plan.thoughts.map((t) => t.tempId));
  const resolve = (ref: string): string | null =>
    tempIds.has(ref) ? (resolved.get(ref) ?? null) : UUID_RE.test(ref) ? ref : null;

  /**
   * tempId of a thought that is not there -> tempId of the one whose failure
   * is why: itself when it was tried and failed, and for one skipped the
   * failure at the top of its chain.
   */
  const blocked = new Map<string, string>();
  const needs = (refs: readonly string[]): string => {
    const causes = [...new Set(refs.flatMap((ref) => blocked.get(ref) ?? []))];
    return (
      `depends on ${causes.map((c) => `"${c}"`).join(" and ")}, ` +
      `which ${causes.length === 1 ? "was" : "were"} not created`
    );
  };

  /** Thoughts this batch created: nothing was next to one before it. */
  const madeHere = new Set<string>();
  /**
   * What each thought a plan item hangs on has next to it, read once per
   * thought and kept up as the batch writes. One created here is not read:
   * it has nothing yet, and a read that can find nothing could only fail.
   */
  const neighbours = new Map<string, Promise<Neighbours>>();
  const neighboursOf = (anchorId: string): Promise<Neighbours> => {
    let known = neighbours.get(anchorId);
    if (known === undefined) {
      known = madeHere.has(anchorId)
        ? Promise.resolve({ child: new Map(), parent: new Map(), jump: new Map() })
        : readNeighbours(api, brainId, anchorId);
      neighbours.set(anchorId, known);
      // A read that failed is not kept: the next thought there asks again.
      const asked = known;
      asked.catch(() => {
        if (neighbours.get(anchorId) === asked) neighbours.delete(anchorId);
      });
    }
    return known;
  };
  /**
   * `neighboursOf` for a thought about to be created there, or null when
   * nobody has the identifier.
   *
   * A read that fails says nothing of what is there. It used to pass for
   * "nothing", and the thought was created, though it might exist. Now the
   * thought fails, with what hangs on it skipped. One answer is not a failed
   * read: the graph of an identifier nobody has is a 403, which this API
   * gives for much else, while the thought itself is a 404. Then there is
   * nothing to look under, and the create goes out to be refused in the
   * API's own words. The plan's checks found the thought there, or the plan
   * would not have come this far: it is one deleted since.
   */
  const lookAround = async (anchorId: string): Promise<Neighbours | null> => {
    try {
      return await neighboursOf(anchorId);
    } catch (error) {
      // The graph was read, and is behind: the thought is there, and the
      // error says all there is to say.
      if (error instanceof IngestBehindError) throw error;
      const nobodyHasIt = await api.thoughts.get(brainId, anchorId).then(
        () => false,
        (e: unknown) => e instanceof TheBrainError && e.kind === "not_found",
      );
      if (nobodyHasIt) return null;
      throw new IngestReadError(
        `${anchorId} could not be read to look for a thought of this name next to it, ` +
          "so nothing was created",
        error,
      );
    }
  };
  /** Why a thought of the same name under another relation stops this one. */
  const namesake = (
    t: IngestThought,
    anchorId: string,
    asked: RelationName,
    found: RelationName,
    thoughtIds: readonly string[],
  ): Error => {
    const [thoughtId, ...more] = thoughtIds as [string, ...string[]];
    if (more.length > 0) {
      return new Error(
        `${anchorId} already has ${thoughtIds.length} thoughts of this name as its ${found}, ` +
          `${thoughtIds.join(" and ")}, and the plan asks for a ${asked}. None was taken for ` +
          `the same thought, and no further one was made. To use one of them, name its ` +
          `identifier where the plan has "${t.tempId}"; to make another of that name, send ` +
          "this thought in a plan with deduplicate set to false",
      );
    }
    return new Error(
      `${anchorId} already has a thought of this name as its ${found}, ${thoughtId}, and the ` +
        `plan asks for a ${asked}. It was not taken for the same thought, and no second one ` +
        `was made. To use it, name ${thoughtId} where the plan has "${t.tempId}"; to make ` +
        "another of that name, send this thought in a plan with deduplicate set to false",
    );
  };
  /**
   * Why two thoughts of the plan's name under the plan's own relation stop
   * this one. Which of them the plan means is no more the server's to say
   * than whether a namesake under another relation is the plan's thought:
   * the plan's children, tags, aliases and links would go to one of two.
   * The last the graph listed used to be taken, and the result said nothing
   * of the other.
   */
  const twins = (
    t: IngestThought,
    anchorId: string,
    relation: RelationName,
    thoughtIds: readonly string[],
  ): Error =>
    new Error(
      `${anchorId} has ${thoughtIds.length} thoughts of this name as its ${relation}: ` +
        `${thoughtIds.join(" and ")}. Which of them the plan means was not decided: none was ` +
        `taken, and no further one was made. To use one of them, name its identifier where ` +
        `the plan has "${t.tempId}"; to make another of that name, send this thought in a ` +
        "plan with deduplicate set to false",
    );

  /**
   * Currently being created, keyed by "parent + name", each with the relation
   * it is created under.
   *
   * Thoughts at one level are written concurrently, so an existence check is
   * not enough: two identical names in a batch both read the cache before the
   * first one lands. The second awaits the first one's promise.
   */
  const inFlight = new Map<
    string,
    { tempId: string; relation: RelationName; creation: Promise<string> }
  >();
  const slot = (parentId: string | null, name: string): string =>
    `${parentId ?? ""}\0${thoughtNameAsStored(name)}`;
  /**
   * What the batch made next to a thought that was there before it, by that
   * thought: what its graph has to list before a second run can find it.
   */
  const toBeListed = new Map<string, Array<{ thoughtId: string; relation: RelationName }>>();

  // A thought is looked for in a graph, and that graph can be a copy from
  // before this process's last write. A batch waits for the graphs to list
  // what it made; the other tools return at once, and a create that got no
  // answer leaves nothing to wait for. A plan sent straight after
  // brain_create_thought, brain_link or a rename made the thought again 25
  // times in 300 when it followed within 150 ms, and never from 200 ms on.
  // So the first look waits until the copy has had its time. By the clock,
  // since nothing in a graph tells a copy that is behind, and only when a
  // write came back less than that long ago: any other call costs nothing.
  // The read of a note is behind a first write in the same way, once in ten
  // still at 150 ms and never from 200 on, and comes after this wait too.
  //
  // The clock is not all there is to go by, though, and it is not enough:
  // the copy can be past it. What this process's own writes put next to a
  // thought is known, and the look itself holds the graph to that
  // (`graphShowingWrites`). This wait is left for what leaves no such mark.
  if (dedupe && plan.thoughts.some((t) => t.parent !== undefined && !tempIds.has(t.parent))) {
    const wait = COPY_LAG_MS - api.client.sinceLastWrite();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  for (const level of levels) {
    await mapWithConcurrency(level, 6, async (t) => {
      // Its parent is of an earlier level, so what became of it is known.
      if (t.parent !== undefined && blocked.has(t.parent)) {
        blocked.set(t.tempId, blocked.get(t.parent)!);
        outcome.skipped.push({
          what: `thought "${shownName(t.name)}" (${t.tempId})`,
          reason: needs([t.parent]),
        });
        return;
      }
      try {
        const parentId = t.parent === undefined ? null : resolve(t.parent);
        const relation = t.relation ?? "child";
        const key = slot(parentId, t.name);
        let near: Neighbours | null = null;

        if (dedupe) {
          if (parentId !== null) {
            near = await lookAround(parentId);
            const there = near?.[relation].get(thoughtNameAsStored(t.name)) ?? [];
            if (there.length > 1) {
              throw twins(t, parentId, relation, there.map((n) => n.id));
            }
            const [existing] = there;
            if (existing !== undefined) {
              resolved.set(t.tempId, existing.id);
              outcome.reused.push({
                tempId: t.tempId,
                thoughtId: existing.id,
                name: t.name,
                ...(existing.kind !== undefined ? { kind: existing.kind } : {}),
              });
              return;
            }
            // The same name under another relation. Whether it is the plan's
            // thought is not for the server to say: reused, it would take the
            // plan's children, tags and links; made again, it would be a
            // duplicate.
            for (const other of RELATION_NAMES) {
              const namedSo = near?.[other].get(thoughtNameAsStored(t.name)) ?? [];
              if (namedSo.length > 0) {
                throw namesake(t, parentId, relation, other, namedSo.map((n) => n.id));
              }
            }
          }
          const pending = inFlight.get(key);
          if (pending !== undefined) {
            const thoughtId = await pending.creation.catch(() => null);
            if (thoughtId === null) {
              // Not tried on its own, and so not failed: it used to be listed
              // under the failures with the other's reason. The two are one
              // thought, and a create of its own would be the same request
              // again: refused again while the cause lasts, and a second
              // thought when the first got no answer and was made all the
              // same. Whether to try again is the caller's to say, with the
              // reason in front of it. A namesake under another relation
              // waits on the same create, to be told whether it is one.
              blocked.set(t.tempId, pending.tempId);
              outcome.skipped.push({
                what: `thought "${shownName(t.name)}" (${t.tempId})`,
                reason:
                  `${pending.relation === relation ? "is the same thought as" : "is a namesake of"} ` +
                  `"${pending.tempId}", which was not created`,
              });
              return;
            }
            if (pending.relation !== relation && parentId !== null) {
              throw namesake(t, parentId, relation, pending.relation, [thoughtId]);
            }
            resolved.set(t.tempId, thoughtId);
            outcome.reused.push({ tempId: t.tempId, thoughtId, name: t.name });
            return;
          }
        }

        const aliases = planAliases(t);
        const creation = api.thoughts.create(brainId, {
          name: t.name,
          ...(parentId !== null ? { sourceThoughtId: parentId } : {}),
          ...(t.relation !== undefined
            ? { relation: RELATION_BY_NAME[t.relation] as Relation }
            : {}),
          ...(t.typeId !== undefined ? { typeId: t.typeId } : {}),
          ...(t.label !== undefined ? { label: t.label } : {}),
          ...(aliases.length > 0 ? { aliases } : {}),
        });
        if (dedupe) inFlight.set(key, { tempId: t.tempId, relation, creation });

        const thoughtId = await creation;
        madeHere.add(thoughtId);
        resolved.set(t.tempId, thoughtId);
        outcome.created.push({ tempId: t.tempId, thoughtId, name: t.name });
        if (aliases.length > 0) {
          aliased.add(thoughtId);
          bornWith.set(thoughtId, aliases);
        }

        if (parentId !== null) {
          near?.[relation].set(thoughtNameAsStored(t.name), [
            { id: thoughtId, kind: ThoughtKind.Normal },
          ]);
          if (!madeHere.has(parentId)) {
            const made = toBeListed.get(parentId) ?? [];
            toBeListed.set(parentId, [...made, { thoughtId, relation }]);
          }
        }
      } catch (error) {
        blocked.set(t.tempId, t.tempId);
        failed("thought", `thought "${shownName(t.name)}" (${t.tempId})`, error);
      }
    });
  }

  // A note goes to a thought that has none, and never over one. It used to
  // be written to every thought of the plan, and a thought the plan found in
  // place lost the note it had: 6 times of 6 on a live TheBrain 15.0.640, on
  // a first run as on a second, a note a person had edited between two runs
  // included. So a thought that was there is read first, and keeps what it
  // has. One the batch made has no note, and is not read.
  //
  // By thought, one item after another: two plan items can be one thought.
  // The first item's note is the thought's then, and the second item finds
  // it there. Their notes used to be sent at once, and which of the two the
  // thought kept was not the plan's to say.
  const noted = new Map<string, IngestThought[]>();
  for (const t of plan.thoughts) {
    const id = resolved.get(t.tempId);
    if (id === undefined || t.note === undefined || t.note.trim() === "") continue;
    noted.set(id, [...(noted.get(id) ?? []), t]);
  }
  await mapWithConcurrency([...noted], 6, async ([id, items]) => {
    /** The note the thought has, null until it is read. */
    let held: string | null = madeHere.has(id) ? "" : null;
    for (const t of items) {
      try {
        // A read that fails is not the answer "no note", which is a 200: the
        // plan's note is not written over what could not be read.
        held ??= await api.notes.get(brainId, id).catch((error: unknown) => {
          throw new IngestReadError(
            "not written, because the note this thought has could not be read and a " +
              "note is not written over one that was not",
            error,
          );
        });
        if (held.trim() !== "") {
          outcome.notesKept.push({
            tempId: t.tempId,
            thoughtId: id,
            same: sameText(held, t.note!),
          });
          continue;
        }
        await api.notes.set(brainId, id, t.note!);
        // As it is stored, which is what the next item of this thought finds.
        held = noteAsStored(t.note!);
        outcome.notesWritten += 1;
        outcome.notesWrittenFor.push(t.tempId);
      } catch (error) {
        // By identifier: two plan thoughts can share a title, and the note
        // is written afterwards with a tool that takes the identifier.
        failed("note", `note for "${shownName(t.name)}" (${id})`, error);
      }
    }
  });

  // One job for a tag on a thought, the first plan item's: two items can be
  // one thought, and a list can name a tag twice. Two attaches of one tag
  // sent at once left two attachments 11 times in 20 on a live TheBrain
  // 15.0.640, and the lookup that finds a tag's link answers 404 from then on.
  const tagJobs = new Map<string, { t: IngestThought; id: string; tagId: string }>();
  for (const t of plan.thoughts) {
    const id = resolved.get(t.tempId);
    if (id === undefined) continue;
    for (const tagId of t.tagIds ?? []) {
      const job = `${id}\0${tagId.toLowerCase()}`;
      if (!tagJobs.has(job)) tagJobs.set(job, { t, id, tagId });
    }
  }
  await mapWithConcurrency([...tagJobs.values()], 6, async ({ t, id, tagId }) => {
    try {
      // A thought that was there may have the tag, as on a second run of the
      // plan. Attached again it is a 200 that changes nothing and logs a
      // `402` against the attachment, which a sync then reads both ends of.
      // So the pair is looked up first, as a link's is. A thought the batch
      // made has no tag, and is not asked.
      if (!madeHere.has(id)) {
        const there = await api.links.hasTag(brainId, id, tagId).catch((error: unknown) => {
          throw new IngestReadError(
            "not attached, because whether the thought has this tag already could not be read",
            error,
          );
        });
        if (there) {
          outcome.tagsAlreadyThere += 1;
          return;
        }
      }
      await api.links.attachTag(brainId, id, tagId);
      outcome.tagsAttached += 1;
    } catch (error) {
      failed("tag", `tag ${tagId} on "${shownName(t.name)}" (${id})`, error);
    }
  });

  // A created thought got its aliases with the create request. One that already
  // existed gains the plan's on top of its own. Grouped by thought: two plan
  // items can resolve to the same one, and the API only replaces whole lists.
  //
  // A thought created a moment ago can still read back without its aliases
  // (measured: 3 times in 60), and adding to that empty list would erase them.
  // So what it was born with goes into the list again rather than being trusted
  // to the read.
  const reusedTempIds = new Set(outcome.reused.map((r) => r.tempId));
  const aliasJobs = new Map<string, { name: string; add: string[] }>();
  for (const t of plan.thoughts) {
    const id = resolved.get(t.tempId);
    const aliases = planAliases(t);
    if (id === undefined || !reusedTempIds.has(t.tempId) || aliases.length === 0) continue;
    const job = aliasJobs.get(id) ?? { name: t.name, add: [...(bornWith.get(id) ?? [])] };
    job.add.push(...aliases);
    aliasJobs.set(id, job);
  }
  await mapWithConcurrency([...aliasJobs], 6, async ([id, job]) => {
    try {
      const { added } = await api.thoughts.changeAliases(brainId, id, { add: job.add });
      if (added.length > 0) aliased.add(id);
    } catch (error) {
      failed("aliases", `aliases for "${shownName(job.name)}" (${id})`, error);
    }
  });
  outcome.aliasesWritten = aliased.size;

  // By the two thoughts a link joins, whichever end is named first and by
  // whatever reference: a `tempId` can come to a thought the plan also names
  // by its identifier. Two links of a plan between one pair both looked,
  // both saw no link, and both posted. Sent at once like that, the two left
  // two links between the pair 14 times in 20 on a live TheBrain 15.0.640,
  // reported as "links created: 2", and where both go the same way the
  // lookup answers 404 from then on and a further post is a 400. So one
  // link a pair is sent, the first in the plan, and the others are listed
  // as not added, on every run. Which of the two the plan means the server
  // does not say otherwise either: the first of two namesakes is the one
  // made, and the first of two notes for one thought the one written.
  const pairs = new Map<string, Array<{ link: IngestLink; from: string; to: string }>>();
  for (const link of plan.links ?? []) {
    const from = resolve(link.from);
    const to = resolve(link.to);
    if (from === null || to === null) {
      outcome.skipped.push({
        what: `link ${link.from} -> ${link.to}`,
        reason: needs([link.from, link.to]),
      });
      continue;
    }
    const pair = [from.toLowerCase(), to.toLowerCase()].sort().join("\0");
    pairs.set(pair, [...(pairs.get(pair) ?? []), { link, from, to }]);
  }
  await mapWithConcurrency([...pairs.values()], 6, async ([first, ...others]) => {
    if (first === undefined) return;
    const { link, from, to } = first;
    try {
      // In the pair's turn, the look and the write together: a `brain_link`
      // call for the same two thoughts at the same moment waits, or is waited for.
      await api.links.inTurn(brainId, from, to, async () => {
        const existing = await api.links.between(brainId, from, to);
        if (existing !== null) {
          const found = linkFound(
            existing,
            {
              from,
              to,
              relation: link.relation ?? "jump",
              fromName: link.from,
              toName: link.to,
            },
            link.name,
          );
          // Not a label the link has already: that write is a 200 that changes
          // nothing, and every run of a plan sent it for every link.
          if (found.label?.write === true) {
            await api.links.update(brainId, existing.id, { name: link.name });
          }
          (found.ordinary ? outcome.linksReused : outcome.linksNotAdded).push({
            from: link.from,
            to: link.to,
            note: found.note,
          });
        } else {
          await api.links.create(brainId, {
            thoughtIdA: from,
            thoughtIdB: to,
            relation: RELATION_BY_NAME[link.relation ?? "jump"] as Relation,
            ...(link.name !== undefined ? { name: link.name } : {}),
          });
          outcome.linksCreated += 1;
        }
      });
    } catch (error) {
      failed("link", `link ${link.from} -> ${link.to}`, error);
    }
    // Whatever became of the first: sent after one that failed, a second
    // link is a second request for the same pair, and after one that got no
    // answer it can be the second link.
    for (const other of others) {
      outcome.linksNotAdded.push({
        from: other.link.from,
        to: other.link.to,
        note:
          `the plan has a link between the same two thoughts ahead of this one, ` +
          `${link.from} -> ${link.to}, and two thoughts share one link: this one was not sent` +
          (other.link.name !== undefined
            ? `, and its label ${JSON.stringify(other.link.name)} was not written`
            : ""),
      });
    }
  });

  // Last, so that the notes and links have taken most of the wait already.
  const listing = await unlistedAfterWaiting(api, brainId, toBeListed);
  outcome.unlisted = listing.unlisted;
  outcome.listingUnread = listing.listingUnread;

  return outcome;
}

/**
 * A thought's graph, read until it shows what this process wrote next to the
 * thought a moment ago.
 *
 * A graph is answered from a copy, and nothing in it says how far behind it
 * is. A wait by the clock ahead of the read was the whole of the guard: 0.3 s
 * from the last write, half as long again as the longest lag measured till
 * then. That was the margin of a good day: with the app slow to answer, a
 * reader first saw a new thought in the copy more than 0.3 s after the
 * create's answer 7 times in 1,800, 364 ms at the latest, and the test
 * behind the wait went red in one run of ten. A copy that far behind lacks
 * the thought `brain_create_thought` made a moment before, and a plan that
 * names it makes it a second time. What the app is busy with decides the
 * lag, so no time is long enough for certain.
 *
 * What a process wrote itself it knows, though: `RecentWrites` keeps the
 * thoughts its creates and links put next to this one, and the names its
 * renames gave. A graph that lacks one of those is behind, by that and not
 * by the clock, and is read again a step later until it is not. It costs no
 * request when the first read shows them all, which is every call that does
 * not follow a write of this process to this thought by seconds.
 *
 * When the wait runs out the graph is still not taken at its word: the
 * thought fails, with `IngestBehindError`, and what hangs on it is skipped.
 * Created then, it may be a second thought of its name, which only a person
 * can remove. The same is true when the graph is right and the record is
 * not, a thought this process linked here having been unlinked in the app
 * since: nothing in either says which, and the record is dropped within
 * `WRITTEN_KEPT_MS`.
 */
async function graphShowingWrites(
  api: TheBrainApi,
  brainId: string,
  thoughtId: string,
): Promise<CleanGraph> {
  const started = Date.now();
  const deadline = started + LISTED.timeoutMs;
  for (;;) {
    const graph = await api.thoughts.getGraph(brainId, thoughtId);
    const behind = api.client.written.notShownBy(brainId, thoughtId, graph);
    if (behind.length === 0) return graph;
    const left = deadline - Date.now();
    if (left <= 0) throw new IngestBehindError(thoughtId, behind, Date.now() - started);
    await new Promise((resolve) => setTimeout(resolve, Math.min(LISTED.stepMs, left)));
  }
}

/** A thought's graph as `Neighbours`. The type is not among the parents: `getGraph` drops it. */
async function readNeighbours(
  api: TheBrainApi,
  brainId: string,
  thoughtId: string,
): Promise<Neighbours> {
  const graph = await graphShowingWrites(api, brainId, thoughtId);
  const byName = (relation: RelationName): Neighbours[RelationName] => {
    const named: Neighbours[RelationName] = new Map();
    for (const t of graph[LIST_OF[relation]]) {
      const name = thoughtNameAsStored(t.name ?? "");
      named.set(name, [...(named.get(name) ?? []), { id: t.id, kind: t.kind }]);
    }
    return named;
  };
  return { child: byName("child"), parent: byName("parent"), jump: byName("jump") };
}

/**
 * Whether the note a thought has is the text a plan has for it. A note reads
 * back as it was written but for its line ends, which come back as `\n`, and
 * for a fence TheBrain deletes (`noteAsStored()`, contract test). So the
 * plan's text is taken as it would be stored, and the blanks around both
 * are set aside. A plan's note with a fence left open used to read as
 * another text than the note the plan itself had written.
 */
function sameText(held: string, planned: string): boolean {
  return held.replaceAll("\r\n", "\n").trim() === noteAsStored(planned).trim();
}

/**
 * Waits until each graph lists what the batch made next to its thought, and
 * returns how many thoughts are still missing when the wait runs out.
 *
 * A graph that has been read, by this batch or by anything before it, is
 * answered from a copy brought up to date about every 0.1 s. Read straight
 * after a create it lacked the new thought 112 times in 120, and a run of the
 * same plan sent then made that thought again. A thought the batch created
 * has no such copy, so only the thoughts that were there before are read.
 *
 * A read that fails has shown nothing, and the wait goes on: the next may be
 * answered. When the last one failed too, its thought is returned apart, as
 * one whose graph was not read. It used to be counted as a graph that listed
 * nothing, and the result said of TheBrain what no read had shown.
 *
 * A graph that fails is asked again after twice the pause each time, not a
 * step later: at a step it was read 74 to 78 times in the two seconds. And
 * the wait is over when its time is, for every graph at once. A read is
 * given up on then, answered or not: a batch whose writes are done used to
 * wait out the request's own timeout, which is 30 s, to say so.
 */
async function unlistedAfterWaiting(
  api: TheBrainApi,
  brainId: string,
  made: ReadonlyMap<string, ReadonlyArray<{ thoughtId: string; relation: RelationName }>>,
): Promise<Pick<IngestOutcome, "unlisted" | "listingUnread">> {
  const deadline = Date.now() + LISTED.timeoutMs;
  const waited = await mapWithConcurrency([...made], 6, async ([anchorId, expected]) => {
    let pause = LISTED.stepMs;
    for (;;) {
      const read = await answeredBy(deadline, api.thoughts.getGraph(brainId, anchorId)).then(
        (graph) => ({ graph, error: undefined }),
        (error: unknown) => ({ graph: null, error }),
      );
      const { graph } = read;
      const lacking = expected.filter(
        ({ thoughtId, relation }) =>
          graph === null || !graph[LIST_OF[relation]].some((t) => t.id === thoughtId),
      ).length;
      const left = deadline - Date.now();
      if (lacking === 0 || left <= 0) return { anchorId, lacking, read };
      pause = graph === null ? Math.min(pause * 2, LISTED.maxStepMs) : LISTED.stepMs;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pause, left)));
    }
  });
  const answered = waited.filter((w) => w.read.graph !== null);
  return {
    unlisted: answered.reduce((sum, w) => sum + w.lacking, 0),
    listingUnread: waited
      .filter((w) => w.read.graph === null)
      .map((w) => ({ thoughtId: w.anchorId, made: w.lacking, error: w.read.error })),
  };
}

/**
 * A graph read, or the failure that it had not been answered when the wait
 * for the graphs ran out. The request is left to end by itself: it is a read,
 * and whatever comes of it is dropped.
 */
function answeredBy<T>(deadline: number, read: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new TheBrainError(
            "network",
            `the graph had not answered when the ${LISTED.timeoutMs} ms a batch waits for ` +
              "the graphs to list what it made ran out",
          ),
        ),
      Math.max(deadline - Date.now(), 0),
    );
    const settle = <V>(pass: (value: V) => void) => (value: V): void => {
      clearTimeout(timer);
      pass(value);
    };
    read.then(settle(resolve), settle(reject));
  });
}

/** How a plan names an existing thought: the field, and the first plan item that has it there. */
interface NamedEnd {
  field: string;
  by: string;
}

/**
 * The existing thoughts a plan puts something under, each with the field that
 * names it: the `parent` of a thought made as its child, and the upper end of
 * a child or parent link. A jump has no upper end, and a `tempId` is not an
 * existing thought.
 */
function parentEnds(plan: IngestPlan): Map<string, NamedEnd> {
  const tempIds = new Set(plan.thoughts.map((t) => t.tempId));
  const ends = new Map<string, NamedEnd>();
  const add = (ref: string, field: string, by: string): void => {
    if (!tempIds.has(ref) && !ends.has(ref)) ends.set(ref, { field, by });
  };
  for (const t of plan.thoughts) {
    if (t.parent !== undefined && (t.relation ?? "child") === "child") {
      add(t.parent, "parent", `thought "${t.tempId}"`);
    }
  }
  for (const link of plan.links ?? []) {
    const by = `the link ${link.from} -> ${link.to}`;
    if (link.relation === "child") add(link.from, "from", by);
    if (link.relation === "parent") add(link.to, "to", by);
  }
  return ends;
}

/**
 * The existing thoughts a plan makes a thought next to and puts nothing
 * under: the `parent` of a thought made as its parent or as its jump. The
 * ones among `ends` are left out, having been read as parents.
 */
function besideEnds(plan: IngestPlan, ends: ReadonlyMap<string, NamedEnd>): Map<string, NamedEnd> {
  const tempIds = new Set(plan.thoughts.map((t) => t.tempId));
  const beside = new Map<string, NamedEnd>();
  for (const t of plan.thoughts) {
    if (t.parent === undefined || tempIds.has(t.parent)) continue;
    if (ends.has(t.parent) || beside.has(t.parent)) continue;
    beside.set(t.parent, { field: "parent", by: `thought "${t.tempId}"` });
  }
  return beside;
}

/**
 * Why a plan is refused for the existing thoughts it names that nobody has:
 * each identifier with the plan item that names it, as a plan error names a
 * reference that is in no batch.
 */
function nobodyHas(named: ReadonlyArray<readonly [string, NamedEnd]>): string {
  const references = named.map(([id, { field, by }]) =>
    field === "parent"
      ? `${by} references parent ${id}`
      : `${by} references ${id} in its ${field} field`,
  );
  const one = named.length === 1;
  return (
    `${references.join(", ")}, and no thought in this brain has ` +
    `${one ? "that identifier. It" : "those identifiers. Each"} may have been deleted, ` +
    "or be another brain's"
  );
}

/**
 * Refuses a relation by a name that is none of the three. Looked up, such a
 * name gives no number, and `create` takes that for a child. `sibling` was one
 * of the names once: the API makes no link of it, and creates the thought
 * asked for with none.
 */
function requireRelation(relation: string | undefined, where: string): void {
  if (relation === undefined || Object.hasOwn(RELATION_BY_NAME, relation)) return;
  throw new IngestValidationError(
    `${where} has the relation "${relation}", and a relation is child, parent or jump`,
  );
}

/** The aliases a plan item asks for, blanks and repeats dropped. */
function planAliases(t: IngestThought): string[] {
  return normalizeAliases(t.aliases ?? []);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A link asked for between two thoughts that exist, by a tool or by a plan. */
export interface AskedLink {
  from: string;
  to: string;
  /** What `to` is to be to `from`. */
  relation: RelationName;
  /** What the caller calls each end: an argument's name, or a plan's reference. */
  fromName: string;
  toName: string;
}

export interface FoundLink {
  /** It is the link asked for: the same kind, the same way up. */
  asAsked: boolean;
  /**
   * An ordinary link, which takes a label whichever of the three it is. A
   * tag's attachment and a type's link are not, and are given none.
   */
  ordinary: boolean;
  /** What to tell the caller, of the link and of the label asked for it. */
  note: string;
  /**
   * What the label asked for comes to on the link that is there. Null when
   * no label came with the request, and for a link that takes none.
   */
  label: FoundLabel | null;
}

export interface FoundLabel {
  /** False when the link has that label already: there is nothing to send. */
  write: boolean;
  /**
   * The same in words: `label updated` for a link that had none, `label
   * already "…"`, or `label updated: it was "…" and is now "…"`.
   */
  said: string;
}

/**
 * What already joins two thoughts, set against the link asked for.
 *
 * Two thoughts share one link, so the one asked for is never added beside
 * another: posted, it replaces it. A jump posted to a thought's parent takes
 * the thought out from under it, and one posted to its tag or its type takes
 * the tag or the type away. So what is there stays, and this says what it is.
 *
 * No link reads back with relation 2: a parent's link is stored as a child's
 * from the other end. `thoughtIdA` is therefore the upper end of a
 * parent-child link, as it is the tag of an attachment and the type of a
 * type's link. Comparing the stored relation with the one asked for used to
 * call every parent link a mismatch, and a link the other way up, a tag and
 * a type the child link asked for.
 *
 * A label goes onto an ordinary link whatever its relation: it says how the
 * two relate, and that link is the one place it can be kept. It does not go
 * onto a tag's attachment or a type's link, which are not links between two
 * thoughts and used to be labelled all the same.
 *
 * `name` is the label asked for, if any. A link has one label, so one that
 * is there is replaced, and the note quotes it: "label updated" used to be
 * the whole of it, and what a person had written there was gone with nobody
 * told. Quoted, it can be put back by the call that set the new one. And a
 * label the link has already is not written: it is set against the name as
 * TheBrain stores it (`linkNameAsStored`).
 */
export function linkFound(existing: LinkDto, asked: AskedLink, name?: string): FoundLink {
  const named = name !== undefined;
  const fromIsHead = existing.thoughtIdA.toLowerCase() === asked.from.toLowerCase();
  const [head, tail] = fromIsHead ? [asked.fromName, asked.toName] : [asked.toName, asked.fromName];
  const hierarchy = (upper: string): string => `parent-child with ${upper} above`;
  const wanted =
    asked.relation === "jump"
      ? "jump"
      : hierarchy(asked.relation === "child" ? asked.fromName : asked.toName);

  if (!isStructuralLink(existing)) {
    const what = isTagLink(existing)
      ? `${head} is a tag on ${tail}`
      : isTypeLink(existing)
        ? `${head} is the type of ${tail}`
        : `the two are joined by a link of another kind (meaning ${existing.meaning})`;
    return {
      asAsked: false,
      ordinary: false,
      note:
        `${what}, and two thoughts share one link: the requested ${wanted} was not ` +
        "added in its place" +
        (named ? ", and no label was written" : ""),
      label: null,
    };
  }

  // A link never named reads `null`, and one whose name was cleared `""`.
  const was = existing.name ?? "";
  const now = named ? linkNameAsStored(name) : was;
  // Said only of a label that took another's place: one written where there
  // was none reads as it did.
  const quoted = JSON.stringify;
  const replaced = was === "" ? "" : `: it was ${quoted(was)} and is now ${quoted(now)}`;
  const label: FoundLabel | null = !named
    ? null
    : now === was
      ? { write: false, said: `label already ${quoted(now)}` }
      : { write: true, said: `label updated${replaced}` };

  const asAsked =
    existing.relation === Relation.Jump
      ? asked.relation === "jump"
      : existing.relation === Relation.Child &&
        asked.relation === (fromIsHead ? "child" : "parent");
  if (asAsked) {
    return {
      asAsked,
      ordinary: true,
      note: "the link already existed" + (label === null ? "" : `, ${label.said}`),
      label,
    };
  }
  const found =
    existing.relation === Relation.Jump
      ? "jump"
      : existing.relation === Relation.Child
        ? hierarchy(head)
        : `kind ${existing.relation}`;
  return {
    asAsked,
    ordinary: true,
    note:
      `the link already existed as ${found}, the requested ${wanted} was not added` +
      (label === null
        ? ""
        : label.write
          ? ` — only the label was updated${replaced}`
          : `, and its label is already ${quoted(now)}`),
    label,
  };
}
