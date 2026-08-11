/**
 * Building tool responses.
 *
 * Core rule: a bad argument or a missing resource is `isError` inside the
 * result, not a JSON-RPC error. The model sees the former and can fix its
 * call; the latter is a protocol failure it never gets to read.
 */

import { TheBrainError } from "../api/index.js";
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
 */
export function describeError(error: unknown): string {
  if (error instanceof EmbedderUnavailableError) return error.message;

  if (error instanceof TheBrainError) {
    switch (error.kind) {
      case "invalid_uuid":
        return `${error.message}. Take identifiers from brain_list, brain_search or brain_get_thought — do not invent them.`;
      case "auth":
        return "TheBrain rejected the key. Check THEBRAIN_API_KEY: find it under Settings > User > Local API Key.";
      case "network":
        return `${error.message} Check that the TheBrain desktop app is running and its local API is enabled.`;
      case "route_miss":
        return "The identifier was not found or is malformed — the API returned the app page instead of data.";
      case "not_found":
        return "Resource not found. It may have been deleted, or the identifier belongs to a different brain.";
      case "forbidden":
        return "Access denied. On the local API this usually means no object with that identifier exists in this brain.";
      default:
        return error.toToolMessage();
    }
  }

  if (error instanceof Error) return error.message;
  return String(error);
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
