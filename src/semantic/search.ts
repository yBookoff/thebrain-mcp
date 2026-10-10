/**
 * Semantic search with graceful degradation.
 *
 * With an index, the concept and every variant are embedded separately and a
 * thought ranks by its best match across them.
 *
 * When the optional embeddings package is missing, search does not switch off:
 * it falls back to a fan-out of prefix queries. The agent supplies the concept
 * along with synonyms, and the server runs them all through TheBrain's own
 * search and merges the results.
 *
 * This covers a fair share of cases, because vector search is not perfect
 * either and its misses are substantive.
 *
 * The fan-out asks TheBrain, and a request that fails is not an empty answer.
 * A failure that is about the key or the brain stops the search. Any other
 * is one phrasing's own: it is left out and named in the outcome, and when no
 * phrasing was answered there is no outcome at all (`SearchFailedError`).
 * Ranking by vectors asks TheBrain nothing, so none of this reaches it.
 */

import {
  TheBrainError,
  type ApiErrorKind,
  type SearchHit,
  type TheBrainApi,
} from "../api/index.js";
import { ThoughtKind } from "../api/types.js";
import { indexModelId } from "./document.js";
import { EmbedderUnavailableError, type Embedder } from "./embedder.js";
import { mapWithConcurrency } from "./indexer.js";
import type { VectorStore } from "./store.js";

export type MatchSource = "vector" | "keyword";

export interface Match {
  thoughtId: string;
  name: string;
  kind: number;
  /** Cosine for vector hits, a heuristic weight for lexical ones. */
  score: number;
  source: MatchSource;
  /** Which of the supplied variants produced the match. */
  matchedVariant: string | null;
}

export interface SearchOptions {
  /** Other phrasings of the same concept: synonyms, translation, splits. */
  variants?: readonly string[];
  limit?: number;
  /** Whether to include types and tags. Off by default; ordinary thoughts only. */
  includeAuxiliary?: boolean;
}

/** A phrasing TheBrain's search gave no answer to, and what came instead. */
export interface PhrasingFailure {
  phrasing: string;
  error: unknown;
}

export interface SearchOutcome {
  matches: Match[];
  /** Whether vector search ran or the fallback kicked in. */
  mode: "vector" | "keyword";
  /** Why it degraded — surfaced to the user. */
  degradedReason: string | null;
  /** How many phrasings there were: the concept and its variants, less duplicates and blanks. */
  phrasings: number;
  /**
   * The ones the fallback asked TheBrain's search for and got no answer to,
   * fewer than all of them. `matches` come from the rest, so a thought only
   * one of these would find is missing. Always empty in vector mode.
   */
  notSearched: PhrasingFailure[];
}

/**
 * No phrasing was answered, so there is no result: not an empty one either.
 * Each failure is kept for the tool to explain.
 */
export class SearchFailedError extends Error {
  readonly failures: readonly PhrasingFailure[];

  constructor(failures: readonly PhrasingFailure[]) {
    super(
      `TheBrain's search answered none of the ${failures.length} phrasings`,
      failures[0] !== undefined ? { cause: failures[0].error } : undefined,
    );
    this.name = "SearchFailedError";
    this.failures = failures;
  }
}

/** The concept and every variant are empty: there is nothing to look for. */
export class EmptyQueryError extends Error {
  constructor() {
    super(
      "query is empty, and so is every variant: there is nothing to search for. " +
        "Say what you are looking for in query.",
    );
    this.name = "EmptyQueryError";
  }
}

const AUXILIARY_KINDS = [ThoughtKind.Type, ThoughtKind.Tag, ThoughtKind.System];

/**
 * Failures that are about the call and not about a phrasing: a `brainId` that
 * is malformed or is no brain, and a key TheBrain rejects. Every phrasing
 * would get the same, so the first one is the search's answer.
 *
 * Nothing else is taken for that ahead of time. A connection that fails or a
 * 5xx may be one request's, and the search does fail one phrasing among
 * several: `query_too_long` for one of them, measured.
 */
const FAILS_EVERY_PHRASING: readonly ApiErrorKind[] = ["invalid_uuid", "unknown_brain", "auth"];

