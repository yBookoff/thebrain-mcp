/**
 * Read tools.
 *
 * Descriptions deliberately say **when** to call a tool, not only what it
 * does: that is what drives the model's routing. They sit in context
 * permanently, so they are written tightly.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TheBrainError } from "../../api/errors.js";
import { compareLogTime, logTime } from "../../api/log.js";
import {
  ThoughtKind,
  aliasesOf,
  type ModificationLogDto,
  type ThoughtDto,
} from "../../api/types.js";
import {
  describeChange,
  isSettingNoise,
  loggedThoughts,
  subjectIds,
  type LoggedThought,
} from "../../operations/changes.js";
import { traverse, type TraverseUnread } from "../../operations/traverse.js";
import {
  mapWithConcurrency,
  type IndexResult,
  type IndexStatus,
  type UnreadThought,
} from "../../semantic/indexer.js";
import type { EmbedderUnavailableError } from "../../semantic/embedder.js";
import {
  SearchFailedError,
  type PhrasingFailure,
  type SearchOutcome,
} from "../../semantic/search.js";
import { IndexBusyError, IndexRunningError } from "../../semantic/store.js";
import type { ServerContext } from "../context.js";
import { brainId, identifier } from "../identifier.js";
import {
  bullet,
  childrenTitle,
  describeError,
  fail,
  guard,
  join,
  kindLabel,
  kindMark,
  labelMark,
  labelOf,
  ok,
  section,
  sentence,
  shownName,
  table,
  TYPE_LABEL,
} from "../respond.js";


/**
 * Cap on how many thoughts `brain_recent_changes` reads in a call: beyond this
 * the output is unreadable anyway. A thought past it still has the name the
 * log kept for it, if it was created or renamed in what was read.
 */
const MAX_RESOLVED_NAMES = 60;

/**
 * What `brain_recent_changes` prints for a thought it has not read. Neither is
 * `(unnamed)`, which here as in the other tools is a thought that is there and
 * has no name.
 *
 * `DELETED`: the log's last word on the thought is its deletion, or the read
 * of it answered 404, as it does for an identifier nobody has
 * (docs/api-map.md, L3). The log is this brain's, so the thought was here and
 * is not now. It stands after the name the thought had, when the log has it.
 *
 * `NOT_READ`: the thought was not read, being past the cap, or its read failed
 * some other way, and the log has no name for it either. Nothing is known of
 * the thought, least of all that it is gone.
 */
const DELETED = "(deleted)";
const NOT_READ = "(name not read)";

/** A thought as `brain_recent_changes` names it. */
interface ChangedThought {
  name: string;
  /** ` [type]` or ` [tag]`, known only of a thought that was read. */
  mark: string;
  /** `unread`: neither read nor deleted by the log's account. */
  state: "there" | "gone" | "unread";
}

/**
 * The name the log has for a thought, or null, printed as a name a read gave
 * is: one with no character that shows is spelled out. One as long as the log
 * keeps is followed by an ellipsis: the thought's own name may go on (L37).
 */
function nameInLog(logged: LoggedThought | undefined): string | null {
  if (logged === undefined || logged.name === null) return null;
  return logged.cut ? `${shownName(logged.name)}…` : shownName(logged.name);
}

/** The read's answer for an identifier nobody has: a 404, or zeros refused ahead of it. */
function nobodyHasIt(error: unknown): boolean {
  return (
    error instanceof TheBrainError &&
    (error.kind === "not_found" || error.kind === "invalid_uuid")
  );
}

/**
 * Cap on search phrasings. Each one costs an embedding and a full scan in
 * vector mode, run one after another, or a request to TheBrain's search in the
 * fallback.
 */
const MAX_VARIANTS = 10;

/** How much of a phrasing a result quotes: a passage given for one is not sent back whole. */
const QUOTED_CHARS = 60;

function quoted(phrasing: string): string {
  if (phrasing.length <= QUOTED_CHARS) return JSON.stringify(phrasing);
  const start = JSON.stringify(`${phrasing.slice(0, QUOTED_CHARS)}…`);
  return `${start} (${phrasing.length} characters)`;
}

/** Why a phrasing got no answer, as any tool would explain that failure. */
function reason(failure: PhrasingFailure): string {
  return sentence(describeError(failure.error));
}

/** One line for each phrasing that got no answer: the phrasing, and why. */
function failureLines(failures: readonly PhrasingFailure[]): string {
  return bullet(failures.map((f) => `${quoted(f.phrasing)}: ${reason(f)}`)) ?? "";
}

/**
 * What `brain_search` answers when no phrasing was answered. It is an error,
 * and it says that nothing was searched: read as an empty result, a search
 * that never ran tells the model the brain holds no such thought.
 *
 * One reason for all of them is given once. That is TheBrain not running, or
 * failing: the failures that are not one phrasing's own.
 */
function nothingSearched(error: SearchFailedError): string {
  const lead = "Nothing was searched, and this is no answer about what the brain holds";
  const count = error.failures.length;
  const reasons = new Set(error.failures.map(reason));
  if (reasons.size > 1) {
    return `${lead}. Each of the ${count} phrasings failed:\n${failureLines(error.failures)}`;
  }
  const [shared] = reasons;
  const all = count > 1 ? ` Each of the ${count} phrasings failed this way.` : "";
  return `${lead}: ${shared}${all}`;
}

/**
 * The phrasings that were left out of a result, or null when none was.
 * Without it "not found" reads as certain, and one phrasing more might have
 * found the thought.
 */
