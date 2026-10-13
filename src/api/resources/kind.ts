import { assertUuid, type TheBrainClient } from "../client.js";
import { TheBrainError } from "../errors.js";
import { shownName } from "../names.js";
import { type ThoughtDto, ThoughtKind } from "../types.js";

/** The kinds a write can ask for, and the words a refusal is put in. */
const REQUIRED = {
  [ThoughtKind.Type]: { field: "typeId", noun: "type", error: "not_a_type" },
  [ThoughtKind.Tag]: { field: "tagId", noun: "tag", error: "not_a_tag" },
} as const;

/**
 * The thought `id` names, when it is of the kind a write needs: a type for a
 * `typeId`, a tag for a tag. Throws `not_a_type` or `not_a_tag` when it names
 * a thought of another kind, or nothing.
 *
 * The API does not ask. It links the thought under whatever is named, with a
 * 200, and the kind of what is named decides what that link is. So the kind
 * is read here, ahead of the write.
 */
export async function requireKind(
  client: TheBrainClient,
  brainId: string,
  id: string,
  kind: keyof typeof REQUIRED,
): Promise<ThoughtDto> {
  const { field, noun, error: refusal } = REQUIRED[kind];
  const named = await read(client, brainId, id, field);
  if (named === null) {
    throw new TheBrainError(
      refusal,
      `${field} ${id} is not a ${noun}: no thought in this brain has that identifier`,
    );
  }
  if (named.kind === kind) return named;
  throw new TheBrainError(
    refusal,
    `${field} ${id} is not a ${noun}: it is the ` +
      `${kindName(named.kind)} "${shownName(named.name)}"`,
  );
}

/**
 * Refuses a type or a tag named as a parent: as the upper end of a
 * parent/child link, or as the thought a new one is created under. Throws
 * `not_a_parent` for a type and `tag_as_parent` for a tag.
 *
 * The API does not ask here either. A thought linked under a type is given
 * that type, with a 200, in place of the one it had, and a thought created
 * under a type has the type and no parent. A type is set through `typeId`,
 * which says so. So the kind of the upper end is read here, ahead of the
 * write. `field` is what the caller calls the identifier.
 *
 * Under a tag the thought is tagged, again with a 200. That takes nothing
 * from it, but it is no parent either: the thought created there has the tag
 * and no parent, and the link is the tag's attachment. `attachTag` is what
 * asks for one, and it does not come through here.
 *
 * An identifier nobody has is left to the write, which answers for it as it
 * did before this check. It is what null says, where a thought that may be a
 * parent comes back as it was read: a caller with more than this one write
 * ahead of it can refuse by that, as `ingest()` does its plan.
 */
export async function requireParent(
  client: TheBrainClient,
  brainId: string,
  id: string,
  field: string,
): Promise<ThoughtDto | null> {
  const named = await read(client, brainId, id, field);
  if (named?.kind === ThoughtKind.Type) {
    throw new TheBrainError(
      "not_a_parent",
      `${field} ${id} cannot be a parent: it is the type "${shownName(named.name)}"`,
    );
  }
  if (named?.kind === ThoughtKind.Tag) {
    throw new TheBrainError(
      "tag_as_parent",
      `${field} ${id} cannot be a parent: it is the tag "${shownName(named.name)}"`,
    );
  }
  return named;
}

/** The thought `id` names, or null when no thought in the brain has it. */
async function read(
  client: TheBrainClient,
  brainId: string,
  id: string,
  field: string,
): Promise<ThoughtDto | null> {
  assertUuid(id, field);
  assertUuid(brainId, "brainId");
  try {
    return await client.get<ThoughtDto>(`/api/thoughts/${brainId}/${id}`);
  } catch (error) {
    // No such thought: this read answers 404, where its graph would answer
    // 403. Only the 404 is taken for that. A 403 is the API's catch-all and
    // names no cause, and a brain that is not there is a 401: neither says
    // that the brain has no such thought.
    if (error instanceof TheBrainError && error.kind === "not_found") return null;
    throw error;
  }
}

function kindName(kind: number): string {
  if (kind === ThoughtKind.Type) return "type";
  return kind === ThoughtKind.Tag ? "tag" : "thought";
}
