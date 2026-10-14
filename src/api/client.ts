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
 * A UUID in lower case, the API's own spelling of it, and anything else as
 * it is.
 *
 * The API takes an identifier in capitals and answers in lower case, in
 * every answer looked at (docs/api-map.md, *Other identifiers that name no
 * thought*). One kept as it was sent is compared with those answers, and
 * keyed beside them, as another thought's: `brain_traverse` from a root in
 * capitals came back to it as to another thought, and `brain_index` took the
 * index of a brain named so for another brain's. A tool lowers each
 * identifier it is given once, where it takes it (`src/server/identifier.ts`),
 * and a plan its references (`ingest()`). What is no UUID stays as it was,
 * for `assertUuid()` to refuse in the caller's spelling.
 */
export function lowerUuid(value: string): string {
  return isUuid(value) ? value.toLowerCase() : value;
}

/**
 * The identifier of zeros. The API returns it, with a 200, for a link it did
 * not make (`createdId`). Sent to the API, it is taken for no identifier at
 * all wherever one can be done without (`assertUuid`).
 */
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Validates a UUID before the request goes out.
 *
 * Without this a malformed identifier reaches the server, misses the router
 * and comes back as an HTML page with status 200 — indistinguishable from
 * success to a naive caller.
 *
 * The identifier of zeros is refused here as well, though it is well formed.
 * It names nothing, and the API does not always say so (docs/api-map.md,
 * L29): a create sent it for a source or for a type answers 200 and makes the
 * thought with no link and no type, where any other identifier nobody has is
 * a 404 or a 400; a note written to it is a 200 and a note that never reads
 * back; and its history is a 200 with other thoughts' entries. Every
 * identifier of every request passes through here, so this is the one place:
 * a check in the tools would leave out a plan's references and the indexer's
 * reads. An identifier of zeros in an *answer* is `zero_id`, from `createdId`.
 */
export function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) {
    throw new TheBrainError(
      "invalid_uuid",
      `${field} must be a UUID, got ${JSON.stringify(value)}`,
    );
  }
  if (value === ZERO_UUID) {
    throw new TheBrainError(
      "invalid_uuid",
      `${field} is the all-zero UUID (${ZERO_UUID}), which names nothing. ` +
        "Leave an optional identifier out rather than send zeros",
    );
  }
}

/**
 * The identifier a create answered with. Throws `zero_id`, with `message`,
 * when it is the one of zeros.
 *
 * `POST /api/links` answers 200 with `00000000-…` for a link it does not
 * make, and writes nothing: a thought with itself, under any relation, and a
 * tag under a type. The zeros used to be handed on as the new link's
 * identifier. Both are refused ahead of the request now, which leaves this
 * for a pair nobody measured, and for a thought that changed kind since it
 * was read.
 *
 * `POST /api/thoughts` was not seen to do it, in 28 creates picked to make
 * it. It is checked all the same: its zeros would go on as the parent of the
 * next thought, and a `sourceThoughtId` of zeros is a 200 that links nothing.
 */
