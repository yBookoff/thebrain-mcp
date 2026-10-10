/**
 * Tests against real response shapes captured from a live TheBrain 15.
 * The fixture strings are copied from actual responses, not invented.
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BASE_URLS,
  TheBrainClient,
  assertUuid,
  emptyOn400,
  isUuid,
  mayHaveLanded,
  normalizeBaseUrl,
} from "../src/api/client.js";
import { TheBrainError } from "../src/api/errors.js";

const KEY = "test-key";
const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";

function clientReturning(
  body: string,
  init: { status?: number; contentType?: string } = {},
) {
  const fetchImpl = vi.fn(
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> =>
      new Response(body, {
        status: init.status ?? 200,
        headers: { "content-type": init.contentType ?? "application/json" },
      }),
  );
  const client = new TheBrainClient({
    apiKey: KEY,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

describe("UUID validation", () => {
  it("accepts a well-formed one", () => {
    expect(isUuid(BRAIN)).toBe(true);
  });

  it.each(["not-a-uuid", "", "aaaaaaaa", `${BRAIN}x`])("rejects %j", (bad) => {
    expect(isUuid(bad)).toBe(false);
  });

  it("throws before touching the network", async () => {
    const { fetchImpl } = clientReturning("{}");
    expect(() => assertUuid("types", "brainId")).toThrowError(TheBrainError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the offending field", () => {
    try {
      assertUuid("oops", "thoughtId");
      expect.unreachable();
    } catch (e) {
      const err = e as TheBrainError;
      expect(err.kind).toBe("invalid_uuid");
      expect(err.message).toContain("thoughtId");
    }
  });
});

describe("normalising the five error shapes", () => {
  it("400 as a bare JSON string (/types on an empty brain)", async () => {
    const { client } = clientReturning(
      JSON.stringify(`Could not retrieve list of Types for brain ${BRAIN}`),
      { status: 400 },
    );
    await expect(client.get("/api/thoughts/x/types")).rejects.toMatchObject({
      kind: "bad_request",
      message: `Could not retrieve list of Types for brain ${BRAIN}`,
    });
  });

  it("401 as plain text", async () => {
    const { client } = clientReturning("Invalid API Key", {
      status: 401,
      contentType: "text/plain",
    });
    await expect(client.get("/api/brains")).rejects.toMatchObject({
      kind: "auth",
      message: "Invalid API Key",
    });
  });

  it("401 with no authorization header", async () => {
    const { client } = clientReturning(
      "API Key was not provided. (Using the 'Authorization' header)",
      { status: 401, contentType: "text/plain" },
    );
    await expect(client.get("/api/brains")).rejects.toMatchObject({ kind: "auth" });
  });

  it("401 that names a brain is about the brain, not the key", async () => {
    // What every request answers for a brainId that is no brain. The key was accepted.
    const { client } = clientReturning(
      JSON.stringify(`Access to brain ${BRAIN} is unauthorized.`),
      { status: 401 },
    );
    await expect(client.get(`/api/thoughts/${BRAIN}/x`)).rejects.toMatchObject({
      kind: "unknown_brain",
      status: 401,
      message: `Access to brain ${BRAIN} is unauthorized.`,
    });
  });

  it("403 router text for the graph of a thought that does not exist", async () => {
    const { client } = clientReturning(
      "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
        "An API key is required via the Authorization header.",
      { status: 403, contentType: "text/plain" },
    );
    await expect(client.get("/api/thoughts/a/b/graph")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("404 in ProblemDetails form", async () => {
    const { client } = clientReturning(
      JSON.stringify({
        type: "https://tools.ietf.org/html/rfc9110#section-15.5.5",
        title: "Not Found",
        status: 404,
        traceId: "00-5df1-eb95-00",
      }),
      { status: 404 },
    );
    await expect(client.get("/api/thoughts/x")).rejects.toMatchObject({
      kind: "not_found",
      message: "Not Found",
    });
  });

  it("HTTP 200 with HTML is recognised as a router miss, not success", async () => {
    const { client } = clientReturning(
      '<!DOCTYPE html>\n<html lang="en"><head><title>TheBrain</title></head><body></body></html>',
      { status: 200, contentType: "text/html" },
    );
    await expect(client.get("/api/thoughts/x/not-a-uuid")).rejects.toMatchObject({
      kind: "route_miss",
    });
  });

  it("HTML is recognised even without a matching content-type", async () => {
    const { client } = clientReturning("  <!doctype html><html></html>", {
      status: 200,
      contentType: "application/json",
    });
    await expect(client.get("/api/x")).rejects.toMatchObject({ kind: "route_miss" });
  });

  it("5xx is marked as a server error", async () => {
    const { client } = clientReturning("boom", { status: 503, contentType: "text/plain" });
    await expect(client.get("/api/x")).rejects.toMatchObject({ kind: "server" });
  });
});

describe("parsing successful responses", () => {
  it("parses JSON declared as text/plain", async () => {
    const { client } = clientReturning(JSON.stringify({ id: BRAIN }), {
      contentType: "text/plain",
    });
    await expect(client.get<{ id: string }>("/api/brains/x")).resolves.toEqual({
      id: BRAIN,
    });
  });

  it("an empty body becomes undefined rather than an error", async () => {
    const { client } = clientReturning("", { status: 200 });
    await expect(client.post("/api/x")).resolves.toBeUndefined();
  });

  it("an unparseable body yields malformed", async () => {
    const { client } = clientReturning("{not json", { status: 200 });
    await expect(client.get("/api/x")).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("request construction", () => {
  it("sets Bearer and Accept: application/json", async () => {
    const { client, fetchImpl } = clientReturning("{}");
    await client.get("/api/brains");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(headers["Accept"]).toBe("application/json");
  });

  it("JSON Patch goes out with the right Content-Type", async () => {
    const { client, fetchImpl } = clientReturning("");
    await client.patch("/api/thoughts/a/b", {
      jsonPatch: [{ op: "replace", path: "/name", value: "new name" }],
    });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json-patch+json");
    expect(JSON.parse(init.body as string)).toEqual([
      { op: "replace", path: "/name", value: "new name" },
    ]);
  });

  it("undefined query values never reach the URL", async () => {
    const { client, fetchImpl } = clientReturning("[]");
    await client.get("/api/search/x", {
      query: { queryText: "thought", maxResults: 10, onlySearchThoughtNames: undefined },
    });
    const url = fetchImpl.mock.calls[0]![0] as URL;
    expect(url.searchParams.get("queryText")).toBe("thought");
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.has("onlySearchThoughtNames")).toBe(false);
  });

  it("an unreachable server gives a readable message, not ECONNREFUSED", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
    );
    const client = new TheBrainClient({
      apiKey: KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.get("/api/brains")).rejects.toMatchObject({ kind: "network" });
    await expect(client.get("/api/brains")).rejects.toThrowError(/is TheBrain running/);
  });
});

/**
 * What Node 22's fetch throws when nothing listens on the port, captured from
 * a real refusal: `localhost` resolves to both ::1 and 127.0.0.1, so the cause
 * is an AggregateError; a literal 127.0.0.1 gives a plain Error.
 */
