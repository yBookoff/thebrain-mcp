import { assertUuid, type TheBrainClient } from "../client.js";
import type {
  AppStateDto,
  BrainDto,
  ModificationLogDto,
  StatisticsDto,
} from "../types.js";

export class BrainsResource {
  constructor(private readonly client: TheBrainClient) {}

  async list(): Promise<BrainDto[]> {
    return this.client.get<BrainDto[]>("/api/brains");
  }

  async get(brainId: string): Promise<BrainDto> {
    assertUuid(brainId, "brainId");
    return this.client.get<BrainDto>(`/api/brains/${brainId}`);
  }

  async statistics(brainId: string): Promise<StatisticsDto> {
    assertUuid(brainId, "brainId");
    return this.client.get<StatisticsDto>(`/api/brains/${brainId}/statistics`);
  }

  /**
   * The brain's modification log.
   *
   * Without `since`/`until` it returns the entire history, which is what makes
   * enumerating a brain and building the semantic index possible.
   *
   * `maxLogs` is required by the API, hence the default.
   */
  async modifications(
    brainId: string,
    options: { maxLogs?: number; since?: Date | string; until?: Date | string } = {},
  ): Promise<ModificationLogDto[]> {
    assertUuid(brainId, "brainId");
    const toIso = (v: Date | string | undefined): string | undefined =>
      v === undefined ? undefined : v instanceof Date ? v.toISOString() : v;
    return this.client.get<ModificationLogDto[]>(
      `/api/brains/${brainId}/modifications`,
      {
        query: {
          maxLogs: options.maxLogs ?? 10_000,
          startTime: toIso(options.since),
          endTime: toIso(options.until),
        },
      },
    );
  }
}

/** Desktop app state. Unique to the local API; the cloud API has no equivalent. */
export class AppResource {
  constructor(private readonly client: TheBrainClient) {}

  async state(): Promise<AppStateDto> {
    return this.client.get<AppStateDto>("/api/app/state");
  }

  async openBrain(brainId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    await this.client.post(`/api/app/brain/${brainId}/open`);
  }

  async closeBrain(brainId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    await this.client.post(`/api/app/brain/${brainId}/close`);
  }

  /** Brings a thought into focus in the desktop app. */
  async activateThought(brainId: string, thoughtId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    await this.client.post(
      `/api/app/brain/${brainId}/thought/${thoughtId}/activate`,
    );
  }
}
