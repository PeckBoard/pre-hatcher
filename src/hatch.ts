// The pre-hatch flow. Pure decision/formatting helpers are exported for
// vitest; everything touching host functions stays in the handlers.
//
// Flow (every control-flow decision is made in CODE — the cheap model only
// does read-only research):
//  1. `session.message.before` fires for an interactive chat message. If the
//     session's provider has a cheaper model (or the user picked an override
//     in Settings) and no pre-hatch is already pending, create a temp
//     research session on that model (idle — NOT dispatched yet) and raise the
//     plugin-authored (no AI) opt-in question on the chat session, redirected
//     to the temp session. Cancel the hook — core parks the message as a
//     `pre-hatch` placeholder event. The cancel verdict carries
//     `{temp_session_id, model}` so the UI can stream the temp session's
//     actions into the parked bubble.
//  2. The user answers the opt-in. Core fires `session.prehatch.answer` (the
//     redirect target is a pre-hatcher session) and this plugin decides in
//     CODE, never by handing the yes/no to the model:
//       - decline / dismiss → deliver the original message untouched, done.
//       - accept → dispatch the read-only research prompt to the temp session.
//     Returning `cancel` tells core NOT to resume the temp agent with the raw
//     answer text.
//  3. The temp agent researches the repo and calls the `pre_hatch_result` MCP
//     tool: `pass` delivers the original; `enrich` PROPOSES a context-enriched
//     message (a plugin-authored approval card is raised, redirected to the
//     temp session); `ask` raises ONE clarifying question (redirected to the
//     temp session so the agent can read the answer and continue).
//  4. The user answers the approval card → `session.prehatch.answer` fires
//     again and this plugin delivers the enriched-or-original message in CODE,
//     strictly from the recorded answer core passes in the hook (the agent
//     cannot forge approval or alter the text), then terminates the temp
//     agent. A clarifying answer instead falls through (verdict `skip`) so
//     core resumes the research agent with it.
//  5. Delivery goes through `peckboard_deliver_message`, which persists the
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
  terminateAgent,
} from "./host";
import { truncate } from "./verdict";

/// Store collections: `pending` is keyed by CHAT session id, `by_temp` by the
/// temp research session id (the reverse link the tool + answer handlers
/// resolve).
export const PENDING_COLLECTION = "pending";
export const BY_TEMP_COLLECTION = "by_temp";

/// The `by_temp` record's `phase` — which question (if any) is currently
/// outstanding for the temp session, so `handleAnswer` knows how to resolve
/// the user's answer in code.
export const PHASE_OPT_IN = "opt_in";
export const PHASE_RESEARCH = "research";
export const PHASE_AWAIT_APPROVAL = "await_approval";
export const PHASE_AWAIT_CLARIFY = "await_clarify";

/// A pending record older than this is treated as dead (temp agent crashed,
/// never reported, or the opt-in question was dismissed by typing past it) —
/// a fresh message may pre-hatch again. There is no user-facing timeout: an
/// in-flight pre-hatch waits as long as it takes.
export const STALE_MS = 30 * 60 * 1000;

/// The opt-in question card (plugin-authored, no AI involved). The option
/// labels are compared against the user's recorded answer in CODE (core
/// passes the selected label into `session.prehatch.answer`).
export const OPT_IN_QUESTION =
  "Expand this message with repository context before sending it to the main model?";
export const OPT_IN_YES = "Yes, expand it";
export const OPT_IN_NO = "No, send as-is";

/// The approval card raised when the temp agent proposes an enriched
/// message (also plugin-authored, no AI). Delivery is decided ONLY from the
/// user's recorded answer core passes back — never from the agent's claim.
export const APPROVE_SEND = "Send expanded message";
export const APPROVE_ORIGINAL = "Send my original message";

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
/// `cancelled` marks a delivery forced by the user cancelling the pre-hatch.
export function userEventData(
  text: string,
  original: string,
  enriched: boolean,
  tempSessionId: string,
  cancelled = false,
): any {
  const pre_hatch: any = {
    original,
    enriched,
    temp_session_id: tempSessionId,
  };
  if (cancelled) {
    pre_hatch.cancelled = true;
  }
  return { text, pre_hatch };
}