export function createdId(created: { id: string }, path: string, message: string): string {
  if (created.id !== ZERO_UUID) return created.id;
  throw new TheBrainError("zero_id", message, { status: 200, method: "POST", path });
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

/**
 * How long after this process's last write a copy is read and taken at its
 * word: a thought's graph, to look for a thought next to it, and a thought's
 * list of attachments. TheBrain answers both from a copy that is behind a
 * write, and nothing in the answer says how far. The graph's was within
 * 0.2 s as a rule and 364 ms at the worst measured, with the app slow to
 * answer (docs/api-map.md, L27); the list's 7–214 ms (L17).
 */
export const COPY_LAG_MS = 500;

/**
 * Waits out what is left of `COPY_LAG_MS` since `client` last had a write
 * come back. No request, and no time when that was longer ago. A write made
 * in the app or by another process is not known here.
 */
export async function afterCopyLag(
  client: Pick<TheBrainClient, "sinceLastWrite">,
): Promise<void> {
  const wait = COPY_LAG_MS - client.sinceLastWrite();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export class TheBrainClient {
  readonly #apiKey: string;
  /** Addresses to try, the one that last answered first. */
  #baseUrls: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  /** When the last request that was not a read came back, answered or not. */
  #lastWrite = Number.NEGATIVE_INFINITY;

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

  /**
   * Milliseconds since this client last had a write come back, to any brain:
   * a request that was not a `GET`, whether it was answered, refused or got
   * no answer. Infinity when it has sent none.
   *
   * It is for a read of a copy that has to follow a write: see
   * `afterCopyLag()`. Only this process's own writes are known here.
   */
  sinceLastWrite(): number {
    return Date.now() - this.#lastWrite;
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

    const response = await this.#send(method, path, options.query, headers, body).finally(() => {
      if (method !== "GET") this.#lastWrite = Date.now();
    });

    const contentType = response.headers.get("content-type");

    if (options.raw && response.ok) {
      const bytes = await this.#body(response, method, path, () => response.arrayBuffer());
      const buf = new Uint8Array(bytes);
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

    const text = await this.#body(response, method, path, () => response.text());

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
      const message = extractErrorMessage(text, contentType);
      throw new TheBrainError(kindForStatus(response.status, message), message, {
        status: response.status,
        method,
        path,
        body: text.slice(0, 500),
      });
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
   * The body of an answer whose status has come. Reading it is a failure of
   * its own: the connection can drop, or the time run out, after the status
   * line. That failure used to leave here as it was thrown, no
   * `TheBrainError`, and a create answered 200 whose body was lost read as
   * a create that failed. It is a `network` failure that keeps the status:
   * the write went out and its answer did not all come (`mayHaveLanded`).
   */
  async #body<B>(
    response: Response,
    method: string,
    path: string,
    read: () => Promise<B>,
  ): Promise<B> {
    try {
      return await read();
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      throw new TheBrainError(
        "network",
        `TheBrain answered ${response.status}, and ` +
          (timedOut
            ? `the rest of the answer did not come within ${this.#timeoutMs} ms`
            : "the connection failed before the rest of the answer came" + inFetchWords(cause)),
        { status: response.status, method, path, cause },
      );
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
    // Three facts, worded apart, on the line `mayHaveLanded` draws. Refused,
    // nothing listened at any address and nothing was sent. The other two
    // went out to the last address tried and got no answer: "could not reach
    // … — is TheBrain running?" used to be said of a connection that was
    // there and dropped, after which a write may have been carried out.
    throw new TheBrainError(
      "network",
      timedOut
        ? `request exceeded ${this.#timeoutMs} ms`
        : isConnectionRefused(failure)
          ? `could not reach ${tried.join(" or ")} — is TheBrain running?`
          : `the connection to ${tried.at(-1)} failed before an answer came` +
            inFetchWords(failure),
      { method, path, cause: failure },
    );
  }
}

/**
 * What `fetch` said of a failure, in brackets, or nothing when it said
 * nothing: its cause's message, where the fault is named (`read ECONNRESET`,
 * `other side closed`), or its own (`fetch failed`).
 */
function inFetchWords(failure: unknown): string {
  const cause =
    failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure;
  const said = cause instanceof Error ? cause.message.trim() : "";
  return said === "" ? "" : ` (${said})`;
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
 *
 * An answer whose body broke off after its status is one too: the status
 * may well be a 200.
 *
 * A read that got no answer is not one: carried out or not, it wrote
 * nothing. A write is preceded by reads, of a type, a tag or a parent, and
 * one of those timing out used to pass for a thought that may be there.
 */
export function mayHaveLanded(error: unknown): boolean {
  return (
    error instanceof TheBrainError &&
    error.kind === "network" &&
    error.method !== "GET" &&
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
 * What `/types`, `/tags` and `/pins` answer, with a 400, for a brain that has
 * none: a bare JSON string, the same every time (5 of 5 each, contract test;
 * docs/api-map.md, L1), with the brain's identifier at its end.
 */
const EMPTY_LIST =
  /^(Could not retrieve list of (Types|Tags)|Failed to get pins) for brain [0-9a-f-]{36}$/i;

/**
 * Wrapper for the three endpoints that answer 400 instead of returning an
 * empty list. That 400 is an empty result, not an error.
 *
 * Only the 400 in the words measured for an empty list is taken for one. Any
 * 400 used to be, and a request refused for a reason of its own then read as
 * a brain with no types: "A request that fails is not an empty answer".
 *
 * A known limit stays. The words are those of a failure, "Could not
 * retrieve…", and name no cause, so a list the API could not read for some
 * other reason would be told in the same sentence and taken for empty. No
 * such failure could be produced: a `brainId` that is no brain is a 401, a
 * rejected key the other 401, a malformed identifier the app's HTML page.
 * And should a later build word the empty list differently, a brain with no
 * types is an error here, in the API's words, until the pattern follows:
 * the contract test is what says so first.
 */
export async function emptyOn400<T>(promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise;
  } catch (error) {
    if (
      error instanceof TheBrainError &&
      error.kind === "bad_request" &&
      EMPTY_LIST.test(error.message)
    ) {
      return [];
    }
    throw error;
  }
}
