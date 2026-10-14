import {
  assertUuid,
  createdId,
  emptyOn400,
  type JsonPatchOp,
  type TheBrainClient,
} from "../client.js";
import { TheBrainError } from "../errors.js";
import { compareLogTime, logTime } from "../log.js";
import { nameRefusal, shownName, thoughtNameAsStored } from "../names.js";
import {
  EntityType,
  ModType,
  aliasesOf,
  type AttachmentDto,
  type BrainDto,
  type LinkDto,
  type ModificationLogDto,
  Relation,
  type ThoughtDto,
  type ThoughtGraphDto,
  ThoughtKind,
} from "../types.js";
import { requireKind } from "./kind.js";
import { isStructuralLink, isTypeLink, type LinksResource } from "./links.js";

export interface CreateThoughtInput {
  name: string;
  /**
   * Which thought to attach to. Without it the thought is created orphaned.
   * Not a type or a tag when the new thought is to be its child: see
   * `requireParent`.
   */
  sourceThoughtId?: string;
  /** How the new thought relates to the source. Defaults to child. Refused with no source. */
  relation?: Relation;
  kind?: number;
  label?: string;
  /** Alternate names. See `UpdateThoughtInput.aliases` for what saving one costs. */
  aliases?: readonly string[];
  /** Has to name a type, which is read first: see `requireType`. */
  typeId?: string;
  acType?: number;
}

/** What `createTypeOrTag` is asked for: a name, and which of the two it is to be. */
export interface CreateTypeOrTagInput {
  name: string;
  kind: typeof ThoughtKind.Type | typeof ThoughtKind.Tag;
}

/** What `createTypeOrTag` made, or was answered with. */
export interface TypeOrTagOutcome {
  /** What the create answered with: by it the type or the tag is addressed. */
  id: string;
  /**
   * True when this call made it. False when TheBrain answered with one the
   * brain had, which it does for a tag under the name of a tag that is there.
   * Null when the log that tells the two apart could not be read: `notRead`.
   */
  created: boolean | null;
  /** The thought as it read after the create: its name need not be the one asked for. */
  thought: ThoughtDto | null;
  /** The failure of a read made after the create, which is no failure of the create. */
  notRead: unknown;
}

/**
 * Flat facade over JSON Patch — patch documents never leave this layer.
 *
 * `undefined` is allowed explicitly: tool handlers build these objects from
 * optional arguments. An absent field is left alone; `null` clears the value.
 */
export interface UpdateThoughtInput {
  name?: string | undefined;
  label?: string | null | undefined;
  /** `null` takes the type away, which no patch does: see `removeType`. */
  typeId?: string | null | undefined;
  foregroundColor?: string | null | undefined;
  backgroundColor?: string | null | undefined;
  acType?: number | undefined;
  kind?: number | undefined;
  /**
   * The whole list: the API refuses per-element paths. `null` or an empty list
   * clears it. To add or drop single aliases use `changeAliases`.
   *
   * Per the spec, saving the first alias in a brain makes that brain require
   * TheBrain 15.0.621 or later on every device.
   */
  aliases?: readonly string[] | null | undefined;
}

/** The API keeps the first hundred aliases of a longer list and drops the rest. */
export const MAX_ALIASES = 100;

/** What a new thought can be to its source: the API's own list has one more. */
const RELATIONS: readonly number[] = Object.values(Relation);

/**
 * A read straight after a write usually still returns the old value.
 *
 * Aliases, measured over 82 writes: the new list showed up 50–100 ms later,
 * 0.2 s at the most, and 7 times it was there at once. A removed type, over 13
 * removals: 20–210 ms, and not once on the first read. A type set by a patch,
 * over 160: up to 107 ms, 92 at the median, and 24 times it was there at once.
 *
 * That is a quiet brain. Writes queue up: the first patch after 150 thoughts
 * created in a burst took 0.6–0.8 s to read back, and after thoughts created
 * with a type 2.6 s for 300 and 5.3 s for 600. Three seconds after the burst
 * it was 0.1 s again. Beside bursts kept up in another brain a rename read
 * back 1–30 s late, later with each burst: no wait is long enough always.
 *
 * So the wait is a bound, and a write it does not see is told as accepted
 * and not read back (`not_read_back`), not as failed. Six seconds is past
 * the 600 creates, three times the thoughts one `brain_ingest` makes; two
 * were short of a burst of 300. It costs nothing where the write
 * reads back, and its whole length only where a read never shows it. The
 * pause doubles each second, 25 ms to 200: some 85 reads, where two seconds
 * at 25 ms were 80.
 */
export const READ_BACK = { stepMs: 25, maxStepMs: 200, timeoutMs: 6000 };

/** The middle of each sentence about a write that has not read back, after its colon. */
export const READ_LAG =
  "reads lag behind writes for seconds after a burst of them, and longer while writes keep coming";

/**
 * How long a write that did not read back holds off a change of the same
 * field built on a read from before it (`#pastUnread`): twice the 30 s a
 * rename was seen to lag. Past that the read is taken as it comes.
 */
const UNREAD_KEPT_MS = 60_000;

/** A field whose write is a read, then a write of the whole. */
type UnreadField = "aliases" | "type";