/// What a `session.prehatch.cancel` should do given the chat's pending
/// record: `deliver` the recorded original untouched; `not-pending` when
/// nothing is in flight or the record belongs to a newer pre-hatch that
/// superseded the cancelled one (core must NOT deliver a second copy
/// either); `fallback` when the record is unusable — clean it up and let
/// core deliver from the parked event's own text.
export function cancelPlan(
  pending: any,
  tempSessionId: string,
): "deliver" | "not-pending" | "fallback" {
  if (!pending) {
    return "not-pending";
  }
  const recorded =
    typeof pending?.temp_session_id === "string" ? pending.temp_session_id : "";
  if (tempSessionId !== "" && recorded !== "" && recorded !== tempSessionId) {
    return "not-pending";
  }
  if (
    typeof pending?.original_text !== "string" ||
    pending.original_text.trim() === ""
  ) {
    return "fallback";
  }
  return "deliver";
}

/// Whether the recorded answer to the enriched-message approval card is an
/// explicit approval. `answer` is the selected option label core passes into
/// `session.prehatch.answer`; a dismissal (`rejected`) or any other label
/// falls back to delivering the original message.
export function isApproved(answer: string, rejected: boolean): boolean {
  return !rejected && answer === APPROVE_SEND;
}

/// The research prompt the temp session runs on the cheap model. The
/// read-only rule is stated here for the model's benefit, but it is also
/// ENFORCED by core: the MCP server refuses every mutating tool call from
/// a pre-hatcher session (see `pre_hatcher_allowed_tool_names` in
/// `peckboard/src/service/mcp_server/schemas.rs`).
export function researchPrompt(text: string, history = ""): string {
  const historyBlock =
    history.trim() === ""
      ? []
      : [
          "",
          "The conversation so far, for context (prior turns of THIS chat,",
          "oldest first, possibly truncated). The user's NEW message is the",
          "one between the USER MESSAGE markers below, NOT the last line here:",
          "---BEGIN CONVERSATION---",
          history,
          "---END CONVERSATION---",
        ];
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
    ...historyBlock,
    "",
    "The user's NEW message is between the markers:",
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
    "  targeted read_file windows. Use the conversation above to interpret",
    '  the new message (references like "that function" or "the same file").',
    "- ALWAYS resolve ambiguity by ASKING. If the new message is ambiguous",
    "  in ANY way that could change what the main model does — an unclear",
    "  target, multiple plausible interpretations, a missing detail, and the",
    "  conversation above does not settle it — you MUST call pre_hatch_result",
    '  with {"action":"ask","question":"...","options":[...]} BEFORE any enrich',
    "  or pass. ONE short question, multiple-choice when possible. The user's",
    "  answer arrives as your next message; then finish with enrich or pass.",
    "  Only skip asking when the request is genuinely unambiguous.",
    "- If the message is conversational, self-contained, or you cannot add",
    '  real value: call pre_hatch_result with {"action":"pass"} immediately.',
    "- If repository context would help the main model: call pre_hatch_result",
    '  with {"action":"enrich","message":<the FULL message to send>}. The',
    "  enriched message MUST start with the original user message VERBATIM,",
    '  followed by a "## Context (pre-gathered)" section: relevant file paths',
    "  (with line numbers), key functions/types, and constraints discovered.",
    "  Keep the context under ~400 words — distill, never dump. Context",
    "  only — never present your findings as changes you have made yourself.",
    "  After you call enrich you are DONE: the user is asked to approve the",
    "  expanded message and the plugin delivers the approved version (or the",
    "  original) itself. End your turn — do NOT call pre_hatch_result again",
    "  and do NOT keep working on the request.",
    "- Call pre_hatch_result EXACTLY once per turn, as your final action.",
  ].join("\n");
}

/// The approval question raised for a proposed enriched message (plugin-
/// authored, no AI). The proposal is embedded, clipped for the card;
/// delivery always uses the full stored text, never anything the card or
/// the agent echoes back.
export function approvalQuestion(proposed: string): string {
  return [
    "The pre-hatcher expanded your message with repository context. Send",
    "the expanded version to the main model?",
    "",
    "---",
    truncate(proposed, 1200),
  ].join("\n");
}

