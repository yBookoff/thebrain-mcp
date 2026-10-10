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
 */

import {
  ALIASES_UNSUPPORTED,
  mayHaveLanded,
  normalizeAliases,
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
   * Skip creating a thought when the same parent already has a child with that
   * name, reusing the existing one. Makes a repeat run safe.
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

  /** Children of existing parents — read once per parent. */
  const childrenCache = new Map<string, Map<string, string>>();
  const childrenOf = async (parentId: string): Promise<Map<string, string>> => {
    let cached = childrenCache.get(parentId);
    if (cached === undefined) {
      const graph = await api.thoughts.getGraph(brainId, parentId).catch(() => null);
      cached = new Map(
        (graph?.children ?? []).map((c) => [(c.name ?? "").trim(), c.id] as const),
      );
      childrenCache.set(parentId, cached);
    }
    return cached;
  };

  /**
   * Currently being created, keyed by "parent + name".
   *
   * Thoughts at one level are written concurrently, so an existence check is
   * not enough: two identical names in a batch both read the cache before the
   * first one lands. The second awaits the first one's promise.
   */
  const inFlight = new Map<string, Promise<string>>();
  const slot = (parentId: string | null, name: string): string =>
    `${parentId ?? ""}\0${name.trim()}`;

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
        const key = slot(parentId, t.name);

        if (dedupe) {
          if (parentId !== null) {
            const existing = (await childrenOf(parentId)).get(t.name.trim());
            if (existing !== undefined) {
              resolved.set(t.tempId, existing);
              outcome.reused.push({ tempId: t.tempId, thoughtId: existing, name: t.name });
              return;
            }
          }
          const pending = inFlight.get(key);
          if (pending !== undefined) {
            const thoughtId = await pending;
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
        if (dedupe) inFlight.set(key, creation);

        const thoughtId = await creation;
        resolved.set(t.tempId, thoughtId);
        outcome.created.push({ tempId: t.tempId, thoughtId, name: t.name });
        if (aliases.length > 0) {
          aliased.add(thoughtId);
          bornWith.set(thoughtId, aliases);
        }

        if (parentId !== null) {
          (await childrenOf(parentId)).set(t.name.trim(), thoughtId);
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

  return outcome;
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
