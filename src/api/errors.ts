/**
 * Error normalisation for TheBrain's local API.
 *
 * The API returns at least five different error shapes, and one of them
 * arrives with HTTP 200. Everything above this layer sees a single error type.
 */

export type ApiErrorKind =
  /** 401 — key missing or rejected. */
  | "auth"
  /** 403 — forbidden. TheBrain also returns this for a thought that does not exist. */
  | "forbidden"
  /** 404 — resource not found. */
  | "not_found"
  /** 400 — bad request. */
  | "bad_request"
  /** 5xx. */
  | "server"
  /** HTTP 200 with HTML: the path missed the API router and fell through to the SPA. */
  | "route_miss"
  /** Local validation: argument is not a UUID. Never reaches the network. */
  | "invalid_uuid"
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

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "bad_request";
}
