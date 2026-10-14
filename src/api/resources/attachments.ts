import { afterCopyLag, assertUuid, type TheBrainClient } from "../client.js";
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
   * No one read is enough. `byLocation` finds an attachment the moment it is
   * created, but takes `Example.com` and `example.com` for two addresses. The
   * thought's own list can be compared with the host case set aside
   * (`urlKey`), but it is a copy: made when a thought's attachments are first
   * read, so that read is live, and brought up to date about every 0.1 s
   * after that. Behind, it lacked a new attachment for 7 to 214 ms (contract
   * test; docs/api-map.md, L17). Lower-casing the host before the lookup
   * would not do instead: the copy already stored may be the one in capitals.
   *
   * So the address that was attached straight before, in another host case,
   * was found by neither, and attached a second time: through
   * `brain_attach_url`, 18 times in 20 back to back. The list is now read
   * only once `COPY_LAG_MS` has passed since this process's last write
   * (`afterCopyLag()`), and has that attachment by then. The wait comes
   * after `byLocation` has been asked for the given spelling, so a repeat in
   * that spelling costs none.
   *
   * Nor is the list taken at its word. Read within 4 ms of the answer to an
   * attachment's delete, it still had it 6 times in 6, and the address was
   * answered "already there" while nothing was. So it only names spellings, and
   * `byLocation` is asked for each it has not been asked for: it finds every
   * location in the spelling it is stored in, a `mailto:` or an
   * `x-devonthink-item:` as well, so one it did not find is gone. That costs
   * a request only where the list has the address in a spelling not asked
   * for yet.
   *
   * `byLocation` names the thought in lower case, and the API takes an
   * identifier in capitals as well. Compared by case, the thought's own
   * attachment was not its own, and the address attached straight before in
   * another host case was attached again 2 times in 3.
   *
   * Not guarded: the same address in another host case attached by another
   * process, or in the app, within the moment the list is behind.
   */
  async attachUrl(
    brainId: string,
    thoughtId: string,
    url: string,
    options: { name?: string; deduplicate?: boolean } = {},
  ): Promise<{ created: boolean; existing?: AttachmentDto }> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");

    if (options.deduplicate === false) {
      await this.#post(brainId, thoughtId, url, options.name);
      return { created: true };
    }

    const existing = await this.#alreadyThere(brainId, thoughtId, url);
    if (existing) return { created: false, existing };
    await this.#post(brainId, thoughtId, url, options.name);
    return { created: true };
  }

  /**
   * The attachment of `thoughtId` that is `url` in any spelling, if one is
   * found, as `byLocation` has it: the thought's list only names spellings.
   */
  async #alreadyThere(
    brainId: string,
    thoughtId: string,
    url: string,
  ): Promise<AttachmentDto | undefined> {
    const key = urlKey(url);
    const asked = new Set<string>();
    const live = async (spellings: readonly string[]): Promise<AttachmentDto | undefined> => {
      for (const spelling of spellings) {
        if (asked.has(spelling)) continue;
        asked.add(spelling);
        const found = (await this.byLocation(brainId, spelling)).find((a) =>
          sameId(a.sourceId, thoughtId),
        );
        if (found) return found;
      }
      return undefined;
    };
    const given = await live([url]);
    if (given) return given;
    await afterCopyLag(this.client);
    return live(
      (await this.ofThought(brainId, thoughtId)).flatMap((a) =>
        a.type === AttachmentType.ExternalUrl && a.location !== null && urlKey(a.location) === key
          ? [a.location]
          : [],
      ),
    );
  }

  async #post(brainId: string, thoughtId: string, url: string, name?: string): Promise<void> {
    await this.client.post(`/api/attachments/${brainId}/${thoughtId}/url`, {
      query: { url, name },
    });
  }

  async delete(brainId: string, attachmentId: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(attachmentId, "attachmentId");
    await this.client.delete(`/api/attachments/${brainId}/${attachmentId}`);
  }
}

/** Case aside: the API takes a UUID in capitals as well, and answers in lower case. */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
