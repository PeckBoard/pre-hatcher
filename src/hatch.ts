// The pre-hatch flow. Pure decision/formatting helpers are exported for
// vitest; everything touching host functions stays in the two handlers.
//
// Flow:
//  1. `session.message.before` fires for an interactive chat message. If the
//     session's provider has a cheaper model (or the user picked an override
//     in Settings) and no pre-hatch is already pending, create a temp
//     research session on that model, dispatch the GATEKEEPER prompt (which
//     holds until the user opts in), and raise the plugin-authored (no AI)
//     opt-in question on the chat session. The answer is redirected to the
//     temp session — core resumes a question's target directly and never
//     re-fires this hook for it, so the temp agent is the only place the
//     answer can be acted on. Cancel the hook — core parks the message as a
//     `pre-hatch` placeholder event. The cancel verdict carries
//     `{temp_session_id, model}` so the UI can stream the temp session's
//     actions into the parked bubble.
//  2. The user's answer resumes the temp session. A decline (or dismissal)
//     makes the agent call `pre_hatch_result` with `pass` immediately, so
//     the original message is delivered untouched; an accept starts the
//     research.
//  3. The temp agent researches the repo and calls the `pre_hatch_result`
//     MCP tool: `pass` delivers the original message, `enrich` delivers the
//     context-enriched message, `ask` raises ONE clarifying question on the
//     chat session (the answer redirects back to the temp session, which then
//     finishes with pass/enrich).
//  4. Delivery goes through `peckboard_deliver_message`, which persists the
//     final `user` event (carrying `pre_hatch: {original, enriched}` so the
//     UI swaps the placeholder for it), broadcasts, and resumes the chat.

import {
  askUser,
  createSession,
  deliverMessage,
  dispatchCapture,
  genId,
  nowMs,
  sessionMetaSet,
  storeDelete,
  storeGet,
  storePut,
} from "./host";
import { truncate } from "./verdict";

/// Store collections: `pending` is keyed by CHAT session id, `by_temp` by the
/// temp research session id (the reverse link the tool handler resolves).
export const PENDING_COLLECTION = "pending";
export const BY_TEMP_COLLECTION = "by_temp";

/// A pending record older than this is treated as dead (temp agent crashed,
/// never reported, or the opt-in question was dismissed by typing past it) —
/// a fresh message may pre-hatch again. There is no user-facing timeout: an
/// in-flight pre-hatch waits as long as it takes.
export const STALE_MS = 30 * 60 * 1000;

/// The opt-in question card (plugin-authored, no AI involved). The option
/// labels also appear verbatim in the answer text core delivers to the temp
/// session, so `gatekeeperPrompt` branches on them — keep them in sync.
export const OPT_IN_QUESTION =
  "Expand this message with repository context before sending it to the main model?";
export const OPT_IN_YES = "Yes, expand it";
export const OPT_IN_NO = "No, send as-is";

// ── Pure helpers (vitest-covered) ──────────────────────────────────────

/// Strip a `provider:` prefix and an `@account` suffix so two model ids
/// compare by their base model.
export function baseModel(id: string): string {
  const noProvider = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const at = noProvider.lastIndexOf("@");
  return at > 0 ? noProvider.slice(0, at) : noProvider;
}

/// Whether a message should be intercepted at all. `cheapModel` comes from
/// core (the user's Settings override when set, otherwise the session
/// provider's cheapest priced model, or empty when the provider prices
/// nothing).
export function shouldIntercept(
  text: string,
  model: string,
  cheapModel: string,
): boolean {
  if (cheapModel.trim() === "") {
    return false; // no priced cheaper model — nothing to save
  }
  if (baseModel(model) === baseModel(cheapModel)) {
    return false; // session already runs the cheapest model
  }
  // Too short to need repository context ("ok", "thanks", "yes do it").
  return Array.from(text.trim()).length >= 8;
}

/// Whether a pending record is stale (dead temp agent) and may be replaced.
export function isStale(pending: any, now: number): boolean {
  const created = typeof pending?.created_ms === "number" ? pending.created_ms : 0;
  return now - created > STALE_MS;
}

/// The final enriched message: the model is told to include the original
/// verbatim, but if it paraphrased it away, prepend the original so the
/// user's actual request always reaches the main model.
export function finalEnriched(original: string, message: string): string {
  if (message.includes(original.trim())) {
    return message;
  }
  return `${original}\n\n${message}`;
}

/// The `user` event data persisted on delivery. `text` is what the UI renders
/// in place of the user's message; `pre_hatch` carries the original for the
/// expandable "original message" view and links the temp session for audit.
export function userEventData(
  text: string,
  original: string,
  enriched: boolean,
  tempSessionId: string,
): any {
  return {
    text,
    pre_hatch: {
      original,
      enriched,
      temp_session_id: tempSessionId,
    },
  };
}

