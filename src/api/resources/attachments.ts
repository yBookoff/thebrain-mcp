import { assertUuid, type TheBrainClient } from "../client.js";
import { AttachmentType, type AttachmentDto } from "../types.js";

export class AttachmentsResource {
  constructor(private readonly client: TheBrainClient) {}

  async metadata(brainId: string, attachmentId: string): Promise<AttachmentDto> {
    assertUuid(brainId, "brainId");
    assertUuid(attachmentId, "attachmentId");
    return this.client.get<AttachmentDto>(
      `/api/attachments/${brainId}/${attachmentId}/metadata`,
    );
  }

  async content(brainId: string, attachmentId: string): Promise<Uint8Array> {
    assertUuid(brainId, "brainId");
    assertUuid(attachmentId, "attachmentId");
    return this.client.getBytes(
      `/api/attachments/${brainId}/${attachmentId}/file-content`,
    );
  }

  async ofThought(brainId: string, thoughtId: string): Promise<AttachmentDto[]> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    return this.client.get<AttachmentDto[]>(
      `/api/thoughts/${brainId}/${thoughtId}/attachments`,
    );
  }

  /**
   * Finds attachments by location.
   *
   * URL matching is normalised: case, http/https scheme and a trailing slash
   * are ignored. Ready-made deduplication for a web clipper.
   */
  async byLocation(
    brainId: string,
    location: string,
    type: number = AttachmentType.ExternalUrl,
  ): Promise<AttachmentDto[]> {
    assertUuid(brainId, "brainId");
    return this.client.get<AttachmentDto[]>(
      `/api/attachments/${brainId}/by-location`,
      { query: { location, type } },
    );
  }

  /**
   * Attaches a URL. An empty name means "take it from the page title".
   *
   * With `deduplicate` it first checks whether the URL is already attached and
   * returns the existing attachment instead of creating a duplicate.
   */
  async attachUrl(
    brainId: string,
    thoughtId: string,
    url: string,
    options: { name?: string; deduplicate?: boolean } = {},
  ): Promise<{ created: boolean; existing?: AttachmentDto }> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");

    if (options.deduplicate !== false) {
      const found = await this.byLocation(brainId, url);
      const onThisThought = found.find((a) => a.sourceId === thoughtId);
      if (onThisThought) return { created: false, existing: onThisThought };
    }

    await this.client.post(`/api/attachments/${brainId}/${thoughtId}/url`, {
      query: { url, name: options.name },
    });
    return { created: true };
  }

  async delete(brainId: string, attachmentId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(attachmentId, "attachmentId");
    await this.client.delete(`/api/attachments/${brainId}/${attachmentId}`);
  }
}
