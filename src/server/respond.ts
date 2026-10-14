/**
 * Building tool responses.
 *
 * Core rule: a bad argument or a missing resource is `isError` inside the
 * result, not a JSON-RPC error. The model sees the former and can fix its
 * call; the latter is a protocol failure it never gets to read.
 */

import { TheBrainError, mayHaveLanded, shownName } from "../api/index.js";
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
      case "type_on_tag":
        return (
          `${error.message}.${nothing} A type goes on an ordinary thought or on a type; ` +
          "to put this tag on a thought, pass both to brain_tag."
        );
      case "type_cycle":
        return (
          `${error.message}.${nothing} To make that type this thought's type, first take ` +
          "this thought away as its type, with typeId null in a brain_update_thought call " +
          "for that type."
        );
      case "two_types":
        return (
          `${error.message}.${nothing} To leave it one type, send typeId null first, which ` +
          "removes them all, then this typeId in a second brain_update_thought call."
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
        return `${sentence(error.message)} Check that the TheBrain desktop app is running and its local API is enabled.`;
      case "server":
        // Without a status it is a sentence of this server's own, whole as it is.
        if (error.status === undefined) return error.toToolMessage();
        // A 5xx was its body and the request, and neither says it is one.
        return (
          `TheBrain failed with a ${error.status}${requestOf(error)}: ` +
          `${sentence(error.message)} The fault is inside the app, not in the arguments of ` +
          "this call. A read is safe to repeat; before repeating a write, check what it left."
        );
      case "query_too_long":
        // The resource's own sentence: the API's answer has no words about size.
        return sentence(error.message);
      case "route_miss":
        // Never an identifier nobody has: that one gets an answer from the API.
        return (
          "An identifier in the request is malformed, or this TheBrain has no such " +
          "endpoint — the API returned the app page instead of data."
        );
      case "not_found":
        return `${whatWasNotFound(error)} ${GONE} ${TAKE_IDENTIFIERS}`;
      case "forbidden":
        // Not an identifier that names nothing, when it is a note's read:
        // the note of a thought nobody has is a 200 that says "no note". This
        // read gets the 403 for a moment after the note's attachment is
        // deleted, on a thought that is there (docs/api-map.md, L3).
        if (error.method === "GET" && NOTE_PATH.test(error.path ?? "")) {
          return (
            `TheBrain answered 403 and named no cause${requestOf(error)}. The read of a ` +
            "note gets that answer for a moment after the note is deleted, and it says " +
            "nothing of the thought or of its identifier."
          );
        }
        // A write: refused in these words, and now and then carried out with
        // them under concurrent writes (L45). The answer does not say which.
        if (mayHaveLanded(error)) {
          return (
            `TheBrain answered 403 and named no cause${requestOf(error)}. It answers a write ` +
            "so when it refuses it, as for an identifier that names nothing in this brain, and " +
            "now and then when it has carried it out."
          );
        }
        // Nor of an identifier, when the request carries none: the app's
        // state and the list of brains were told that one of the call's
        // names nothing in this brain.
        if (error.path !== undefined && !CARRIES_ID.test(error.path)) {
          return (
            `TheBrain answered 403 and named no cause${requestOf(error)}. The request ` +
            "carries no identifier, so none is at fault."
          );
        }
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
        // An end of a link that no thought has, and a thought to be tagged
        // that nobody has: a 400 where a create under such a thought is a
        // 404, in words that carry the identifier (L3). They are kept, and
        // the request is left out: its path names the brain alone, which is
        // not what was wrong. "source" is the link's first end and "target"
        // its second, as the tools' own arguments have them.
        if (LINK_END_MISSING.test(error.message.trim())) {
          return `${sentence(error.message)} ${GONE} ${TAKE_IDENTIFIERS}`;
        }
        // The other 400 of a link, which names nothing. It is the answer for
        // two thoughts joined by more than one link already, which two posts
        // sent at once leave: whatever is posted, either way, and for a tag
        // attached twice too. An end deleted a moment ago is the sentence
        // above, with its identifier (L43). It was passed on as it came, and
        // no tool could do anything about it.
        if (/^link could not be created\.?$/i.test(error.message.trim())) {
          return (
            `${sentence(error.message)} TheBrain named no cause${requestOf(error)}. It answers ` +
            "so when the two thoughts are joined by more than one link already, as two links " +
            "posted at once can leave them: nothing more can be posted between them, of any " +
            `kind or either way.${nothing} brain_unlink, given the same two thoughts, lists ` +
            "the links that join them and removes the one its linkId names; or one is removed " +
            "in TheBrain itself."
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

/**
 * Why a write that failed may have been carried out all the same, as the
 * opening of a sentence, for an error `mayHaveLanded()` holds of. `to` names
 * the write: "the create", "the deletion".
 */
export function landedWhy(error: unknown, to?: string): string {
  const of = to === undefined ? "" : ` to ${to}`;
  if (error instanceof TheBrainError && error.kind === "forbidden") {
    return `The 403 does not say whether ${to ?? "it"} was carried out`;
  }
  // A status with a `network` failure is an answer whose body broke off.
  if (error instanceof TheBrainError && error.status !== undefined) {
    return `The answer${of} broke off after its status`;
  }
  return `No answer came${of}`;
}

const GONE = "It may have been deleted, or be another brain's.";
/** Where an identifier that names nothing is to be taken from instead. */
export const TAKE_IDENTIFIERS = "Take identifiers from brain_search or brain_get_thought.";

/** The path of a thought or a link addressed by its own identifier: brain, then it. */
const ADDRESSED = /^\/api\/(thought|link)s\/[^/]+\/([0-9a-f-]{36})$/i;

/** A path with an identifier in it, of a brain if of nothing else. */
const CARRIES_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The path a note is read from: brain, then the thought it is the note of. */
const NOTE_PATH = /^\/api\/notes\/[^/]+\/[0-9a-f-]{36}$/i;

/** What `POST /api/links` answers for an end no thought of the brain has: the first it misses. */
const LINK_END_MISSING = /^could not get (source|target) thought [0-9a-f-]{36}\.?$/i;

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
export function sentence(message: string): string {
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

/**
 * Compact table: easier for a model to read than raw JSON, and fewer tokens.
 * No rows is null, which `section()` drops. It used to be the text "(empty)",
 * and `section()` dropped that text wherever it came from: a note, or the one
 * tag a thought had, of that name went missing from `brain_get_thought`.
 */
export function table(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string | null {
  if (rows.length === 0) return null;
  // A cell that holds something and shows nothing says what it holds: it
  // read as a cell with nothing in it, and at the end of a row a byte order
  // mark went with the padding. An empty cell is one the caller left empty.
  const shown = rows.map((r) => r.map((c) => (c === "" ? c : shownName(c))));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...shown.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "─".repeat(w))), ...shown.map(line)].join(
    "\n",
  );
}

/** One line to an item; no items is null, as no rows is for `table()`. */
export function bullet(items: readonly string[]): string | null {
  return items.length === 0 ? null : items.map((i) => `- ${i}`).join("\n");
}

/**
 * A titled section, or null for a body of null or "": nothing to show. What
 * a body says is never looked at: it may be the brain's own text, and a note
 * or a name can be "(empty)" or white space like anything else.
 */
export function section(title: string, body: string | null): string | null {
  if (body === null || body === "") return null;
  return `## ${title}\n${body}`;
}

export function join(parts: ReadonlyArray<string | null>): string {
  return parts.filter((p): p is string => p !== null).join("\n\n");
}

/**
 * A thought's name as a result prints it: `(unnamed)` for none, and the code
 * points of one with no character that shows. It is the API layer's, where a
 * refusal that quotes a name is worded, and is passed on here for the tools.
 */
export { shownName };

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

/**
 * A thought's label as a result prints it, or null where it prints none: for
 * a thought with no label, and for one whose label is its name, which says
 * nothing. TheBrain gives a type its name for a label when it becomes one
 * (docs/api-map.md, L38), so every type has one, and printed it would cost
 * every type in a result its name twice. A label with no character that
 * shows is spelled out, as a name is.
 *
 * Every thought the API returns carries its label, in a graph's lists and in
 * `/types` and `/tags` alike (contract tests), so no request is spent on it.
 */
export function labelOf(thought: {
  name: string | null;
  label?: string | null | undefined;
}): string | null {
  const { label } = thought;
  if (label === null || label === undefined || label === "" || label === thought.name) {
    return null;
  }
  return shownName(label);
}

/**
 * The label after a thought's identifier in a list, where it cannot be read
 * as part of the name: `, label "…"`, or nothing. Quoted as a link's label
 * is, unless it is spelled out.
 */
export function labelMark(thought: {
  name: string | null;
  label?: string | null | undefined;
}): string {
  const shown = labelOf(thought);
  if (shown === null) return "";
  return `, label ${shown === thought.label ? JSON.stringify(shown) : shown}`;
}

/**
 * What a result says under a type whose label is not its name. TheBrain
 * writes the name a thought has into its label when it becomes a type, and a
 * rename leaves it there: a renamed type reads with the name it had, and
 * TheBrain's search finds it by that name, as the semantic index does (L38).
 * A read cannot tell such a label from a caption someone wrote, so it is
 * said to be a name the type may have had.
 */
export const TYPE_LABEL =
  "A type's label may be a name it had, which TheBrain keeps there through a rename and " +
  "finds the type by. label null in brain_update_thought clears it.";

/**
 * The title for what a graph lists as `children`. Under a type those are the
 * thoughts of that type, and under a tag the thoughts the tag is on: a link
 * with a type or a tag above is the type's or the tag's, never a parent's
 * (docs/api-map.md, L23 and L24). "Children" there sends a model to add one,
 * which the write tools refuse (`not_a_parent`, `tag_as_parent`). Any other
 * thought keeps the title it had.
 */
export function childrenTitle(kind: number): string {
  if (kind === ThoughtKind.Type) return "Thoughts of this type";
  if (kind === ThoughtKind.Tag) return "Thoughts with this tag";
  return "Children";
}
