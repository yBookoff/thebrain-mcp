import { assertUuid, type TheBrainClient } from "../client.js";
import { TheBrainError } from "../errors.js";
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
  assertUuid(id, field);
  assertUuid(brainId, "brainId");
  let named: ThoughtDto;
  try {
    named = await client.get<ThoughtDto>(`/api/thoughts/${brainId}/${id}`);
  } catch (error) {
    // No such thought. This read answers 404; its graph would answer 403.
    if (
      error instanceof TheBrainError &&
      (error.kind === "forbidden" || error.kind === "not_found")
    ) {
      throw new TheBrainError(
        refusal,
        `${field} ${id} is not a ${noun}: no thought in this brain has that identifier`,
      );
    }
    throw error;
  }
  if (named.kind === kind) return named;
  throw new TheBrainError(
    refusal,
    `${field} ${id} is not a ${noun}: it is the ` +
      `${kindName(named.kind)} "${named.name ?? "(unnamed)"}"`,
  );
}

function kindName(kind: number): string {
  if (kind === ThoughtKind.Type) return "type";
  return kind === ThoughtKind.Tag ? "tag" : "thought";
}
