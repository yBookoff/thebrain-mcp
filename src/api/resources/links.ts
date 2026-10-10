import { assertUuid, type JsonPatchOp, type TheBrainClient } from "../client.js";
import { TheBrainError } from "../errors.js";
import {
  type AttachmentDto,
  type LinkDto,
  LinkMeaning,
  Relation,
  type ThoughtDto,
  ThoughtKind,
} from "../types.js";
import { requireKind } from "./kind.js";

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
   * The tag is read first (`requireTag`), and nothing is sent unless it is
   * one: the server infers the same way from any other kind.
   *
   * Returns the identifier of the created link.
   */
  async attachTag(
    brainId: string,
    thoughtId: string,
    tagThoughtId: string,
  ): Promise<string> {
    await this.requireTag(brainId, tagThoughtId, thoughtId);
    return this.create(brainId, {
      thoughtIdA: thoughtId,
      thoughtIdB: tagThoughtId,
      relation: Relation.Parent,
    });
  }

  /**
   * The tag that `tagId` names. Throws `not_a_tag` when it names a thought of
   * another kind, or nothing, or `thoughtId`: the thought the tag is for.
   *
   * The API does not ask. The request that attaches a tag links the thought
   * under whatever it names, with a 200: under a type that is the thought's
   * type, set or replaced, and under an ordinary thought one more parent. A
   * thought named as its own tag is a 200 as well, with an identifier of
   * zeros for a link that was not made. So the kind is read here, ahead of
   * the write, and by a caller that writes something else first, ahead of
   * that.
   */
  async requireTag(brainId: string, tagId: string, thoughtId?: string): Promise<ThoughtDto> {
    // Case aside: the API reads a UUID in capitals too.
    if (thoughtId !== undefined && sameId(tagId, thoughtId)) {
      throw new TheBrainError(
        "not_a_tag",
        `a thought cannot be its own tag: tagId ${tagId} is the thought itself`,
      );
    }
    return requireKind(this.client, brainId, tagId, ThoughtKind.Tag);
  }

  /**
   * Removes a tag by finding the tag's link to the thought and deleting it.
   * False when the tag is not on the thought.
   *
   * Two thoughts share one link, and `between` returns it whatever it is: a
   * thought's type, parent, child or jump, named here for a tag, used to lose
   * that link. Only the link that carries the tag is deleted: a tag's, with
   * the tag at its head. A tag linked to the thought some other way stays.
   */
  async detachTag(
    brainId: string,
    thoughtId: string,
    tagThoughtId: string,
  ): Promise<boolean> {
    const link = await this.between(brainId, thoughtId, tagThoughtId);
    if (link === null || !isTagLink(link) || !sameId(link.thoughtIdA, tagThoughtId)) {
      return false;
    }
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

/**
 * A tag attachment rather than an ordinary link between thoughts: a tag on a
 * thought, or on another tag. `thoughtIdA` is the tag attached.
 */
export function isTagLink(link: LinkDto): boolean {
  return link.meaning === LinkMeaning.Tag || link.meaning === LinkMeaning.SubTag;
}

/** A type attachment: arrives in the graph alongside parent links. */
export function isTypeLink(link: LinkDto): boolean {
  return link.meaning === LinkMeaning.Type;
}

/** An ordinary link — the kind worth showing as graph structure. */
export function isStructuralLink(link: LinkDto): boolean {
  return link.meaning === LinkMeaning.Normal;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export { ThoughtKind };
