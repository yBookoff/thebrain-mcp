import {
  assertUuid,
  emptyOn400,
  type JsonPatchOp,
  type TheBrainClient,
} from "../client.js";
import { TheBrainError } from "../errors.js";
import { compareLogTime } from "../log.js";
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
 * A read straight after an alias write usually still returns the old list.
 * Measured over 82 writes: the new one showed up 50–100 ms later, 0.2 s at the
 * most, and 7 times it was there at once.
 */
const ALIAS_READ_BACK = { stepMs: 25, timeoutMs: 2000 };

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

  constructor(private readonly client: TheBrainClient) {}

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

  /** Takes flat fields and assembles the JSON Patch internally. */
  async update(
    brainId: string,
    thoughtId: string,
    changes: UpdateThoughtInput,
  ): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    if (changes.typeId) assertUuid(changes.typeId, "typeId");

    const { aliases, ...fields } = changes;
    const ops: JsonPatchOp[] = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ op: "replace" as const, path: `/${key}`, value }));
    if (aliases !== undefined) {
      ops.push(
        aliases === null || aliases.length === 0
          ? { op: "remove", path: "/aliases" }
          : { op: "replace", path: "/aliases", value: aliases },
      );
    }

    if (ops.length === 0) return;
    await this.client.patch(`/api/thoughts/${brainId}/${thoughtId}`, {
      jsonPatch: ops,
    });
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
    const readBack = await this.#aliasesReadBack(brainId, thoughtId, aliases);
    return { aliases, added, removed, readBack };
  }

  /** Waits for a written alias list to show up on a read. */
  async #aliasesReadBack(
    brainId: string,
    thoughtId: string,
    written: readonly string[],
  ): Promise<boolean> {
    const wanted = written.map(aliasKey).sort().join("\n");
    const deadline = Date.now() + ALIAS_READ_BACK.timeoutMs;
    for (;;) {
      const seen = aliasesOf(await this.get(brainId, thoughtId));
      if (seen.map(aliasKey).sort().join("\n") === wanted) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, ALIAS_READ_BACK.stepMs));
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
  const ordered = [...logs].sort((a, b) =>
    compareLogTime(a.creationDateTime, b.creationDateTime),
  );
  for (const log of ordered) {
    if (log.sourceType !== 2) continue;
    if (log.modType === ModType.Created) alive.add(log.sourceId);
    else if (log.modType === ModType.Deleted) alive.delete(log.sourceId);
  }
  return alive;
}
