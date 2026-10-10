import {
  assertUuid,
  emptyOn400,
  type JsonPatchOp,
  type TheBrainClient,
} from "../client.js";
import { TheBrainError } from "../errors.js";
import { compareLogTime, logTime } from "../log.js";
import {
  ModType,
  aliasesOf,
  type AttachmentDto,
  type BrainDto,
  type LinkDto,
  type ModificationLogDto,
  type Relation,
  type ThoughtDto,
  type ThoughtGraphDto,
  ThoughtKind,
} from "../types.js";
import type { LinksResource } from "./links.js";

export interface CreateThoughtInput {
  name: string;
  /** Which thought to attach to. Without it the thought is created orphaned. */
  sourceThoughtId?: string;
  /** How the new thought relates to the source. Defaults to child. */
  relation?: Relation;
  kind?: number;
  label?: string;
  /** Alternate names. See `UpdateThoughtInput.aliases` for what saving one costs. */
  aliases?: readonly string[];
  typeId?: string;
  acType?: number;
}

/**
 * Flat facade over JSON Patch — patch documents never leave this layer.
 *
 * `undefined` is allowed explicitly: tool handlers build these objects from
 * optional arguments. An absent field is left alone; `null` clears the value.
 */
export interface UpdateThoughtInput {
  name?: string | undefined;
  label?: string | null | undefined;
  /** `null` takes the type away, which no patch does: see `removeType`. */
  typeId?: string | null | undefined;
  foregroundColor?: string | null | undefined;
  backgroundColor?: string | null | undefined;
  acType?: number | undefined;
  kind?: number | undefined;
  /**
   * The whole list: the API refuses per-element paths. `null` or an empty list
   * clears it. To add or drop single aliases use `changeAliases`.
   *
   * Per the spec, saving the first alias in a brain makes that brain require
   * TheBrain 15.0.621 or later on every device.
   */
  aliases?: readonly string[] | null | undefined;
}

/** The API keeps the first hundred aliases of a longer list and drops the rest. */
export const MAX_ALIASES = 100;

/**
 * A read straight after a write usually still returns the old value.
 *
 * Aliases, measured over 82 writes: the new list showed up 50–100 ms later,
 * 0.2 s at the most, and 7 times it was there at once. A removed type, over 13
 * removals: 20–210 ms, and not once on the first read.
 */
const READ_BACK = { stepMs: 25, timeoutMs: 2000 };

export interface AliasChanges {
  add?: readonly string[] | undefined;
  /** Matched ignoring case and surrounding whitespace. */
  remove?: readonly string[] | undefined;
}

export interface AliasOutcome {
  /** The list after the change. */
  aliases: string[];
  added: string[];
  removed: string[];
  /**
   * False when a written list had not shown up on a read by the time this
   * returned. Another edit made now would start from the old list and undo it.
   */
  readBack: boolean;
}

/**
 * Graph with the type filtered out of parents: the API returns it in both
 * `type` and `parents`. All lists are normalised — the API sends `null`
 * instead of empty arrays.
 */
export interface CleanGraph {
  thought: ThoughtDto;
  parents: ThoughtDto[];
  children: ThoughtDto[];
  jumps: ThoughtDto[];
  siblings: ThoughtDto[];
  tags: ThoughtDto[];
  type: ThoughtDto | null;
  links: LinkDto[];
  attachments: AttachmentDto[];
}

/** What a caller is told when it asks a build without aliases to save some. */
export const ALIASES_UNSUPPORTED =
  "this TheBrain has no aliases: they arrived in 15.0.621. " +
  "Update TheBrain, or leave the aliases out";

export class ThoughtsResource {
  /** Only a yes is remembered: an update can add aliases while we run. */
  #aliasesSeen = false;

  constructor(
    private readonly client: TheBrainClient,
    private readonly links: LinksResource,
  ) {}

