import { assertUuid, mayHaveLanded, type TheBrainClient } from "../client.js";
import { AttachmentType, type AttachmentDto } from "../types.js";

export class AttachmentsResource {
  /**
   * The `attachUrl` calls with a check under way, by thought and address
   * (`urlKey`): a second one waits for the first.
   */
  readonly #underWay = new Map<string, Promise<unknown>>();

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
   * `brain_attach_url`, 18 times in 20 back to back. Nothing waits for the
   * copy. What this process attached in the last ten seconds is kept
   * (`client.written`), as it was sent and so as it is stored, and
   * `byLocation` is asked for each such spelling of the address as well,
   * before the list. That read is live: an attachment deleted since is not
   * found (6 of 6 at the first read). It costs no request unless this process
   * attached the address to this thought in another spelling in those ten
   * seconds, and then one, which finds it.
   *
   * Two calls for one address on one thought go one after the other. Sent at
   * once, each looked before either attached, and both attached, in one
   * spelling as in two (3 of 3 each).
   *
   * Not guarded: the same address in another host case attached by another
   * process, or in the app, within the moment the list is behind; two
   * processes attaching one address at once; and an attachment deleted in
   * the last 0.1 s, which the list may still show (2 of 3, up to 75 ms).
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

    const slot = `${brainId.toLowerCase()} ${thoughtId.toLowerCase()} ${urlKey(url)}`;
    const mine = (this.#underWay.get(slot) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const existing = await this.#alreadyThere(brainId, thoughtId, url);
        if (existing) return { created: false, existing };
        await this.#post(brainId, thoughtId, url, options.name);
        return { created: true };
      });
    this.#underWay.set(slot, mine);
    try {
      return await mine;
    } finally {
      if (this.#underWay.get(slot) === mine) this.#underWay.delete(slot);
    }
  }

  /** The attachment of `thoughtId` that is `url` in any spelling, if one is found. */
  async #alreadyThere(
    brainId: string,
    thoughtId: string,
    url: string,
  ): Promise<AttachmentDto | undefined> {
    const key = urlKey(url);
    const spellings = new Set([
      url,
      ...this.client.written.attachedTo(brainId, thoughtId).filter((s) => urlKey(s) === key),
    ]);
    for (const spelling of spellings) {
      const found = (await this.byLocation(brainId, spelling)).find(
        (a) => a.sourceId === thoughtId,
      );
      if (found) return found;
    }
    return (await this.ofThought(brainId, thoughtId)).find(
      (a) =>
        a.type === AttachmentType.ExternalUrl && a.location !== null && urlKey(a.location) === key,
    );
  }

  /** Sends the attach, and keeps the URL for `#alreadyThere` when it may have landed. */
  async #post(brainId: string, thoughtId: string, url: string, name?: string): Promise<void> {
    try {
      await this.client.post(`/api/attachments/${brainId}/${thoughtId}/url`, {
        query: { url, name },
      });
    } catch (error) {
      if (mayHaveLanded(error)) this.client.written.attached(brainId, thoughtId, url);
      throw error;
    }
    this.client.written.attached(brainId, thoughtId, url);
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
