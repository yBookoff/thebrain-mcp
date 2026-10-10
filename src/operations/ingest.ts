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
 *  5. A graph that has been read is answered from a copy, which is up to 0.2 s
 *     behind a create. So the batch returns once the graphs list what it made:
 *     a second run sent straight after it used to make the children again too.
 */

import {
  ALIASES_UNSUPPORTED,
  TheBrainError,
  mayHaveLanded,
  normalizeAliases,
  type CleanGraph,
  type TheBrainApi,
} from "../api/index.js";
import { Relation } from "../api/types.js";
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

/** What a thought has next to it: for each relation, identifiers by trimmed name. */
type Neighbours = Record<RelationName, Map<string, string>>;

/**
 * How long a batch waits for the graphs to list what it made. Measured on a
 * quiet brain: about 80 ms at the median, 205 ms at the most.
 */
const LISTED = { stepMs: 25, timeoutMs: 2000 };

export interface IngestThought {
  /** Local label within the batch, for referencing before creation. */
  tempId: string;
  name: string;
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
   * reused nor made again: it fails, with the identifier. A thought with no
   * parent is not looked for.
   */
  deduplicate?: boolean | undefined;
}

export interface IngestOutcome {
  created: Array<{ tempId: string; thoughtId: string; name: string }>;
  reused: Array<{ tempId: string; thoughtId: string; name: string }>;
  linksCreated: number;
  /**
   * Links that already existed. Cases where the requested kind did not match
   * the actual one are flagged separately: a jump asked for between a thought and
   * its own parent is not posted, since the API would turn the parent link into it.
   */
  linksReused: Array<{ from: string; to: string; note: string }>;
  notesWritten: number;
  tagsAttached: number;
  /** Thoughts whose alias list was written, at creation or by adding to it. */
  aliasesWritten: number;
  /**
   * What was tried and failed. `unanswered` marks a create that went out and
   * got no answer: the thought may be there, with no identifier to report.
   */
  failures: Array<{ what: string; reason: string; unanswered?: true }>;
  /**
   * What was not tried, because a thought it needs was not created: the
   * thoughts under one that failed, with their notes, tags and aliases, and
   * the links to any of them. The reason names the thought that failed.
   */
  skipped: Array<{ what: string; reason: string }>;
  /**
   * Thoughts created here that the graph of the thought they hang on did not
   * list by the time the batch gave up waiting. A run sent now would not find
   * them, and would make them again.
   */
  unlisted: number;
}