// ── Handlers (host-touching) ───────────────────────────────────────────

/// `session.message.before`: decide whether to take ownership of the turn.
/// Returns a verdict object; `lib.ts` serializes it. A cancel carries `data`
/// (temp session id + model) that core copies onto the `pre-hatch`
/// placeholder event so the UI can follow the temp session live. The temp
/// session is created idle (NOT dispatched) and the opt-in question is raised
/// on the chat session, redirected to the temp session; no model does any work
/// until the user accepts (`session.prehatch.answer` starts the research in
/// code). Any internal failure falls back to `{skip}` so the user's message
/// always proceeds.
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
    // The full chat transcript (prior turns) and the configurable research
    // system prompt (a library prompt body, default "fable 5"), both
    // resolved by core in the hook payload.
    const history = asStr(payload?.history);
    const systemPrompt = asStr(payload?.system_prompt);
    const systemPromptName = asStr(payload?.system_prompt_name);
    if (sessionId === "" || !shouldIntercept(text, model, cheapModel)) {
      return { verdict: "skip" };
    }

    // One pre-hatch per chat session at a time; a stale record (dead temp
    // agent) is replaced rather than blocking enrichment forever.
    const pending = tryGet(PENDING_COLLECTION, sessionId);
    if (pending && !isStale(pending, nowMs())) {
      return { verdict: "skip" };
    }
    if (pending) {
      try { terminateAgent({ session_id: pending.temp_session_id }); } catch (_e) { /* best-effort */ }
    }
    const created = createSession({
      name: `Pre-hatcher: ${truncate(text, 40)}`,
      model: cheapModel,
      effort: "low",
      is_expert: true,
      expert_kind: "pre-hatcher",
      ...(systemPrompt !== "" ? { system_prompt: systemPrompt } : {}),
      ...(systemPromptName !== "" ? { system_prompt_name: systemPromptName } : {}),
    });
    const tempId = created?.session?.id;
    if (typeof tempId !== "string" || tempId === "") {
      return { verdict: "skip" };
    }
    sessionMetaSet({
      session_id: tempId,
      data: { chat_session_id: sessionId, original_text: text },
    });
    // Ask BEFORE storing the pending records: if the question cannot be raised
    // (e.g. headless — no live host), the throw lands in the catch below and
    // the message dispatches normally, leaving nothing behind but an idle,
    // never-dispatched temp session. The token is stored so `handleAnswer` can
    // match the opt-in answer core reports on `session.prehatch.answer`.
    const optInToken = genId();
    askUser({
      session_id: sessionId,
      question: OPT_IN_QUESTION,
      options: [OPT_IN_YES, OPT_IN_NO],
      token: optInToken,
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
      data: {
        chat_session_id: sessionId,
        original_text: text,
        history,
        phase: PHASE_OPT_IN,
        token: optInToken,
      },
    });
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