function unreadKey(field: UnreadField, brainId: string, thoughtId: string): string {
  return `${field} ${brainId.toLowerCase()} ${thoughtId.toLowerCase()}`;
}

/** A write of this process, accepted by the API, that a read has not shown. */
interface Unread {
  /** When it was answered. */
  at: number;
  /** What it shows once it reads back, for a sentence: `the type <id>`, `no type`. */
  shown: string;
  /** Whether a read is still from before it. */
  behind: (thought: ThoughtDto) => boolean;
}

export interface AliasChanges {
  add?: readonly string[] | undefined;
  /** Matched ignoring case and surrounding whitespace. */
  remove?: readonly string[] | undefined;
}

export interface AliasOutcome {
  /** The list after the change. */
  aliases: string[];
  added: string[];
  removed: string[];
  /**
   * False when a written list had not shown up on a read by the time this
   * returned. Another edit made now would start from the old list and undo it.
   */
  readBack: boolean;
}

/**
 * Graph with what is no parent taken out of `parents`. The API lists there
 * every thought above this one, whatever the link: the thought's type, the
 * tag a tag carries, and the second type of a thought made with two. Each
 * also has a list of its own here. All lists are normalised — the API sends
 * `null` instead of empty arrays.
 */
export interface CleanGraph {
  thought: ThoughtDto;
  /** The thoughts above this one by an ordinary link. */
  parents: ThoughtDto[];
  children: ThoughtDto[];
  jumps: ThoughtDto[];
  siblings: ThoughtDto[];
  /** On a tag, the tag it carries as well: the API lists that one in both. */
  tags: ThoughtDto[];
  /**
   * The type `typeId` names. The API's own `type` names either of two types
   * a thought can be linked under, and not by `typeId`.
   */
  type: ThoughtDto | null;
  /**
   * Any other type the thought is linked under. A thought created under one
   * type with another for its `typeId` has a link from each (docs/api-map.md,
   * L44). Empty but for such a thought.
   */
  otherTypes: ThoughtDto[];
  links: LinkDto[];
  attachments: AttachmentDto[];
}

/** What a caller is told when it asks a build without aliases to save some. */
export const ALIASES_UNSUPPORTED =
  "this TheBrain has no aliases: they arrived in 15.0.621. " +
  "Update TheBrain, or leave the aliases out";

export class ThoughtsResource {
  /** Only a yes is remembered: an update can add aliases while we run. */
  #aliasesSeen = false;
  /** The last `createTypeOrTag` of each brain, settled or not: the next one waits for it. */
  #typesAndTags = new Map<string, Promise<void>>();
  /** By field, brain and thought: see `#pastUnread`. */
  #unread = new Map<string, Unread>();

  constructor(
    private readonly client: TheBrainClient,
    private readonly links: LinksResource,
  ) {}