function notSearchedSection(outcome: SearchOutcome): string | null {
  const skipped = outcome.notSearched.length;
  if (skipped === 0) return null;
  const rest = outcome.phrasings - skipped;
  return section(
    "Not searched",
    `${skipped} of ${outcome.phrasings} phrasings got no answer from TheBrain's search, ` +
      `so this result is from the other ${rest === 1 ? "one" : rest} only:\n` +
      failureLines(outcome.notSearched),
  );
}

/**
 * The body of the result's first section. With no hit the fallback says so
 * in words, and of how many phrasings: it used to print no section at all,
 * which is also all it printed when every request had failed.
 *
 * When every hit was a thought that is gone, that is said in either mode, and
 * not that nothing matched.
 *
 * Ranking by vectors has a best row for any query, so there it lists nothing
 * only when the index has no row a search ranks: by default the ordinary
 * thoughts, and an index can hold types and tags alone. That used to be a
 * result with no text in it at all. `hits` is the table of the matches, null
 * for none; `auxiliary` is whether types and tags were asked for.
 */
function foundBody(outcome: SearchOutcome, hits: string | null, auxiliary: boolean): string {
  if (hits !== null) return hits;
  const gone = outcome.gone.length;
  if (gone > 0) {
    return gone === 1
      ? "Nothing that is still there: the one hit was a thought that is gone."
      : `Nothing that is still there: each of the ${gone} hits was a thought that is gone.`;
  }
  if (outcome.mode === "vector") {
    return auxiliary
      ? "Nothing: the semantic index had no row to rank. Call brain_index with action=status " +
          "to see what it holds."
      : "Nothing: the semantic index holds only types and tags, and a search leaves those out " +
          "unless includeAuxiliary is true. A thought added since the index was last synced " +
          "is not in it: call brain_index with action=sync.";
  }
  const answered = outcome.phrasings - outcome.notSearched.length;
  if (outcome.phrasings === 1) return "Nothing: TheBrain's search matched no thought.";
  const which = answered === outcome.phrasings ? "" : " it answered";
  return answered === 1
    ? `Nothing: TheBrain's search matched no thought for the one phrasing${which}.`
    : `Nothing: TheBrain's search matched no thought for any of the ${answered} phrasings${which}.`;
}

/**
 * The hits that were left out because their thoughts are gone, or null when
 * none was. Counted and not listed: an identifier nobody has is of no use,
 * and a result is where identifiers are taken from.
 *
 * What it says to do goes by the source. TheBrain's own search drops a
 * deleted thought by itself or not at all, and there is nothing to call for
 * it. The index is brought up to date by a sync (docs/api-map.md, L34).
 */
function leftOutSection(outcome: SearchOutcome): string | null {
  const gone = outcome.gone.length;
  if (gone === 0) return null;
  const one = gone === 1;
  const lead = `${gone} ${one ? "hit was" : "hits were"} left out: `;
  const read = `and the read of ${one ? "the" : "each"} thought answered 404`;
  return section(
    "Left out",
    outcome.mode === "vector"
      ? `${lead}the semantic index holds ${one ? "it" : "them"}, ${read}. The index holds a ` +
          "deleted thought until its next sync: call brain_index with action=sync."
      : `${lead}TheBrain's search returned ${one ? "it" : "them"}, ${read}. Its search goes ` +
          "on returning a deleted thought for about five seconds, and now and then for good.",
  );
}

/** What a hit's row has in the `Verified` column when its thought could not be read. */
const NOT_VERIFIED = "no";

/**
 * Why the read of a hit's thought failed, with no identifier in it, so that
 * the same failure of many hits is one reason.
 */
function whyUnverified(error: unknown): string {
  return error instanceof TheBrainError && error.kind === "network"
    ? sentence(describeError(error))
    : answered(error);
}

/**
 * The hits whose thoughts could not be read, or null when every one was.
 * Each has `no` under `Verified` in its row. Without this a hit for a thought
 * that may be gone reads like any other.
 *
 * One reason for all of them is given once, as for the phrasings above.
 */
function notVerifiedSection(outcome: SearchOutcome): string | null {
  const failed = outcome.unverified.length;
  if (failed === 0) return null;
  const listed = outcome.matches.length;
  const lead =
    listed === 1
      ? "The read of the thought above failed, so this result does not say whether it is " +
        "still there"
      : failed === listed
        ? `The read of each of the ${listed} thoughts above failed, so this result does not ` +
          "say whether any of them is still there"
        : `The read of ${failed} of the ${listed} thoughts above failed, so this result does ` +
          `not say whether ${failed === 1 ? "it is" : "they are"} still there`;
  const next = "Read a thought with brain_get_thought before using its identifier.";
  const reasons = new Set(outcome.unverified.map((u) => whyUnverified(u.error)));
  if (reasons.size > 1) {
    const lines = outcome.unverified.map((u) => `${u.thoughtId}: ${whyUnverified(u.error)}`);
    return section("Not verified", `${lead}:\n${bullet(lines)}\n${next}`);
  }
  const [shared] = reasons;
  return section("Not verified", `${lead}: ${shared} ${next}`);
}

/** A read that was answered, or the failure that came in its place. */
type Read<T> = { value: T } | { error: unknown };

/**
 * Keeps a read's failure beside the reads that are awaited with it, so that
 * the result can say what was not read. Dropped, it used to pass for the
 * answer of something that is not there: `.catch(() => "")` made a note that
 * was not read a thought with no note.
 */
