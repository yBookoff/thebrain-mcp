/**
 * Tests against real response shapes captured from a live TheBrain 15.
 * The fixture strings are copied from actual responses, not invented.
 */
import { describe, expect, it, vi } from "vitest";

import {
  TheBrainClient,
  assertUuid,
  emptyOn400,
  isUuid,
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

  it("403 router text for a thought that does not exist", async () => {
    const { client } = clientReturning(
      "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
        "An API key is required via the Authorization header.",
      { status: 403, contentType: "text/plain" },
    );
    await expect(client.get("/api/thoughts/a/b")).rejects.toMatchObject({
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
