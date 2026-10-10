import { assertUuid, createdId, type JsonPatchOp, type TheBrainClient } from "../client.js";
import { TheBrainError } from "../errors.js";
import {
  type AttachmentDto,
  type LinkDto,
  LinkMeaning,
  Relation,
  type ThoughtDto,
  ThoughtKind,
} from "../types.js";
import { requireKind, requireParent } from "./kind.js";

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
 *
 * No `relation`, and `update` refuses one: see there. What a link is, is set
 * by `create`, which rewrites the link two thoughts already share.
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

  /**
   * Links two thoughts. `relation` is what `thoughtIdB` is to `thoughtIdA`.
   *
   * A parent/child link with a type or a tag for its upper end is refused
   * before the request (`requireParent`): the API would answer 200 and make
   * it the lower thought's type, or attach the tag. A jump to either, and
   * either as the lower end, are ordinary links.
   *
   * A thought linked to itself is refused as well, whatever the relation:
   * that is a 200 with an identifier of zeros and no link. Any other answer
   * of zeros is `zero_id`, from `#post`.
   */
  async create(brainId: string, input: CreateLinkInput): Promise<string> {
    // Here as well as in `#post`: a malformed end sends nothing, a read included.
    assertUuid(brainId, "brainId");
    assertUuid(input.thoughtIdA, "thoughtIdA");
    assertUuid(input.thoughtIdB, "thoughtIdB");
    // Case aside: the API reads a UUID in capitals too.
    if (sameId(input.thoughtIdA, input.thoughtIdB)) {
      throw new TheBrainError(
        "bad_request",
        `a thought cannot be linked to itself: both ends of the link are ${input.thoughtIdA}`,
      );
    }
    const relation = input.relation ?? Relation.Child;
    if (relation === Relation.Child) {
      await this.requireParent(brainId, input.thoughtIdA, "thoughtIdA");
    }
    if (relation === Relation.Parent) {
      await this.requireParent(brainId, input.thoughtIdB, "thoughtIdB");
    }
    return this.#post(brainId, input);
  }

  /**
   * The request itself, with none of the reading `create` does ahead of it.
   *
   * An answer of zeros is thrown here, as `zero_id`, for `create` and
   * `attachTag` alike: see `createdId`.
   */
  async #post(brainId: string, input: CreateLinkInput): Promise<string> {
    assertUuid(brainId, "brainId");
    assertUuid(input.thoughtIdA, "thoughtIdA");
    assertUuid(input.thoughtIdB, "thoughtIdB");
    const body: Record<string, unknown> = {
      thoughtIdA: input.thoughtIdA,
      thoughtIdB: input.thoughtIdB,
      relation: input.relation ?? Relation.Child,
    };
    if (input.name !== undefined) body["name"] = input.name;
    const path = `/api/links/${brainId}`;
    const created = await this.client.post<{ id: string }>(path, { json: body });
    return createdId(
      created,
      path,
      `no link was made between ${input.thoughtIdA} and ${input.thoughtIdB}: TheBrain answered ` +
        "200 with an identifier of zeros, which is its answer for a pair it does not link. " +
        "Nothing was written",
    );
  }

  /**
   * Takes flat fields and assembles the JSON Patch internally.
   *
   * A name or a colour is cleared with `remove`. `replace` with null is a 400
   * for a colour, and for a name a 200 that leaves the name where it was.
   *
   * A `relation` is refused, forced past the type too. Patched to 4 a link
   * answers 200 and stays as it was; to 2 it swaps its ends each time the
   * patch is sent; and to 1 or 2 with a type left above, it becomes the lower
   * thought's type, which `create` refuses.
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
    // Ahead of the request, so the fields beside it are not written either.
    if ((changes as { relation?: unknown }).relation !== undefined) {
      throw new TheBrainError(
        "bad_request",
        "update() does not change a link's relation: patched to 4 the link answers 200 and " +
          "stays as it was, and to 2 it swaps its ends every time the patch is sent. " +
          "create() between the same two thoughts rewrites the link that is there",
      );
    }
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
    // Not through `create`: what it would read again is known to be a tag.
    return this.#post(brainId, {
      thoughtIdA: thoughtId,
      thoughtIdB: tagThoughtId,
      relation: Relation.Parent,
    });
  }

  /**
   * Refuses a type named as a parent, with `not_a_parent`, and a tag, with
   * `tag_as_parent`: the upper end of a parent/child link, or the thought a
   * new one is created under. `field` is the caller's name for the
   * identifier.
   *
   * `create` here and `ThoughtsResource.create` both call it. A caller that
   * writes something else first calls it ahead of that. See `requireParent`
   * in `kind.ts` for what the API does with a type and with a tag there, and
   * for what is let through.
   */
  async requireParent(brainId: string, id: string, field: string): Promise<void> {
    return requireParent(this.client, brainId, id, field);
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
