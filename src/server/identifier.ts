/**
 * The schema of an identifier a tool takes.
 *
 * A UUID is lowered here, once, ahead of everything the tool does with it
 * (`lowerUuid()`): the API answers in lower case whatever it was sent, and an
 * argument kept in capitals was keyed beside its answers as another thought,
 * and an index file named after it as another brain's. So no identifier past
 * this point is in capitals, and a result names a thought as the API does.
 * Anything that is no UUID is left as sent, for `assertUuid()` to refuse in
 * the caller's own spelling.
 */

import { z } from "zod";

import { lowerUuid } from "../api/client.js";

/**
 * A thought's, a link's or a brain's identifier as a tool argument.
 *
 * A new schema at each use: the JSON Schema of a tool gives a schema met
 * twice as a `$ref` to the first place it was met.
 */
export const identifier = () => z.string().transform(lowerUuid);

/**
 * The same, for an identifier that a `null` clears. Not `identifier()` made
 * nullable, whose JSON Schema is an `anyOf` where this one's is the type
 * `["string", "null"]` it always was.
 */
export const identifierOrNull = () =>
  z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : lowerUuid(value)));

/** The `brainId` every tool but `brain_list` takes. */
export const brainId = identifier().describe(
  "Brain identifier. Take it from brain_list — never guess it.",
);