  async get(brainId: string, thoughtId: string): Promise<ThoughtDto> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    return this.client.get<ThoughtDto>(`/api/thoughts/${brainId}/${thoughtId}`);
  }

  /**
   * One hop of the graph around a thought.
   *
   * The API lists among `parents` every thought above this one, by whatever
   * link: the thought's type, which is in `type` as well; on a tag, a tag it
   * carries, which is in `tags` as well; and the second type of a thought
   * created under one type with another for its `typeId`, which is nowhere
   * else. A parent here is the upper end of an ordinary link, by the link the
   * two share in the graph's own `links`, and the rest are taken out:
   * otherwise types and tags leak into the tree as ordinary ancestors, and
   * the read tools call them parents. A thought above with no link listed is
   * kept unless it is the type, as every one but the type was before.
   *
   * `type` is the one `typeId` names, where the API's names the other of two.
   */
  async getGraph(
    brainId: string,
    thoughtId: string,
    options: { includeSiblings?: boolean } = {},
  ): Promise<CleanGraph> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    const raw = await this.client.get<ThoughtGraphDto>(
      `/api/thoughts/${brainId}/${thoughtId}/graph`,
      { query: { includeSiblings: options.includeSiblings ?? false } },
    );
    const thought = raw.activeThought;
    const typeId = thought.typeId;
    const links = raw.links ?? [];
    const above = raw.parents ?? [];
    // Two thoughts share one link, whichever end is named first.
    const linkWith = (id: string): LinkDto | undefined =>
      links.find(
        (l) =>
          (l.thoughtIdA === id && l.thoughtIdB === thought.id) ||
          (l.thoughtIdA === thought.id && l.thoughtIdB === id),
      );
    const isParent = (p: ThoughtDto): boolean => {
      const link = linkWith(p.id);
      return link === undefined ? p.id !== typeId : isStructuralLink(link);
    };
    const isTypeAbove = (p: ThoughtDto): boolean => {
      const link = linkWith(p.id);
      return link === undefined ? p.id === typeId : isTypeLink(link);
    };
    // The API's `type` first, then any other a type's link joins to this one.
    const named = raw.type ?? null;
    const types: ThoughtDto[] = [];
    for (const t of [...(named === null ? [] : [named]), ...above.filter(isTypeAbove)]) {
      if (!types.some((known) => known.id === t.id)) types.push(t);
    }
    const type = types.find((t) => t.id === typeId) ?? named;
    return {
      thought,
      parents: above.filter(isParent),
      children: raw.children ?? [],
      jumps: raw.jumps ?? [],
      siblings: raw.siblings ?? [],
      tags: raw.tags ?? [],
      type,
      otherTypes: types.filter((t) => t.id !== type?.id),
      links,
      attachments: raw.attachments ?? [],
    };
  }

  /**
   * The thought that has exactly this name now, as it reads now, or null.
   *
   * Faster than full-text search but **not instant**: measured at roughly
   * 5.6 seconds between creating a thought and its appearance here. After a
   * write, address thoughts by id rather than by name.
   *
   * The lookup answers from the index TheBrain's search has, and that index
   * is behind in the other direction too (docs/api-map.md, L34). Until its
   * next refresh, at most 5.2 s, it answers with a thought that was deleted,
   * and with a renamed thought under the old name, the old name in the answer.
   * A thought deleted a moment after a neighbour stayed in it for good about
   * once in a hundred. So the answer is read by its identifier before it is
   * returned, and what comes back is that read: a 404 or another name is null.
   * Any other failure of that read is thrown: it is no answer.
   *
   * Null is then "the lookup's one answer is not such a thought", which is
   * less than "no thought has this name". Of two namesakes the lookup gives
   * the newer, and it went on giving it for 5.1 s after it was deleted, 8 of
   * 8, with the older one there all along.
   */
  async findByName(brainId: string, nameExact: string): Promise<ThoughtDto | null> {
    assertUuid(brainId, "brainId");
    const gone = (error: unknown): boolean =>
      error instanceof TheBrainError && error.kind === "not_found";
    let listed: ThoughtDto;
    try {
      listed = await this.client.get<ThoughtDto>(`/api/thoughts/${brainId}`, {
        query: { nameExact },
      });
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
    let thought: ThoughtDto;
    try {
      thought = await this.get(brainId, listed.id);
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
    return thought.name === nameExact ? thought : null;
  }

  /**
   * Whether this TheBrain has aliases at all.
   *
   * Builds before 15.0.621 do not. What they do with `aliases` in a create
   * request could not be measured, and a field ignored in silence would be
   * reported as written, so writers ask first. The current build sends
   * `aliases` on every thought, empty or not; its absence on the home thought
   * settles it. When the question cannot be answered the write goes ahead.
   */
  async supportsAliases(brainId: string): Promise<boolean> {
    assertUuid(brainId, "brainId");
    if (this.#aliasesSeen) return true;
    try {
      const brain = await this.client.get<BrainDto>(`/api/brains/${brainId}`);
      const home = await this.get(brainId, brain.homeThoughtId);
      this.#aliasesSeen = home.aliases !== undefined;
      return this.#aliasesSeen;
    } catch {
      return true;
    }
  }

  async create(brainId: string, input: CreateThoughtInput): Promise<string> {
    assertUuid(brainId, "brainId");
    // Ahead of the reads below: the API refuses a name of white space only
    // once they are made, and cuts a long one without a word.
    assertName(input.name);
    if (input.sourceThoughtId !== undefined) {
      assertUuid(input.sourceThoughtId, "sourceThoughtId");
    }
    // Here as well as in `requireType`: one that is malformed or of zeros
    // sends nothing, the read of the source included.
    if (input.typeId !== undefined) assertUuid(input.typeId, "typeId");
    // Ahead of the request, which answers 200 to any number and creates the
    // thought. With 4, the spec's "Sibling", or with 0 it has no link at all;
    // with 5 it has one that no list of the graph shows.
    if (input.relation !== undefined && !RELATIONS.includes(input.relation)) {
      throw new TheBrainError(
        "bad_request",
        `relation must be 1 (child), 2 (parent) or 3 (jump), got ${String(input.relation)}. ` +
          "The API would create the thought all the same: for 4, which the spec calls " +
          "Sibling, with no link to its source",
      );
    }
    // The same for a relation with no source to relate to: it used to be
    // left out of the request without a word, and the thought made unlinked.
    if (input.relation !== undefined && input.sourceThoughtId === undefined) {
      throw new TheBrainError(
        "bad_request",
        "relation says how the new thought is linked to sourceThoughtId, and none was given: " +
          "the thought would be created with no link. Give the source or leave the relation out",
      );
    }
    // Ahead of the request: a thought made under a type is one of that type,
    // with no parent, and with another `typeId` beside it carries both types.
    // One made under a tag is tagged, and has no parent either.
    if (
      input.sourceThoughtId !== undefined &&
      (input.relation ?? Relation.Child) === Relation.Child
    ) {
      await this.links.requireParent(brainId, input.sourceThoughtId, "sourceThoughtId");
    }
    // The same for the type: one made with a tag or an ordinary thought for a
    // type would leave a thought behind, tagged or with one parent too many.
    if (input.typeId !== undefined) await this.requireType(brainId, input.typeId);
    const aliases = input.aliases ?? [];
    if (aliases.length > 0 && !(await this.supportsAliases(brainId))) {
      throw new TheBrainError("bad_request", ALIASES_UNSUPPORTED);
    }

    const body: Record<string, unknown> = {
      name: input.name,
      kind: input.kind ?? ThoughtKind.Normal,
      acType: input.acType ?? 0,
    };
    if (input.label !== undefined) body["label"] = input.label;
    if (aliases.length > 0) body["aliases"] = aliases;
    if (input.typeId !== undefined) body["typeId"] = input.typeId;
    if (input.sourceThoughtId !== undefined) {
      body["sourceThoughtId"] = input.sourceThoughtId;
      body["relation"] = input.relation ?? 1;
    }

    const path = `/api/thoughts/${brainId}`;
    const created = await this.client.post<{ id: string }>(path, { json: body });
    const id = createdId(
      created,
      path,
      `TheBrain answered 200 with an identifier of zeros for the thought ` +
        `"${shownName(input.name)}", so ` +
        "there is nothing to address it by. For a link that answer means none was made; for a " +
        "thought it has not been seen, so look for the thought before creating it again",
    );
    // The source's graph lists it from now on, and a copy of that graph from
    // before this answer does not: kept for a reader that looks there next.
    // An ordinary thought alone: where a new type or tag is listed next to
    // its source was not measured.
    if (
      input.sourceThoughtId !== undefined &&
      (input.kind ?? ThoughtKind.Normal) === ThoughtKind.Normal
    ) {
      this.client.written.linked(
        brainId,
        input.sourceThoughtId,
        id,
        input.relation ?? Relation.Child,
      );
    }
    return id;
  }

  /**
   * Makes a type or a tag, with a name and nothing else, and says whether it
   * was made: for a tag TheBrain answers with the one the brain has under
   * that name, and the answer is an identifier either way.
   *
   * **A tag's name is matched, loosely.** A create with `kind: 4` under the
   * name of a tag that is there makes nothing and answers with that tag's
   * identifier. The names need not be the same: letter case, a character
   * that does not show, a ligature or a superscript for its letters, and a
   * no-break space for a space are all taken for one name (docs/api-map.md,
   * L39). The tag keeps the name it had. A type is not matched at all: a
   * second create makes a second type of the same name.
   *
   * **The log tells the two apart.** A thought made by a create has its
   * `101` in the log when the create is answered, and that entry is later
   * than every entry the log had before. So the newest entry is read ahead
   * of the create and the thought's own entries after it. A list would not
   * do: `/types` and `/tags` are a copy, behind a create by up to 0.42 s.
   *
   * **One at a time in a brain.** Two creates of one new tag name sent at
   * once were two tags 5 times of 10, where one sent straight after the
   * other's answer was the same tag 25 times of 25. And a create that
   * overtook another's read of the log would pass for what that call made.
   *
   * **Nothing beside the name is sent.** A label or aliases sent with the
   * name of a tag that is there are written onto that tag. A source or a
   * `typeId` makes a link whose meaning goes by the kinds at its two ends, a
   * type set on the source among them, and a type under a type and a tag
   * under a tag are the catch-all 403. A caption and colours are a patch of
   * the thought afterwards.
   *
   * A read that fails after the create does not fail it: the identifier is
   * returned with what was read, and the failure in `notRead`.
   */
  async createTypeOrTag(
    brainId: string,
    input: CreateTypeOrTagInput,
  ): Promise<TypeOrTagOutcome> {
    assertUuid(brainId, "brainId");
    assertName(input.name);
    // Ahead of the request, which takes 1 as well and makes an ordinary thought.
    if (input.kind !== ThoughtKind.Type && input.kind !== ThoughtKind.Tag) {
      throw new TheBrainError(
        "bad_request",
        `kind must be 2 (type) or 4 (tag), got ${String(input.kind)}: ` +
          "an ordinary thought is made by create()",
      );
    }
    const before = this.#typesAndTags.get(brainId) ?? Promise.resolve();
    const mine = before.then(() => this.#typeOrTag(brainId, input));
    // What the next one waits for is that this one is over, not how it ended.
    this.#typesAndTags.set(
      brainId,
      mine.then(
        () => undefined,
        () => undefined,
      ),
    );
    return mine;
  }

  async #typeOrTag(brainId: string, input: CreateTypeOrTagInput): Promise<TypeOrTagOutcome> {
    const [newest] = await this.client.get<ModificationLogDto[]>(
      `/api/brains/${brainId}/modifications`,
      { query: { maxLogs: 1 } },
    );
    const path = `/api/thoughts/${brainId}`;
    const answer = await this.client.post<{ id: string }>(path, {
      json: { name: input.name, kind: input.kind, acType: 0 },
    });
    const id = createdId(
      answer,
      path,
      `TheBrain answered 200 with an identifier of zeros for "${shownName(input.name)}", so ` +
        "there is nothing to address it by. That answer has not been seen for a type or a " +
        "tag, so look for it before creating it again",
    );

    let created: boolean | null = null;
    let thought: ThoughtDto | null = null;
    let notRead: unknown = null;
    try {
      // Its own entries alone: a tag in use has an entry for each thought it
      // is on, and its `101` would be past the newest hundred of those.
      const own = await this.modifications(brainId, id, { maxLogs: 100, includeRelated: false });
      const made = own.find(
        (l) =>
          l.modType === ModType.Created &&
          l.sourceType === EntityType.Thought &&
          l.sourceId.toLowerCase() === id.toLowerCase(),
      );
      // With no `101` among them it was there before: one made a moment ago
      // has no other entry. A log with nothing in it had none to be later than.
      created =
        made !== undefined &&
        (newest === undefined || compareLogTime(logTime(made), logTime(newest)) > 0);
      thought = await this.get(brainId, id);
    } catch (error) {
      notRead = error;
    }
    return { id, created, thought, notRead };
  }

  /**
   * Takes flat fields and assembles the JSON Patch internally.
   *
   * A value is cleared with `remove`. `replace` with null is refused for a
   * label (403) and for a colour (400), and for a type it answers 200 and
   * changes nothing, so a type goes through `removeType` instead.
   *
   * A `typeId` has to name a type other than the thought itself, and is read
   * before anything is sent (`requireType`). So is the thought's graph, for a
   * type the patch would not set as asked (`#requireTypeable`). Once the
   * patch is in, the call waits for the thought to read back with the type,
   * and throws when it does not.
   *
   * The API applies a patch one operation at a time and keeps what it wrote
   * before the one it refuses: an update that throws may have landed in part.
   */
  async update(
    brainId: string,
    thoughtId: string,
    changes: UpdateThoughtInput,
  ): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    // A 200 that renames nothing, when the name is white space alone: it used
    // to pass for a rename. Ahead of the type's read, so that nothing is sent.
    if (changes.name !== undefined) assertName(changes.name);
    const { aliases, typeId, ...fields } = changes;
    // A 200 that sets nothing, also when the thought is a type and so passes
    // the check of its kind. Case aside: the API reads a UUID in capitals too.
    if (typeof typeId === "string" && typeId.toLowerCase() === thoughtId.toLowerCase()) {
      throw new TheBrainError(
        "not_a_type",
        `a thought cannot be its own type: typeId ${typeId} is the thought being updated`,
      );
    }
    const type = typeof typeId === "string" ? await this.requireType(brainId, typeId) : null;
    if (type !== null) await this.#requireTypeable(brainId, thoughtId, type);

    const ops: JsonPatchOp[] = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) =>
        value === null
          ? { op: "remove", path: `/${key}` }
          : { op: "replace", path: `/${key}`, value },
      );
    if (type !== null) ops.push({ op: "replace", path: "/typeId", value: type.id });
    if (aliases !== undefined) {
      ops.push(
        aliases === null || aliases.length === 0
          ? { op: "remove", path: "/aliases" }
          : { op: "replace", path: "/aliases", value: aliases },
      );
    }

    if (ops.length > 0) {
      // Whatever comes of it: a patch that was refused may have changed the
      // kind before the operation it was refused for, and one that got no
      // answer may have landed. What a graph lists of a thought of another
      // kind was not measured, so nothing is asked of a graph about this one.
      if (fields.kind !== undefined) this.client.written.forget(brainId, thoughtId);
      await this.client.patch(`/api/thoughts/${brainId}/${thoughtId}`, {
        jsonPatch: ops,
      });
      // A graph lists the thought under its old name for a moment yet, and a
      // reader that looks for it by the new one has to know that copy is behind.
      if (typeof fields.name === "string") {
        this.client.written.named(brainId, thoughtId, thoughtNameAsStored(fields.name));
      }
    }
    // Not for certainty alone: a removal made before this reads back would
    // find no type to remove. Past the wait `removeType` waits for it again.
    if (type !== null) {
      const answered = Date.now();
      const shows = (t: ThoughtDto): boolean => t.typeId === type.id;
      if ((await this.#readsBack(brainId, thoughtId, shows)) !== null) {
        this.#unread.delete(unreadKey("type", brainId, thoughtId));
      } else {
        this.#markUnread("type", brainId, thoughtId, {
          at: answered,
          shown: `the type ${type.id}`,
          behind: (t) => !shows(t),
        });
        throw new TheBrainError(
          "not_read_back",
          "TheBrain accepted the type, and the thought did not read back with it within " +
            `${READ_BACK.timeoutMs / 1000} s: ${READ_LAG}. Do not send it again: ` +
            "brain_get_thought shows it once TheBrain catches up",
        );
      }
    }
    if (typeId === null) await this.removeType(brainId, thoughtId);
  }

  /**
   * The type that `typeId` names. Throws `not_a_type` when it names a thought
   * of another kind, or nothing.
   *
   * The API does not ask. A `typeId`, in a patch as in a create, links the
   * thought under whatever it names, and that thought's kind decides what the
   * link is: under a type the type, under a tag an attached tag, under an
   * ordinary thought one more parent. Each is a 200, and the last two leave
   * `typeId` as it was. So the kind is read here, ahead of the write.
   */
  async requireType(brainId: string, typeId: string): Promise<ThoughtDto> {
    return requireKind(this.client, brainId, typeId, ThoughtKind.Type);
  }

  /**
   * Refuses, ahead of the write, a type that the patch would not set as
   * asked. The API answers each of these with a 200 (docs/api-map.md, L44):
   *
   * - `type_on_tag`: a tag given a type has none, and no link;
   * - `type_cycle`: a type given for its type a type whose own type it is
   *   has none either;
   * - `two_types`: a thought linked under two types keeps one of them
   *   whatever is set. The other of the two, or `typeId` again, changes
   *   nothing, and a third comes in with one of the two left beside it.
   *
   * Left to the write, the first two waited out the read-back and were told,
   * two seconds later, that the type might yet show; the last answered
   * "Done" for a thought that was not of that type alone. All three are told
   * by the thought's graph, one read.
   *
   * That graph is a copy, a moment behind a write. Read straight after two
   * type links of a thought were deleted, it listed both 19 times of 20; after
   * `removeType`, which waits for its read-back, none of 20. Taken at its
   * word, a copy that far behind would refuse the very call this refusal asks
   * for. So two types are counted by the lookup of each pair, which is not
   * behind a write (L43), and that costs requests only when the graph lists
   * two. A type set a moment ago may be missing from the copy, and the patch
   * then goes ahead as it did.
   */
  async #requireTypeable(brainId: string, thoughtId: string, type: ThoughtDto): Promise<void> {
    const graph = await this.#graphOfOne(brainId, thoughtId);
    const { thought } = graph;
    if (thought.kind === ThoughtKind.Tag) {
      throw new TheBrainError(
        "type_on_tag",
        `thoughtId ${thoughtId} is the tag "${shownName(thought.name)}", and a tag takes no ` +
          "type: TheBrain answers a typeId on a tag and sets nothing",
      );
    }
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
    // A type's link from this thought to the type named: this is that type's type.
    if (
      graph.links.some(
        (l) => isTypeLink(l) && same(l.thoughtIdA, thoughtId) && same(l.thoughtIdB, type.id),
      )
    ) {
      throw new TheBrainError(
        "type_cycle",
        `typeId ${type.id} is the type "${shownName(type.name)}", and this thought is its ` +
          "type: TheBrain answers a typeId that would make two types each other's and sets nothing",
      );
    }
    const listed = [graph.type, ...graph.otherTypes].filter((t): t is ThoughtDto => t !== null);
    if (listed.length < 2) return;
    const linked: ThoughtDto[] = [];
    for (const t of listed) {
      const link = await this.links.between(brainId, t.id, thoughtId);
      if (link !== null && isTypeLink(link) && same(link.thoughtIdA, t.id)) linked.push(t);
    }
    if (linked.length < 2) return;
    const names = linked.map((t) => `"${shownName(t.name)}" ${t.id}`);
    throw new TheBrainError(
      "two_types",
      `thoughtId ${thoughtId} is linked under ${linked.length === 2 ? "two" : linked.length} ` +
        `types, ${names.slice(0, -1).join(", ")} and ${names.at(-1)}, and a typeId set while ` +
        "they are there leaves one of them in place",
    );
  }

  /**
   * The graph of a thought, where a thought nobody has is the 404 of its own
   * read. Its graph is the catch-all 403, which names no cause (L3), and the
   * patch, which used to be the first request about it, a 404 that names it.
   */
  async #graphOfOne(brainId: string, thoughtId: string): Promise<CleanGraph> {
    try {
      return await this.getGraph(brainId, thoughtId);
    } catch (error) {
      if (error instanceof TheBrainError && error.kind === "forbidden") {
        await this.get(brainId, thoughtId);
      }
      throw error;
    }
  }

  /**
   * Takes a thought's type away. False when it had none.
   *
   * No patch does it: `replace /typeId` with null or "" answers 200 and leaves
   * the type in place, and `remove` is a 403. The type is a link from the type
   * to the thought, and deleting that link is what clears `typeId`.
   *
   * It returns once the thought reads back without a type, and throws when it
   * never does: a removal that did not happen must not pass for one that did.
   * The first read is trusted, though, and a type takes up to 0.2 s to read
   * back: one set a moment ago is not seen here, and stays. `update` waits for
   * the type it sets, so that one is seen.
   *
   * Every type the thought is linked under goes, and the graph is read for
   * them. A thought created under one type with another for its `typeId` has
   * a link from each, and deleting either reads back as `typeId: null` while
   * the other stays its type in the graph and in TheBrain: the second one
   * passed for removed. No patch takes one of the two away (docs/api-map.md,
   * L44). Only a type's link from the type is deleted (`detachType`).
   *
   * A type this process set or removed that has not read back is waited for
   * before the first read is trusted, and the call is refused when it still
   * does not (`#pastUnread`): that read would find no type to remove.
   */
  async removeType(brainId: string, thoughtId: string): Promise<boolean> {
    const { typeId } = await this.#pastUnread(
      "type",
      brainId,
      thoughtId,
      await this.get(brainId, thoughtId),
    );
    const graph = await this.getGraph(brainId, thoughtId);
    const types: string[] = [];
    for (const id of [typeId, graph.type?.id, ...graph.otherTypes.map((t) => t.id)]) {
      if (id && !types.some((known) => known.toLowerCase() === id.toLowerCase())) types.push(id);
    }
    if (types.length === 0) return false;

    let detached = false;
    for (const id of types) {
      if (await this.links.detachType(brainId, thoughtId, id)) detached = true;
    }
    // Also when there was no link to delete: this read may be a stale one that
    // follows an earlier removal.
    const answered = Date.now();
    if ((await this.#readsBack(brainId, thoughtId, (t) => !t.typeId)) !== null) {
      this.#unread.delete(unreadKey("type", brainId, thoughtId));
      return detached;
    }
    if (!detached) {
      throw new TheBrainError(
        "server",
        "the thought has a type, but the link that carries it was not found: " +
          "nothing was deleted and the type is still in place",
      );
    }
    this.#markUnread("type", brainId, thoughtId, {
      at: answered,
      shown: "no type",
      behind: (t) => Boolean(t.typeId),
    });
    throw new TheBrainError(
      "not_read_back",
      "TheBrain deleted the link that carries the type, and the thought did not read back " +
        `without it within ${READ_BACK.timeoutMs / 1000} s: ${READ_LAG}. Do not send the ` +
        "removal again: brain_get_thought shows the thought without a type once TheBrain " +
        "catches up",
    );
  }

  /**
   * Adds and removes single aliases.
   *
   * The API only replaces the whole list, so this reads it first and writes
   * the result back; nothing is written when nothing would change. Removal
   * runs before addition, so one call can replace an alias.
   *
   * It returns once the new list reads back. A read straight after the write
   * usually still returns the old list, and a second edit built on that would
   * silently undo the first: measured, two edits in a row left only the second
   * alias. Edits made at the same moment can still collide; the API has no way
   * to prevent that.
   *
   * `known.name` is the name a caller gave the thought a moment ago. The read
   * here still returns the old one then, 19 times of 20, and an alias equal
   * to it was dropped as the name's own: a rename that kept the old name as
   * an alias lost it, and reported nothing to add. The API keeps such an
   * alias, sent straight after the rename, 20 times of 20.
   *
   * A list that does not read back within the wait is returned with
   * `readBack: false`, and the next edit of this thought's aliases in this
   * process waits for it before it reads the list to change, and is refused
   * with nothing sent when it still does not show (`#pastUnread`). Built on
   * the old list, it would undo the one written.
   */
  async changeAliases(
    brainId: string,
    thoughtId: string,
    changes: AliasChanges,
    known: { name?: string | undefined } = {},
  ): Promise<AliasOutcome> {
    const thought = await this.#pastUnread(
      "aliases",
      brainId,
      thoughtId,
      await this.get(brainId, thoughtId),
    );
    const current = aliasesOf(thought);
    const drop = new Set(normalizeAliases(changes.remove ?? []).map(aliasKey));
    const kept = current.filter((a) => !drop.has(aliasKey(a)));
    const removed = current.filter((a) => drop.has(aliasKey(a)));

    // The API drops an alias equal to the name, in any case, so asking for one
    // is not a change.
    const taken = new Set([...kept, known.name ?? thought.name ?? ""].map(aliasKey));
    const added = normalizeAliases(changes.add ?? []).filter((a) => !taken.has(aliasKey(a)));

    const aliases = [...kept, ...added];
    if (added.length === 0 && removed.length === 0) {
      return { aliases, added, removed, readBack: true };
    }
    if (thought.aliases === undefined) {
      throw new TheBrainError("bad_request", ALIASES_UNSUPPORTED);
    }
    if (aliases.length > MAX_ALIASES) {
      // The API would keep the first hundred and say nothing about the rest.
      throw new TheBrainError(
        "bad_request",
        `a thought holds at most ${MAX_ALIASES} aliases, and this would make ${aliases.length}. ` +
          "Remove some first",
      );
    }
    await this.update(brainId, thoughtId, { aliases });
    const answered = Date.now();
    const listed = (list: readonly string[]): string => list.map(aliasKey).sort().join("\n");
    const before = listed(current);
    const readBack =
      (await this.#readsBack(
        brainId,
        thoughtId,
        (t) => listed(aliasesOf(t)) === listed(aliases),
      )) !== null;
    if (readBack) {
      this.#unread.delete(unreadKey("aliases", brainId, thoughtId));
    } else {
      this.#markUnread("aliases", brainId, thoughtId, {
        at: answered,
        shown: `the aliases ${JSON.stringify(aliases)}`,
        behind: (t) => listed(aliasesOf(t)) === before,
      });
    }
    return { aliases, added, removed, readBack };
  }

  /**
   * Waits for a write to show up on a read of the thought, and returns that
   * read; null when none showed it within `READ_BACK`.
   *
   * A read that fails has not shown the write, and no more than that: thrown
   * from here, its error passed for the write's own, and a write that had
   * gone through was reported as one that failed.
   */
  async #readsBack(
    brainId: string,
    thoughtId: string,
    landed: (thought: ThoughtDto) => boolean,
  ): Promise<ThoughtDto | null> {
    const started = Date.now();
    const deadline = started + READ_BACK.timeoutMs;
    for (;;) {
      const thought = await this.get(brainId, thoughtId).catch(() => null);
      if (thought !== null && landed(thought)) return thought;
      const now = Date.now();
      if (now >= deadline) return null;
      const pause = Math.min(
        READ_BACK.stepMs * 2 ** Math.floor((now - started) / 1000),
        READ_BACK.maxStepMs,
        deadline - now,
      );
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  /**
   * `thought`, or a later read of it, past a write of `field` this process
   * made and has not seen read back.
   *
   * A field written whole is changed by a read, then a write: the alias
   * list, and the type, whose removal trusts its first read. Built on a read
   * from before a write that has not shown yet, the change undoes that write
   * (aliases), or finds nothing to change and passes for done (a type). So
   * while `thought` still reads as before such a write, this waits for a
   * read past it, and throws `not_read_back` when none comes: the change is
   * not sent. An alias list that is neither the one before the write nor the
   * one written is someone else's change since, and is taken; of a type only
   * the one written is known. Any read is taken past `UNREAD_KEPT_MS`.
   * Another process's writes are not known here.
   */
  async #pastUnread(
    field: UnreadField,
    brainId: string,
    thoughtId: string,
    thought: ThoughtDto,
  ): Promise<ThoughtDto> {
    const key = unreadKey(field, brainId, thoughtId);
    const unread = this.#unread.get(key);
    if (unread === undefined) return thought;
    if (Date.now() - unread.at > UNREAD_KEPT_MS || !unread.behind(thought)) {
      this.#unread.delete(key);
      return thought;
    }
    const past = await this.#readsBack(brainId, thoughtId, (t) => !unread.behind(t));
    if (past === null) {
      const ago = Math.round((Date.now() - unread.at) / 1000);
      throw new TheBrainError(
        "not_read_back",
        `this server's write to the thought's ${field} ${ago} s ago does not read back yet: ` +
          `${READ_LAG}. A change built on what the thought reads now would undo that write, ` +
          `so this one was not sent. Send it again once brain_get_thought shows ${unread.shown}`,
      );
    }
    this.#unread.delete(key);
    return past;
  }

  #markUnread(field: UnreadField, brainId: string, thoughtId: string, unread: Unread): void {
    for (const [key, { at }] of this.#unread) {
      if (unread.at - at > UNREAD_KEPT_MS) this.#unread.delete(key);
    }
    this.#unread.set(unreadKey(field, brainId, thoughtId), unread);
  }

  async delete(brainId: string, thoughtId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    // Ahead of the request, and whatever comes of it: one that got no answer
    // may have deleted the thought, and no graph is to be held to listing it.
    this.client.written.forget(brainId, thoughtId);
    await this.client.delete(`/api/thoughts/${brainId}/${thoughtId}`);
  }

  /** The brain's types. An empty list arrives as 400; normalised to [] here. */
  async listTypes(brainId: string): Promise<ThoughtDto[]> {
    assertUuid(brainId, "brainId");
    return emptyOn400(this.client.get<ThoughtDto[]>(`/api/thoughts/${brainId}/types`));
  }

  /** The brain's tags. An empty list arrives as 400; normalised to [] here. */
  async listTags(brainId: string): Promise<ThoughtDto[]> {
    assertUuid(brainId, "brainId");
    return emptyOn400(this.client.get<ThoughtDto[]>(`/api/thoughts/${brainId}/tags`));
  }

  async listPinned(brainId: string): Promise<ThoughtDto[]> {
    assertUuid(brainId, "brainId");
    return emptyOn400(this.client.get<ThoughtDto[]>(`/api/thoughts/${brainId}/pins`));
  }

  async pin(brainId: string, thoughtId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    await this.client.post(`/api/thoughts/${brainId}/${thoughtId}/pin`);
  }

  async unpin(brainId: string, thoughtId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    await this.client.delete(`/api/thoughts/${brainId}/${thoughtId}/pin`);
  }

  async modifications(
    brainId: string,
    thoughtId: string,
    options: { maxLogs?: number; includeRelated?: boolean } = {},
  ): Promise<ModificationLogDto[]> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    return this.client.get<ModificationLogDto[]>(
      `/api/thoughts/${brainId}/${thoughtId}/modifications`,
      {
        query: {
          maxLogs: options.maxLogs ?? 100,
          includeRelatedLogs: options.includeRelated ?? true,
        },
      },
    );
  }
}