/// `session.prehatch.answer`: the user answered a pre-hatcher question whose
/// answer core would otherwise redirect to the temp research session. We
/// resolve it in CODE and return `cancel` when we own the outcome (so core
/// does NOT resume the temp agent with the raw answer), or `skip` to let core
/// resume it (a clarifying answer the research agent must read). Payload:
/// `{ chat_session_id, temp_session_id, token, answer, rejected }`.
export function handleAnswer(payload: any): {
  verdict: string;
  reason?: string;
  data?: any;
} {
  const tempId = asStr(payload?.temp_session_id);
  const chatId = asStr(payload?.chat_session_id);
  const token = asStr(payload?.token);
  const answer = asStr(payload?.answer);
  const rejected = payload?.rejected === true;
  if (tempId === "") {
    return { verdict: "skip" };
  }
  const link = tryGet(BY_TEMP_COLLECTION, tempId);
  if (!link) {
    // Nothing pending for this temp session — the flow already resolved.
    // Own it so core doesn't resume a stale (possibly terminated) temp agent
    // with the answer text, which is exactly the run-past-hand-off bug.
    return {
      verdict: "cancel",
      reason: "no pre-hatch pending for this answer",
      data: { delivered: "none" },
    };
  }
  const recordedToken = asStr(link.token);
  // A stale answer (an older, superseded question) must not drive the flow.
  if (recordedToken !== "" && token !== "" && recordedToken !== token) {
    return {
      verdict: "cancel",
      reason: "answer does not match the outstanding pre-hatch question",
      data: { delivered: "none" },
    };
  }
  const phase = asStr(link.phase);
  const original = asStr(link.original_text);

  if (phase === PHASE_OPT_IN) {
    if (isOptInAccept(answer, rejected)) {
      // Start the read-only research now — in code, not by resuming the temp
      // agent with the raw "yes".
      const history = asStr(link.history);
      storePut({
        collection: BY_TEMP_COLLECTION,
        key: tempId,
        data: {
          chat_session_id: chatId,
          original_text: original,
          history,
          phase: PHASE_RESEARCH,
          token: "",
        },
      });
      try {
        dispatchCapture({ session_id: tempId, prompt: researchPrompt(original, history) });
      } catch (_e) {
        // Could not start research: deliver the original so the message is
        // never lost.
        deliverOriginal(chatId, tempId, original);
        return {
          verdict: "cancel",
          reason: "pre-hatch research dispatch failed; original delivered",
          data: { delivered: "original" },
        };
      }
      return {
        verdict: "cancel",
        reason: "pre-hatch accepted: read-only research dispatched",
        data: { dispatched: true },
      };
    }
    // Decline or dismissal: deliver the original untouched, in code.
    deliverOriginal(chatId, tempId, original);
    return {
      verdict: "cancel",
      reason: "pre-hatch declined: original message delivered untouched",
      data: { delivered: "original" },
    };
  }

  if (phase === PHASE_AWAIT_APPROVAL) {
    const proposed = asStr(link.proposed_text);
    const approved = proposed !== "" && isApproved(answer, rejected);
    const text = approved ? proposed : original;
    try {
      deliverMessage({
        session_id: chatId,
        text,
        data: userEventData(text, original, approved, tempId),
      });
    } catch (_e) {
      // Could not deliver: clear the records and stop the temp agent so the
      // chat isn't left blocked or the research agent left running.
      cleanup(chatId, tempId);
      try { terminateAgent({ session_id: tempId }); } catch (_e2) { /* best-effort */ }
      return {
        verdict: "cancel",
        reason: "pre-hatch approval delivery failed",
        data: { delivered: "none" },
      };
    }
    cleanup(chatId, tempId);
    // Delivery from a hook does not auto-terminate the temp session (that only
    // happens when the caller itself is the pre-hatcher, e.g. `pass`), so stop
    // it explicitly — its work is over.
    try { terminateAgent({ session_id: tempId }); } catch (_e) { /* best-effort */ }
    return {
      verdict: "cancel",
      reason: approved ? "enriched message delivered" : "original message delivered",
      data: { delivered: approved ? "enriched" : "original" },
    };
  }

  if (phase === PHASE_AWAIT_CLARIFY) {
    // The clarifying answer must reach the research agent so it can finish
    // gathering context. Move back to the research phase and let core resume
    // the temp session with the answer (skip = not owned).
    storePut({
      collection: BY_TEMP_COLLECTION,
      key: tempId,
      data: {
        chat_session_id: chatId,
        original_text: original,
        history: asStr(link.history),
        phase: PHASE_RESEARCH,
        token: "",
      },
    });
    return { verdict: "skip" };
  }

  // Any other phase (research in flight, unknown): own it so core doesn't
  // resume the temp agent unexpectedly.
  return {
    verdict: "cancel",
    reason: "no outstanding pre-hatch question for this answer",
    data: { delivered: "none" },
  };
}

