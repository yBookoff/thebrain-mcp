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
   *
   * It is also what keeps a code block that is appended whole. Joined to the
   * end of a line, the block's first fence is no longer at the start of one,
   * its last fence is then the odd one out, and TheBrain deletes it
   * (`noteAsStored()`): 60 times of 60 for the bare request, and never with
   * the separator, 40 of 40.
   *
   * Resolves to the whole text this call left the note with, as it was sent:
   * what the note held, the separator and the addition. TheBrain goes over
   * the whole of it and not the addition alone, so `noteAsStored()` of this
   * text is what the note holds.
   */
  async append(
    brainId: string,
    thoughtId: string,
    markdown: string,
    options: { separator?: string } = {},
  ): Promise<string> {
    assertUuid(brainId, "brainId");
    assertUuid(thoughtId, "thoughtId");

    const current = await this.getRaw(brainId, thoughtId);
    if (!hasNote(current)) {
      await this.set(brainId, thoughtId, markdown);
      return markdown;
    }

    const separator = options.separator ?? "\n\n";
    const existing = current.markdown ?? "";
    const glue = existing.endsWith(separator) ? "" : separator;
    await this.client.post(`/api/notes/${brainId}/${thoughtId}/append`, {
      json: { markdown: glue + markdown },
    });
    return existing + glue + markdown;
  }
}

/** A code fence, to TheBrain: three backticks at the very start of a line. */
const FENCE = "```";

/** A line of a note that TheBrain does not keep. */
export interface DroppedLine {
  /** Its number in the text as it was sent, from 1. */
  line: number;
  text: string;
  /** The odd fence out, or one of the two fences of a block with nothing in it. */
  why: "unpaired" | "empty";
}

/**
 * The lines of a note's Markdown that TheBrain deletes when the note is
 * written, by `update` and by `append` alike, with a 200 (contract test;
 * docs/api-map.md, L5). There are two rules, and both go by lines that begin
 * with three backticks, whatever follows them on the line: a language, a
 * fourth backtick, or the rest of a sentence that opens with a code span.
 *
 * - With an odd number of such lines the last one is deleted, whole. That is
 *   the opening fence of a block left unclosed, and the closing fence of a
 *   block whose opening one is not at the start of its line.
 * - The rest pair up in order. A pair with no line between them, the second
 *   of them three backticks and nothing else, is a block with nothing in it,
 *   and both lines are deleted.
 *
 * A fence that is indented, quoted or in a list item is not at the start of
 * its line and is not counted; nor is one of tildes. A block that is closed
 * is kept to the character.
 */
export function noteLinesDropped(markdown: string): DroppedLine[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const fences = lines.flatMap((line, i) => (line.startsWith(FENCE) ? [i] : []));
  const dropped = new Map<number, DroppedLine["why"]>();
  if (fences.length % 2 === 1) dropped.set(fences.pop()!, "unpaired");
  for (let k = 0; k + 1 < fences.length; k += 2) {
    const open = fences[k]!;
    const close = fences[k + 1]!;
    if (close === open + 1 && lines[close] === FENCE) {
      dropped.set(open, "empty");
      dropped.set(close, "empty");
    }
  }
  return [...dropped]
    .sort(([a], [b]) => a - b)
    .map(([i, why]) => ({ line: i + 1, text: lines[i]!, why }));
}

/**
 * A note's Markdown as TheBrain keeps it: `\r\n` is `\n`, and the lines of
 * `noteLinesDropped()` are gone, each with its line end. Nothing else is
 * touched: a carriage return alone, the blanks at either end and a byte order
 * mark are stored as they were sent (contract test).
 *
 * It is what a text asked for is set against the note a thought has: a plan's
 * note with a fence left open is stored without that line, and compared as it
 * was sent it would pass for another text on every run.
 *
 * A text that comes to nothing this way leaves no note, and one of white
 * space alone is stored and reads as none.
 */
export function noteAsStored(markdown: string): string {
  const gone = new Set(noteLinesDropped(markdown).map((d) => d.line - 1));
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  return lines.filter((_, i) => !gone.has(i)).join("\n");
}
