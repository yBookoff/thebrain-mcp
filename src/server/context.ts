/**
 * Shared server state: the API client, the embedder and per-brain indexes.
 *
 * An index is opened lazily and only for the brain actually requested: there
 * may be many files and no reason to hold them all open.
 */

import { TheBrainApi } from "../api/index.js";
import { type Config, indexPath } from "../config.js";
import { LocalEmbedder, type Embedder } from "../semantic/embedder.js";
import { SemanticIndexer } from "../semantic/indexer.js";
import { SemanticSearch } from "../semantic/search.js";
import { VectorStore } from "../semantic/store.js";

export class ServerContext {
  readonly api: TheBrainApi;
  readonly embedder: Embedder;
  readonly config: Config;

  readonly #stores = new Map<string, VectorStore>();

  constructor(config: Config) {
    this.config = config;
    this.api = new TheBrainApi({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
    });
    this.embedder = new LocalEmbedder({
      model: config.embeddingModel,
      dtype: config.embeddingDtype,
      // Progress goes to stderr: stdout carries the protocol.
      onProgress: (message) => process.stderr.write(`[thebrain-mcp] ${message}\n`),
    });
  }

  store(brainId: string): VectorStore {
    let store = this.#stores.get(brainId);
    if (store === undefined) {
      store = new VectorStore(indexPath(this.config, brainId));
      this.#stores.set(brainId, store);
    }
    return store;
  }

  indexer(brainId: string): SemanticIndexer {
    return new SemanticIndexer(this.api, this.store(brainId), this.embedder);
  }

  search(brainId: string): SemanticSearch {
    return new SemanticSearch(this.api, this.store(brainId), this.embedder);
  }

  close(): void {
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }
}
