/**
 * Facade over TheBrain's local API.
 *
 * The single entry point for everything else: tools and the semantic layer go
 * through it and know nothing about HTTP or per-endpoint quirks.
 */

import { TheBrainClient, type ClientOptions } from "./client.js";
import { AppResource, BrainsResource } from "./resources/brains.js";
import { AttachmentsResource } from "./resources/attachments.js";
import { LinksResource } from "./resources/links.js";
import { NotesResource } from "./resources/notes.js";
import { SearchResource } from "./resources/search.js";
import { ThoughtsResource } from "./resources/thoughts.js";

export class TheBrainApi {
  readonly client: TheBrainClient;
  readonly app: AppResource;
  readonly brains: BrainsResource;
  readonly thoughts: ThoughtsResource;
  readonly links: LinksResource;
  readonly notes: NotesResource;
  readonly attachments: AttachmentsResource;
  readonly search: SearchResource;

  constructor(options: ClientOptions | TheBrainClient) {
    this.client =
      options instanceof TheBrainClient ? options : new TheBrainClient(options);
    this.app = new AppResource(this.client);
    this.brains = new BrainsResource(this.client);
    this.thoughts = new ThoughtsResource(this.client);
    this.links = new LinksResource(this.client);
    this.notes = new NotesResource(this.client);
    this.attachments = new AttachmentsResource(this.client);
    this.search = new SearchResource(this.client);
  }
}

export { TheBrainClient, assertUuid, isUuid, emptyOn400 } from "./client.js";
export { TheBrainError, type ApiErrorKind } from "./errors.js";
export * from "./types.js";
export {
  replayThoughtIds,
  type CleanGraph,
  type CreateThoughtInput,
  type UpdateThoughtInput,
} from "./resources/thoughts.js";
export {
  isStructuralLink,
  isTagLink,
  isTypeLink,
  type CreateLinkInput,
  type UpdateLinkInput,
} from "./resources/links.js";
export { warnIfFencedCode } from "./resources/notes.js";
export type { SearchHit } from "./resources/search.js";
