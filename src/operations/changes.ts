/**
 * Turning modification-log entries into readable change rows.
 *
 * Measured on a live TheBrain 15, about 1,600 entries across three brains:
 *
 * - Link events (`sourceType` 3) name both ends in `extraAId`/`extraBId`, each
 *   with type 2. `sourceId` is the link itself, which has no name.
 * - Attachment events (`sourceType` 4), notes and icons included, name their
 *   thought in `extraAId` with type 2 — or the brain, type 1, for a wallpaper.
 * - Brain-setting events (`sourceType` 5) were 724 of the entries, nearly all
 *   `601`: view zoom and position. They name no thought and say nothing a
 *   digest could use.
 *
 * The API returns the newest entries first and truncates at `maxLogs`, so
 * settings have to be filtered before the caller's limit is applied: with the
 * limit applied first, a zoomed view could leave nothing else to show.
 *
 * The link, attachment and truncation claims have contract tests in
 * `test/resources.integration.test.ts`.
 *
 * And on 15.0.640, over the 159,451 entries of one brain's log:
 *
 * - A thought's own lifecycle entries carry its name. `101` has the name it
 *   was created with in `newValue` (48,013 of 48,013), `103` the old name in
 *   `oldValue` and the new one in `newValue` (639 of 639), `102` the name it
 *   had when it was deleted in `oldValue` (48,012 of 48,012, 624 of them
 *   after a rename). The same for a type and a tag. Of the kinds of entry
 *   that log holds no other names a thought: a link's and an attachment's
 *   values are the link's label and the attachment's own name or address,
 *   and a `203`'s are the *type's* name. A `101` says nothing of the kind.
 * - That name is the first 140 UTF-16 code units of the thought's own, with
 *   nothing to say that more followed.
 *
 * Contract tests: "a thought's name in the log".
 */

import { compareLogTime, logTime } from "../api/log.js";
import {
  EntityType,
  ModType,
  describeEntityType,
  describeModType,
  type ModificationLogDto,
} from "../api/types.js";

/**
 * An event about the brain's settings rather than its content. Nearly all are
 * view zoom and position, but the filter goes by entity type, so any other
 * brain setting is hidden with them.
 */
export function isSettingNoise(log: ModificationLogDto): boolean {
  return log.sourceType === EntityType.BrainSetting;
}

/** The thoughts an event is about: none, one, or both ends of a link. */
export function subjectIds(log: ModificationLogDto): string[] {
  if (log.sourceType === EntityType.Thought) return [log.sourceId];
  if (log.sourceType === EntityType.Link) {
    return [
      ...(log.extraAType === EntityType.Thought ? [log.extraAId] : []),
      ...(log.extraBType === EntityType.Thought ? [log.extraBId] : []),
    ];
  }
  if (log.sourceType === EntityType.Attachment && log.extraAType === EntityType.Thought) {
    return [log.extraAId];
  }
  return [];
}

/** Lifecycle codes whose description does not say what was created or changed. */
const GENERIC_MOD_TYPES: ReadonlySet<number> = new Set([101, 102, 103, 104, 105]);

/**
 * What happened, naming the entity when the code alone is ambiguous: a bare
 * "created" on a link event read as if a thought had been created.
 */
export function describeChange(log: ModificationLogDto): string {
  const what = describeModType(log.modType);
  const entityNamed =
    log.sourceType === EntityType.Link || log.sourceType === EntityType.Attachment;
  return entityNamed && GENERIC_MOD_TYPES.has(log.modType)
    ? `${describeEntityType(log.sourceType)} ${what}`
    : what;
}

/**
 * How much of a thought's name a log entry keeps: its first 140 UTF-16 code
 * units (docs/api-map.md, L37). A name of that length may be a longer one cut.
 */
export const LOG_NAME_LIMIT = 140;

/** What the log itself says of a thought, with no read of the thought. */
export interface LoggedThought {
  /** The newest name the entries have for it, or null when none carries one. */
  name: string | null;
  /** The name is as long as the log keeps one: the thought's own may go on. */
  cut: boolean;
  /** Its newest `created` or `deleted` entry is the deletion. */
  deleted: boolean;
}

/** `created`, `renamed`, `deleted`: the order they can only come in for one thought. */
const LIFECYCLE: readonly number[] = [ModType.Created, ModType.NameChanged, ModType.Deleted];

/**
 * The name and the fate of every thought that has an entry of its own among
 * `logs`: created, renamed or deleted. In any order; entries of one time are
 * taken in the order a thought can live through them.
 *
 * The newest name is the thought's name when the log was read, as long as
 * `logs` has no gap between that entry and the newest one: a rename since
 * would be a `103` among them. The log read newest first, page after page, is
 * such a run, and so is any tail of it.
 */
export function loggedThoughts(logs: readonly ModificationLogDto[]): Map<string, LoggedThought> {
  const own = logs
    .filter((l) => l.sourceType === EntityType.Thought && LIFECYCLE.includes(l.modType))
    .sort(
      (a, b) =>
        compareLogTime(logTime(a), logTime(b)) ||
        LIFECYCLE.indexOf(a.modType) - LIFECYCLE.indexOf(b.modType),
    );
  const thoughts = new Map<string, LoggedThought>();
  for (const l of own) {
    const before = thoughts.get(l.sourceId);
    const deleted = l.modType === ModType.Deleted;
    // An empty value names nothing, and is not what the API logs for a name.
    const name = (deleted ? l.oldValue : l.newValue) || (before?.name ?? null);
    thoughts.set(l.sourceId, {
      name,
      cut: name !== null && name.length >= LOG_NAME_LIMIT,
      deleted: l.modType === ModType.NameChanged ? (before?.deleted ?? false) : deleted,
    });
  }
  return thoughts;
}
