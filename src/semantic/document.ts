/**
 * Assembles the text that goes into an embedding.
 *
 * A thought's name is the strongest signal but not enough on its own: "Unity"
 * and "engine for 3D games" share no words, and that is exactly where the
 * model fails. Aliases, type, tags and the start of the note add context.
 *
 * Notes are never truncated when read by tools, but only their beginning is
 * embedded: the model has a limited window anyway, and the tail of a long note
 * dilutes the vector.
 */

import { createHash } from "node:crypto";

export interface IndexableThought {
  id: string;
  name: string;
  kind: number;
  aliases?: readonly string[];
  label?: string | null;
  typeName?: string | null;
  tagNames?: readonly string[];
  note?: string | null;
}

/** How many characters of the note take part in the vector. */
export const NOTE_EXCERPT_LIMIT = 1500;

/**
 * Version of the document format.
 *
 * Folded into the identifier stored with an index (see `indexModelId`), so that
 * changing what goes into a vector invalidates existing indexes rather than
 * leaving them silently ranked against differently-built vectors.
 *
 * Bumped to 2 when notes actually started reaching the embedder: until then a
 * bug in note detection meant every vector was built from name, type and tags
 * alone, and the document hash never changed, so no rebuild would repair it.
 *
 * Bumped to 3 when aliases joined the document. A thought that already had
 * aliases would otherwise keep its old vector until something else touched it.
 */
export const DOCUMENT_FORMAT = 3;

/** What an index records as its model: the embedder plus the document format. */
export function indexModelId(embedderId: string): string {
  return `${embedderId}#doc${DOCUMENT_FORMAT}`;
}

/**
 * Builds the text to embed.
 *
 * The name comes first deliberately: with mean pooling this pulls the vector
 * towards the thought's title rather than its note. Aliases follow it
 * unprefixed, because they are other titles for the same thought.
 *
 * The label goes in as the API reads it, a type's included. TheBrain gives a
 * thought with no label its name for one when it becomes a type, and leaves
 * that label where it was when the type is renamed: a type nobody renamed
 * has its name twice here, and a renamed one its old name on the second line
 * (contract test; docs/api-map.md, L38). That line is kept, on three counts.
 * It is TheBrain's own label, and its search finds the type by it. A read
 * cannot tell it from a caption someone wrote on the type, which belongs
 * in the document. And leaving it out would change the document of
 * every type, which takes a new `DOCUMENT_FORMAT` and a rebuild of every
 * index, for rows a search leaves out unless it is asked for types.
 * Removing the label, `label: null` through `brain_update_thought`, takes
 * the line away, and the `202` it logs brings the row up to date at the next
 * sync.
 */
export function buildDocument(thought: IndexableThought): string {
  const parts: string[] = [thought.name];

  const aliases = thought.aliases ?? [];
  if (aliases.length > 0) parts.push(aliases.join(", "));

  if (thought.label) parts.push(thought.label);
  if (thought.typeName) parts.push(`type: ${thought.typeName}`);

  const tags = thought.tagNames ?? [];
  if (tags.length > 0) parts.push(`tags: ${tags.join(", ")}`);

  const note = (thought.note ?? "").trim();
  if (note.length > 0) parts.push(excerpt(note, NOTE_EXCERPT_LIMIT));

  return parts.join("\n");
}

/**
 * Hash of the indexed text.
 *
 * Lets re-indexing skip unchanged entries: the modification log says a thought
 * was touched, but the edit may not have affected anything that reaches the
 * vector.
 */
export function documentHash(document: string): string {
  return createHash("sha256").update(document).digest("hex").slice(0, 32);
}

/** Truncates on a word boundary and marks the cut. */
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