function kept<T>(read: Promise<T>): Promise<Read<T>> {
  return read.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

/**
 * What `brain_get_thought` says under the types of a thought with two. A
 * patch of `typeId` leaves two links: asked for the other of the two it
 * changes nothing, and asked for a third, one of the two goes and the third
 * comes in its place (docs/api-map.md, L44), so `update()` refuses a type
 * while both are there. Deleting the links is what takes either away, and
 * `removeType` deletes both.
 */
const TWO_TYPES =
  "TheBrain links this thought under both. typeId null in brain_update_thought removes " +
  "both, and a type is set only once they are gone: to keep one, remove both, then set it.";

/**
 * What `brain_get_thought` prints where the note goes when the note's read
 * failed. No section at all is what a thought with no note prints, and the
 * model acts on that with a write that erases the note.
 */
function noteNotRead(error: unknown): string | null {
  return section(
    "Note not read",
    "The read of this thought's note failed, so this result does not say whether it has " +
      `one: ${sentence(describeError(error))} The rest is as TheBrain returned it. Call ` +
      "brain_get_thought again before relying on the note or replacing it.",
  );
}

/**
 * What `brain_list` adds when the app's state could not be read. Without it
 * no row is marked open and no active thought is printed, which is also what
 * an app with no brain open prints.
 */
function stateNotRead(error: unknown): string | null {
  return section(
    "Open brain not read",
    "Which brain is open in the app, and its active thought, could not be read: " +
      `${sentence(describeError(error))} The brains above are all of them.`,
  );
}

/**
 * The thoughts a walk reached and could not look around, or null when it
 * read them all. Each is listed in its hop like any other, and without this
 * it reads as one with nothing next to it.
 *
 * One reason for all of them is given once, as `brain_search` gives it.
 */
function notReadSection(unread: readonly TraverseUnread[]): string | null {
  if (unread.length === 0) return null;
  const one = unread.length === 1;
  const lead =
    `${one ? "The graph of one thought" : `The graphs of ${unread.length} thoughts`} on the ` +
    `way could not be read, so what lies beyond ${one ? "it" : "them"} is missing from this result`;
  const named = (u: TraverseUnread): string => `${shownName(u.name)} — ${u.id}`;
  const why = (u: TraverseUnread): string => sentence(describeError(u.error));
  const reasons = new Set(unread.map(why));
  if (reasons.size > 1) {
    return section("Not read", `${lead}:\n${bullet(unread.map((u) => `${named(u)}: ${why(u)}`))}`);
  }
  const [shared] = reasons;
  return section("Not read", `${lead}: ${shared}\n${bullet(unread.map(named))}`);
}

/**
 * Built is a build that finished. A rebuild writes its metadata ahead of its
 * first row and its watermark last, and that only when it read every
 * thought: one that stopped in between, or left a thought unread, has the
 * first and not the second.
 */
function indexBuilt(s: IndexStatus): boolean {
  return s.exists && s.syncedThrough !== null;
}

/** What `brain_search` asks of an index before it ranks by it. */
function indexUsable(s: IndexStatus): boolean {
  return s.compatible && s.size > 0;
}

/**
 * What status says to do, or null when there is nothing to. `ready` is an
 * index that is built and that a search can rank by; `why` is the embedder's
 * reason for encoding nothing, or null.
 *
 * The package comes first, whatever the index: without it a rebuild is
 * refused and `brain_search` does not rank by vectors, so "rebuild" alone
 * sent the model to a call that fails.
 */
function afterStatus(ready: boolean, why: EmbedderUnavailableError | null): string | null {
  if (why === null) return ready ? null : "Call this tool with action=rebuild.";
  const install =
    why.loadFailure === null
      ? `Install the embeddings package: ${why.installCommand}.`
      : `The embeddings package failed to load: ${sentence(why.loadFailure)} ` +
        `Install it again: ${why.installCommand}.`;
  return ready
    ? `${install} Until then brain_search answers from TheBrain's own search, and does not ` +
        "rank by this index."
    : `${install} Then call this tool with action=rebuild.`;
}

/**
 * The index of a brain in a row of `brain_list`. It printed `index: 0` for a
 * build that never finished, which reads as an index of a brain with nothing
 * in it.
 */
function indexCell(s: IndexStatus): string {
  const unfinished = s.exists && s.compatible && !indexBuilt(s);
  if (indexUsable(s)) return `index: ${s.size}${unfinished ? ", build not finished" : ""}`;
  return unfinished ? "build not finished" : "no index";
}

/** How many of the thoughts a run left unread its result lists by identifier. */
const MAX_UNREAD_LISTED = 20;

/**
 * What TheBrain answered in place of a read, in its own words where they say
 * something. The catch-all 403 is not quoted: its text is about the key, and
 * the key is not what it is about (docs/api-map.md, L3).
 */
function answered(error: unknown): string {
  if (!(error instanceof TheBrainError)) {
    return sentence(error instanceof Error ? error.message : String(error));
  }
  if (error.kind === "forbidden") return "TheBrain answered 403 and named no cause.";
  if (error.status === undefined || error.status < 400) return sentence(error.message);
  return `TheBrain answered ${error.status}: ${sentence(error.message)}`;
}

/**
 * Why a thought was left unread, with no identifier in it, so that the same
 * failure of many thoughts is one reason. A 403 is said for what it is here:
 * the indexer has asked for the thought itself, and a thought that is not
 * there is not in this list.
 */
function whyUnread(u: UnreadThought): string {
  const refused = u.error instanceof TheBrainError && u.error.kind === "forbidden";
  if (u.read === "note") {
    return (
      `The read of the note failed: ${answered(u.error)}` +
      (refused ? " A note's read gets that answer for a moment after the note is deleted." : "")
    );
  }
  if (u.read === "thought") {
    return (
      "The read of the graph was a 403 that names no cause, and the read of the thought " +
      `itself failed: ${answered(u.error)}`
    );
  }
  return refused
    ? "The read of the graph failed: TheBrain answered 403 and named no cause, while the " +
        "thought itself reads."
    : `The read of the graph failed: ${answered(u.error)}`;
}

/**
 * What `brain_index` answers for a run that left thoughts unread. It is an
 * error, and its title does not say built or refreshed: it used to say both
 * of a run that had read nothing, with a watermark moved past what it had
 * not read.
 *
 * It says what was written, which thoughts were left and why, and what to
 * call next. One reason for all of them is given once, as `brain_search`
 * gives it.
 */
function leftUnread(r: IndexResult, after: IndexStatus): string {
  const rebuild = r.ran === "rebuild";
  const left = r.unread.length;
  const none = left === r.asked;
  const run = rebuild ? "rebuild" : "sync";

  const title = none
    ? `Index not ${rebuild ? "rebuilt" : "refreshed"}`
    : `Index ${rebuild ? "rebuilt" : "refreshed"} in part`;
  const done = none
    ? [`thoughts read: 0 of ${r.asked}`, "written to the index: nothing, it is as it was"]
    : [
        `thoughts read: ${r.asked - left} of ${r.asked}`,
        `thoughts encoded: ${r.indexed}`,
        ...(r.kindUpdated > 0 ? [`kind updated, nothing to encode: ${r.kindUpdated}`] : []),
        `skipped unchanged: ${r.skipped}`,
        `removed from index: ${r.removed}`,
      ];

  const one = left === 1;
  const lead = none
    ? `None of the ${r.asked} thoughts the ${run} asked TheBrain for could be read.`
    : `${left} of the ${r.asked} thoughts the ${run} asked TheBrain for could not be read. ` +
      `What the index holds for ${one ? "it" : "them"} is what it held before this run, ` +
      "which for a thought not yet indexed is nothing.";
  const named = (u: UnreadThought): string => (u.name ? `${shownName(u.name)} — ${u.id}` : u.id);
  const reasons = new Set(r.unread.map(whyUnread));
  const listed = r.unread.slice(0, MAX_UNREAD_LISTED);
  const more = left > listed.length ? [`and ${left - listed.length} more, not listed`] : [];
  const [shared] = reasons;
  const list =
    reasons.size > 1
      ? `\n${bullet([...listed.map((u) => `${named(u)}: ${whyUnread(u)}`), ...more])}`
      : ` ${shared}\n${bullet([...listed.map(named), ...more])}`;
  // A rebuild finds the thoughts the log does not list through graphs alone,
  // and removes a row for what its walk did not reach only when it was whole.
  const kept = r.keptUnreached;
  const unwalked =
    rebuild && r.unread.some((u) => u.read !== "note")
      ? "\nWhat is next to a thought whose graph was not read was not walked to from it, so a " +
        "thought the log does not list may be missing as well." +
        (kept > 0
          ? ` ${kept} ${kept === 1 ? "row of a thought" : "rows of thoughts"} the walk did not ` +
            `reach ${kept === 1 ? "was" : "were"} left in the index, not removed.`
          : "")
      : "";

  const through = after.syncedThrough;
  const next = !rebuild
    ? `Call this tool with action=sync again. The index is still synced through ${through}: ` +
      "this run did not move that on, so the next one reads the same changes again."
    : through === null
      ? "Call this tool with action=rebuild again. The index is not built until a rebuild " +
        "has read every thought" +
        (indexUsable(after) ? "; brain_search ranks by what is in it meanwhile." : ".")
      : "Call this tool with action=rebuild again. action=sync would not go back for " +
        `${one ? "this thought" : "these thoughts"}: it reads what changed since ${through}, ` +
        "which this run did not move on.";

  return join([
    section(title, bullet([...done, `took: ${(r.elapsedMs / 1000).toFixed(1)} s`])),
    section("Not read", `${lead}${list}${unwalked}`),
    section("What to do", next),
  ]);
}

/**
 * What `brain_index` answers when another run has the index and this one
 * gave up waiting for it. Every client session runs its own server over the
 * same index file, and a run holds the index from its first look at it to
 * its last write (`SemanticIndexer`), so this run did nothing at all.
 */
function heldByAnotherRun(error: IndexRunningError, action: "rebuild" | "sync"): string {
  return (
    `${error.message} This ${action} read nothing and wrote nothing. brain_search ranks by ` +
    `the index as it stands meanwhile. Call this tool with action=${action} again once that ` +
    "run is done."
  );
}

/**
 * And when a statement of the run waited out a lock on the index file. No run
 * holds that: it is a single write of another process, a thought's row
 * removed after its deletion, or a server from before runs were kept apart.
 * The run stopped where it was, with its earlier batches written and the
 * watermark, which is written last, not moved.
 */
function stoppedAtLock(error: IndexBusyError, action: "rebuild" | "sync"): string {
  return (
    `${error.message} The ${action} stopped there: what it had already written stays in the ` +
    "index, and the index is not marked as synced any further than it was. Call this tool " +
    `with action=${action} again: it encodes only what is still missing.`
  );
}

export function registerReadTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "brain_list",
    {
      description:
        "Lists the user's brains and which one is currently open in the app. " +
        "Call this first in any session: every other tool needs a brainId and " +
        "guessing one is not allowed. Also shows whether the semantic index is ready.",
      inputSchema: {},
    },
    guard(async () => {
      const [brains, appState] = await Promise.all([
        ctx.api.brains.list(),
        kept(ctx.api.app.state()),
      ]);
      const state = "value" in appState ? appState.value : null;

      const rows = brains.map((b) => {
        return [
          b.name ?? "(unnamed)",
          b.id,
          b.id === state?.currentBrainId ? "open" : "",
          // A look at a local file, and one that creates none.
          indexCell(ctx.indexer(b.id).status(b.id)),
        ];
      });

      return ok(
        join([
          section("Brains", table(["Name", "Identifier", "", "Semantic"], rows)),
          state?.activeThoughtName
            ? section(
                "Active thought",
                `${shownName(state.activeThoughtName)} (${state.activeThoughtId})`,
              )
            : null,
          // The list is whole without it, so this is no error: nothing is
          // written by which brain is open, and brainId is never taken from it.
          "error" in appState ? stateNotRead(appState.error) : null,
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_get_thought",
    {
      description:
        "A thought in full: note, aliases, parents, children, jumps, tags, type and attachments in one call. " +
        "The main way to understand a thought's context. Call it when you need to know " +
        "what a thought is about and how it connects, before changing or extending it.",
      inputSchema: {
        brainId,
        thoughtId: identifier().describe("Thought identifier."),
        includeSiblings: z
          .boolean()
          .optional()
          .describe("Include siblings under the same parent. Off by default — there can be many."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, includeSiblings }) => {
      const [graph, note] = await Promise.all([
        ctx.api.thoughts.getGraph(bid, thoughtId, {
          includeSiblings: includeSiblings ?? false,
        }),
        // Kept when it fails: a thought with no note is a 200 from this read
        // (docs/api-map.md, L3), so a failure is never that answer. The
        // graph's own failure is the call's, as it was.
        kept(ctx.api.notes.get(bid, thoughtId)),
      ]);

      // A type or a tag among them is marked: any of these lists can hold one,
      // and a write refuses it where an ordinary thought was meant. A label
      // that is not the name follows: it is what tells two of one name apart.
      const names = (list: readonly ThoughtDto[]): string[] =>
        list.map((t) => `${shownName(t.name)} — ${t.id}${kindMark(t.kind)}${labelMark(t)}`);

      // The thought's own label, read back as it was written. A type's may be
      // a name it had, which TheBrain keeps there through a rename (L38).
      const label = labelOf(graph.thought);
      const labelBody =
        label === null
          ? null
          : graph.thought.kind === ThoughtKind.Type
            ? `${label}\n${TYPE_LABEL}`
            : label;

      // With its identifier: that is what a typeId takes. A thought made
      // under one type with another for its typeId has two, and the second
      // stood among the parents.
      const types = [...(graph.type === null ? [] : [graph.type]), ...graph.otherTypes];
      const typeLine = (t: { name: string | null; id: string }): string =>
        `${shownName(t.name)} — ${t.id}`;

      // A thought printed without its note is an error, so that it is not
      // read as the thought in full: the rest is there, and the note is not.
      return ("error" in note ? fail : ok)(
        join([
          `# ${shownName(graph.thought.name)}\n${graph.thought.id}${kindMark(graph.thought.kind)}`,
          section("Label", labelBody),
          // One per line: an alias may hold a comma, and the list gets edited by value.
          section("Aliases", bullet(aliasesOf(graph.thought))),
          types.length > 1
            ? section("Types", `${bullet(types.map(typeLine))}\n${TWO_TYPES}`)
            : types.length === 1
              ? section("Type", typeLine(types[0]!))
              : null,
          graph.tags.length > 0
            ? section("Tags", graph.tags.map((t) => shownName(t.name)).join(", "))
            : null,
          section("Parents", bullet(names(graph.parents))),
          section(childrenTitle(graph.thought.kind), bullet(names(graph.children))),
          section("Jumps", bullet(names(graph.jumps))),
          includeSiblings ? section("Siblings", bullet(names(graph.siblings))) : null,
          // Less the note, which the API lists among them (`isNotes`): it
          // stood here as "(unnamed) — Notes.md", beside its own section.
          section(
            "Attachments",
            bullet(
              graph.attachments
                .filter((a) => !a.isNotes)
                .map((a) => `${a.name ?? "(unnamed)"}${a.location ? ` — ${a.location}` : ""}`),
            ),
          ),
          // As the read returns it. "" is no note, and a note of white space
          // alone, which TheBrain keeps in its file and reads as "" (contract
          // test). Anything else is the note, "(empty)" too, spelled out when
          // nothing in it shows: a note of a byte order mark alone reads back
          // as one, and trim() took it for none.
          "error" in note
            ? noteNotRead(note.error)
            : section("Note", note.value === "" ? null : shownName(note.value)),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_search",
    {
      description:
        "Finds thoughts by meaning. Call it when looking for something by description " +
        "rather than exact title — for instance to check whether a thought on this topic " +
        "already exists. Always pass variants: several phrasings of the same concept " +
        "(synonyms, translation, a broader and a narrower term). They raise recall " +
        "noticeably, and if the semantic index is not built they are all that works.",
      inputSchema: {
        brainId,
        query: z.string().describe("What you are looking for, in your own words."),
        variants: z
          .array(z.string())
          .max(MAX_VARIANTS)
          .optional()
          .describe(
            "Other phrasings of the same concept: synonyms, a translation into the " +
              `second language, a broader and a narrower term. Three to six of them, at most ${MAX_VARIANTS}.`,
          ),
        limit: z.number().int().min(1).max(50).optional().describe("Defaults to 15."),
        includeAuxiliary: z
          .boolean()
          .optional()
          .describe("Include types and tags in results. By default only ordinary thoughts."),
      },
    },
    guard(async ({ brainId: bid, query, variants, limit, includeAuxiliary }) => {
      let outcome: SearchOutcome;
      try {
        outcome = await ctx.search(bid).find(bid, query, {
          ...(variants !== undefined ? { variants } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(includeAuxiliary !== undefined ? { includeAuxiliary } : {}),
        });
      } catch (error) {
        if (error instanceof SearchFailedError) return fail(nothingSearched(error));
        throw error;
      }

      // The column is there only when a hit is not an ordinary thought, and a
      // type or a tag is one only with includeAuxiliary: a result of ordinary
      // thoughts reads as it did.
      const kinds = outcome.matches.map((m) => kindLabel(m.kind));
      const kindColumn = kinds.some((k) => k !== null);
      // The same for a hit whose thought could not be read: a column that is
      // there only when there is one, so that it is not read as a thought to
      // use. A hit whose thought is gone is not in the table at all.
      const unverified = new Set(outcome.unverified.map((u) => u.thoughtId));
      const verifiedColumn = unverified.size > 0;
      const rows = outcome.matches.map((m, i) => [
        m.score.toFixed(3),
        m.name,
        m.thoughtId,
        ...(kindColumn ? [kinds[i] ?? ""] : []),
        ...(verifiedColumn ? [unverified.has(m.thoughtId) ? NOT_VERIFIED : ""] : []),
        m.matchedVariant ?? "",
      ]);

      return ok(
        join([
          section(
            outcome.mode === "vector" ? "Found by meaning" : "Found by substring",
            foundBody(
              outcome,
              table(
                [
                  "Score",
                  "Thought",
                  "Identifier",
                  ...(kindColumn ? ["Kind"] : []),
                  ...(verifiedColumn ? ["Verified"] : []),
                  "Matched",
                ],
                rows,
              ),
              includeAuxiliary === true,
            ),
          ),
          notVerifiedSection(outcome),
          leftOutSection(outcome),
          notSearchedSection(outcome),
          outcome.degradedReason === null
            ? null
            : section(
                "Warning",
                // The reason may be a sentence already: the embedder's own
                // ended "…without it.. Fell back".
                `Semantic search unavailable: ${sentence(outcome.degradedReason)} ` +
                  "Fell back to substring name search, so recall is lower. " +
                  // For want of the package the index is one to rank by, and
                  // "Build the index" sent the model to a rebuild.
                  (outcome.embedderFailure === null
                    ? "Build the index with the brain_index tool."
                    : "The index is there and needs no rebuild: install the package with " +
                      `${outcome.embedderFailure.installCommand}.`),
              ),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_traverse",
    {
      description:
        "Walks the graph several hops out from a thought. Call it when you need to see " +
        "the whole neighbourhood: which region of the brain adjoins a topic, where new " +
        "material should slot in, what already sits nearby. Viewing a thought shows one hop only.",
      inputSchema: {
        brainId,
        thoughtId: identifier().describe("Where to start."),
        depth: z.number().int().min(1).max(4).optional().describe("Hops. Defaults to 2."),
        follow: z
          .array(z.enum(["child", "parent", "jump"]))
          .optional()
          .describe("Which link kinds to follow. All of them by default."),
        maxNodes: z
          .number()
          .int()
          .min(10)
          .max(500)
          .optional()
          .describe("Safety valve. Defaults to 150."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, depth, follow, maxNodes }) => {
      const result = await traverse(ctx.api, bid, thoughtId, {
        ...(depth !== undefined ? { depth } : {}),
        ...(follow !== undefined ? { follow } : {}),
        ...(maxNodes !== undefined ? { maxNodes } : {}),
      });

      const byDepth = new Map<number, string[]>();
      for (const node of result.nodes) {
        if (node.depth === 0) continue;
        const named = `${shownName(node.name)} — ${node.id}${kindMark(node.kind)}`;
        const line = node.path.length > 0
          ? `${named}  (via ${node.path.map((name) => shownName(name)).join(" -> ")})`
          : named;
        byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), line]);
      }

      const root = result.nodes.find((n) => n.depth === 0);
      const labelled = result.edges.filter((e) => e.name !== null);

      return ok(
        join([
          `# Neighbourhood of: ${root ? shownName(root.name) + kindMark(root.kind) : thoughtId}`,
          ...[...byDepth.entries()]
            .sort(([a], [b]) => a - b)
            .map(([d, items]) => section(`Hop ${d}`, bullet(items))),
          labelled.length > 0
            ? section(
                "Labelled links",
                bullet(
                  labelled.map((e) => {
                    const end = (id: string): string => {
                      const node = result.nodes.find((n) => n.id === id);
                      return node === undefined ? id : shownName(node.name);
                    };
                    return `${end(e.from)} -> ${e.name} -> ${end(e.to)}`;
                  }),
                ),
              )
            : null,
          notReadSection(result.unread),
          section(
            "Totals",
            `thoughts ${result.nodes.length}, links ${result.edges.length}` +
              (result.truncated ? " (traversal hit the limit, there is more)" : "") +
              (result.unread.length > 0
                ? ` (${result.unread.length} not read, there may be more beyond)`
                : ""),
          ),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_list_types_and_tags",
    {
      description:
        "The brain's vocabulary: which thought types and tags exist. Call it before " +
        "creating thoughts so you use this brain's established conventions instead of " +
        "inventing new ones.",
      inputSchema: { brainId },
    },
    guard(async ({ brainId: bid }) => {
      const [types, tags] = await Promise.all([
        ctx.api.thoughts.listTypes(bid),
        ctx.api.thoughts.listTags(bid),
      ]);
      // A label that is not the name follows the identifier. Every type has
      // one, its name, and a renamed type keeps the name it had there (L38):
      // the vocabulary is where that shows across the brain.
      const line = (t: ThoughtDto): string => `${shownName(t.name)} — ${t.id}${labelMark(t)}`;
      const relabelled = types.some((t) => labelOf(t) !== null);
      return ok(
        join([
          section(
            "Types",
            relabelled ? `${bullet(types.map(line))}\n${TYPE_LABEL}` : bullet(types.map(line)),
          ),
          section("Tags", bullet(tags.map(line))),
          types.length === 0 && tags.length === 0
            ? section("Note", "This brain has no types or tags yet.")
            : null,
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_recent_changes",
    {
      description:
        "What changed in the brain over a period, in plain language. Call it for digests " +
        '("what did I add this week") and to understand what work was in progress ' +
        "before continuing it.",
      inputSchema: {
        brainId,
        since: z
          .string()
          .optional()
          .describe(
            "ISO timestamp to start from, UTC unless it carries an offset. " +
              "Defaults to the last seven days.",
          ),
        limit: z.number().int().min(1).max(500).optional().describe("Defaults to 100."),
        identifiers: z
          .boolean()
          .optional()
          .describe(
            "true adds a list of the thoughts in the result with their identifiers, " +
              "for reading or changing one next. Defaults to false.",
          ),
      },
    },
    guard(async ({ brainId: bid, since, limit, identifiers }) => {
      const from = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const want = limit ?? 100;

      // The caller's limit cannot go to the API: it keeps the newest entries,
      // and those can all be settings. So pages are read, newest first, until
      // one event more than the limit shows there is something left out.
      const events: ModificationLogDto[] = [];
      const settings: string[] = [];
      for await (const page of ctx.api.brains.modificationPages(bid, { since: from })) {
        for (const l of page) {
          if (isSettingNoise(l)) settings.push(logTime(l));
          else events.push(l);
        }
        if (events.length > want) break;
      }
      const newestFirst = (a: ModificationLogDto, b: ModificationLogDto): number =>
        compareLogTime(logTime(b), logTime(a));
      const logs = events.sort(newestFirst).slice(0, want);
      const cut = events.length > want;
      // Settings count only within the period the rows cover.
      const lastShown = logs.at(-1);
      const oldestShown = lastShown === undefined ? undefined : logTime(lastShown);
      const hidden =
        cut && oldestShown !== undefined
          ? settings.filter((t) => compareLogTime(t, oldestShown) >= 0).length
          : settings.length;

      // What the log itself says of the thoughts it names: the name of one
      // created, renamed or deleted, and that it was deleted. From everything
      // read, the entries past the limit included: nothing newer than any of
      // them was left unread, so the newest name is the name now.
      const logged = loggedThoughts(events);
      const gone = (id: string): boolean => logged.get(id)?.deleted === true;
      const named = (id: string): boolean => {
        const l = logged.get(id);
        return l !== undefined && l.name !== null && !l.cut;
      };

      // The rest is read, for the name and for the kind, in one bounded batch:
      // otherwise a large `limit` turns into hundreds of requests. A thought
      // the log says is deleted is not read at all, and one the log has no
      // whole name for goes first, so that the cap falls on a mark and not on
      // a name.
      const subjects = [...new Set(logs.flatMap(subjectIds))];
      const here = subjects.filter((id) => !gone(id));
      const toRead = [...here.filter((id) => !named(id)), ...here.filter(named)];
      const reads = new Map(
        await mapWithConcurrency(
          toRead.slice(0, MAX_RESOLVED_NAMES),
          10,
          async (id) => [id, await kept(ctx.api.thoughts.get(bid, id))] as const,
        ),
      );

      const thought = (id: string): ChangedThought => {
        const read = reads.get(id);
        if (read !== undefined && "value" in read) {
          // The read has the kind: a tag attached is logged as a link created,
          // and reads as one unless the tag is marked.
          const t = read.value;
          return { state: "there", name: shownName(t.name), mark: kindMark(t.kind) };
        }
        const inLog = nameInLog(logged.get(id));
        // Not "(unnamed)" for a thought that is gone: it would read as one
        // that is there, in every row about it. The identifier of zeros, which
        // the log has for a note written to no thought, is the read's 404 too,
        // and is refused ahead of the request.
        if (gone(id) || (read !== undefined && nobodyHasIt(read.error))) {
          const name = inLog === null ? DELETED : `${inLog} ${DELETED}`;
          return { state: "gone", name, mark: "" };
        }
        return { state: "unread", name: inLog ?? NOT_READ, mark: "" };
      };
      const changed = subjects.map((id) => ({ id, ...thought(id) }));
      const shown = new Map(changed.map((t) => [t.id, `${t.name}${t.mark}`]));
      const unread = changed.filter((t) => t.state === "unread").length;

      const rows = logs.map((l) => [
        logTime(l).slice(0, 16).replace("T", " "),
        describeChange(l),
        subjectIds(l)
          .map((id) => shown.get(id) ?? NOT_READ)
          .join(" ↔ "),
      ]);

      // The identifiers are the log's own, so the list costs no request. A
      // thought that is gone is left out: nothing can be done with its
      // identifier. The mark goes after the identifier, as in the other tools.
      const listed =
        identifiers === true
          ? changed.filter((t) => t.state !== "gone").map((t) => `${t.name} — ${t.id}${t.mark}`)
          : [];

      const totals = [
        `events ${logs.length}`,
        hidden > 0 ? `brain-setting changes hidden: ${hidden}` : null,
        cut ? "older events not shown — raise `limit`" : null,
        unread > 0
          ? `thoughts not read: ${unread}, so a type or a tag among them is not marked`
          : null,
      ].filter((s) => s !== null);

      return ok(
        join([
          section(
            `Changes since ${from.slice(0, 16).replace("T", " ")}`,
            table(["When (UTC)", "What", "Thought"], rows),
          ),
          section("Thoughts", bullet(listed)),
          section("Totals", totals.join("; ")),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_index",
    {
      description:
        "Manages the semantic index: status, build, refresh. " +
        "Call with action=status when brain_search complains the index is missing; " +
        "with action=rebuild to build it for the first time or after changing the model; " +
        "with action=sync to pull in changes (fast, new material only). " +
        "The first build on a large brain takes minutes.",
      inputSchema: {
        brainId,
        action: z
          .enum(["status", "rebuild", "sync"])
          .describe("status — look only; rebuild — build from scratch; sync — catch up."),
      },
    },
    guard(async ({ brainId: bid, action }) => {
      // The brain first, whatever the action: one request, ahead of the index
      // file. An index is a local file and can be described with no request
      // at all, which is how a brainId that names no brain was told its index
      // was not built and to rebuild it. What fails here fails the call: a
      // rebuild or a sync needs TheBrain as much, and status says nothing of
      // an index before the brain it would be the index of has answered.
      const brain = await ctx.api.brains.get(bid);
      const indexer = ctx.indexer(bid);

      if (action === "status") {
        const s = indexer.status(bid);
        const built = indexBuilt(s);
        // Usable is what a model takes it for: brain_search ranks by this
        // index. That takes the embedder as well as the index, and status
        // went by the index alone: without the package it said "usable: yes"
        // of an index every search fell back from.
        const rankable = indexUsable(s);
        const why = await indexer.cannotEmbed();
        const usable = rankable && why === null;
        const noPackage =
          why === null
            ? ""
            : why.loadFailure === null
              ? " — the embeddings package is not installed"
              : " — the embeddings package does not load";
        const unfinished = s.exists ? "no — a build was started and did not finish" : "no";
        return ok(
          join([
            section(
              "Index status",
              bullet([
                `brain: ${brain.name ?? "(unnamed)"}`,
                `built: ${built ? "yes" : unfinished}`,
                `usable: ${usable ? "yes" : `no${noPackage}`}`,
                `thoughts indexed: ${s.size}`,
                `model: ${s.model ?? "—"}`,
                `synced through: ${s.syncedThrough ?? "—"}`,
              ]),
            ),
            section("What to do", afterStatus(built && rankable, why)),
          ]),
        );
      }

      let result: IndexResult;
      try {
        result = action === "rebuild" ? await indexer.rebuild(bid) : await indexer.sync(bid);
      } catch (error) {
        // Not SQLite's own words for either: `database is locked` was the
        // whole result of one of two runs started together.
        if (error instanceof IndexRunningError) return fail(heldByAnotherRun(error, action));
        if (error instanceof IndexBusyError) return fail(stoppedAtLock(error, action));
        // A request that stops a run is a read, and every read of a run comes
        // before its first write: the index is as it was. Said, because the
        // failure's own words are about the request and not about the index.
        if (!(error instanceof TheBrainError)) throw error;
        return fail(
          `${sentence(describeError(error))} The ${action} stopped at that request and wrote ` +
            "nothing: the index is as it was.",
        );
      }
      // Anything left unread makes the result an error: read as a success,
      // "Not read" would be one more section of an index that was built.
      if (result.unread.length > 0) return fail(leftUnread(result, indexer.status(bid)));

      return ok(
        join([
          section(
            // By what ran, not by what was asked for: a sync with no finished
            // index to refresh is a rebuild, and answered "Index refreshed".
            result.ran === "rebuild" ? "Index built" : "Index refreshed",
            bullet([
              `thoughts encoded: ${result.indexed}`,
              // A thought that changed kind and kept its document: the row
              // was corrected, which is neither encoded nor unchanged.
              ...(result.kindUpdated > 0
                ? [`kind updated, nothing to encode: ${result.kindUpdated}`]
                : []),
              `skipped unchanged: ${result.skipped}`,
              `removed from index: ${result.removed}`,
              `took: ${(result.elapsedMs / 1000).toFixed(1)} s`,
            ]),
          ),
        ]),
      );
    }),
  );
}

export { ThoughtKind };
