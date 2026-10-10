/**
 * Building tool responses.
 *
 * Core rule: a bad argument or a missing resource is `isError` inside the
 * result, not a JSON-RPC error. The model sees the former and can fix its
 * call; the latter is a protocol failure it never gets to read.
 */

import { TheBrainError } from "../api/index.js";
import { ThoughtKind } from "../api/types.js";
import { EmbedderUnavailableError } from "../semantic/embedder.js";

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): ToolResponse {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Turns an exception into text the model can act on.
 *
 * The wording points at the next step rather than just stating the failure:
 * "no such thought" is useless, "check the identifier" is not.
 *
 * And at the right identifier. The API's status does not say which: a
 * `brainId` that is no brain is a 401 like a rejected key's, and an identifier
 * nobody has is a 404 or a 403 by the request (docs/api-map.md, L3). A
 * message for one never names the other, and the API's own words are kept
 * wherever they carry the identifier.
 *
 * `alone` is false for a step that failed after the call had written
 * something. A refusal ahead of a write says that nothing was written: true
 * of the step, and it would be read of the call.
 */
export function describeError(error: unknown, alone = true): string {
  if (error instanceof EmbedderUnavailableError) return error.message;

  if (error instanceof TheBrainError) {
    const nothing = alone ? " Nothing was written." : "";
    switch (error.kind) {
      case "invalid_uuid":
        return `${error.message}. Take identifiers from brain_list, brain_search or brain_get_thought — do not invent them.`;
      case "not_a_type":
        return `${error.message}.${nothing} Take type identifiers from brain_list_types_and_tags.`;
      case "not_a_tag":
        return `${error.message}.${nothing} Take tag identifiers from brain_list_types_and_tags.`;
      case "not_a_parent":
        return (
          `${error.message}.${nothing} A thought linked under a type is given ` +
          "that type in place of the one it had. To set a type pass it as typeId to " +
          "brain_update_thought or brain_create_thought; for a parent name an ordinary thought."
        );
      case "tag_as_parent":
        return (
          `${error.message}.${nothing} A thought linked under a tag is tagged ` +
          "with it, and gets no parent. To attach a tag pass it to brain_tag, or as tagIds to " +
          "brain_create_thought or brain_ingest; for a parent name an ordinary thought."
        );
      case "auth":
        return "TheBrain rejected the key. Check THEBRAIN_API_KEY: find it under Settings > User > Local API Key.";
      case "unknown_brain":
        // A 401 like a rejected key's, and not about the key.
        return (
          `${sentence(error.message)} The key was accepted: it is brainId that names no ` +
          "brain open to it. Take brainId from brain_list. The other identifiers in the " +
          "call were not looked at."
        );
      case "network":
        return `${error.message} Check that the TheBrain desktop app is running and its local API is enabled.`;
      case "route_miss":
        // Never an identifier nobody has: that one gets an answer from the API.
        return (
          "An identifier in the request is malformed, or this TheBrain has no such " +
          "endpoint — the API returned the app page instead of data."
        );
      case "not_found":
        return `${whatWasNotFound(error)} ${GONE} ${TAKE_IDENTIFIERS}`;
      case "forbidden":
        // The API's catch-all. It says nothing of access, and neither does this.
        return (
          `TheBrain answered 403 and named no cause${requestOf(error)}. That is its answer ` +
          `when an identifier in the call names nothing in this brain. ${GONE} ${TAKE_IDENTIFIERS}`
        );
      case "bad_request":
        // The one 400 that names nothing. A create answers it for a parent
        // deleted a moment ago and for a typeId nobody has (L3, L26), and
        // makes no thought.
        if (/^could not create thought\.?$/i.test(error.message.trim())) {
          return (
            `${sentence(error.message)} TheBrain named no cause${requestOf(error)}. It answers ` +
            "so when the parent named for the new thought was deleted a moment ago, or the " +
            "type named for it is no thought of this brain. Nothing was created. Read the " +
            "parent and the type with brain_get_thought before sending the call again."
          );
        }
        return error.toToolMessage();
      default:
        return error.toToolMessage();
    }
  }

  if (error instanceof Error) return error.message;
  return String(error);
}

const GONE = "It may have been deleted, or be another brain's.";
const TAKE_IDENTIFIERS = "Take identifiers from brain_search or brain_get_thought.";

/** The path of a thought or a link addressed by its own identifier: brain, then it. */
const ADDRESSED = /^\/api\/(thought|link)s\/[^/]+\/([0-9a-f-]{36})$/i;

/**
 * The first sentence for a 404. The API's own text is kept when it has one:
 * a create names the source thought it did not find, an attachment its
 * thought. The read and the patch of a thought or a link answer a bare "Not
 * Found", and what they did not find is the identifier their path ends with.
 * Any other path is quoted and not interpreted.
 */
function whatWasNotFound(error: TheBrainError): string {
  if (!/^not found\.?$/i.test(error.message.trim())) return sentence(error.message);
  const [, noun, id] = ADDRESSED.exec(error.path ?? "") ?? [];
  return noun === undefined
    ? `Not found${requestOf(error)}.`
    : `No ${noun} in this brain has the identifier ${id}${requestOf(error)}.`;
}

function requestOf(error: TheBrainError): string {
  return error.method && error.path ? ` (${error.method} ${error.path})` : "";
}

/** The API ends some of its messages with a period and some without. */
function sentence(message: string): string {
  const text = message.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Wraps a handler so any exception becomes `isError`. */
export function guard<A>(
  handler: (args: A) => Promise<ToolResponse>,
): (args: A) => Promise<ToolResponse> {
  return async (args: A): Promise<ToolResponse> => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(describeError(error));
    }
  };
}

// ---------------------------------------------------------------- formatting

/** Compact table: easier for a model to read than raw JSON, and fewer tokens. */
export function table(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  if (rows.length === 0) return "(empty)";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "─".repeat(w))), ...rows.map(line)].join(
    "\n",
  );
}

export function bullet(items: readonly string[]): string {
  return items.length === 0 ? "(empty)" : items.map((i) => `- ${i}`).join("\n");
}

/** A titled section; empty sections are dropped. */
export function section(title: string, body: string | null): string | null {
  if (body === null || body.trim() === "" || body === "(empty)") return null;
  return `## ${title}\n${body}`;
}

export function join(parts: ReadonlyArray<string | null>): string {
  return parts.filter((p): p is string => p !== null).join("\n\n");
}

/**
 * What a thought is when it is not an ordinary one: `type`, `tag`, or the
 * API's own number for a kind that has no name here. Null for an ordinary
 * thought: only the exception is spelled out, so the common row costs nothing.
 *
 * The write tools refuse an identifier of the wrong kind, and a read result is
 * where the model picks identifiers from. A thought read with no kind at all
 * is taken for an ordinary one.
 */
export function kindLabel(kind: number): string | null {
  if (kind === ThoughtKind.Type) return "type";
  if (kind === ThoughtKind.Tag) return "tag";
  return kind === ThoughtKind.Normal || !Number.isInteger(kind) ? null : `kind ${kind}`;
}

/**
 * The label as a mark: ` [type]`, ` [tag]`, or nothing for an ordinary
 * thought. It goes after the identifier wherever a line has one, where it
 * cannot be read as part of the name.
 */
export function kindMark(kind: number): string {
  const label = kindLabel(kind);
  return label === null ? "" : ` [${label}]`;
}
