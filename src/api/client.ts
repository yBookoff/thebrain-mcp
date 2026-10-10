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

/**
 * Where TheBrain listens when no address is configured, newest first.
 *
 * An update moved the local API from port 8001 to 11522 (measured on
 * 15.0.640), and both builds are in use.
 */
export const DEFAULT_BASE_URLS: readonly string[] = [
  "http://localhost:11522",
  "http://localhost:8001",
];

/**
 * Settings shows the endpoint as `http://localhost:11522/api/`, while every
 * path here already starts with `/api` — so a pasted value loses that suffix.
 */
export function normalizeBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
}

export interface ClientOptions {
  apiKey: string;
  /** One fixed address. Omitted: `DEFAULT_BASE_URLS`, tried in order. */
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
  /** Addresses to try, the one that last answered first. */
  #baseUrls: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new TheBrainError("auth", "no API key provided");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrls =
      options.baseUrl !== undefined
        ? [normalizeBaseUrl(options.baseUrl)]
        : DEFAULT_BASE_URLS;
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

    const response = await this.#send(method, path, options.query, headers, body);

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

  /**
   * Sends to the first address that accepts the connection.
   *
   * Only a refused connection moves on to the next address: nothing listened,
   * so nothing was sent, and repeating even a write is safe. A timeout or a
   * dropped connection may have reached TheBrain and is never repeated.
   */
  async #send(
    method: string,
    path: string,
    query: RequestOptions["query"],
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<Response> {
    const tried: string[] = [];
    let failure: unknown;

    for (const baseUrl of this.#baseUrls) {
      const url = new URL(baseUrl + path);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      tried.push(baseUrl);
      try {
        const response = await this.#fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        // TheBrain can move mid-session — an update restarts it on the new
        // port — so the preference follows whichever address answered last.
        if (baseUrl !== this.#baseUrls[0]) {
          this.#baseUrls = [baseUrl, ...this.#baseUrls.filter((u) => u !== baseUrl)];
        }
        return response;
      } catch (cause) {
        failure = cause;
        if (!isConnectionRefused(cause)) break;
      }
    }

    const timedOut = failure instanceof Error && failure.name === "TimeoutError";
    throw new TheBrainError(
      "network",
      timedOut
        ? `request exceeded ${this.#timeoutMs} ms`
        : `could not reach ${tried.join(" or ")} — is TheBrain running?`,
      { method, path, cause: failure },
    );
  }
}

/**
 * Did nothing listen on the port? `fetch` reports that as a `TypeError` whose
 * cause carries the code: an `AggregateError` when `localhost` resolved to both
 * ::1 and 127.0.0.1, a plain `Error` for a single address.
 */
function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED";
}

/**
 * Whether a request that failed may have been carried out all the same: it
 * went out and no answer came, as on a timeout or a dropped connection. A
 * refused connection sent nothing, and an answer, whatever it says, is not
 * this.
 *
 * It matters for a create: the thought can be there with no identifier to
 * name it by. Measured by dropping the answer to a create on its way back:
 * the thought was there 3 times of 3.
 */
export function mayHaveLanded(error: unknown): boolean {
  return (
    error instanceof TheBrainError &&
    error.kind === "network" &&
    !isConnectionRefused(error.cause)
  );
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