/** Throws `bad_request` for a name `nameRefusal` has a reason against, before anything is sent. */
function assertName(name: string): void {
  const refusal = nameRefusal(name, "name");
  if (refusal !== null) throw new TheBrainError("bad_request", refusal);
}

/** How aliases are compared: the API deduplicates them ignoring case. */
function aliasKey(alias: string): string {
  return alias.trim().toLocaleLowerCase();
}

/**
 * Aliases as the API stores them: trimmed, blanks dropped, and the first
 * spelling kept when two differ only in case.
 */
export function normalizeAliases(aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (alias === "" || seen.has(aliasKey(alias))) continue;
    seen.add(aliasKey(alias));
    out.push(alias);
  }
  return out;
}

/**
 * Reconstructs a brain's contents from the modification log.
 *
 * The API has no "list all thoughts" endpoint. Over the whole log
 * (`brains.allModifications`), `created` minus `deleted` yields the thoughts
 * that were created in this brain and still exist. Imported and old brains hold
 * thoughts the log never recorded, which is why a rebuild also walks the graph
 * (ARCHITECTURE.md §7).
 *
 * Cross-checked against `statistics`: the log covers thoughts of every kind,
 * whereas `statistics.thoughts` counts only `kind = Normal`.
 */
export function replayThoughtIds(logs: readonly ModificationLogDto[]): Set<string> {
  const alive = new Set<string>();
  // Not through `Date`: it drops microseconds, and a create and a delete in the
  // same millisecond would then replay in whatever order they arrived.
  const ordered = [...logs].sort((a, b) => compareLogTime(logTime(a), logTime(b)));
  for (const log of ordered) {
    if (log.sourceType !== 2) continue;
    if (log.modType === ModType.Created) alive.add(log.sourceId);
    else if (log.modType === ModType.Deleted) alive.delete(log.sourceId);
  }
  return alive;
}