/// `session.prehatch.cancel`: the user cancelled the pre-hatch parked on
/// `session_id`. Core has already terminated the temp research agent and
/// dismissed the question cards; our job is to clear the pending records and
/// deliver the parked original message untouched. Returns a cancel verdict
/// whenever this plugin owned the outcome (delivered now, or nothing left to
/// do) — core treats anything else as "not handled" and delivers the
/// original itself, so `skip` is reserved for delivery failure.
export function handleHatchCancel(payload: any): {
  verdict: string;
  reason?: string;
  data?: any;
} {
  const chatId = asStr(payload?.session_id);
  if (chatId === "") {
    return { verdict: "skip" };
  }
  const pending = tryGet(PENDING_COLLECTION, chatId);
  const plan = cancelPlan(pending, asStr(payload?.temp_session_id));
  if (plan === "not-pending") {
    return {
      verdict: "cancel",
      reason: "no matching pre-hatch pending — nothing left to cancel",
      data: { delivered: "none" },
    };
  }
  const tempId = asStr(pending.temp_session_id);
  if (plan === "fallback") {
    cleanup(chatId, tempId);
    return { verdict: "skip" };
  }
  const original = asStr(pending.original_text);
  try {
    deliverMessage({
      session_id: chatId,
      text: original,
      data: userEventData(original, original, false, tempId, true),
    });
  } catch (_e) {
    // Could not deliver: clear the records so the chat isn't blocked and
    // skip so core's fallback delivery sends the original instead.
    cleanup(chatId, tempId);
    return { verdict: "skip" };
  }
  cleanup(chatId, tempId);
  return {
    verdict: "cancel",
    reason: "pre-hatch cancelled: original message delivered untouched",
    data: { delivered: "original" },
  };
}

/// The `pre_hatch_result` MCP tool, called by the temp research agent. It
/// reports the research outcome; the enrich/ask APPROVAL decisions are made in
/// code later (`handleAnswer`), never here from the agent's claim.
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
    // Delivery from the temp session's own tool call auto-terminates it
    // (core kills a pre-hatcher caller after `deliver_message`).
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
    // Never deliver AI-generated text directly: store the proposal, raise a
    // plugin-authored approval card on the chat session (redirected to this
    // temp session so `session.prehatch.answer` fires), and deliver from the
    // user's recorded answer in `handleAnswer`.
    const token = genId();
    storePut({
      collection: BY_TEMP_COLLECTION,
      key: callerSessionId,
      data: {
        chat_session_id: chatId,
        original_text: original,
        proposed_text: finalText,
        phase: PHASE_AWAIT_APPROVAL,
        token,
      },
    });
    askUser({
      session_id: chatId,
      question: approvalQuestion(finalText),
      options: [APPROVE_SEND, APPROVE_ORIGINAL],
      token,
      redirect_session_id: callerSessionId,
    });
    return {
      ok: true,
      status: "waiting_for_user",
      note:
        "The user is being asked to approve the expanded message; the plugin " +
        "delivers the approved version (or the original) itself once they " +
        "answer. You are DONE — end your turn and do not call pre_hatch_result " +
        "again.",
    };
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
    storePut({
      collection: BY_TEMP_COLLECTION,
      key: callerSessionId,
      data: {
        chat_session_id: chatId,
        original_text: original,
        history: asStr(link.history),
        phase: PHASE_AWAIT_CLARIFY,
        token,
      },
    });
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

  throw new Error(
    `unknown action '${action}' — expected pass | enrich | ask`,
  );
}

/// Deliver the original message untouched, clear the records, and stop the
/// temp agent. Used by the code-driven answer paths (a decline, or a research
/// dispatch that failed), where delivery from a hook does not auto-terminate
/// the temp session.
function deliverOriginal(chatId: string, tempId: string, original: string): void {
  try {
    deliverMessage({
      session_id: chatId,
      text: original,
      data: userEventData(original, original, false, tempId),
    });
  } catch (_e) {
    // best-effort — a delivery failure must not leave records dangling
  }
  cleanup(chatId, tempId);
  try { terminateAgent({ session_id: tempId }); } catch (_e) { /* best-effort */ }
}

/// Whether the recorded opt-in answer accepts expansion. A dismissal or any
/// label other than the explicit yes declines (the message is delivered
/// untouched).
function isOptInAccept(answer: string, rejected: boolean): boolean {
  return !rejected && answer === OPT_IN_YES;
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
