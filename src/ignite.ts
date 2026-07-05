// The pre-ignite flow. Pure decision/formatting helpers are exported for
// vitest; everything touching host functions stays in the two handlers.
//
// Flow:
//  1. `session.message.before` fires for an interactive chat message. If the
//     session's provider has a cheaper model and no pre-ignite is already
//     pending, create a temp research session on that model, dispatch the
//     research prompt, and Cancel the hook — core parks the message as a
//     `pre-ignite` placeholder event.
//  2. The temp agent researches the repo and calls the `pre_ignite_result`
//     MCP tool: `pass` delivers the original message, `enrich` delivers the
//     context-enriched message, `ask` raises ONE clarifying question on the
//     chat session (the answer redirects back to the temp session, which then
//     finishes with pass/enrich).
//  3. Delivery goes through `peckboard_deliver_message`, which persists the
//     final `user` event (carrying `pre_ignite: {original, enriched}` so the
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

/// A pending record older than this is treated as dead (temp agent crashed or
/// never reported) — a fresh message may pre-ignite again. There is no
/// user-facing timeout: an in-flight pre-ignite waits as long as it takes.
export const STALE_MS = 30 * 60 * 1000;

// ── Pure helpers (vitest-covered) ──────────────────────────────────────

/// Strip a `provider:` prefix and an `@account` suffix so two model ids
/// compare by their base model.
export function baseModel(id: string): string {
  const noProvider = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const at = noProvider.lastIndexOf("@");
  return at > 0 ? noProvider.slice(0, at) : noProvider;
}

/// Whether a message should be intercepted at all. `cheapModel` comes from
/// core (the session provider's cheapest priced model, or empty when the
/// provider prices nothing).
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
/// in place of the user's message; `pre_ignite` carries the original for the
/// expandable "original message" view and links the temp session for audit.
export function userEventData(
  text: string,
  original: string,
  enriched: boolean,
  tempSessionId: string,
): any {
  return {
    text,
    pre_ignite: {
      original,
      enriched,
      temp_session_id: tempSessionId,
    },
  };
}

/// The research prompt the temp session runs on the cheap model.
export function researchPrompt(text: string): string {
  return [
    "You are the PRE-IGNITER for a chat session: a fast, cheap context-gatherer",
    "that runs BEFORE the user's message reaches the main (expensive) model.",
    "Decide whether the message needs repository context, gather the minimum",
    "that genuinely helps, and hand off by calling the `pre_ignite_result` MCP",
    "tool. Your text output is discarded — only the tool call matters.",
    "",
    "The user's message is between the markers:",
    "---BEGIN USER MESSAGE---",
    text,
    "---END USER MESSAGE---",
    "",
    "Rules:",
    "- Work fast and cheap: use file_outline / search_files / targeted",
    "  read_file windows. Never run commands or tests; never edit files.",
    '- If the message is conversational, self-contained, or you cannot add',
    '  real value: call pre_ignite_result with {"action":"pass"} immediately.',
    "- If repository context would help the main model: call pre_ignite_result",
    '  with {"action":"enrich","message":<the FULL message to send>}. The',
    "  enriched message MUST start with the original user message VERBATIM,",
    '  followed by a "## Context (pre-gathered)" section: relevant file paths',
    "  (with line numbers), key functions/types, and constraints discovered.",
    "  Keep the context under ~400 words — distill, never dump.",
    "- Only if the request is genuinely ambiguous AND the ambiguity changes",
    "  what the main model would do: call pre_ignite_result with",
    '  {"action":"ask","question":"...","options":[...]}. ONE short question,',
    "  multiple-choice when possible. The user's answer arrives as your next",
    "  message; then finish with enrich or pass.",
    "- Call pre_ignite_result EXACTLY once per turn, as your final action.",
  ].join("\n");
}

// ── Handlers (host-touching) ───────────────────────────────────────────

/// `session.message.before`: decide whether to take ownership of the turn.
/// Returns a verdict object; `lib.ts` serializes it. Any internal failure
/// falls back to `{skip}` so the user's message always proceeds.
export function handleMessageBefore(payload: any): { verdict: string; reason?: string } {
  try {
    const sessionId = asStr(payload?.session_id);
    const text = asStr(payload?.text);
    const model = asStr(payload?.model);
    const cheapModel = asStr(payload?.cheap_model);
    if (sessionId === "" || !shouldIntercept(text, model, cheapModel)) {
      return { verdict: "skip" };
    }

    // One pre-ignite per chat session at a time; a stale record (dead temp
    // agent) is replaced rather than blocking enrichment forever.
    const pending = tryGet(PENDING_COLLECTION, sessionId);
    if (pending && !isStale(pending, nowMs())) {
      return { verdict: "skip" };
    }

    const created = createSession({
      name: `Pre-igniter: ${truncate(text, 40)}`,
      model: cheapModel,
      effort: "low",
      is_expert: true,
      expert_kind: "pre-igniter",
    });
    const tempId = created?.session?.id;
    if (typeof tempId !== "string" || tempId === "") {
      return { verdict: "skip" };
    }
    sessionMetaSet({
      session_id: tempId,
      data: { chat_session_id: sessionId, original_text: text },
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
    dispatchCapture({ session_id: tempId, prompt: researchPrompt(text) });
    return {
      verdict: "cancel",
      reason: `pre-igniting: gathering context on ${cheapModel} before dispatch`,
    };
  } catch (_e) {
    // Enrichment is best-effort; a failure must never eat the user's message.
    return { verdict: "skip" };
  }
}

/// The `pre_ignite_result` MCP tool, called by the temp research agent.
export function preIgniteResult(args: any, callerSessionId: string): any {
  const link = tryGet(BY_TEMP_COLLECTION, callerSessionId);
  if (!link) {
    throw new Error(
      "no pre-ignite pending for this session (already delivered, or this is not a pre-igniter research session)",
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
        "pre_ignite_result again with enrich or pass.",
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
