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
 */

import {
  EntityType,
  describeEntityType,
  describeModType,
  type ModificationLogDto,
} from "../api/types.js";

/** An event about the brain's view settings rather than its content. */
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
