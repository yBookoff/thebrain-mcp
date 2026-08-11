/**
 * HTTP client for TheBrain's local API.
 *
 * It knows this API's quirks and hides them from everything above:
 *  - a malformed UUID in the path returns HTTP 200 with HTML, so UUIDs are
 *    validated before the request and the response content type is checked
 *    anyway;
 *  - error bodies arrive in five different shapes;
 *  - a successful response may be declared `text/plain` while holding JSON.
 */

import {
  TheBrainError,
  extractErrorMessage,
  kindForStatus,
  looksLikeHtml,
} from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Validates a UUID before the request goes out.
 *
 * Without this a malformed identifier reaches the server, misses the router
 * and comes back as an HTML page with status 200 — indistinguishable from
 * success to a naive caller.
 */
export function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) {
    throw new TheBrainError(
      "invalid_uuid",
      `${field} must be a UUID, got ${JSON.stringify(value)}`,
    );
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. Mutually exclusive with jsonPatch. */
  json?: unknown;
  /** JSON Patch body (Content-Type: application/json-patch+json). */
  jsonPatch?: readonly JsonPatchOp[];
  /** Skip parsing and return raw bytes (for attachment content). */
  raw?: boolean;
}

export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

export class TheBrainClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new TheBrainError("auth", "no API key provided");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "http://localhost:8001").replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>("GET", path, options);
  }

  async post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>("POST", path, options);
  }

  async patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>("PATCH", path, options);
  }

  async delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>("DELETE", path, options);
  }

  /** Raw bytes — used for attachment content. */
  async getBytes(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.#request<Uint8Array>("GET", path, { ...options, raw: true });
  }

  async #request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.jsonPatch !== undefined) {
      headers["Content-Type"] = "application/json-patch+json";
      body = JSON.stringify(options.jsonPatch);
    } else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      throw new TheBrainError(
        "network",
        timedOut
          ? `request exceeded ${this.#timeoutMs} ms`
          : `could not reach ${this.#baseUrl} — is TheBrain running?`,
        { method, path, cause },
      );
    }

    const contentType = response.headers.get("content-type");

    if (options.raw && response.ok) {
      const buf = new Uint8Array(await response.arrayBuffer());
      // A router miss returns HTML with status 200, so check here too.
      const head = new TextDecoder().decode(buf.subarray(0, 64));
      if (looksLikeHtml(head, contentType)) {
        throw new TheBrainError("route_miss", routeMissMessage(), {
          status: response.status,
          method,
          path,
        });
      }
      return buf as T;
    }

    const text = await response.text();

    // The critical check: 200 plus HTML means the path missed the API router.
    if (looksLikeHtml(text, contentType)) {
      throw new TheBrainError("route_miss", routeMissMessage(), {
        status: response.status,
        method,
        path,
        body: text.slice(0, 200),
      });
    }

    if (!response.ok) {
      throw new TheBrainError(
        kindForStatus(response.status),
        extractErrorMessage(text, contentType),
        { status: response.status, method, path, body: text.slice(0, 500) },
      );
    }

    if (text.trim() === "") return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new TheBrainError("malformed", "response did not parse as JSON", {
        status: response.status,
        method,
        path,
        body: text.slice(0, 200),
        cause,
      });
    }
  }
}

function routeMissMessage(): string {
  return (
    "the path missed the API router and returned the app's HTML page — " +
    "usually this means a malformed identifier in the path"
  );
}

/**
 * Wrapper for endpoints that answer 400 instead of returning an empty list.
 *
 * On a brain with no types or tags, /types and /tags return HTTP 400 with a
 * bare JSON string. That is an empty result, not an error.
 */
export async function emptyOn400<T>(promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof TheBrainError && error.kind === "bad_request") return [];
    throw error;
  }
}
