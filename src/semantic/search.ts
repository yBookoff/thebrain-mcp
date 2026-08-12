/**
 * Semantic search with graceful degradation.
 *
 * When the optional embeddings package is missing, search does not switch off:
 * it falls back to a fan-out of prefix queries. The agent supplies the concept
 * along with synonyms, and the server runs them all through TheBrain's own
 * search and merges the results.
 *
 * This covers a fair share of cases, because vector search is not perfect
 * either and its misses are substantive.
 */

import type { TheBrainApi } from "../api/index.js";
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

export interface SearchOutcome {
  matches: Match[];
  /** Whether vector search ran or the fallback kicked in. */
  mode: "vector" | "keyword";
  /** Why it degraded — surfaced to the user. */
  degradedReason: string | null;
}

const AUXILIARY_KINDS = [ThoughtKind.Type, ThoughtKind.Tag, ThoughtKind.System];

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
   */
  async find(
    brainId: string,
    concept: string,
    options: SearchOptions = {},
  ): Promise<SearchOutcome> {
    const limit = options.limit ?? 15;
    const excludeKinds = options.includeAuxiliary ? [] : AUXILIARY_KINDS;

    const indexReady =
      this.store.isCompatible(
        brainId,
        indexModelId(this.embedder.id),
        this.embedder.dimensions,
      ) &&
      this.store.size() > 0;

    if (indexReady) {
      try {
        const vector = await this.embedder.embedQuery(concept);
        const hits = this.store.search(vector, { limit, excludeKinds });
        return {
          matches: hits.map((h) => ({
            thoughtId: h.thoughtId,
            name: h.name,
            kind: h.kind,
            score: h.score,
            source: "vector" as const,
            matchedVariant: null,
          })),
          mode: "vector",
          degradedReason: null,
        };
      } catch (error) {
        if (!(error instanceof EmbedderUnavailableError)) throw error;
        return this.#keyword(brainId, concept, options, limit, error.message);
      }
    }

    const reason =
      this.store.size() === 0
        ? "the semantic index has not been built yet — run a rebuild"
        : "the index was built with a different model or document format and is unusable — rebuild it";
    return this.#keyword(brainId, concept, options, limit, reason);
  }

  async #keyword(
    brainId: string,
    concept: string,
    options: SearchOptions,
    limit: number,
    reason: string,
  ): Promise<SearchOutcome> {
    const variants = dedupeVariants([concept, ...(options.variants ?? [])]);
    const perVariant = await mapWithConcurrency(variants, 6, async (variant) => {
      const hits = await this.api.search
        .inBrain(brainId, variant, { maxResults: limit })
        .catch(() => []);
      return { variant, hits };
    });

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

    return { matches, mode: "keyword", degradedReason: reason };
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
