/**
 * How the contract tests sweep up what a run made: which thoughts, from when,
 * and in what order. Pure, so that `sweep.test.ts` can hold it to its rules
 * without a brain; `resources.integration.test.ts` does the deleting.
 */
import { logTime, replayThoughtIds, type ModificationLogDto } from "../src/api/index.js";
import { linkEndIds } from "../src/semantic/indexer.js";

/**
 * Where a run's sweep starts: the first whole millisecond after the newest
 * entry the brain logged before the run's first write, or `fallback` when it
 * logged nothing in the minute before.
 *
 * Not a minute before the run, as it was: a brain made in that minute had its
 * home thought's `101` in the window, and two sweeps deleted two home
 * thoughts (2026-10-14). With no thought left, a brain answers its
 * `statistics` with the catch-all 403, which no run gets past. Anything else
 * written in that minute went the same way. The time is a log's own, so no
 * clock but TheBrain's decides it.
 */
export function sweepFrom(newest: ModificationLogDto | undefined, fallback: string): string {
  if (newest === undefined) return fallback;
  // To the millisecond the API reads a bound in, and past the entry: never
  // the millisecond it is in, which would take it in again.
  return new Date(Date.parse(`${logTime(newest).slice(0, 23)}Z`) + 1).toISOString();
}

/**
 * The thoughts a sweep deletes, if they are still there: `also`, and those
 * the log has as created and not deleted, but never the brain's home thought.
 */
export function sweepTargets(
  logs: readonly ModificationLogDto[],
  also: Iterable<string>,
  home: string,
): string[] {
  return [...new Set([...also, ...replayThoughtIds(logs)])].filter((id) => id !== home);
}

/** The thoughts each thought has shared a link with, by the link entries of a log. */
export function linkedIn(logs: readonly ModificationLogDto[]): Map<string, Set<string>> {
  const near = new Map<string, Set<string>>();
  for (const l of logs) {
    const ends = linkEndIds(l);
    for (const a of ends) {
      for (const b of ends) if (a !== b) near.set(a, (near.get(a) ?? new Set()).add(b));
    }
  }
  return near;
}

/**
 * `ids` in rounds, in their order: each round takes every thought that
 * shares a link with none taken into it before. A parent and its children,
 * a type and its instances, a tag and what it is on take two rounds, the
 * first of them with every thought linked to nothing; a ring of three takes
 * three.
 */
export function roundsApart(
  ids: readonly string[],
  near: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const rounds: string[][] = [];
  let rest = [...ids];
  while (rest.length > 0) {
    const round = new Set<string>();
    const later: string[] = [];
    for (const id of rest) {
      if ([...(near.get(id) ?? [])].some((n) => round.has(n))) later.push(id);
      else round.add(id);
    }
    rounds.push([...round]);
    rest = later;
  }
  return rounds;
}
