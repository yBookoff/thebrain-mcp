/**
 * DTOs and enumerations for TheBrain's local API.
 *
 * Some values are absent from the OpenAPI spec and were found empirically;
 * those are called out individually. See docs/api-map.md.
 */

// ----------------------------------------------------------------- enums

/** Kind of thought. */
export const ThoughtKind = {
  Normal: 1,
  Type: 2,
  Event: 3,
  Tag: 4,
  System: 5,
} as const;
export type ThoughtKind = (typeof ThoughtKind)[keyof typeof ThoughtKind];

/** Access level. */
export const AccessType = { Public: 0, Private: 1 } as const;
export type AccessType = (typeof AccessType)[keyof typeof AccessType];

/**
 * How a new thought (or link) relates to the source thought.
 *
 * Note: when creating a link towards a thought with `kind = Tag`, the server
 * rewrites `Parent` into a tag attachment (`relation = Child`, `meaning = Tag`).
 */
export const Relation = { Child: 1, Parent: 2, Jump: 3, Sibling: 4 } as const;
export type Relation = (typeof Relation)[keyof typeof Relation];

/**
 * Link meaning. **The spec does not document these values** — found
 * empirically. Read-only: the server derives it from the target's `kind`.
 */
export const LinkMeaning = {
  /** Ordinary link: child / parent / jump / sibling. */
  Normal: 1,
  /** Type attachment. Created when a thought's `typeId` is set. */
  Type: 2,
  /** Tag attachment. Created by `relation: Parent` towards a `kind: Tag` thought. */
  Tag: 5,
} as const;
export type LinkMeaning = (typeof LinkMeaning)[keyof typeof LinkMeaning];

/** Attachment type. Only three values are documented. */
export const AttachmentType = {
  ExternalFile: 2,
  ExternalUrl: 3,
  ExternalDirectory: 8,
} as const;
export type AttachmentType = (typeof AttachmentType)[keyof typeof AttachmentType];

