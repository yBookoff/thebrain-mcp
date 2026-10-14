/**
 * Contract tests against a live TheBrain, none of which writes.
 *
 * Skipped when THEBRAIN_API_KEY is unset, so CI without the app never runs
 * them while locally they catch drift from the real API.
 *
 * The tests that read a brain read only the throwaway one the write tests
 * use, named by THEBRAIN_TEST_BRAIN_ID, and skip without it: a test does not
 * read the user's brains. With the key alone the rest still runs, and of the
 * brains it reads only their list.
 *
 *   THEBRAIN_API_KEY=... THEBRAIN_TEST_BRAIN_ID=<uuid> npx vitest run test/integration.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";

import { TheBrainClient, emptyOn400, isUuid } from "../src/api/client.js";
import { TheBrainError } from "../src/api/errors.js";

const apiKey = process.env["THEBRAIN_API_KEY"];
const testBrainId = process.env["THEBRAIN_TEST_BRAIN_ID"];
const suite = apiKey ? describe : describe.skip;
const inTestBrain = apiKey && testBrainId ? describe : describe.skip;

interface BrainDto {
  id: string;
  name: string | null;
  homeThoughtId: string;
}
interface AppState {
  currentBrainId: string | null;
  isLoggedIn: boolean;
}
interface ThoughtDto {
  id: string;
  name: string | null;
  kind: number;
}

suite("live API", () => {
  // A describe.skip body still executes, so the client is built lazily —
  // otherwise the file would throw in the constructor instead of skipping.
  let cached: TheBrainClient | undefined;
  const getClient = (): TheBrainClient =>
    (cached ??= new TheBrainClient({ apiKey: apiKey! }));

  it("returns the app state", async () => {
    const state = await getClient().get<AppState>("/api/app/state");
    expect(state.isLoggedIn).toBe(true);
  });

  it("returns the list of brains", async () => {
    const brains = await getClient().get<BrainDto[]>("/api/brains");
    expect(Array.isArray(brains)).toBe(true);
    expect(brains.length).toBeGreaterThan(0);
    expect(brains[0]).toHaveProperty("homeThoughtId");
  });

  it("a wrong key yields kind=auth", async () => {
    const bad = new TheBrainClient({ apiKey: "definitely-wrong" });
    await expect(bad.get("/api/brains")).rejects.toMatchObject({ kind: "auth" });
  });

  it("an unreachable port yields kind=network rather than a crash", async () => {
    const dead = new TheBrainClient({
      apiKey: apiKey!,
      baseUrl: "http://localhost:9",
      timeoutMs: 2000,
    });
    await expect(dead.get("/api/brains")).rejects.toMatchObject({ kind: "network" });
  });

  inTestBrain("in the test brain", () => {
    // Read only: the write tests may be at work in the same brain meanwhile,
    // and nothing here depends on what they make.
    let brainId = "";
    let home = "";

    beforeAll(async () => {
      if (!isUuid(testBrainId!)) {
        throw new Error(
          `THEBRAIN_TEST_BRAIN_ID must be a UUID, got ${JSON.stringify(testBrainId)}`,
        );
      }
      brainId = testBrainId!;
      home = (await getClient().get<BrainDto>(`/api/brains/${brainId}`)).homeThoughtId;
    });

    it("a malformed UUID is recognised as a router miss, not success", async () => {
      await expect(
        getClient().get(`/api/thoughts/${brainId}/definitely-not-a-uuid`),
      ).rejects.toMatchObject({ kind: "route_miss" });
    });

    it("a nonexistent thought errors rather than succeeding emptily", async () => {
      const missing = "11111111-2222-3333-4444-555555555555";
      await expect(
        getClient().get(`/api/thoughts/${brainId}/${missing}`),
      ).rejects.toBeInstanceOf(TheBrainError);
    });

    it("/types reads as a list of types, whether the brain has any or not", async () => {
      // One brain is in one of the two states at a time; the write tests take
      // this one through both (*a brain with no types, tags or pins…*).
      const types = await emptyOn400(
        getClient().get<ThoughtDto[]>(`/api/thoughts/${brainId}/types`),
      );
      expect(Array.isArray(types)).toBe(true);
      for (const t of types) expect(t.kind).toBe(2);
    });

    it("the home thought graph parses", async () => {
      const graph = await getClient().get<{
        activeThought: ThoughtDto;
        children: ThoughtDto[];
        tags: ThoughtDto[];
      }>(`/api/thoughts/${brainId}/${home}/graph`);
      expect(graph.activeThought.id).toBe(home);
      expect(Array.isArray(graph.children)).toBe(true);
    });

    it("a thought carries its aliases as a list, in the thought and throughout its graph", async (ctx) => {
      // Measured on 15.0.640: `[]` when there are none, never null and never
      // absent. Builds before 15.0.621 have no aliases, so nothing to check there.
      // `supportsAliases()` asks the home thought. Around a throwaway brain's
      // home there is often nothing; a graph with every list filled is checked
      // by the write tests (*every thought a graph lists…*).
      type WithAliases = ThoughtDto & { aliases?: unknown };
      const path = `/api/thoughts/${brainId}/${home}`;
      const thought = await getClient().get<WithAliases>(path);
      if (!("aliases" in thought)) return ctx.skip();
      expect(thought.aliases).toBeInstanceOf(Array);

      const graph = await getClient().get<{
        activeThought: WithAliases;
        parents: WithAliases[] | null;
        children: WithAliases[] | null;
        jumps: WithAliases[] | null;
        tags: WithAliases[] | null;
        type: WithAliases | null;
      }>(`${path}/graph`);
      const around = [
        graph.activeThought,
        ...(graph.parents ?? []),
        ...(graph.children ?? []),
        ...(graph.jumps ?? []),
        ...(graph.tags ?? []),
        ...(graph.type === null ? [] : [graph.type]),
      ];
      for (const t of around) expect(t.aliases, t.id).toBeInstanceOf(Array);
    });
  });
});