export class SemanticSearch {
  constructor(
    private readonly api: TheBrainApi,
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Finds thoughts close to a concept.
   *
   * Order: try vectors; if the package is missing or the index is empty, fall
   * back to the lexical fan-out and say so plainly.
   *
   * Throws `EmptyQueryError` when there is no phrasing to look for, in either
   * mode: the fan-out would send nothing and report nothing found, and the
   * vectors would rank the brain against an empty string.
   */
  async find(
    brainId: string,
    concept: string,
    options: SearchOptions = {},
  ): Promise<SearchOutcome> {
    const limit = options.limit ?? 15;
    const excludeKinds = options.includeAuxiliary ? [] : AUXILIARY_KINDS;
    const phrasings = dedupeVariants([concept, ...(options.variants ?? [])]);
    if (phrasings.length === 0) throw new EmptyQueryError();

    const indexReady =
      this.store.isCompatible(
        brainId,
        indexModelId(this.embedder.id),
        this.embedder.dimensions,
      ) &&
      this.store.size() > 0;

    if (indexReady) {
      try {
        return {
          matches: await this.#vector(concept, phrasings, limit, excludeKinds),
          mode: "vector",
          degradedReason: null,
          phrasings: phrasings.length,
          notSearched: [],
        };
      } catch (error) {
        if (!(error instanceof EmbedderUnavailableError)) throw error;
        return this.#keyword(brainId, phrasings, options, limit, error.message);
      }
    }

    const reason =
      this.store.size() === 0
        ? "the semantic index has not been built yet — run a rebuild"
        : "the index was built with a different model or document format and is unusable — rebuild it";
    return this.#keyword(brainId, phrasings, options, limit, reason);
  }

  /**
   * Each phrasing is searched on its own and a thought keeps its best score.
   *
   * Variants used to be ignored whenever the index was ready. A short query
   * embeds poorly against thoughts that are titles of a few words, and the
   * variants are exactly what the agent supplies to cover that. Measured on
   * 11 queries over a 199-entry brain, precision@5 against hand-labelled
   * relevant thoughts: query alone 0.40, variants joined into one string 0.67,
   * centroid of variant vectors 0.65, best score per thought 0.75, reciprocal
   * rank fusion 0.42. Max per thought also found a relevant hit first in 0.95
   * of cases (MRR), against 0.47 for the query alone.
   *
   * Taking the top `limit` per phrasing loses nothing: a thought in the merged
   * top `limit` is in the top `limit` of the phrasing that gave it that score.
   */
  async #vector(
    concept: string,
    phrasings: readonly string[],
    limit: number,
    excludeKinds: readonly number[],
  ): Promise<Match[]> {
    const primary = concept.trim();
    const best = new Map<string, Match>();
    for (const phrasing of phrasings) {
      const vector = await this.embedder.embedQuery(phrasing);
      for (const hit of this.store.search(vector, { limit, excludeKinds })) {
        const found = best.get(hit.thoughtId);
        if (found !== undefined && found.score >= hit.score) continue;
        best.set(hit.thoughtId, {
          thoughtId: hit.thoughtId,
          name: hit.name,
          kind: hit.kind,
          score: hit.score,
          source: "vector",
          matchedVariant: phrasing === primary ? null : phrasing,
        });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * The fan-out. A request that failed used to count as one that found
   * nothing: a rejected key, TheBrain not running and a 5xx all read as an
   * empty result, from a search that never ran.
   */
  async #keyword(
    brainId: string,
    phrasings: readonly string[],
    options: SearchOptions,
    limit: number,
    reason: string,
  ): Promise<SearchOutcome> {
    type Answered = { variant: string; hits: SearchHit[] };
    const asked = await mapWithConcurrency<string, Answered | PhrasingFailure>(
      phrasings,
      6,
      async (variant) => {
        try {
          const hits = await this.api.search.inBrain(brainId, variant, { maxResults: limit });
          return { variant, hits };
        } catch (error) {
          if (error instanceof TheBrainError && FAILS_EVERY_PHRASING.includes(error.kind)) {
            throw error;
          }
          return { phrasing: variant, error };
        }
      },
    );

    const perVariant: Answered[] = [];
    const notSearched: PhrasingFailure[] = [];
    for (const answer of asked) {
      if ("hits" in answer) perVariant.push(answer);
      else notSearched.push(answer);
    }
    if (perVariant.length === 0) throw new SearchFailedError(notSearched);

    // A thought found by several phrasings is more relevant than one found by a single phrasing.
    const byThought = new Map<string, Match & { hitCount: number }>();
    for (const { variant, hits } of perVariant) {
      hits.forEach((hit, rank) => {
        const kind = hit.thought.kind;
        if (!options.includeAuxiliary && AUXILIARY_KINDS.includes(kind as never)) return;
        const id = hit.thought.id;
        const positional = 1 / (rank + 1);
        const found = byThought.get(id);
        if (found === undefined) {
          byThought.set(id, {
            thoughtId: id,
            name: hit.thought.name ?? "",
            kind,
            score: positional,
            source: "keyword",
            matchedVariant: variant,
            hitCount: 1,
          });
        } else {
          found.score += positional;
          found.hitCount += 1;
        }
      });
    }

    const matches = [...byThought.values()]
      .sort((a, b) => b.hitCount - a.hitCount || b.score - a.score)
      .slice(0, limit)
      .map(({ hitCount: _hitCount, ...m }) => m);

    return {
      matches,
      mode: "keyword",
      degradedReason: reason,
      phrasings: phrasings.length,
      notSearched,
    };
  }
}

/** Drops case-insensitive duplicates and empty strings. */
export function dedupeVariants(variants: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of variants) {
    const value = raw.trim();
    if (value.length === 0) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
