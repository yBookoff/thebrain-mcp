/**
 * What this process wrote a moment ago that a thought's graph, or its list of
 * attachments, has to show.
 *
 * A graph is answered from a copy, and the copy is behind a write by a time
 * nothing bounds. It had the new thought within 0.2 s as a rule; while the
 * app was slow to answer, a reader first saw it more than 0.3 s after the
 * answer 7 times in 1,800, 364 ms at the latest. `ingest()` waited 0.3 s by
 * the clock and then took the copy at its word, and a copy that far behind
 * is a second thought of the name (docs/api-map.md, L27 and L33). Nothing in
 * a graph says how old it is. But a process knows what it wrote itself: a
 * graph that lacks the thought this process created next to its thought, or
 * lists a thought under the name it had before this process renamed it, is
 * behind, whatever the clock says.
 *
 * So the writes whose mark on a graph is known are kept here for a while, by
 * `ThoughtsResource` and `LinksResource` as each is answered, and a reader
 * that decides by a graph asks `notShownBy()` and reads again until there is
 * nothing left. Only what a measurement stands behind is kept: a thought
 * created next to another and a link between two are in the list their
 * relation puts them in, on both sides (L27), and a renamed thought is listed
 * under its new name.
 *
 * It knows this process's writes alone, and the answered ones: a create that
 * got no answer has no identifier to look for.
 *
 * The URLs this process attached are kept as well, as they were sent, and so
 * as TheBrain stores them (L17). A thought's list of attachments is a copy
 * of the same kind, and `by-location`, which is not, tells `Example.com` from
 * `example.com`: the same address in another host case, attached straight
 * after, was attached a second time 18 times in 20. `attachedTo()` gives
 * `attachments.attachUrl()` the spellings to ask `by-location` for. That read
 * is live, so a URL kept here that is no longer attached is not taken for
 * one that is.
 */

import { Relation } from "./types.js";

/** The lists of a graph a thought can be in next to another. */
export type GraphList = "children" | "parents" | "jumps";

/** What is asked of a graph: who is next to its thought, and under what name. */
export interface ShownGraph {
  children: ReadonlyArray<{ id: string; name?: string | null | undefined }>;
  parents: ReadonlyArray<{ id: string; name?: string | null | undefined }>;
  jumps: ReadonlyArray<{ id: string; name?: string | null | undefined }>;
}

/** Something a graph shows once it has caught up with a write of this process. */
export type WrittenFact =
  | {
      /** `thoughtId` is in `list` of the graph of `anchorId`. */
      of: "listed";
      brainId: string;
      anchorId: string;
      list: GraphList;
      thoughtId: string;
      /** When the write was answered, by `Date.now()`. */
      at: number;
    }
  | {
      /** Wherever a graph lists `thoughtId`, it is under `name`. */
      of: "named";
      brainId: string;
      thoughtId: string;
      /** As TheBrain stores it: `thoughtNameAsStored()`. */
      name: string;
      at: number;
    };

/**
 * How long a write is kept. The copy of a graph has to be this far behind for
 * a write to go unseen again: some twenty-five times the longest lag measured
 * for a graph, 364 ms, and about twice the 5.3 s that a write queued behind a
 * burst of 600 creates took to read back. A list of attachments was behind
 * by 214 ms at the most.
 *
 * It is also how long a write made here can be contradicted from outside. A
 * thought this process linked somewhere and a person then unlinked in the app
 * is one the graph will never list there: for the rest of this time a reader
 * waits for it and gives up. Hence no longer than this.
 */
export const WRITTEN_KEPT_MS = 10_000;

const LIST_OF: Readonly<Record<Relation, GraphList>> = {
  [Relation.Child]: "children",
  [Relation.Parent]: "parents",
  [Relation.Jump]: "jumps",
};
/** What the first thought is to the second, when the second is this to the first. */
const SEEN_FROM_THE_OTHER_END: Readonly<Record<Relation, Relation>> = {
  [Relation.Child]: Relation.Parent,
  [Relation.Parent]: Relation.Child,
  [Relation.Jump]: Relation.Jump,
};

/** Case aside: the API reads a UUID in capitals too. */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A URL this process attached to a thought, as it was sent. */
interface AttachedUrl {
  brainId: string;
  thoughtId: string;
  location: string;
  at: number;
}

export class RecentWrites {
  #facts: WrittenFact[] = [];
  #urls: AttachedUrl[] = [];

