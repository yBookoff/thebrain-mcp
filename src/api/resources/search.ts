import { assertUuid, type TheBrainClient } from "../client.js";
import { TheBrainError } from "../errors.js";
import type { SearchResultDto, ThoughtDto } from "../types.js";

export interface SearchHit {
  thought: ThoughtDto;
  /** The real brain: the field at the result root arrives as all zeroes. */
  brainId: string;
  brainName: string | null;
  isFromOtherBrain: boolean;
  matchedOn: string | null;
}

/**
 * TheBrain's own search.
 *
 * Two properties confirmed against the live API:
 *  - the index lags by up to 15 seconds, so freshly created content is missing;
 *  - matching is prefix-based, not semantic: `OT` finds `OTGP`, but a typo or
 *    a synonym returns nothing.
 */
export class SearchResource {
  constructor(private readonly client: TheBrainClient) {}

  async inBrain(
    brainId: string,
    queryText: string,
    options: { maxResults?: number; namesOnly?: boolean } = {},
  ): Promise<SearchHit[]> {
    assertUuid(brainId, "brainId");
    const raw = await this.client
      .get<SearchResultDto[]>(`/api/search/${brainId}`, {
        query: {
          queryText,
          maxResults: options.maxResults ?? 25,
          onlySearchThoughtNames: options.namesOnly ?? false,
        },
      })
      .catch((error: unknown) => {
        throw refusedForSize(error, queryText);
      });
    return normalize(raw, brainId);
  }

  async accessible(
    queryText: string,
    options: { maxResults?: number; namesOnly?: boolean } = {},
  ): Promise<SearchHit[]> {
    const raw = await this.client.get<SearchResultDto[]>("/api/search/accessible", {
      query: {
        queryText,
        maxResults: options.maxResults ?? 25,
        onlySearchThoughtNames: options.namesOnly ?? false,
      },
    });
    return normalize(raw, null);
  }
}

/**
 * The search's two refusals of a long query, as the one error that says so.
 * Any other failure is returned as it came.
 *
 * Measured on 15.0.640, each the same every time it was asked for
 * (docs/api-map.md, L30). Neither answer mentions the query's size, and a
 * shorter query to the same brain is answered:
 *
 * - A request line past 8,192 bytes, its line ending counted, is a 414 with no
 *   body, sent before the key or the brain is looked at. With this path and
 *   its two other parameters that leaves the query 8,075 bytes as the URL
 *   carries it: as many Latin letters, 1,345 Cyrillic ones, 897 CJK characters.
 * - A query of more than 512 words of two characters or more, and no more
 *   than 1,024 words in all, is the 403 the API answers when it names no
 *   cause. One of 1,025 words is a 200 again.
 *
 * Read by status, the first was "(empty response)" and the second a matter of
 * an identifier nobody has, which a search does not carry.
 */
function refusedForSize(error: unknown, queryText: string): unknown {
  if (!(error instanceof TheBrainError)) return error;
  const { status, method, path } = error;
  const details = {
    ...(status !== undefined ? { status } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(path !== undefined ? { path } : {}),
    cause: error,
  };

  if (status === 414) {
    const bytes = new URLSearchParams({ q: queryText }).toString().length - "q=".length;
    return new TheBrainError(
      "query_too_long",
      `the search text is too long for one request: ${queryText.length} characters, ` +
        `${bytes} bytes as the URL carries them, where TheBrain takes about 8,000 ` +
        "(a Cyrillic letter is 6 of them, a CJK character 9). Shorten it",
      details,
    );
  }

  const words = queryText.trim().split(/\s+/);
  const counted = words.filter((w) => w.length >= 2).length;
  if (error.kind === "forbidden" && counted > 512 && words.length <= 1024) {
    return new TheBrainError(
      "query_too_long",
      `the search text is ${words.length} words, and TheBrain's search answers a 403 ` +
        "that names no cause to one of 513 to 1,024 words. Shorten it",
      details,
    );
  }

  return error;
}

function normalize(raw: SearchResultDto[], fallbackBrainId: string | null): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const r of raw) {
    // Skip link and attachment hits: we only care about thoughts.
    if (r.sourceThought === null) continue;
    hits.push({
      thought: r.sourceThought,
      brainId: r.sourceThought.brainId || fallbackBrainId || "",
      brainName: r.brainName,
      isFromOtherBrain: r.isFromOtherBrain,
      matchedOn: r.name,
    });
  }
  return hits;
}