export class IngestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (t.name.trim() === "") {
      throw new IngestValidationError(`thought "${t.tempId}" has an empty name`);
    }
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
  plan: IngestPlan,
): Promise<IngestOutcome> {
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
  // type a thought is given that type, with a 200, and loses the one it had.
  // Only a UUID can name a type, since a plan makes ordinary thoughts. A
  // `tempId` is checked at its own turn, by `create` and `links.create`: it
  // can land on a type its parent holds as an ordinary child.
  await mapWithConcurrency([...parentEnds(plan)], 6, ([id, field]) =>
    api.links.requireParent(brainId, id, field),
  );

  const outcome: IngestOutcome = {
    created: [],
    reused: [],
    linksCreated: 0,
    linksReused: [],
    notesWritten: 0,
    tagsAttached: 0,
    aliasesWritten: 0,
    failures: [],
    skipped: [],
    unlisted: 0,
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
   * API's own words.
   */
  const lookAround = async (anchorId: string): Promise<Neighbours | null> => {
    try {
      return await neighboursOf(anchorId);
    } catch (error) {
      const nobodyHasIt = await api.thoughts.get(brainId, anchorId).then(
        () => false,
        (e: unknown) => e instanceof TheBrainError && e.kind === "not_found",
      );
      if (nobodyHasIt) return null;
      throw new Error(
        `${anchorId} could not be read to look for a thought of this name next to it, ` +
          `so nothing was created: ${describe(error)}`,
      );
    }
  };
  /** Why a thought of the same name under another relation stops this one. */
  const namesake = (
    t: IngestThought,
    anchorId: string,
    asked: RelationName,
    found: RelationName,
    thoughtId: string,
  ): Error =>
    new Error(
      `${anchorId} already has a thought of this name as its ${found}, ${thoughtId}, and the ` +
        `plan asks for a ${asked}. It was not taken for the same thought, and no second one ` +
        `was made. To use it, name ${thoughtId} where the plan has "${t.tempId}"; to make ` +
        "another of that name, send this thought in a plan with deduplicate set to false",
    );

  /**
   * Currently being created, keyed by "parent + name", each with the relation
   * it is created under.
   *
   * Thoughts at one level are written concurrently, so an existence check is
   * not enough: two identical names in a batch both read the cache before the
   * first one lands. The second awaits the first one's promise.
   */
  const inFlight = new Map<string, { relation: RelationName; creation: Promise<string> }>();
  const slot = (parentId: string | null, name: string): string =>
    `${parentId ?? ""}\0${name.trim()}`;
  /**
   * What the batch made next to a thought that was there before it, by that
   * thought: what its graph has to list before a second run can find it.
   */
  const toBeListed = new Map<string, Array<{ thoughtId: string; relation: RelationName }>>();

  for (const level of levels) {
    await mapWithConcurrency(level, 6, async (t) => {
      // Its parent is of an earlier level, so what became of it is known.
      if (t.parent !== undefined && blocked.has(t.parent)) {
        blocked.set(t.tempId, blocked.get(t.parent)!);
        outcome.skipped.push({
          what: `thought "${t.name}" (${t.tempId})`,
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
            const existing = near?.[relation].get(t.name.trim());
            if (existing !== undefined) {
              resolved.set(t.tempId, existing);
              outcome.reused.push({ tempId: t.tempId, thoughtId: existing, name: t.name });
              return;
            }
            // The same name under another relation. Whether it is the plan's
            // thought is not for the server to say: reused, it would take the
            // plan's note and children; made again, it would be a duplicate.
            for (const other of RELATION_NAMES) {
              const namedSo = near?.[other].get(t.name.trim());
              if (namedSo !== undefined) throw namesake(t, parentId, relation, other, namedSo);
            }
          }
          const pending = inFlight.get(key);
          if (pending !== undefined) {
            // Fails with it when it fails, whatever its relation: the two
            // were sent for one place at one moment.
            const thoughtId = await pending.creation;
            if (pending.relation !== relation && parentId !== null) {
              throw namesake(t, parentId, relation, pending.relation, thoughtId);
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
        if (dedupe) inFlight.set(key, { relation, creation });

        const thoughtId = await creation;
        madeHere.add(thoughtId);
        resolved.set(t.tempId, thoughtId);
        outcome.created.push({ tempId: t.tempId, thoughtId, name: t.name });
        if (aliases.length > 0) {
          aliased.add(thoughtId);
          bornWith.set(thoughtId, aliases);
        }

        if (parentId !== null) {
          near?.[relation].set(t.name.trim(), thoughtId);
          if (!madeHere.has(parentId)) {
            const made = toBeListed.get(parentId) ?? [];
            toBeListed.set(parentId, [...made, { thoughtId, relation }]);
          }
        }
      } catch (error) {
        blocked.set(t.tempId, t.tempId);
        outcome.failures.push({
          what: `thought "${t.name}" (${t.tempId})`,
          reason: describe(error),
          ...(mayHaveLanded(error) ? { unanswered: true as const } : {}),
        });
      }
    });
  }

  // Notes and tags are independent of each other, so write them in parallel.
  await mapWithConcurrency(
    plan.thoughts.filter((t) => t.note !== undefined && t.note.trim() !== ""),
    6,
    async (t) => {
      const id = resolved.get(t.tempId);
      if (id === undefined) return;
      try {
        await api.notes.set(brainId, id, t.note!);
        outcome.notesWritten += 1;
      } catch (error) {
        outcome.failures.push({
          what: `note for "${t.name}"`,
          reason: describe(error),
        });
      }
    },
  );

  const tagJobs = plan.thoughts.flatMap((t) =>
    (t.tagIds ?? []).map((tagId) => ({ t, tagId })),
  );
  await mapWithConcurrency(tagJobs, 6, async ({ t, tagId }) => {
    const id = resolved.get(t.tempId);
    if (id === undefined) return;
    try {
      await api.links.attachTag(brainId, id, tagId);
      outcome.tagsAttached += 1;
    } catch (error) {
      outcome.failures.push({
        what: `tag ${tagId} on "${t.name}"`,
        reason: describe(error),
      });
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
      outcome.failures.push({
        what: `aliases for "${job.name}"`,
        reason: describe(error),
      });
    }
  });
  outcome.aliasesWritten = aliased.size;

  await mapWithConcurrency(plan.links ?? [], 6, async (link) => {
    const from = resolve(link.from);
    const to = resolve(link.to);
    if (from === null || to === null) {
      outcome.skipped.push({
        what: `link ${link.from} -> ${link.to}`,
        reason: needs([link.from, link.to]),
      });
      return;
    }
    try {
      const existing = await api.links.between(brainId, from, to);
      if (existing !== null) {
        const requested = RELATION_BY_NAME[link.relation ?? "jump"];
        const mismatch = existing.relation !== requested;
        if (link.name !== undefined) {
          await api.links.update(brainId, existing.id, { name: link.name });
        }
        outcome.linksReused.push({
          from: link.from,
          to: link.to,
          note: mismatch
            ? `the link already existed as ${describeRelation(existing.relation)}, ` +
              `the requested ${describeRelation(requested)} was not added` +
              (link.name !== undefined ? " — only the label was updated" : "")
            : link.name !== undefined
              ? "the link already existed, label updated"
              : "the link already existed",
        });
        return;
      }
      await api.links.create(brainId, {
        thoughtIdA: from,
        thoughtIdB: to,
        relation: RELATION_BY_NAME[link.relation ?? "jump"] as Relation,
        ...(link.name !== undefined ? { name: link.name } : {}),
      });
      outcome.linksCreated += 1;
    } catch (error) {
      outcome.failures.push({
        what: `link ${link.from} -> ${link.to}`,
        reason: describe(error),
      });
    }
  });

  // Last, so that the notes and links have taken most of the wait already.
  outcome.unlisted = await unlistedAfterWaiting(api, brainId, toBeListed);

  return outcome;
}

/** A thought's graph as `Neighbours`. The type is not among the parents: `getGraph` drops it. */
async function readNeighbours(
  api: TheBrainApi,
  brainId: string,
  thoughtId: string,
): Promise<Neighbours> {
  const graph = await api.thoughts.getGraph(brainId, thoughtId);
  const byName = (relation: RelationName): Map<string, string> =>
    new Map(graph[LIST_OF[relation]].map((t) => [(t.name ?? "").trim(), t.id] as const));
  return { child: byName("child"), parent: byName("parent"), jump: byName("jump") };
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
 */
async function unlistedAfterWaiting(
  api: TheBrainApi,
  brainId: string,
  made: ReadonlyMap<string, ReadonlyArray<{ thoughtId: string; relation: RelationName }>>,
): Promise<number> {
  const missing = await mapWithConcurrency([...made], 6, async ([anchorId, expected]) => {
    const deadline = Date.now() + LISTED.timeoutMs;
    for (;;) {
      // A read that fails has listed nothing.
      const graph = await api.thoughts.getGraph(brainId, anchorId).catch(() => null);
      const lacking = expected.filter(
        ({ thoughtId, relation }) =>
          graph === null || !graph[LIST_OF[relation]].some((t) => t.id === thoughtId),
      ).length;
      if (lacking === 0 || Date.now() >= deadline) return lacking;
      await new Promise((resolve) => setTimeout(resolve, LISTED.stepMs));
    }
  });
  return missing.reduce((sum, n) => sum + n, 0);
}

/**
 * The existing thoughts a plan puts something under, each with the field that
 * names it: the `parent` of a thought made as its child, and the upper end of
 * a child or parent link. A jump has no upper end, and a `tempId` is not an
 * existing thought.
 */
function parentEnds(plan: IngestPlan): Map<string, string> {
  const tempIds = new Set(plan.thoughts.map((t) => t.tempId));
  const ends = new Map<string, string>();
  const add = (ref: string, field: string): void => {
    if (!tempIds.has(ref) && !ends.has(ref)) ends.set(ref, field);
  };
  for (const t of plan.thoughts) {
    if (t.parent !== undefined && (t.relation ?? "child") === "child") add(t.parent, "parent");
  }
  for (const link of plan.links ?? []) {
    if (link.relation === "child") add(link.from, "from");
    if (link.relation === "parent") add(link.to, "to");
  }
  return ends;
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

function describeRelation(relation: number): string {
  const names: Record<number, string> = {
    [Relation.Child]: "parent-child",
    [Relation.Parent]: "parent-child",
    [Relation.Jump]: "jump",
  };
  return names[relation] ?? `kind ${relation}`;
}