/// The research prompt the temp session runs on the cheap model. The
/// read-only rule is stated here for the model's benefit, but it is also
/// ENFORCED by core: the MCP server refuses every mutating tool call from
/// a pre-hatcher session (see `pre_hatcher_allowed_tool_names` in
/// `peckboard/src/service/mcp_server/schemas.rs`).
export function researchPrompt(text: string): string {
  return [
    "You are the PRE-HATCHER for a chat session: a fast, cheap, STRICTLY",
    "READ-ONLY context-gatherer that runs BEFORE the user's message reaches",
    "the main (expensive) model. Your ONLY purpose is to hand the main model",
    "useful context. You NEVER make code changes, no matter what the user's",
    "message asks for — if it requests an implementation, a fix, or an edit,",
    "that work belongs to the main model; you only gather the context that",
    "helps it do that work. Decide whether the message needs repository",
    "context, gather the minimum that genuinely helps, and hand off by",
    "calling the `pre_hatch_result` MCP tool. Your text output is discarded",
    "— only the tool call matters.",
    "",
    "The user's message is between the markers:",
    "---BEGIN USER MESSAGE---",
    text,
    "---END USER MESSAGE---",
    "",
    "Rules:",
    "- READ-ONLY, no exceptions: never write, edit, or delete files; never",
    "  run commands or tests. write_file, edit_file, run_command, run_tests,",
    "  git — and any built-in or mcp__-prefixed Write/Edit/Bash variant —",
    "  are forbidden, and the server refuses them from this session. Do not",
    "  attempt them.",
    "- Work fast and cheap: use file_outline / search_files / read_symbol /",
    "  targeted read_file windows.",
    '- If the message is conversational, self-contained, or you cannot add',
    '  real value: call pre_hatch_result with {"action":"pass"} immediately.',
    "- If repository context would help the main model: call pre_hatch_result",
    '  with {"action":"enrich","message":<the FULL message to send>}. The',
    "  enriched message MUST start with the original user message VERBATIM,",
    '  followed by a "## Context (pre-gathered)" section: relevant file paths',
    "  (with line numbers), key functions/types, and constraints discovered.",
    "  Keep the context under ~400 words — distill, never dump. Context",
    "  only — never present your findings as changes you have made yourself.",
    "- Only if the request is genuinely ambiguous AND the ambiguity changes",
    "  what the main model would do: call pre_hatch_result with",
    '  {"action":"ask","question":"...","options":[...]}. ONE short question,',
    "  multiple-choice when possible. The user's answer arrives as your next",
    "  message; then finish with enrich or pass.",
    "- Call pre_hatch_result EXACTLY once per turn, as your final action.",
  ].join("\n");
}

/// The prompt the temp session is dispatched with while the user answers the
/// opt-in question. The first turn must do NOTHING — the user may decline,
/// and any research done before the answer would be wasted spend. The answer
/// (redirected here by the question's `redirectSessionId`) arrives as the
/// next message and either starts the research or reports `pass` so the
/// original message is delivered untouched.
export function gatekeeperPrompt(text: string): string {
  return [
    "HOLD — do not start working yet. The user is being asked whether this",
    "message should be expanded with repository context, and may decline.",
    "THIS TURN: do NOT call pre_hatch_result and do NOT use any other tool —",
    "reply with exactly: ok. Everything below applies only AFTER the user's",
    "answer arrives as your next message:",
    `- If the answer contains "${OPT_IN_YES}": follow the instructions below`,
    "  from the beginning.",
    `- If it contains "${OPT_IN_NO}", or the user dismissed the question, or`,
    "  it is anything else: immediately call the `pre_hatch_result` MCP tool",
    '  with {"action":"pass"} and do nothing else — the user\'s message must',
    "  never be left undelivered.",
    "",
    researchPrompt(text),
  ].join("\n");
}

// ── Handlers (host-touching) ───────────────────────────────────────────

