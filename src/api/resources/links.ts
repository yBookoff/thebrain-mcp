import { assertUuid, type TheBrainClient } from "../client.js";
import { TheBrainError } from "../errors.js";
import {
  type AttachmentDto,
  type LinkDto,
  LinkMeaning,
  Relation,
  ThoughtKind,
} from "../types.js";

export interface CreateLinkInput {
  thoughtIdA: string;
  thoughtIdB: string;
  relation?: Relation;
  name?: string;
}

/** Flat facade over JSON Patch. `kind` and `meaning` are read-only. */
export interface UpdateLinkInput {
  name?: string | null | undefined;
  color?: string | null | undefined;
  thickness?: number | null | undefined;
  direction?: number | undefined;
  relation?: number | undefined;
}

export class LinksResource {
  constructor(private readonly client: TheBrainClient) {}

  async get(brainId: string, linkId: string): Promise<LinkDto> {
    assertUuid(brainId, "brainId");
    assertUuid(linkId, "linkId");
    return this.client.get<LinkDto>(`/api/links/${brainId}/${linkId}`);
  }

  /** The link between two thoughts, or null if there is none. */
  async between(
    brainId: string,
    thoughtIdA: string,
    thoughtIdB: string,
  ): Promise<LinkDto | null> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtIdA, "thoughtIdA");
    assertUuid(thoughtIdB, "thoughtIdB");
    try {
      return await this.client.get<LinkDto>(
        `/api/links/${brainId}/${thoughtIdA}/${thoughtIdB}`,
      );
    } catch (error) {
      if (error instanceof TheBrainError && error.kind === "not_found") return null;
      throw error;
    }
  }

  async create(brainId: string, input: CreateLinkInput): Promise<string> {
    assertUuid(brainId, "brainId");
    assertUuid(input.thoughtIdA, "thoughtIdA");
    assertUuid(input.thoughtIdB, "thoughtIdB");
    const body: Record<string, unknown> = {
      thoughtIdA: input.thoughtIdA,
      thoughtIdB: input.thoughtIdB,
      relation: input.relation ?? Relation.Child,
    };
    if (input.name !== undefined) body["name"] = input.name;
    const created = await this.client.post<{ id: string }>(`/api/links/${brainId}`, {
      json: body,
    });
    return created.id;
  }

  async update(
    brainId: string,
    linkId: string,
    changes: UpdateLinkInput,
  ): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(linkId, "linkId");
    const ops = Object.entries(changes)
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({ op: "replace" as const, path: `/${key}`, value }));
    if (ops.length === 0) return;
    await this.client.patch(`/api/links/${brainId}/${linkId}`, { jsonPatch: ops });
  }

  async delete(brainId: string, linkId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(linkId, "linkId");
    await this.client.delete(`/api/links/${brainId}/${linkId}`);
  }

  async attachments(brainId: string, linkId: string): Promise<AttachmentDto[]> {
    assertUuid(brainId, "brainId");
    assertUuid(linkId, "linkId");
    return this.client.get<AttachmentDto[]>(`/api/links/${brainId}/${linkId}/attachments`);
  }

  // ------------------------------------------------------------------ tags

  /**
   * Attaches a tag to a thought.
   *
   * The mechanism is undocumented: the link is created with `relation: Parent`,
   * and the server — seeing `kind: Tag` on the target — rewrites it to
   * `relation: Child, meaning: Tag`. `meaning` cannot be set directly:
   * `PATCH /meaning` is silently ignored.
   *
   * Returns the identifier of the created link.
   */
  async attachTag(
    brainId: string,
    thoughtId: string,
    tagThoughtId: string,
  ): Promise<string> {
    return this.create(brainId, {
      thoughtIdA: thoughtId,
      thoughtIdB: tagThoughtId,
      relation: Relation.Parent,
    });
  }

  /** Removes a tag by finding the thought-to-tag link and deleting it. */
  async detachTag(
    brainId: string,
    thoughtId: string,
    tagThoughtId: string,
  ): Promise<boolean> {
    const link = await this.between(brainId, thoughtId, tagThoughtId);
    if (link === null) return false;
    await this.delete(brainId, link.id);
    return true;
  }
}

/** A tag attachment rather than an ordinary link between thoughts. */
export function isTagLink(link: LinkDto): boolean {
  return link.meaning === LinkMeaning.Tag;
}

/** A type attachment: arrives in the graph alongside parent links. */
export function isTypeLink(link: LinkDto): boolean {
  return link.meaning === LinkMeaning.Type;
}

/** An ordinary link — the kind worth showing as graph structure. */
export function isStructuralLink(link: LinkDto): boolean {
  return link.meaning === LinkMeaning.Normal;
}

export { ThoughtKind };
