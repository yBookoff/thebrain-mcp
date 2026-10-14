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
   * Finds attachments by location, across the whole brain.
   *
   * URL matching ignores the http/https scheme and trailing slashes; the rest
   * must match exactly, case included, and that takes in the host: measured,
   * `Example.com/p` does not find `example.com/p`. A location is stored as it
   * was given, so neither spelling leads to the other. A new attachment is
   * found at once.
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
   * returns the existing attachment instead of creating a duplicate. The API
   * itself attaches a second copy without complaint.
   *
   * The check reads twice, because neither read is enough alone. `byLocation`
   * finds an attachment the moment it is created, but takes `Example.com` and
   * `example.com` for two addresses. The thought's own list can be compared
   * with the host case set aside (`urlKey`), but it is a copy: made when a
   * thought's attachments are first read, so that read is live, and brought
   * up to date about every 0.1 s after that. Behind, it lacked a new
   * attachment for 7 to 214 ms (contract test; docs/api-map.md, L17).
   * Lower-casing the host before the lookup would not do instead: the copy
   * already stored may be the one in capitals.
   *
   * Nothing here waits for that copy, so no figure is relied on. Not guarded
   * for the same reason: the same address in another host case, attached
   * straight after the first, is found by neither read and attached a second
   * time (17 of 20; 1 of 10 at 0.3 s). A repeat in the same spelling is
   * caught at once.
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
      const sameSpelling = await this.byLocation(brainId, url);
      const existing =
        sameSpelling.find((a) => a.sourceId === thoughtId) ??
        (await this.ofThought(brainId, thoughtId)).find(
          (a) =>
            a.type === AttachmentType.ExternalUrl &&
            a.location !== null &&
            urlKey(a.location) === urlKey(url),
        );
      if (existing) return { created: false, existing };
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

/**
 * What every spelling of one web address has in common: two URLs with the same
 * key are the same address.
 *
 * It is the form `by-location` compares, without the http/https scheme and the
 * trailing slashes, and with the host in lower case as well. A host has no
 * letter case (RFC 3986 §3.2.2); the path, the query and the fragment do, and
 * keep it. Anything that is not http(s) comes back untouched: in
 * `x-devonthink-item://4F2A` an identifier stands where the host would be.
 */
export function urlKey(location: string): string {
  const web = /^https?:\/\/([^/?#]*)(.*)$/i.exec(location);
  if (web === null) return location;
  const [, authority = "", rest = ""] = web;
  // In `user:Pass@Host:8080` only the host is case-insensitive.
  const host = authority.lastIndexOf("@") + 1;
  return (authority.slice(0, host) + authority.slice(host).toLowerCase() + rest).replace(
    /\/+$/,
    "",
  );
}
