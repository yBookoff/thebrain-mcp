import { assertUuid, type TheBrainClient } from "../client.js";
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
    const raw = await this.client.get<SearchResultDto[]>(`/api/search/${brainId}`, {
      query: {
        queryText,
        maxResults: options.maxResults ?? 25,
        onlySearchThoughtNames: options.namesOnly ?? false,
      },
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
