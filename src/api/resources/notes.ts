import { assertUuid, type TheBrainClient } from "../client.js";
import { hasNote, type NotesDto } from "../types.js";

/**
 * Thought notes.
 *
 * Two API quirks handled here:
 *  - `append` on a thought with no note returns 200 and silently does nothing;
 *  - `append` concatenates without a separator.
 */
export class NotesResource {
  constructor(private readonly client: TheBrainClient) {}

  /** The full DTO — needed when the "no note" signal matters. */
  async getRaw(brainId: string, thoughtId: string): Promise<NotesDto> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    return this.client.get<NotesDto>(`/api/notes/${brainId}/${thoughtId}`);
  }

  /** The note's markdown. Empty string when there is no note. */
  async get(brainId: string, thoughtId: string): Promise<string> {
    const dto = await this.getRaw(brainId, thoughtId);
    return dto.markdown ?? "";
  }

  async exists(brainId: string, thoughtId: string): Promise<boolean> {
    return hasNote(await this.getRaw(brainId, thoughtId));
  }

  /** Replaces the note in full. */
  async set(brainId: string, thoughtId: string, markdown: string): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");
    await this.client.post(`/api/notes/${brainId}/${thoughtId}/update`, {
      json: { markdown },
    });
  }

  /**
   * Appends to the end of a note.
   *
   * If no note exists yet the API swallows the append silently, so we read
   * first and fall back to a full write. The separator is ours: the API
   * concatenates strings with nothing in between.
   */
  async append(
    brainId: string,
    thoughtId: string,
    markdown: string,
    options: { separator?: string } = {},
  ): Promise<void> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");

    const current = await this.getRaw(brainId, thoughtId);
    if (!hasNote(current)) {
      await this.set(brainId, thoughtId, markdown);
      return;
    }

    const separator = options.separator ?? "\n\n";
    const existing = current.markdown ?? "";
    const glue = existing.endsWith(separator) ? "" : separator;
    await this.client.post(`/api/notes/${brainId}/${thoughtId}/append`, {
      json: { markdown: glue + markdown },
    });
  }
}

/**
 * A markdown round-trip loses the closing triple backtick of a fenced code
 * block, which swallows the rest of the document into the block.
 *
 * Returns a warning when the text is at risk.
 */
export function warnIfFencedCode(markdown: string): string | null {
  const fences = markdown.match(/^```/gm);
  if (!fences || fences.length === 0) return null;
  return (
    "this note contains a fenced code block — TheBrain drops the closing ``` on " +
    "save and the rest of the text gets swallowed into the block. " +
    "Prefer indenting code by four spaces"
  );
}
