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
import { Relation } from "../src/api/types.js";
import { RecentWrites, WRITTEN_KEPT_MS, type ShownGraph } from "../src/api/written.js";

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
    // Not so a read: with no answer or with one, it wrote nothing. A create
    // reads its parent and its type first, and one of those reads timing out
    // used to be told as a thought that may have been made.
    const read = await client.get(`/api/thoughts/${BRAIN}/${BRAIN}`).catch((e: unknown) => e);
    expect(read).toMatchObject({ kind: "network" });
    expect(mayHaveLanded(read)).toBe(false);
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

describe("how long ago the client last wrote", () => {
  it("is never, until it has sent something that is not a read", async () => {
    const { client } = clientReturning("{}");
    expect(client.sinceLastWrite()).toBe(Number.POSITIVE_INFINITY);
    await client.get("/api/brains");
    await client.getBytes("/api/attachments/x/y/file-content");
    expect(client.sinceLastWrite()).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts from the moment a write came back, by any method, and a read after it changes nothing", async () => {
    vi.useFakeTimers();
    try {
      for (const method of ["post", "patch", "delete"] as const) {
        const { client } = clientReturning("{}");
        await client[method]("/api/thoughts/x");
        expect(client.sinceLastWrite(), method).toBe(0);
        await vi.advanceTimersByTimeAsync(120);
        await client.get("/api/brains");
        expect(client.sinceLastWrite(), method).toBe(120);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a write that was refused, or got no answer, is a write that came back all the same", async () => {
    // Refused, it wrote nothing, but nothing here knows what the next
    // refusal means; unanswered, it may have been carried out.
    vi.useFakeTimers();
    try {
      const refused = clientReturning(JSON.stringify("Could not create thought."), { status: 400 });
      await expect(refused.client.post("/api/thoughts/x")).rejects.toMatchObject({
        kind: "bad_request",
      });
      expect(refused.client.sinceLastWrite()).toBe(0);

      const deaf = new TheBrainClient({
        apiKey: KEY,
        fetchImpl: (async () => {
          throw new DOMException("timed out", "TimeoutError");
        }) as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(50);
      await expect(deaf.post("/api/thoughts/x")).rejects.toMatchObject({ kind: "network" });
      expect(deaf.sinceLastWrite()).toBe(0);
      await expect(deaf.get("/api/brains")).rejects.toMatchObject({ kind: "network" });
      await vi.advanceTimersByTimeAsync(40);
      expect(deaf.sinceLastWrite()).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what a process wrote a moment ago, set against a graph", () => {
  const OTHER_BRAIN = "aaaaaaaa-0000-4000-8000-00000000000f";
  const ROOT = "bbbbbbbb-0000-4000-8000-000000000002";
  const NEW = "cccccccc-0000-4000-8000-000000000003";
  const ELSE = "dddddddd-0000-4000-8000-000000000004";
  /** The graph of `of`, listing the given thoughts as `id: name`. */
  type Graph = ShownGraph & { of: string };
  const graph = (
    of: string,
    lists: Partial<Record<"children" | "parents" | "jumps", Record<string, string>>> = {},
  ): Graph => {
    const listed = (there: Record<string, string> = {}) =>
      Object.entries(there).map(([thoughtId, name]) => ({ id: thoughtId, name }));
    return {
      of,
      children: listed(lists.children),
      parents: listed(lists.parents),
      jumps: listed(lists.jumps),
    };
  };
  const lacking = (written: RecentWrites, read: Graph, brainId = BRAIN) =>
    written
      .notShownBy(brainId, read.of, read)
      .map((f) =>
        f.of === "listed" ? `${f.thoughtId} in ${f.list}` : `${f.thoughtId} as ${f.name}`,
      );

  it("a client that wrote nothing holds no graph to anything", () => {
    const { client } = clientReturning("{}");
    expect(client.written.notShownBy(BRAIN, ROOT, graph(ROOT))).toEqual([]);
  });

  it("a thought made next to another is in the list its relation puts it in, on both sides", () => {
    for (const [relation, there, back] of [
      [Relation.Child, "children", "parents"],
      [Relation.Parent, "parents", "children"],
      [Relation.Jump, "jumps", "jumps"],
    ] as const) {
      const written = new RecentWrites();
      written.linked(BRAIN, ROOT, NEW, relation);

      // A copy from before the write lacks it, and one that lists it under
      // another relation is from before the write too.
      expect(lacking(written, graph(ROOT)), there).toEqual([`${NEW} in ${there}`]);
      const elsewhere = there === "jumps" ? "children" : "jumps";
      expect(lacking(written, graph(ROOT, { [elsewhere]: { [NEW]: "n" } })), there).toEqual([
        `${NEW} in ${there}`,
      ]);
      expect(lacking(written, graph(ROOT, { [there]: { [NEW]: "n" } })), there).toEqual([]);
      // The source is in the new thought's graph, seen from that end.
      expect(lacking(written, graph(NEW)), back).toEqual([`${ROOT} in ${back}`]);
      expect(lacking(written, graph(NEW, { [back]: { [ROOT]: "r" } })), back).toEqual([]);
      // No other graph is held to it, and none of another brain.
      expect(lacking(written, graph(ELSE))).toEqual([]);
      expect(lacking(written, graph(ROOT), OTHER_BRAIN)).toEqual([]);
    }
  });

  it("an identifier is the same in capitals, as it is to the API", () => {
    const written = new RecentWrites();
    written.linked(BRAIN, ROOT.toUpperCase(), NEW, Relation.Child);
    expect(lacking(written, graph(ROOT))).toEqual([`${NEW} in children`]);
    expect(
      lacking(written, graph(ROOT, { children: { [NEW.toUpperCase()]: "n" } }), BRAIN.toUpperCase()),
    ).toEqual([]);
  });

  it("two thoughts share one link: a later link between the pair takes the place of what was known", () => {
    const written = new RecentWrites();
    written.linked(BRAIN, ROOT, NEW, Relation.Child);
    // Posted from the other end, as a jump: the child link is that jump now.
    written.linked(BRAIN, NEW, ROOT, Relation.Jump);

    expect(lacking(written, graph(ROOT, { children: { [NEW]: "n" } }))).toEqual([`${NEW} in jumps`]);
    expect(lacking(written, graph(ROOT, { jumps: { [NEW]: "n" } }))).toEqual([]);
    expect(lacking(written, graph(NEW, { jumps: { [ROOT]: "r" } }))).toEqual([]);
  });

  it("a renamed thought is listed under its new name, wherever a graph lists it", () => {
    const written = new RecentWrites();
    written.named(BRAIN, NEW, "After");

    for (const list of ["children", "parents", "jumps"] as const) {
      expect(lacking(written, graph(ROOT, { [list]: { [NEW]: "Before" } })), list).toEqual([
        `${NEW} as After`,
      ]);
      expect(lacking(written, graph(ROOT, { [list]: { [NEW]: "After" } })), list).toEqual([]);
    }
    // A graph that does not list it has nothing to be behind in,
    expect(lacking(written, graph(ROOT, { children: { [ELSE]: "Before" } }))).toEqual([]);
    // and the last name given is the one that counts.
    written.named(BRAIN, NEW, "Later");
    expect(lacking(written, graph(ROOT, { children: { [NEW]: "After" } }))).toEqual([
      `${NEW} as Later`,
    ]);
  });

  it("nothing is asked of a graph about a thought that was forgotten, as either end", () => {
    const written = new RecentWrites();
    written.linked(BRAIN, ROOT, NEW, Relation.Child);
    written.linked(BRAIN, ROOT, ELSE, Relation.Child);
    written.named(BRAIN, NEW, "After");
    written.forget(BRAIN, NEW.toUpperCase());

    expect(lacking(written, graph(ROOT, { jumps: { [NEW]: "Before" } }))).toEqual([
      `${ELSE} in children`,
    ]);
    expect(lacking(written, graph(NEW))).toEqual([]);
    // In another brain it is another thought.
    written.forget(OTHER_BRAIN, ELSE);
    expect(lacking(written, graph(ROOT))).toEqual([`${ELSE} in children`]);
  });

  it("a link deleted by its identifier leaves no thought of that brain known to be next to another", () => {
    const written = new RecentWrites();
    written.linked(BRAIN, ROOT, NEW, Relation.Child);
    written.linked(OTHER_BRAIN, ROOT, NEW, Relation.Child);
    written.named(BRAIN, NEW, "After");
    written.unlinked(BRAIN);

    expect(lacking(written, graph(ROOT))).toEqual([]);
    // A name is no link, and the other brain's links are its own.
    expect(lacking(written, graph(ROOT, { children: { [NEW]: "Before" } }))).toEqual([
      `${NEW} as After`,
    ]);
    expect(lacking(written, graph(ROOT), OTHER_BRAIN)).toEqual([`${NEW} in children`]);
  });

  it("a write is kept for ten seconds and no longer", () => {
    vi.useFakeTimers();
    try {
      const written = new RecentWrites();
      written.linked(BRAIN, ROOT, NEW, Relation.Child);
      written.named(BRAIN, ELSE, "After");
      const behind = graph(ROOT, { jumps: { [ELSE]: "Before" } });

      vi.advanceTimersByTime(WRITTEN_KEPT_MS);
      expect(WRITTEN_KEPT_MS).toBe(10_000);
      expect(lacking(written, behind)).toEqual([`${NEW} in children`, `${ELSE} as After`]);
      vi.advanceTimersByTime(1);
      expect(lacking(written, behind)).toEqual([]);
      // Each from its own write: a later one outlives an earlier.
      written.linked(BRAIN, ROOT, NEW, Relation.Child);
      vi.advanceTimersByTime(6000);
      written.named(BRAIN, ELSE, "After");
      vi.advanceTimersByTime(6000);
      expect(lacking(written, behind)).toEqual([`${ELSE} as After`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("what is past its time goes as the next write is kept: a process that never looks at a graph keeps ten seconds of writes", () => {
    vi.useFakeTimers();
    try {
      const written = new RecentWrites();
      const id = (n: number): string => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
      // A create a second for a minute, and no graph read in all that time.
      for (let n = 0; n < 60; n += 1) {
        written.linked(BRAIN, ROOT, id(n), Relation.Child);
        written.named(BRAIN, id(n), "After");
        vi.advanceTimersByTime(1000);
      }
      // Two for a link, one for a name, of the eleven writes ten seconds hold.
      expect(written.size).toBeLessThanOrEqual(11 * 3);
      expect(written.size).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
