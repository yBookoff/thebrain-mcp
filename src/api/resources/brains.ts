import { assertUuid, type TheBrainClient } from "../client.js";
import { compareLogTime, logEntryKey } from "../log.js";
import type {
  AppStateDto,
  BrainDto,
  ModificationLogDto,
  StatisticsDto,
} from "../types.js";

/**
 * Entries per log request. Every brain measured so far fits in one page; it
 * takes a brain with a long history, where view settings alone can be most of
 * the log, to need a second.
 */
export const LOG_PAGE_SIZE = 10_000;

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
   * One request to the brain's modification log.
   *
   * The API keeps only the newest `maxLogs` entries in the range, with or
   * without `since`, and returns them newest first. Everything up to now lives
   * in `allModifications`; this is the single page underneath it.
   */
  async modifications(
    brainId: string,
    options: {
      maxLogs: number;
      since?: Date | string | undefined;
      until?: Date | string | undefined;
    },
  ): Promise<ModificationLogDto[]> {
    assertUuid(brainId, "brainId");
    const toIso = (v: Date | string | undefined): string | undefined =>
      v === undefined ? undefined : v instanceof Date ? v.toISOString() : v;
    return this.client.get<ModificationLogDto[]>(
      `/api/brains/${brainId}/modifications`,
      {
        query: {
          maxLogs: options.maxLogs,
          startTime: toIso(options.since),
          endTime: toIso(options.until),
        },
      },
    );
  }

  /**
   * The log from `since` (inclusive) to now, newest first, a page at a time.
   *
   * A single request cannot reach past the newest `maxLogs` entries, so this
   * pages back on `endTime`. Measured on a live TheBrain 15, each fact pinned
   * by a contract test:
   *
   * - `endTime` is inclusive to the microsecond, so the next page repeats the
   *   entries at the boundary. They are dropped by content.
   * - An offsetless `endTime` is read as UTC, the zone the log is written in,
   *   so the oldest entry's own timestamp goes back unchanged. Through `Date`
   *   it would lose its microseconds, and the boundary entry with them.
   * - Concurrent writes share timestamps. A full page of one timestamp cannot
   *   move the boundary, so the page grows until it can.
   *
   * Paging backwards is also safe against writes made meanwhile: they land
   * above the boundary.
   */
  async *modificationPages(
    brainId: string,
    options: { since?: Date | string | undefined; pageSize?: number } = {},
  ): AsyncGenerator<ModificationLogDto[]> {
    assertUuid(brainId, "brainId");
    let size = Math.max(1, Math.floor(options.pageSize ?? LOG_PAGE_SIZE));
    let until: string | undefined;
    // Entries stamped exactly `until` that were already yielded.
    let seen = new Set<string>();

    for (;;) {
      const page = await this.modifications(brainId, {
        maxLogs: size,
        since: options.since,
        until,
      });
      const fresh = page.filter((l) => {
        if (until === undefined) return true;
        const order = compareLogTime(l.creationDateTime, until);
        return order < 0 || (order === 0 && !seen.has(logEntryKey(l)));
      });
      if (fresh.length > 0) yield fresh;
      if (page.length < size) return;

      const oldest = page
        .map((l) => l.creationDateTime)
        .reduce((a, b) => (compareLogTime(b, a) < 0 ? b : a));
      if (until !== undefined && compareLogTime(oldest, until) === 0) {
        for (const l of fresh) seen.add(logEntryKey(l));
        size *= 2;
        continue;
      }
      until = oldest;
      seen = new Set(
        page.filter((l) => compareLogTime(l.creationDateTime, oldest) === 0).map(logEntryKey),
      );
    }
  }

  /** The whole log from `since` (inclusive) to now, newest first. */
  async allModifications(
    brainId: string,
    options: { since?: Date | string | undefined; pageSize?: number } = {},
  ): Promise<ModificationLogDto[]> {
    const all: ModificationLogDto[] = [];
    for await (const page of this.modificationPages(brainId, options)) all.push(...page);
    return all;
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
