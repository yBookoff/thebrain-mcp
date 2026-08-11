/**
 * Contract tests against a live TheBrain.
 *
 * Skipped when THEBRAIN_API_KEY is unset, so CI without the app never runs
 * them while locally they catch drift from the real API.
 *
 *   THEBRAIN_API_KEY=... npx vitest run test/integration.test.ts
 */
import { describe, expect, it } from "vitest";

import { TheBrainClient, emptyOn400 } from "../src/api/client.js";
import { TheBrainError } from "../src/api/errors.js";

const apiKey = process.env["THEBRAIN_API_KEY"];
const suite = apiKey ? describe : describe.skip;

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

  it("a malformed UUID is recognised as a router miss, not success", async () => {
    const brains = await getClient().get<BrainDto[]>("/api/brains");
    const brainId = brains[0]!.id;
    await expect(
      getClient().get(`/api/thoughts/${brainId}/definitely-not-a-uuid`),
    ).rejects.toMatchObject({ kind: "route_miss" });
  });

  it("a nonexistent thought errors rather than succeeding emptily", async () => {
    const brains = await getClient().get<BrainDto[]>("/api/brains");
    const brainId = brains[0]!.id;
    const missing = "11111111-2222-3333-4444-555555555555";
    await expect(
      getClient().get(`/api/thoughts/${brainId}/${missing}`),
    ).rejects.toBeInstanceOf(TheBrainError);
  });

  it("a wrong key yields kind=auth", async () => {
    const bad = new TheBrainClient({ apiKey: "definitely-wrong" });
    await expect(bad.get("/api/brains")).rejects.toMatchObject({ kind: "auth" });
  });

  it("/types survives both an empty and a populated brain", async () => {
    const brains = await getClient().get<BrainDto[]>("/api/brains");
    for (const brain of brains) {
      const types = await emptyOn400(
        getClient().get<ThoughtDto[]>(`/api/thoughts/${brain.id}/types`),
      );
      expect(Array.isArray(types)).toBe(true);
      for (const t of types) expect(t.kind).toBe(2);
    }
  });

  it("the home thought graph parses", async () => {
    const brains = await getClient().get<BrainDto[]>("/api/brains");
    const brain = brains[0]!;
    const graph = await getClient().get<{
      activeThought: ThoughtDto;
      children: ThoughtDto[];
      tags: ThoughtDto[];
    }>(`/api/thoughts/${brain.id}/${brain.homeThoughtId}/graph`);
    expect(graph.activeThought.id).toBe(brain.homeThoughtId);
    expect(Array.isArray(graph.children)).toBe(true);
  });

  it("an unreachable port yields kind=network rather than a crash", async () => {
    const dead = new TheBrainClient({
      apiKey: apiKey!,
      baseUrl: "http://localhost:9",
      timeoutMs: 2000,
    });
    await expect(dead.get("/api/brains")).rejects.toMatchObject({ kind: "network" });
  });
});