  async get(brainId: string, thoughtId: string): Promise<ThoughtDto> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    return this.client.get<ThoughtDto>(`/api/thoughts/${brainId}/${thoughtId}`);
  }

  /**
   * One hop of the graph around a thought.
   *
   * The API returns the thought's type twice — in `type` and among `parents`.
   * It is removed from parents here, otherwise types leak into the tree as
   * ordinary ancestors.
   */
  async getGraph(
    brainId: string,
    thoughtId: string,
    options: { includeSiblings?: boolean } = {},
  ): Promise<CleanGraph> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    const raw = await this.client.get<ThoughtGraphDto>(
      `/api/thoughts/${brainId}/${thoughtId}/graph`,
      { query: { includeSiblings: options.includeSiblings ?? false } },
    );
    const typeId = raw.activeThought.typeId;
    return {
      thought: raw.activeThought,
      parents: (raw.parents ?? []).filter((p) => p.id !== typeId),
      children: raw.children ?? [],
      jumps: raw.jumps ?? [],
      siblings: raw.siblings ?? [],
      tags: raw.tags ?? [],
      type: raw.type,
      links: raw.links ?? [],
      attachments: raw.attachments ?? [],
    };
  }

  /**
   * Exact name match, or null.
   *
   * Faster than full-text search but **not instant**: measured at roughly
   * 5.6 seconds between creating a thought and its appearance here. After a
   * write, address thoughts by id rather than by name.
   */
  async findByName(brainId: string, nameExact: string): Promise<ThoughtDto | null> {
    assertUuid(brainId, "brainId");
    try {
      return await this.client.get<ThoughtDto>(`/api/thoughts/${brainId}`, {
        query: { nameExact },
      });
    } catch (error) {
      if (error instanceof TheBrainError && error.kind === "not_found") return null;
      throw error;
    }
  }

  /**
   * Whether this TheBrain has aliases at all.
   *
   * Builds before 15.0.621 do not. What they do with `aliases` in a create
   * request could not be measured, and a field ignored in silence would be
   * reported as written, so writers ask first. The current build sends
   * `aliases` on every thought, empty or not; its absence on the home thought
   * settles it. When the question cannot be answered the write goes ahead.
   */
  async supportsAliases(brainId: string): Promise<boolean> {
    assertUuid(brainId, "brainId");
    if (this.#aliasesSeen) return true;
    try {
      const brain = await this.client.get<BrainDto>(`/api/brains/${brainId}`);
      const home = await this.get(brainId, brain.homeThoughtId);
      this.#aliasesSeen = home.aliases !== undefined;
      return this.#aliasesSeen;
    } catch {
      return true;
    }
  }

  async create(brainId: string, input: CreateThoughtInput): Promise<string> {
    assertUuid(brainId, "brainId");
    if (input.sourceThoughtId !== undefined) {
      assertUuid(input.sourceThoughtId, "sourceThoughtId");
    }
    if (input.typeId !== undefined) assertUuid(input.typeId, "typeId");
    const aliases = input.aliases ?? [];
    if (aliases.length > 0 && !(await this.supportsAliases(brainId))) {
      throw new TheBrainError("bad_request", ALIASES_UNSUPPORTED);
    }

    const body: Record<string, unknown> = {
      name: input.name,
      kind: input.kind ?? ThoughtKind.Normal,
      acType: input.acType ?? 0,
    };
    if (input.label !== undefined) body["label"] = input.label;
    if (aliases.length > 0) body["aliases"] = aliases;
    if (input.typeId !== undefined) body["typeId"] = input.typeId;
    if (input.sourceThoughtId !== undefined) {
      body["sourceThoughtId"] = input.sourceThoughtId;
      body["relation"] = input.relation ?? 1;
    }

    const created = await this.client.post<{ id: string }>(
      `/api/thoughts/${brainId}`,
      { json: body },
    );
    return created.id;
  }

  /**
   * Takes flat fields and assembles the JSON Patch internally.
   *
   * A value is cleared with `remove`. `replace` with null is refused for a
   * label (403) and for a colour (400), and for a type it answers 200 and
   * changes nothing, so a type goes through `removeType` instead.
   *
   * The API applies a patch one operation at a time and keeps what it wrote
   * before the one it refuses: an update that throws may have landed in part.
   */
  async update(
    brainId: string,
    thoughtId: string,
    changes: UpdateThoughtInput,
  ): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    const { aliases, typeId, ...fields } = changes;
    if (typeof typeId === "string") assertUuid(typeId, "typeId");

    const ops: JsonPatchOp[] = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) =>
        value === null
          ? { op: "remove", path: `/${key}` }
          : { op: "replace", path: `/${key}`, value },
      );
    if (typeof typeId === "string") {
      ops.push({ op: "replace", path: "/typeId", value: typeId });
    }
    if (aliases !== undefined) {
      ops.push(
        aliases === null || aliases.length === 0
          ? { op: "remove", path: "/aliases" }
          : { op: "replace", path: "/aliases", value: aliases },
      );
    }

    if (ops.length > 0) {
      await this.client.patch(`/api/thoughts/${brainId}/${thoughtId}`, {
        jsonPatch: ops,
      });
    }
    if (typeId === null) await this.removeType(brainId, thoughtId);
  }

  /**
   * Takes a thought's type away. False when it had none.
   *
   * No patch does it: `replace /typeId` with null or "" answers 200 and leaves
   * the type in place, and `remove` is a 403. The type is a link from the type
   * to the thought, and deleting that link is what clears `typeId`.
   *
   * It returns once the thought reads back without a type, and throws when it
   * never does: a removal that did not happen must not pass for one that did.
   * The first read is trusted, though, and a type takes up to 0.2 s to read
   * back: one set a moment ago is not seen here, and stays.
   */
  async removeType(brainId: string, thoughtId: string): Promise<boolean> {
    const { typeId } = await this.get(brainId, thoughtId);
    if (!typeId) return false;

    const detached = await this.links.detachType(brainId, thoughtId, typeId);
    // Also when there was no link to delete: this read may be a stale one that
    // follows an earlier removal.
    if (await this.#readsBack(brainId, thoughtId, (t) => !t.typeId)) return detached;
    throw new TheBrainError(
      "server",
      detached
        ? "the type's link was deleted, but the thought still reads back with its type"
        : "the thought has a type, but the link that carries it was not found: " +
          "nothing was deleted and the type is still in place",
    );
  }

  /**
   * Adds and removes single aliases.
   *
   * The API only replaces the whole list, so this reads it first and writes
   * the result back; nothing is written when nothing would change. Removal
   * runs before addition, so one call can replace an alias.
   *
   * It returns once the new list reads back. A read straight after the write
   * usually still returns the old list, and a second edit built on that would
   * silently undo the first: measured, two edits in a row left only the second
   * alias. Edits made at the same moment can still collide; the API has no way
   * to prevent that.
   */
  async changeAliases(
    brainId: string,
    thoughtId: string,
    changes: AliasChanges,
  ): Promise<AliasOutcome> {
    const thought = await this.get(brainId, thoughtId);
    const current = aliasesOf(thought);
    const drop = new Set(normalizeAliases(changes.remove ?? []).map(aliasKey));
    const kept = current.filter((a) => !drop.has(aliasKey(a)));
    const removed = current.filter((a) => drop.has(aliasKey(a)));

    // The API drops an alias equal to the name, in any case, so asking for one
    // is not a change.
    const taken = new Set([...kept, thought.name ?? ""].map(aliasKey));
    const added = normalizeAliases(changes.add ?? []).filter((a) => !taken.has(aliasKey(a)));

    const aliases = [...kept, ...added];
    if (added.length === 0 && removed.length === 0) {
      return { aliases, added, removed, readBack: true };
    }
    if (thought.aliases === undefined) {
      throw new TheBrainError("bad_request", ALIASES_UNSUPPORTED);
    }
    if (aliases.length > MAX_ALIASES) {
      // The API would keep the first hundred and say nothing about the rest.
      throw new TheBrainError(
        "bad_request",
        `a thought holds at most ${MAX_ALIASES} aliases, and this would make ${aliases.length}. ` +
          "Remove some first",
      );
    }
    await this.update(brainId, thoughtId, { aliases });
    const listed = (list: readonly string[]): string => list.map(aliasKey).sort().join("\n");
    const readBack = await this.#readsBack(
      brainId,
      thoughtId,
      (t) => listed(aliasesOf(t)) === listed(aliases),
    );
    return { aliases, added, removed, readBack };
  }

  /** Waits for a write to show up on a read of the thought. */
  async #readsBack(
    brainId: string,
    thoughtId: string,
    landed: (thought: ThoughtDto) => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + READ_BACK.timeoutMs;
    for (;;) {
      if (landed(await this.get(brainId, thoughtId))) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, READ_BACK.stepMs));
    }
  }

  async delete(brainId: string, thoughtId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    await this.client.delete(`/api/thoughts/${brainId}/${thoughtId}`);
  }

  /** The brain's types. An empty list arrives as 400; normalised to [] here. */
  async listTypes(brainId: string): Promise<ThoughtDto[]> {
    assertUuid(brainId, "brainId");
    return emptyOn400(this.client.get<ThoughtDto[]>(`/api/thoughts/${brainId}/types`));
  }

  /** The brain's tags. An empty list arrives as 400; normalised to [] here. */
  async listTags(brainId: string): Promise<ThoughtDto[]> {
    assertUuid(brainId, "brainId");
    return emptyOn400(this.client.get<ThoughtDto[]>(`/api/thoughts/${brainId}/tags`));
  }

  async listPinned(brainId: string): Promise<ThoughtDto[]> {
    assertUuid(brainId, "brainId");
    return emptyOn400(this.client.get<ThoughtDto[]>(`/api/thoughts/${brainId}/pins`));
  }

  async pin(brainId: string, thoughtId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    await this.client.post(`/api/thoughts/${brainId}/${thoughtId}/pin`);
  }

  async unpin(brainId: string, thoughtId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    await this.client.delete(`/api/thoughts/${brainId}/${thoughtId}/pin`);
  }

  async modifications(
    brainId: string,
    thoughtId: string,
    options: { maxLogs?: number; includeRelated?: boolean } = {},
  ): Promise<ModificationLogDto[]> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    return this.client.get<ModificationLogDto[]>(
      `/api/thoughts/${brainId}/${thoughtId}/modifications`,
      {
        query: {
          maxLogs: options.maxLogs ?? 100,
          includeRelatedLogs: options.includeRelated ?? true,
        },
      },
    );
  }
}