  /**
   * `thoughtId` was made `relation` to `sourceId`: created next to it, or
   * joined to it by a link. Each is in the other's graph from then on, in the
   * list the relation puts it in. Two thoughts share one link, so what was
   * known of the pair before is dropped: a link posted over another replaces it.
   */
  linked(brainId: string, sourceId: string, thoughtId: string, relation: Relation): void {
    const at = Date.now();
    this.#drop(
      (f) =>
        this.#old(f, at) ||
        (f.of === "listed" &&
          same(f.brainId, brainId) &&
          ((same(f.anchorId, sourceId) && same(f.thoughtId, thoughtId)) ||
            (same(f.anchorId, thoughtId) && same(f.thoughtId, sourceId)))),
    );
    this.#facts.push(
      { of: "listed", brainId, anchorId: sourceId, list: LIST_OF[relation], thoughtId, at },
      {
        of: "listed",
        brainId,
        anchorId: thoughtId,
        list: LIST_OF[SEEN_FROM_THE_OTHER_END[relation]],
        thoughtId: sourceId,
        at,
      },
    );
  }

  /** `thoughtId` was given `name`, which is the name as TheBrain stores it. */
  named(brainId: string, thoughtId: string, name: string): void {
    const at = Date.now();
    this.#drop(
      (f) =>
        this.#old(f, at) ||
        (f.of === "named" && same(f.brainId, brainId) && same(f.thoughtId, thoughtId)),
    );
    this.#facts.push({ of: "named", brainId, thoughtId, name, at });
  }

  /**
   * Nothing is known of `thoughtId` any more: it was deleted, or changed
   * kind, and what a graph then lists of it was not measured. A graph is not
   * held to what may no longer be so.
   */
  forget(brainId: string, thoughtId: string): void {
    this.#drop(
      (f) =>
        same(f.brainId, brainId) &&
        (same(f.thoughtId, thoughtId) || (f.of === "listed" && same(f.anchorId, thoughtId))),
    );
    this.#urls = this.#urls.filter(
      (u) => !(same(u.brainId, brainId) && same(u.thoughtId, thoughtId)),
    );
  }

  /**
   * `location` was attached to `thoughtId`, or was sent to be and got no
   * answer: as it was sent, which is how TheBrain stores it.
   */
  attached(brainId: string, thoughtId: string, location: string): void {
    const at = Date.now();
    this.#drop((f) => this.#old(f, at));
    this.#urls = this.#urls.filter((u) => !this.#old(u, at));
    this.#urls.push({ brainId, thoughtId, location, at });
  }

  /** The URLs this process attached to `thoughtId` in the time a write is kept. */
  attachedTo(brainId: string, thoughtId: string): string[] {
    const now = Date.now();
    this.#urls = this.#urls.filter((u) => !this.#old(u, now));
    return this.#urls
      .filter((u) => same(u.brainId, brainId) && same(u.thoughtId, thoughtId))
      .map((u) => u.location);
  }

  /**
   * A link of the brain was deleted by its identifier, which does not say
   * between which two thoughts: no thought of the brain is known to be next
   * to another any more.
   */
  unlinked(brainId: string): void {
    this.#drop((f) => f.of === "listed" && same(f.brainId, brainId));
  }

  /**
   * What `graph`, the graph of `thoughtId`, does not show of the writes kept
   * here: empty when it has caught up with them, or when none of them is
   * about this graph. While it is not empty the graph is a copy from before
   * a write of this process.
   */
  notShownBy(brainId: string, thoughtId: string, graph: ShownGraph): WrittenFact[] {
    const now = Date.now();
    this.#drop((f) => this.#old(f, now));
    return this.#facts.filter((f) => {
      if (!same(f.brainId, brainId)) return false;
      if (f.of === "listed") {
        return same(f.anchorId, thoughtId) && !graph[f.list].some((t) => same(t.id, f.thoughtId));
      }
      return [...graph.children, ...graph.parents, ...graph.jumps].some(
        (t) => same(t.id, f.thoughtId) && (t.name ?? "") !== f.name,
      );
    });
  }

  /**
   * Past its time. Dropped as each write is kept as well as on a look: a
   * process that writes for hours and never looks would keep them all.
   */
  #old(write: { at: number }, now: number): boolean {
    return now - write.at > WRITTEN_KEPT_MS;
  }

  /** How many writes are kept: for a test of what is not. */
  get size(): number {
    return this.#facts.length + this.#urls.length;
  }

  #drop(which: (fact: WrittenFact) => boolean): void {
    this.#facts = this.#facts.filter((f) => !which(f));
  }
}
