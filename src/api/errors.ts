/**
 * Error normalisation for TheBrain's local API.
 *
 * The API returns at least five different error shapes, and one of them
 * arrives with HTTP 200. Everything above this layer sees a single error type.
 */

export type ApiErrorKind =
  /** 401 in the API's words for the key: missing or rejected. */
  | "auth"
  /**
   * 401 in its words for a brain: `"Access to brain <id> is unauthorized."` The
   * key was accepted, and no brain with that identifier is open to it. Every
   * request with a brain in its path answers so, whatever else it names.
   */
  | "unknown_brain"
  /**
   * 403 — the API's catch-all, in its router's words and with no cause named.
   * The graph of a thought nobody has gets it, and so does a patch the API
   * cannot apply. The read and the patch of such a thought are a 404.
   */
  | "forbidden"
  /**
   * 404 — nothing under that identifier. A create and an attachment name the
   * thought they did not find; a read and a patch answer a bare "Not Found".
   */
  | "not_found"
  /** 400 — bad request. */
  | "bad_request"
  /** 5xx. */
  | "server"
  /** HTTP 200 with HTML: the path missed the API router and fell through to the SPA. */
  | "route_miss"
  /** Local validation: argument is not a UUID. Never reaches the network. */
  | "invalid_uuid"
  /**
   * A `typeId` that names a thought of another kind, nothing, or the thought it
   * is for. The API has no such error: it answers 200, and makes a parent or a
   * tag of what it was given or does nothing at all. Raised ahead of the
   * write, so nothing was written.
   */
  | "not_a_type"
  /**
   * An identifier given for a tag that names a thought of another kind,
   * nothing, or the thought the tag is for. No such error in the API either:
   * the request that attaches a tag answers 200 to a type and to an ordinary
   * thought, and sets the type or adds a parent. Raised ahead of the write.
   */
  | "not_a_tag"
  /**
   * A type named as a parent: as the upper end of a parent/child link, or as
   * the thought a new one is created under. No such error in the API either:
   * it answers 200 and gives the thought below that type, in place of the one
   * it had. Raised ahead of the write.
   */
  | "not_a_parent"
  /**
   * A tag named as a parent, in the same two places. The API answers 200 here
   * too, and attaches the tag: the thought below is tagged and has no parent.
   * Raised ahead of the write. A kind of its own because the way on is
   * another: a tag is attached by the call that says so.
   */
  | "tag_as_parent"
  /**
   * A type set on a tag. The API answers 200 and sets nothing, no link
   * either. Raised ahead of the write.
   */
  | "type_on_tag"
  /**
   * A type set on a type that is the named type's own type. The API answers
   * 200 and sets nothing. Raised ahead of the write.
   */
  | "type_cycle"
  /**
   * A type set on a thought linked under two types. The API answers 200 and
   * one of the two stays, beside the new type or alone. Raised ahead of the
   * write. `typeId: null` takes both away, and a type is set after that.
   */
  | "two_types"
  /**
   * HTTP 200 with an identifier of zeros for what was to be created. It is the
   * API's answer for a link it does not make, and nothing is written then: a
   * thought with itself, a tag under a type.
   */
  | "zero_id"
  /**
   * The search endpoint's answer to a query for its size, which says nothing
   * of size: a 414 with no body once the request line passes 8,192 bytes, and
   * the catch-all 403 for 513 to 1,024 words. Made of those two by the search
   * resource; a shorter query to the same brain is answered (docs/api-map.md,
   * L30).
   */
  | "query_too_long"
  /**
   * A write the API accepted that a read of the thought did not show within
   * the wait (`READ_BACK`): this call's own, which was carried out, or an
   * earlier one of this process that a change now would build over, in which
   * case the change was not sent. Reads lag behind writes, by seconds after a
   * burst and with no bound under steady load.
   */
  | "not_read_back"
  /** Connection failed or dropped. */
  | "network"
  /** A response arrived but could not be parsed. */
  | "malformed";

export class TheBrainError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly body: string | undefined;

  constructor(
    kind: ApiErrorKind,
    message: string,
    details: {
      status?: number;
      method?: string;
      path?: string;
      body?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "TheBrainError";
    this.kind = kind;
    this.status = details.status;
    this.method = details.method;
    this.path = details.path;
    this.body = details.body;
  }

  /** One-line description for a tool result: the model must know what to do next. */
  toToolMessage(): string {
    const where = this.method && this.path ? ` (${this.method} ${this.path})` : "";
    return `${this.message}${where}`;
  }
}

const HTML_START = /^\s*(<!doctype html|<html\b)/i;

/** Does the body look like the desktop app's HTML page rather than an API response? */
export function looksLikeHtml(body: string, contentType: string | null): boolean {
  if (contentType && contentType.toLowerCase().includes("text/html")) return true;
  return HTML_START.test(body);
}

/**
 * Extracts a human-readable message from an error body, whatever shape it has:
 *
 *  - bare JSON string:  "Could not retrieve list of Types for brain ..."
 *  - plain text:        Invalid API Key
 *  - ProblemDetails:    {"title":"Not Found","status":404,...}
 *  - HTML:              <!DOCTYPE html>...
 */
export function extractErrorMessage(body: string, contentType: string | null): string {
  const trimmed = body.trim();
  if (trimmed === "") return "(empty response)";
  if (looksLikeHtml(trimmed, contentType)) {
    return "the request missed the API router and returned the app's HTML page";
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      const detail = typeof o["detail"] === "string" ? o["detail"] : undefined;
      const title = typeof o["title"] === "string" ? o["title"] : undefined;
      const msg = typeof o["message"] === "string" ? o["message"] : undefined;
      const picked = detail ?? msg ?? title;
      if (picked !== undefined) return picked;
    }
  } catch {
    // Not JSON, so it is plain text.
  }

  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** The 401 that is about the brain in the path, where the others are about the key. */
const NO_SUCH_BRAIN = /^Access to brain \S+ is unauthorized/;

/** `message` is what `extractErrorMessage` made of the body: one status, two meanings. */
export function kindForStatus(status: number, message = ""): ApiErrorKind {
  if (status === 401) return NO_SUCH_BRAIN.test(message) ? "unknown_brain" : "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "bad_request";
}
