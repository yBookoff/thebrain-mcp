/**
 * A name's characters: as TheBrain stores them, why it would not take them,
 * and as a result prints them.
 *
 * Text in and text out. Nothing here makes a request, and nothing is
 * imported, from `resources/` least of all: `kind.ts` words its refusals with
 * `shownName()`, and `thoughts.ts` reads a kind through `kind.ts`. While
 * `shownName()` stood in `thoughts.ts` the two imported each other.
 */

/**
 * The API keeps the first 1,024 UTF-16 units of a longer name and drops the
 * rest, with a 200, on a create and on a rename alike. A link's name is cut
 * at the same length, by a `POST` and by a `PATCH`.
 */
export const MAX_NAME_LENGTH = 1024;

/** Unicode's `White_Space`, 25 code points: what the API takes for a blank in a name. */
const NAME_EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;

/**
 * A thought's name as TheBrain keeps it, by a create and by a rename alike: a
 * tab and a line feed are each a space, and the white space at either end is
 * dropped (contract test; docs/api-map.md, L36).
 *
 * White space is Unicode's property of that name. It is not what `trim()`
 * drops: a next line (U+0085) is white space and goes, and a byte order mark
 * (U+FEFF) is none and stays, as a zero width space does. What is inside a
 * name is kept, a run of spaces and a carriage return included.
 *
 * It is what a name asked for is set against the name a thought has, and what
 * a result gives for the name: a plan thought sent as `"a\tb"` is stored as
 * `"a b"`, and looked for as it was sent it was made again by every run.
 */
export function thoughtNameAsStored(name: string): string {
  return name.replace(/[\t\n]/g, " ").replace(NAME_EDGES, "");
}

/**
 * A link's name as TheBrain keeps it, by a `POST` and by a `PATCH` alike. It
 * is the rule of a thought's name, measured over the same code points
 * (contract test; docs/api-map.md, L35): a tab and a line feed are each a
 * space, then the white space at either end is dropped, Unicode's
 * `White_Space` and not what `trim()` drops, and then the name is cut at
 * `MAX_NAME_LENGTH`. A run of spaces inside is kept, and so are a carriage
 * return and a next line there.
 *
 * `trim()` stood here and was wrong at both ends of the difference: it keeps
 * a next line (U+0085), which the API drops, so a label that ended in one
 * was patched again by every run of a plan; and it drops a byte order mark
 * (U+FEFF), which the API keeps, so a label that ended in one was reported
 * as the one the link had.
 *
 * The cut comes last, so a cut name can end in white space, and one that
 * falls inside a surrogate pair leaves U+FFFD for the half it kept. Nothing
 * here refuses a long label, where a thought's long name is refused: what
 * compares or quotes a label gets it as it will be stored.
 *
 * It is what a name asked for is set against the name a link has: sent as it
 * was given, `" motivates\n"` would pass for another label than the
 * `"motivates"` it was stored as, on every run of a plan.
 */
export function linkNameAsStored(name: string): string {
  const whole = name.replace(/[\t\n]/g, " ").replace(NAME_EDGES, "");
  if (whole.length <= MAX_NAME_LENGTH) return whole;
  const cut = whole.slice(0, MAX_NAME_LENGTH);
  const last = cut.charCodeAt(MAX_NAME_LENGTH - 1);
  // The first half of a pair with its second half cut off.
  return last >= 0xd800 && last <= 0xdbff ? `${cut.slice(0, -1)}\ufffd` : cut;
}

/**
 * Why `name` cannot be a thought's name as it was given, or null when it can.
 * `what` is the caller's word for it, and begins the sentence.
 *
 * The API does not refuse all of it. A name with nothing in it but white
 * space is a 400 for a new thought, and for a rename a 200 that logs nothing
 * and leaves the name as it was. A name past `MAX_NAME_LENGTH` is cut, with a
 * 200. So both are refused here, ahead of the request.
 *
 * A name of characters that do not show is none of this: the API stores a
 * zero width space as it stores a letter, and the server has no opinion of
 * what a name should look like. A result says so where it prints one.
 */
export function nameRefusal(name: string, what: string): string | null {
  const stored = thoughtNameAsStored(name);
  if (stored === "") {
    const of = name === "" ? "empty" : `white space alone (${codePoints(name)})`;
    return `${what} is ${of}, and a thought has to have a name`;
  }
  if (stored.length > MAX_NAME_LENGTH) {
    return (
      `${what} is ${stored.length} UTF-16 units long, and TheBrain keeps the first ` +
      `${MAX_NAME_LENGTH} of a name and drops the rest with a 200`
    );
  }
  return null;
}

/** The most code points a result spells out. */
const CODE_POINTS_SHOWN = 8;

/** The code points of a text as `U+200B U+FEFF`: for characters that do not show. */
export function codePoints(text: string): string {
  const all = [...text].map(
    (c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
  );
  const shown = all.slice(0, CODE_POINTS_SHOWN).join(" ");
  const more = all.length - CODE_POINTS_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** A text with nothing in it that shows: white space, what is ignored in drawing text, controls. */
const UNSEEN = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]*$/u;

/**
 * A thought's name as a result prints it. `(unnamed)` for none, and for a
 * name with no character that shows its code points, `(no visible character:
 * U+200B)`: the API stores such a name as it stores any other, and printed
 * as it is it read as no name at all, with nothing to say why.
 *
 * "Shows" is not judged here. A name is spelled out when every code point of
 * it has one of three Unicode properties: `White_Space`,
 * `Default_Ignorable_Code_Point`, or the general category `Cc`. That takes
 * in a zero width space, a byte order mark, a soft hyphen, a Hangul filler
 * and a variation selector on its own. It leaves out what is blank to the
 * eye and a symbol by its properties, the braille pattern blank (U+2800)
 * for one: that prints as it is, as it did. Spelled out, a name of up to
 * eight code points loses nothing: the code points are the name.
 *
 * It is on this side of the tools, which print most names, because a
 * refusal that quotes a name is worded in this layer (`requireKind`), and a
 * batch's line for a thought one layer up.
 */
export function shownName(name: string | null | undefined): string {
  if (name === null || name === undefined || name === "") return "(unnamed)";
  return UNSEEN.test(name) ? `(no visible character: ${codePoints(name)})` : name;
}
