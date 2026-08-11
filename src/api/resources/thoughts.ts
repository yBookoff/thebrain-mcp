import { assertUuid, emptyOn400, type TheBrainClient } from "../client.js";
import { TheBrainError } from "../errors.js";
import {
  ModType,
  type AttachmentDto,
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

export class ThoughtsResource {
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

  async create(brainId: string, input: CreateThoughtInput): Promise<string> {
    assertUuid(brainId, "brainId");
    if (input.sourceThoughtId !== undefined) {
      assertUuid(input.sourceThoughtId, "sourceThoughtId");
    }
    if (input.typeId !== undefined) assertUuid(input.typeId, "typeId");

    const body: Record<string, unknown> = {
      name: input.name,
      kind: input.kind ?? ThoughtKind.Normal,
      acType: input.acType ?? 0,
    };
    if (input.label !== undefined) body["label"] = input.label;
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

    const ops = Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ op: "replace" as const, path: `/${key}`, value }));

    if (ops.length === 0) return;
    await this.client.patch(`/api/thoughts/${brainId}/${thoughtId}`, {
      jsonPatch: ops,
    });
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

/**
 * Reconstructs a brain's contents from the modification log.
 *
 * The API has no "list all thoughts" endpoint. The log without a date range
 * holds the full history: `created` minus `deleted` yields the current set of
 * identifiers.
 *
 * Cross-checked against `statistics`: the log covers thoughts of every kind,
 * whereas `statistics.thoughts` counts only `kind = Normal`.
 *
 * Caveat: log completeness for imported brains has not been verified.
 */
export function replayThoughtIds(logs: readonly ModificationLogDto[]): Set<string> {
  const alive = new Set<string>();
  const ordered = [...logs].sort(
    (a, b) => Date.parse(a.creationDateTime) - Date.parse(b.creationDateTime),
  );
  for (const log of ordered) {
    if (log.sourceType !== 2) continue;
    if (log.modType === ModType.Created) alive.add(log.sourceId);
    else if (log.modType === ModType.Deleted) alive.delete(log.sourceId);
  }
  return alive;
}