/** Entity type in the modification log. */
export const EntityType = {
  Unknown: -1,
  Brain: 1,
  Thought: 2,
  Link: 3,
  Attachment: 4,
  BrainSetting: 5,
  BrainAccessEntry: 6,
  CalendarEvent: 7,
  FieldInstance: 8,
  FieldDefinition: 9,
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

// -------------------------------------------------------- modification log

/**
 * `modType` decoding. The API returns bare integers; without this table the
 * log is useless to a model.
 */
export const MODIFICATION_TYPES: Readonly<Record<number, string>> = {
  101: "created",
  102: "deleted",
  103: "renamed",
  104: "created by paste",
  105: "modified by paste",

  201: "colour changed",
  202: "label changed",
  203: "type set",
  204: "second colour changed",
  205: "icon added",
  206: "icon removed",
  207: "icon changed",
  208: "field value changed",
  209: "field added",
  210: "field removed",

  301: "forgotten",
  302: "remembered",
  303: "access level changed",
  304: "kind changed",

  401: "link thickness changed",
  402: "link moved",
  403: "link direction changed",
  404: "link meaning changed",
  405: "link relation changed",

  501: "attachment content changed",
  502: "attachment location changed",
  503: "attachment position changed",

  601: "brain setting changed",
  602: "pins reordered",

  701: "brain access entry changed",

  801: "note created",
  802: "note deleted",
  803: "note changed",
  804: "note asset deleted",
  805: "note asset created",
  806: "note asset changed",
  807: "markdown image deleted",
  808: "markdown image created",
  809: "markdown image changed",
  810: "dynamic wallpaper deleted",
  811: "dynamic wallpaper created",
  812: "dynamic wallpaper changed",

  900: "calendar event created",
  901: "calendar event modified",
  902: "calendar event deleted",
  903: "recurring event instance deleted",

  1001: "field definition changed",
  1002: "field definition created",
  1003: "field definition deleted",
};

/** Frequently used codes, so logic avoids magic numbers. */
export const ModType = {
  Created: 101,
  Deleted: 102,
  NameChanged: 103,
  TypeSet: 203,
  Forgotten: 301,
  Remembered: 302,
  NoteCreated: 801,
  NoteDeleted: 802,
  NoteChanged: 803,
} as const;

/** Codes after which a thought must be re-embedded in the semantic index. */
export const REEMBED_MOD_TYPES: ReadonlySet<number> = new Set([
  ModType.NameChanged,
  ModType.NoteCreated,
  ModType.NoteDeleted,
  ModType.NoteChanged,
]);

export function describeModType(modType: number): string {
  return MODIFICATION_TYPES[modType] ?? `unknown change (${modType})`;
}

export function describeEntityType(entityType: number): string {
  const names: Record<number, string> = {
    [-1]: "unknown",
    1: "brain",
    2: "thought",
    3: "link",
    4: "attachment",
    5: "brain setting",
    6: "access entry",
    7: "calendar event",
    8: "field value",
    9: "field definition",
  };
  return names[entityType] ?? `type ${entityType}`;
}

// ------------------------------------------------------------------- DTO

export interface BrainDto {
  id: string;
  name: string | null;
  homeThoughtId: string;
}

export interface AppStateTabDto {
  id: string;
  brainId: string;
  brainName: string | null;
  isActive: boolean;
  activeThoughtId: string | null;
  activeThoughtName: string | null;
}

export interface AppStateDto {
  currentBrainId: string | null;
  currentBrainName: string | null;
  activeThoughtId: string | null;
  activeThoughtName: string | null;
  isLoggedIn: boolean;
  userId: string | null;
  tabs: AppStateTabDto[] | null;
}

export interface ThoughtDto {
  id: string;
  brainId: string;
  creationDateTime: string;
  modificationDateTime: string;
  name: string | null;
  cleanedUpName: string | null;
  typeId: string | null;
  displayModificationDateTime: string | null;
  forgottenDateTime: string | null;
  linksModificationDateTime: string | null;
  acType: number;
  kind: number;
  label: string | null;
  foregroundColor: string | null;
  backgroundColor: string | null;
}

export interface LinkDto {
  id: string;
  brainId: string;
  creationDateTime: string;
  modificationDateTime: string;
  name: string | null;
  cleanedUpName: string | null;
  typeId: string | null;
  kind: number;
  color: string | null;
  thickness: number | null;
  thoughtIdA: string;
  thoughtIdB: string;
  relation: number;
  direction: number;
  meaning: number;
}

export interface ThoughtGraphDto {
  activeThought: ThoughtDto;
  parents: ThoughtDto[] | null;
  children: ThoughtDto[] | null;
  jumps: ThoughtDto[] | null;
  siblings: ThoughtDto[] | null;
  tags: ThoughtDto[] | null;
  type: ThoughtDto | null;
  links: LinkDto[] | null;
  attachments: AttachmentDto[] | null;
}

export interface AttachmentDto {
  id: string;
  brainId: string;
  sourceId: string;
  sourceType: number;
  creationDateTime: string;
  modificationDateTime: string;
  name: string | null;
  position: number;
  fileModificationDateTime: string | null;
  type: number;
  isNotes: boolean;
  dataLength: number | null;
  location: string | null;
}

export interface NotesDto {
  brainId: string;
  sourceId: string;
  sourceType: number;
  modificationDateTime: string;
  markdown: string | null;
  html: string | null;
  text: string | null;
}

export interface SearchResultDto {
  sourceThought: ThoughtDto | null;
  sourceLink: LinkDto | null;
  searchResultType: number;
  isFromOtherBrain: boolean;
  name: string | null;
  attachmentId: string;
  brainName: string | null;
  /** Arrives as all zeroes. The real identifier is `sourceThought.brainId`. */
  brainId: string;
  entityType: number;
  sourceType: number;
}

export interface ModificationLogDto {
  sourceId: string;
  sourceType: number;
  extraAId: string;
  extraAType: number;
  extraBId: string;
  extraBType: number;
  modType: number;
  oldValue: string | null;
  newValue: string | null;
  userId: string;
  brainId: string;
  creationDateTime: string;
  modificationDateTime: string;
  syncUpdateDateTime: string | null;
}

export interface StatisticsDto {
  brainName: string | null;
  dateGenerated: string;
  brainId: string;
  /** Counts only `kind = Normal`. Types and tags have their own fields. */
  thoughts: number;
  forgottenThoughts: number;
  links: number;
  linksPerThought: number;
  thoughtTypes: number;
  linkTypes: number;
  tags: number;
  notes: number;
  internalFiles: number;
  internalFolders: number;
  externalFiles: number;
  externalFolders: number;
  webLinks: number;
  assignedIcons: number;
  internalFilesSize: number;
  iconsFilesSize: number;
}

/** The "no note" sentinel in `NotesDto.modificationDateTime`. */
export const NO_NOTE_SENTINEL = "0001-01-01T00:00:00";

export function hasNote(notes: NotesDto): boolean {
  return (
    notes.modificationDateTime !== NO_NOTE_SENTINEL &&
    (notes.markdown ?? "").length > 0
  );
}
