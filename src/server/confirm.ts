/**
 * Confirmation for irreversible operations.
 *
 * The preferred path is elicitation: the server asks the client to show a form
 * to the user. It is the only MCP client capability not marked deprecated —
 * sampling and roots were both deprecated in protocol version 2026-07-28.
 *
 * Client support is not guaranteed, so there is a fallback: the tool returns a
 * description of the consequences and requires a second call carrying an
 * explicit confirmation flag.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ConfirmOutcome =
  | { granted: true }
  | { granted: false; reason: "declined" | "needs-explicit-flag" };

/**
 * Asks permission for an irreversible action.
 *
 * @param summary What exactly will happen — shown to the user verbatim.
 * @param alreadyConfirmed Flag from the tool arguments, for clients without elicitation.
 */
export async function confirmDestructive(
  server: McpServer,
  summary: string,
  alreadyConfirmed: boolean,
): Promise<ConfirmOutcome> {
  if (alreadyConfirmed) return { granted: true };

  const supportsElicitation =
    server.server.getClientCapabilities()?.elicitation !== undefined;

  if (!supportsElicitation) return { granted: false, reason: "needs-explicit-flag" };

  try {
    const response = await server.server.elicitInput({
      message: summary,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Confirm this irreversible deletion",
          },
        },
        required: ["confirm"],
      },
    });

    const granted =
      response.action === "accept" && response.content?.["confirm"] === true;
    return granted ? { granted: true } : { granted: false, reason: "declined" };
  } catch {
    // The client advertised the capability but failed — do not delete silently.
    return { granted: false, reason: "needs-explicit-flag" };
  }
}

/** Text for the case where confirmation could not be obtained. */
export function confirmationInstructions(
  summary: string,
  reason: "declined" | "needs-explicit-flag",
): string {
  if (reason === "declined") {
    return `Deletion cancelled by the user.\n\n${summary}`;
  }
  return (
    `${summary}\n\n` +
    "This client cannot display a confirmation form. Ask the user yourself and, " +
    "once they agree, repeat the call with confirm=true. " +
    "Never do this without explicit human consent."
  );
}
