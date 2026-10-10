import { assertUuid, type JsonPatchOp, type TheBrainClient } from "../client.js";
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

/**
 * Flat facade over JSON Patch. `kind` and `meaning` are read-only.
 *
 * An absent field is left alone; `null` clears a name or a colour, the two
 * fields that can be cleared.
 */
export interface UpdateLinkInput {
  /** Cleared, a name reads back as `""`, not as the `null` of a link never named. */
  name?: string | null | undefined;
  /** `#rrggbb`; it reads back in capitals. */
  color?: string | null | undefined;
  /**
   * A whole number. The API stores a hundred times it and a read returns that:
   * 3 reads back as 300.
   *
   * No `null`: a new link reads -1, and no patch puts that back. `remove` and
   * `replace` with null are a 400, and -1 is stored as -100.
   */
  thickness?: number | undefined;
  /** 0 to 7. A new link reads -1, which is a 400 to write. */
  direction?: number | undefined;
  /**
   * 1 makes `thoughtIdB` the child and 3 makes a jump, the ends staying as
   * they are. 2 swaps the ends every time it is sent, and 4 answers 200 and
   * changes nothing: neither is guarded here.
   */
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

  /**
   * Takes flat fields and assembles the JSON Patch internally.
   *
   * A name or a colour is cleared with `remove`. `replace` with null is a 400
   * for a colour, and for a name a 200 that leaves the name where it was.
   *
   * The API applies a patch one operation at a time and keeps what it wrote
   * before the one it refuses: an update that throws may have landed in part.
   */
  async update(
    brainId: string,
    linkId: string,
    changes: UpdateLinkInput,
  ): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(linkId, "linkId");
    // Ahead of the request: a fraction is a 403 and null a 400, and by then
    // the fields before the thickness are written.
    if (changes.thickness !== undefined && !Number.isInteger(changes.thickness)) {
      throw new TheBrainError(
        "bad_request",
        `thickness must be a whole number, got ${String(changes.thickness)}. It cannot be ` +
          "cleared either: no patch returns a link to the thickness it was created with",
      );
    }
    const ops: JsonPatchOp[] = Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) =>
        value === null
          ? { op: "remove", path: `/${key}` }
          : { op: "replace", path: `/${key}`, value },
      );
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

  /**
   * Takes a type off a thought by deleting the link that carries it. False
   * when there is no such link.
   *
   * `PATCH /typeId` cannot do this, see `ThoughtsResource.removeType`. A link
   * between the two that is not the type link is left alone.
   */
  async detachType(
    brainId: string,
    thoughtId: string,
    typeThoughtId: string,
  ): Promise<boolean> {
    const link = await this.between(brainId, typeThoughtId, thoughtId);
    if (link === null || !isTypeLink(link)) return false;
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
