/**
 * Modification-log timestamps and entry identity.
 *
 * Measured on a live TheBrain 15: `creationDateTime` is UTC with no offset and
 * up to microsecond precision, trailing zeros trimmed —
 * `2026-09-30T13:48:59.61898`. `Date` keeps milliseconds only, so parsing one
 * merges entries that are microseconds apart. Order and page boundaries
 * therefore work on the string.
 */

import type { ModificationLogDto } from "./types.js";

/** Pads the fraction so that plain string order is time order. */
function sortable(time: string): string {
  const [whole = "", fraction = ""] = time.split(".");
  return `${whole}.${fraction.padEnd(7, "0")}`;
}

/** Orders two log timestamps without dropping their microseconds. */
export function compareLogTime(a: string, b: string): number {
  const x = sortable(a);
  const y = sortable(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * What tells two log entries apart. The log has no identifier of its own, and
 * timestamps are not unique: concurrent writes share them.
 */
export function logEntryKey(log: ModificationLogDto): string {
  return JSON.stringify([
    log.creationDateTime,
    log.modType,
    log.sourceType,
    log.sourceId,
    log.extraAId,
    log.extraBId,
    log.oldValue,
    log.newValue,
    log.userId,
  ]);
}
