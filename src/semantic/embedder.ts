/**
 * Source of embeddings.
 *
 * The local implementation sits behind a dynamic import of the optional
 * `@huggingface/transformers` dependency: the base install stays small and
 * starts instantly, and semantic search is enabled by a separate command.
 *
 * Queries and documents are encoded differently — e5-family models require the
 * asymmetric `query:` and `passage:` prefixes. Quality drops noticeably without
 * them, hence two methods rather than one.
 */

import { normalize } from "./store.js";

export interface Embedder {
  /** Identifier used to check index compatibility. A change means re-index. */
  readonly id: string;
  readonly dimensions: number;
  /** Encodes documents (`passage` in e5 terms). */
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  /** Encodes a search query (`query` in e5 terms). */
  embedQuery(text: string): Promise<Float32Array>;
}

/** The optional dependency is missing. Tools turn this into guidance. */
export class EmbedderUnavailableError extends Error {
  readonly installCommand = "npm install -g @huggingface/transformers";

  constructor(cause?: unknown) {
    super(
      "semantic search is off: the @huggingface/transformers package is not " +
        "installed. It weighs about 380 MB and downloads a further 113 MB model " +
        "on first use, which is why it is not part of the base install. " +
        "Substring name search is available without it.",
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "EmbedderUnavailableError";
  }
}

export interface LocalEmbedderOptions {
  /** Hugging Face model. Defaults to multilingual e5-small. */
  model?: string;
  /**
   * Weight precision. Defaults to `q8`: on a benchmark of 48 thoughts and
   * 20 queries, q8 scored 16/20 top-1 against 15/20 for fp32 at a quarter of
   * the size — a difference within noise.
   */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** Progress messages while the model downloads; that takes minutes. */
  onProgress?: (message: string) => void;
}

/** Dimensions of known models: needed before loading, to validate the index. */
const KNOWN_DIMENSIONS: Readonly<Record<string, number>> = {
  "Xenova/multilingual-e5-small": 384,
  "Xenova/multilingual-e5-base": 768,
};

const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
const DEFAULT_DTYPE = "q8";

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options: { dtype: string },
  ) => Promise<FeatureExtractor>;
}

/**
 * The specifier lives in a variable on purpose: the package is optional, and a
 * literal import would make `tsc` demand its types even where it is unused.
 */
const TRANSFORMERS = "@huggingface/transformers";

async function loadTransformers(): Promise<TransformersModule> {
  return (await import(TRANSFORMERS)) as TransformersModule;
}

export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;

  readonly #model: string;
  readonly #dtype: string;
  readonly #onProgress: (message: string) => void;
  #pipeline: FeatureExtractor | null = null;
  #loading: Promise<FeatureExtractor> | null = null;

  constructor(options: LocalEmbedderOptions = {}) {
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#dtype = options.dtype ?? DEFAULT_DTYPE;
    this.#onProgress = options.onProgress ?? ((): void => undefined);

    const dims = KNOWN_DIMENSIONS[this.#model];
    if (dims === undefined) {
      throw new Error(
        `unknown dimensions for model ${this.#model} — add it to KNOWN_DIMENSIONS`,
      );
    }
    this.dimensions = dims;
    this.id = `${this.#model}@${this.#dtype}`;
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    const extract = await this.#ensureLoaded();
    const out: Float32Array[] = [];
    for (const text of texts) {
      out.push(await run(extract, `passage: ${text}`));
    }
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const extract = await this.#ensureLoaded();
    return run(extract, `query: ${text}`);
  }

  /** Warms the model up so the first search does not wait for the download. */
  async warmUp(): Promise<void> {
    await this.#ensureLoaded();
  }

  #ensureLoaded(): Promise<FeatureExtractor> {
    if (this.#pipeline !== null) return Promise.resolve(this.#pipeline);
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<FeatureExtractor> {
    let transformers: TransformersModule;
    try {
      transformers = await loadTransformers();
    } catch (cause) {
      // Reset the loading promise: otherwise later calls would return the same
      // rejected promise, and installing the package would not help until the
      // server restarts.
      this.#loading = null;
      throw new EmbedderUnavailableError(cause);
    }

    this.#onProgress(`loading model ${this.#model} (${this.#dtype})…`);
    const extractor = await transformers.pipeline(
      "feature-extraction",
      this.#model,
      { dtype: this.#dtype },
    );
    this.#onProgress("model ready");
    this.#pipeline = extractor;
    return extractor;
  }
}

async function run(extract: FeatureExtractor, text: string): Promise<Float32Array> {
  const output = await extract(text, { pooling: "mean", normalize: true });
  // Normalise again: trusting the model's own flag is risky, and search
  // computes cosine as a dot product, which needs unit length.
  return normalize(Float32Array.from(output.data));
}

/**
 * Whether the optional dependency is installed.
 *
 * Only checks that the package is present: the model may not be downloaded
 * yet, which surfaces on first use.
 */
export async function isLocalEmbedderAvailable(): Promise<boolean> {
  try {
    await loadTransformers();
    return true;
  } catch {
    return false;
  }
}