/// `session.message.before`: decide whether to take ownership of the turn.
/// Returns a verdict object; `lib.ts` serializes it. A cancel carries `data`
/// (temp session id + model) that core copies onto the `pre-hatch`
/// placeholder event so the UI can follow the temp session live. The temp
/// session is dispatched holding (see `gatekeeperPrompt`) and the opt-in
/// question is raised on the chat session with the answer redirected to the
/// temp session; no model does any work until the user accepts. Any internal
/// failure falls back to `{skip}` so the user's message always proceeds.
export function handleMessageBefore(payload: any): {
  verdict: string;
  reason?: string;
  data?: any;
} {
  try {
    const sessionId = asStr(payload?.session_id);
    const text = asStr(payload?.text);
    const model = asStr(payload?.model);
    const cheapModel = asStr(payload?.cheap_model);
    if (sessionId === "" || !shouldIntercept(text, model, cheapModel)) {
      return { verdict: "skip" };
    }

    // One pre-hatch per chat session at a time; a stale record (dead temp
    // agent) is replaced rather than blocking enrichment forever.
    const pending = tryGet(PENDING_COLLECTION, sessionId);
    if (pending && !isStale(pending, nowMs())) {
      return { verdict: "skip" };
    }

    const created = createSession({
      name: `Pre-hatcher: ${truncate(text, 40)}`,
      model: cheapModel,
      effort: "low",
      is_expert: true,
      expert_kind: "pre-hatcher",
    });
    const tempId = created?.session?.id;
    if (typeof tempId !== "string" || tempId === "") {
      return { verdict: "skip" };
    }
    sessionMetaSet({
      session_id: tempId,
      data: { chat_session_id: sessionId, original_text: text },
    });
    // Ask BEFORE storing the pending records or dispatching: if the question
    // cannot be raised (e.g. headless — no live host), the throw lands in the
    // catch below and the message dispatches normally, leaving nothing behind
    // but an idle, never-dispatched temp session.
    askUser({
      session_id: sessionId,
      question: OPT_IN_QUESTION,
      options: [OPT_IN_YES, OPT_IN_NO],
      token: genId(),
      redirect_session_id: tempId,
    });
    storePut({
      collection: PENDING_COLLECTION,
      key: sessionId,
      data: { temp_session_id: tempId, original_text: text, created_ms: nowMs() },
    });
    storePut({
      collection: BY_TEMP_COLLECTION,
      key: tempId,
      data: { chat_session_id: sessionId, original_text: text },
    });
    dispatchCapture({ session_id: tempId, prompt: gatekeeperPrompt(text) });
    return {
      verdict: "cancel",
      reason: `pre-hatch offered: expands with context gathered on ${cheapModel} if accepted`,
      data: { temp_session_id: tempId, model: cheapModel },
    };
  } catch (_e) {
    // Enrichment is best-effort; a failure must never eat the user's message.
    return { verdict: "skip" };
  }
}

/// The `pre_hatch_result` MCP tool, called by the temp research agent.
export function preHatchResult(args: any, callerSessionId: string): any {
  const link = tryGet(BY_TEMP_COLLECTION, callerSessionId);
  if (!link) {
    throw new Error(
      "no pre-hatch pending for this session (already delivered, or this is not a pre-hatcher research session)",
    );
  }
  const chatId = asStr(link.chat_session_id);
  const original = asStr(link.original_text);
  const action = asStr(args?.action);

  if (action === "pass") {
    deliverMessage({
      session_id: chatId,
      text: original,
      data: userEventData(original, original, false, callerSessionId),
    });
    cleanup(chatId, callerSessionId);
    return { ok: true, delivered: "original" };
  }

  if (action === "enrich") {
    const message = asStr(args?.message);
    if (message.trim() === "") {
      throw new Error("`message` is required for action=enrich");
    }
    const finalText = finalEnriched(original, message);
    deliverMessage({
      session_id: chatId,
      text: finalText,
      data: userEventData(finalText, original, true, callerSessionId),
    });
    cleanup(chatId, callerSessionId);
    return { ok: true, delivered: "enriched" };
  }

  if (action === "ask") {
    const question = asStr(args?.question);
    if (question.trim() === "") {
      throw new Error("`question` is required for action=ask");
    }
    const options = Array.isArray(args?.options)
      ? args.options.filter((o: any) => typeof o === "string")
      : [];
    const token = genId();
    askUser({
      session_id: chatId,
      question,
      options,
      token,
      redirect_session_id: callerSessionId,
    });
    return {
      ok: true,
      status: "waiting_for_user",
      note:
        "The user's answer will arrive as your next message; then call " +
        "pre_hatch_result again with enrich or pass.",
    };
  }

  throw new Error(`unknown action '${action}' — expected pass | enrich | ask`);
}

function cleanup(chatId: string, tempId: string): void {
  try {
    storeDelete({ collection: PENDING_COLLECTION, key: chatId });
  } catch (_e) {
    // best-effort
  }
  try {
    storeDelete({ collection: BY_TEMP_COLLECTION, key: tempId });
  } catch (_e) {
    // best-effort
  }
}

/// storeGet returns `{value: null}` for a missing key; normalize to null and
/// swallow read errors (a broken store must not break message dispatch).
function tryGet(collection: string, key: string): any {
  try {
    const got = storeGet({ collection, key });
    const v = got?.value;
    return v === null || v === undefined ? null : v;
  } catch (_e) {
    return null;
  }
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