const REFUSALS = {
  localhost: (): Error =>
    Object.assign(new AggregateError([new Error("::1"), new Error("127.0.0.1")]), {
      code: "ECONNREFUSED",
    }),
  "127.0.0.1": (): Error =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8001"), { code: "ECONNREFUSED" }),
};

/** A machine where TheBrain answers on some ports and nothing listens on the rest. */
function machine(
  listening: string[],
  options: { baseUrl?: string; refusal?: keyof typeof REFUSALS } = {},
) {
  const ports = new Set(listening);
  const fetchImpl = vi.fn(
    async (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      if (!ports.has((input as URL).port)) {
        throw new TypeError("fetch failed", {
          cause: REFUSALS[options.refusal ?? "localhost"](),
        });
      }
      return new Response("[]", { headers: { "content-type": "application/json" } });
    },
  );
  const client = new TheBrainClient({
    apiKey: KEY,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });
  const called = (): string[] => fetchImpl.mock.calls.map(([input]) => (input as URL).port);
  return { client, ports, called };
}

describe("finding TheBrain", () => {
  it("knows the current port and the one before the move", () => {
    expect(DEFAULT_BASE_URLS).toEqual(["http://localhost:11522", "http://localhost:8001"]);
  });

  it("asks the current port first", async () => {
    const { client, called } = machine(["11522", "8001"]);
    await client.get("/api/brains");
    expect(called()).toEqual(["11522"]);
  });

  it.each(["localhost", "127.0.0.1"] as const)(
    "falls back to the old port when the new one refuses (%s)",
    async (refusal) => {
      const { client, called } = machine(["8001"], { refusal });
      await expect(client.get("/api/brains")).resolves.toEqual([]);
      expect(called()).toEqual(["11522", "8001"]);
    },
  );

  it("stays on the port that answered", async () => {
    const { client, called } = machine(["8001"]);
    await client.get("/api/brains");
    await client.get("/api/brains");
    expect(called()).toEqual(["11522", "8001", "8001"]);
  });

  it("follows TheBrain when an update moves it mid-session", async () => {
    const { client, ports, called } = machine(["8001"]);
    await client.get("/api/brains");
    ports.delete("8001");
    ports.add("11522");
    await expect(client.get("/api/brains")).resolves.toEqual([]);
    expect(called().at(-1)).toBe("11522");
  });

  it("names every address it tried when nothing listens", async () => {
    const { client } = machine([]);
    await expect(client.get("/api/brains")).rejects.toMatchObject({
      kind: "network",
      message: expect.stringMatching(/localhost:11522 or http:\/\/localhost:8001.*is TheBrain running/),
    });
  });

  it("never second-guesses an explicit address", async () => {
    const { client, called } = machine(["11522", "8001"], { baseUrl: "http://localhost:9000" });
    const failure = await client.get("/api/brains").catch((e: unknown) => e as TheBrainError);
    expect(failure).toMatchObject({ kind: "network" });
    expect((failure as TheBrainError).message).not.toMatch(/11522|8001/);
    expect(called()).toEqual(["9000"]);
  });

  // The request may have reached TheBrain, and a repeated write is a duplicate.
  it.each([
    ["a timeout", (): Error => new DOMException("timed out", "TimeoutError")],
    [
      "a dropped connection",
      (): Error =>
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        }),
    ],
  ])("does not repeat a write after %s", async (_name, failure) => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        throw failure();
      },
    );
    const client = new TheBrainClient({
      apiKey: KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const create = client.post(`/api/thoughts/${BRAIN}`, { json: { name: "A" } });
    await expect(create).rejects.toMatchObject({ kind: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // And the caller can tell: the thought may be there with no identifier.
    expect(mayHaveLanded(await create.catch((e: unknown) => e))).toBe(true);
  });

  it("a request that went nowhere, or was answered, is not one that may have landed", async () => {
    const { client } = machine([]);
    const refused = await client
      .post(`/api/thoughts/${BRAIN}`, { json: { name: "A" } })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: "network" });
    expect(mayHaveLanded(refused)).toBe(false);

    const answered = await clientReturning('"Source Thought x could not be located"', { status: 404 })
      .client.post(`/api/thoughts/${BRAIN}`, { json: { name: "A" } })
      .catch((e: unknown) => e);
    expect(answered).toMatchObject({ kind: "not_found" });
    expect(mayHaveLanded(answered)).toBe(false);
    expect(mayHaveLanded(new Error("anything else"))).toBe(false);
  });

  it.each([
    ["http://localhost:11522/api/", "http://localhost:11522"],
    ["http://localhost:11522/api", "http://localhost:11522"],
    ["http://localhost:11522/", "http://localhost:11522"],
    ["  http://localhost:11522  ", "http://localhost:11522"],
    ["http://localhost:11522", "http://localhost:11522"],
  ])("takes the endpoint as Settings shows it: %j", (given, expected) => {
    expect(normalizeBaseUrl(given)).toBe(expected);
  });

  it("an address pasted with /api does not double the prefix", async () => {
    const { client, called } = machine(["11522"], { baseUrl: "http://localhost:11522/api/" });
    await client.get("/api/brains");
    expect(called()).toEqual(["11522"]);
  });
});

describe("emptyOn400", () => {
  it("turns a 400 from /types into an empty list", async () => {
    const { client } = clientReturning(JSON.stringify("Could not retrieve list of Types"), {
      status: 400,
    });
    await expect(emptyOn400(client.get<unknown[]>("/api/thoughts/x/types"))).resolves.toEqual(
      [],
    );
  });

  it("does not swallow other kinds of error", async () => {
    const { client } = clientReturning("Invalid API Key", {
      status: 401,
      contentType: "text/plain",
    });
    await expect(emptyOn400(client.get<unknown[]>("/api/thoughts/x/tags"))).rejects.toMatchObject(
      { kind: "auth" },
    );
  });

  it("a non-empty list passes straight through", async () => {
    const { client } = clientReturning(JSON.stringify([{ name: "Decision" }]));
    await expect(
      emptyOn400(client.get<{ name: string }[]>("/api/thoughts/x/types")),
    ).resolves.toEqual([{ name: "Decision" }]);
  });
});