/** How aliases are compared: the API deduplicates them ignoring case. */
function aliasKey(alias: string): string {
  return alias.trim().toLocaleLowerCase();
}

/**
 * Aliases as the API stores them: trimmed, blanks dropped, and the first
 * spelling kept when two differ only in case.
 */
export function normalizeAliases(aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (alias === "" || seen.has(aliasKey(alias))) continue;
    seen.add(aliasKey(alias));
    out.push(alias);
  }
  return out;
}

/**
 * Reconstructs a brain's contents from the modification log.
 *
 * The API has no "list all thoughts" endpoint. Over the whole log
 * (`brains.allModifications`), `created` minus `deleted` yields the thoughts
 * that were created in this brain and still exist. Imported and old brains hold
 * thoughts the log never recorded, which is why a rebuild also walks the graph
 * (ARCHITECTURE.md §7).
 *
 * Cross-checked against `statistics`: the log covers thoughts of every kind,
 * whereas `statistics.thoughts` counts only `kind = Normal`.
 */
export function replayThoughtIds(logs: readonly ModificationLogDto[]): Set<string> {
  const alive = new Set<string>();
  // Not through `Date`: it drops microseconds, and a create and a delete in the
  // same millisecond would then replay in whatever order they arrived.
  const ordered = [...logs].sort((a, b) => compareLogTime(logTime(a), logTime(b)));
  for (const log of ordered) {
    if (log.sourceType !== 2) continue;
    if (log.modType === ModType.Created) alive.add(log.sourceId);
    else if (log.modType === ModType.Deleted) alive.delete(log.sourceId);
  }
  return alive;
}
