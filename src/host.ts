// FFI layer: the host functions Peckboard core provides, the host_call
// marshaling helper, and the small id/time helpers the logic module reaches
// through. All host calls are kept LAZY (inside functions) so the pure module
// (`ignite.ts`) can be loaded under vitest without an Extism runtime.

type HostFn = (offset: bigint) => bigint;

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as a thrown Error.
export function hostCall(name: string, input: unknown): any {
  const f = (Host.getFunctions() as Record<string, HostFn>)[name];
  const mem = Memory.fromString(JSON.stringify(input));
  const out = f(mem.offset);
  const parsed = JSON.parse(Memory.find(out).readString());
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    throw new Error(String(parsed.error));
  }
  return parsed;
}

// ── Typed wrappers for each peckboard_* host function ──────────────────

export function createSession(input: {
  name: string;
  model?: string;
  effort?: string;
  is_expert?: boolean;
  expert_kind?: string;
}): any {
  return hostCall("peckboard_create_session", input);
}

export function sessionMetaSet(input: { session_id: string; data: unknown }): any {
  return hostCall("peckboard_session_meta_set", input);
}

export function dispatchCapture(input: { session_id: string; prompt: string }): any {
  return hostCall("peckboard_dispatch_capture", input);
}

/// Persist a `user` event (with `data`) on the target session, broadcast it,
/// and resume the session with `text` — the transcript-writing twin of
/// resume_session. This is how the final (enriched or original) chat message
/// lands.
export function deliverMessage(input: {
  session_id: string;
  text: string;
  data?: unknown;
}): any {
  return hostCall("peckboard_deliver_message", input);
}

/// Emit a question card on `session_id`. `redirect_session_id` makes the
/// user's answer resume THAT session instead of the asker — the pre-hatcher
/// asks on the chat session and receives the answer on its temp session.
export function askUser(input: {
  session_id: string;
  question: string;
  options?: string[];
  token: string;
  redirect_session_id?: string;
}): any {
  return hostCall("peckboard_ask_user", input);
}

/// Read the user's REAL answer to a plugin-emitted question (`token`) from
/// the target session's event log — core is the source of truth, so an
/// agent cannot forge an approval. Returns
/// `{status: "pending"|"answered"|"unknown", answer?, rejected?}`.
export function getAnswer(input: { token: string; session_id?: string }): any {
  return hostCall("peckboard_get_answer", input);
}
export function storePut(input: { collection: string; key: string; data: unknown }): any {
  return hostCall("peckboard_store_put", input);
}

export function storeGet(input: { collection: string; key: string }): any {
  return hostCall("peckboard_store_get", input);
}

export function storeDelete(input: { collection: string; key: string }): any {
  return hostCall("peckboard_store_delete", input);
}

// ── IDs / time (sandbox-provided; no WASI needed) ─────────────────────

/// A random opaque correlation id (question tokens).
export function genId(): string {
  return crypto.randomUUID();
}

/// Current realtime clock in milliseconds.
export function nowMs(): number {
  return Date.now();
}

export function terminateAgent(input: { session_id: string }): any {
  return hostCall("peckboard_terminate_agent", input);
}
