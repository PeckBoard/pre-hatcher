// The plugin manifest JSON body — identity, hooks, the MCP tool the temp
// research agent reports through, and the permissions the host functions
// require.

const DESCRIPTION =
  "Pre-hatcher: pre-warms chat messages before they reach the main model. A cheaper model (the session provider's lowest-priced one, or the model picked in Settings) gathers repository context in a temp session, optionally asks one clarifying question, then delivers the enriched — or untouched — message to the chat.";
const VERSION = "0.2.1";
const REPOSITORY = "https://github.com/PeckBoard/pre-hatcher";

/// Build the manifest JSON string. `index.ts`'s `manifest()` export wraps this.
export function manifestJson(): string {
  const manifest = {
    description: DESCRIPTION,
    version: VERSION,
    repository: REPOSITORY,

    hooks: ["session.message.before", "mcp.tool.invoke"],

    mcp_tools: [
      {
        name: "pre_hatch_result",
        title: "Report pre-hatch result",
        description:
          "PRE-HATCHER RESEARCH SESSIONS ONLY: report the outcome of pre-warming a chat message. action=pass sends the user's message unchanged; action=enrich sends `message` (the original message verbatim plus a distilled context section) in its place; action=ask raises ONE clarifying question to the user — their answer arrives as your next message, then finish with enrich or pass. Call exactly once per turn, as your final action.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["pass", "enrich", "ask"],
              description: "What to do with the pre-warmed message.",
            },
            message: {
              type: "string",
              description:
                "action=enrich: the FULL message to send — the original user message verbatim, then a '## Context (pre-gathered)' section under ~400 words.",
            },
            question: {
              type: "string",
              description: "action=ask: ONE short clarifying question.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "action=ask: optional multiple-choice answers (recommended).",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
    ],

    permissions: [
      "ask_user",
      "data_store",
      "provide_mcp_tools",
      "session_dispatch",
      "session_write",
      "user_authority",
    ],
  };
  return JSON.stringify(manifest);
}
