import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVE_ORIGINAL,
  APPROVE_SEND,
  BY_TEMP_COLLECTION,
  OPT_IN_NO,
  OPT_IN_YES,
  PENDING_COLLECTION,
  PHASE_AWAIT_APPROVAL,
  PHASE_AWAIT_CLARIFY,
  PHASE_OPT_IN,
  PHASE_RESEARCH,
  STALE_MS,
  approvalQuestion,
  baseModel,
  cancelPlan,
  finalEnriched,
  handleAnswer,
  isApproved,
  isStale,
  preHatchResult,
  researchPrompt,
  shouldIntercept,
  userEventData,
} from "../src/hatch";
import { cancel } from "../src/verdict";

// A fake in-memory host so the host-touching handlers can be exercised.
// `store` mirrors the plugin data store; `calls` records the side effects we
// assert the flow does (and, crucially, does NOT do) after it hatches.
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: {
    deliver: [] as any[],
    ask: [] as any[],
    dispatch: [] as any[],
    terminate: [] as any[],
  },
}));

vi.mock("../src/host", () => ({
  storePut: vi.fn((i: any) => {
    h.store.set(`${i.collection}:${i.key}`, i.data);
    return {};
  }),
  storeGet: vi.fn((i: any) => {
    const k = `${i.collection}:${i.key}`;
    return { value: h.store.has(k) ? h.store.get(k) : null };
  }),
  storeDelete: vi.fn((i: any) => {
    h.store.delete(`${i.collection}:${i.key}`);
    return {};
  }),
  deliverMessage: vi.fn((i: any) => {
    h.calls.deliver.push(i);
    return {};
  }),
  askUser: vi.fn((i: any) => {
    h.calls.ask.push(i);
    return {};
  }),
  dispatchCapture: vi.fn((i: any) => {
    h.calls.dispatch.push(i);
    return {};
  }),
  createSession: vi.fn(() => ({ session: { id: "temp-1" } })),
  sessionMetaSet: vi.fn(() => ({})),
  terminateAgent: vi.fn((i: any) => {
    h.calls.terminate.push(i);
    return {};
  }),
  genId: vi.fn(() => "tok-1"),
  nowMs: vi.fn(() => 1000),
}));

describe("baseModel", () => {
  it("strips provider prefix and account suffix", () => {
    expect(baseModel("claude:claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(baseModel("claude-haiku-4-5@acc_1")).toBe("claude-haiku-4-5");
    expect(baseModel("claude:claude-haiku-4-5@acc_1")).toBe("claude-haiku-4-5");
    expect(baseModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
});

describe("shouldIntercept", () => {
  it("skips when the provider prices no cheaper model", () => {
    expect(shouldIntercept("please refactor the auth flow", "claude-opus-4-8", "")).toBe(false);
  });

  it("skips when the session already runs the cheapest model", () => {
    expect(
      shouldIntercept("please refactor the auth flow", "claude-haiku-4-5", "claude:claude-haiku-4-5"),
    ).toBe(false);
  });

  it("skips trivially short messages", () => {
    expect(shouldIntercept("ok", "claude-opus-4-8", "claude:claude-haiku-4-5")).toBe(false);
    expect(shouldIntercept("  yes  ", "claude-opus-4-8", "claude:claude-haiku-4-5")).toBe(false);
  });

  it("intercepts a substantive message on an expensive model", () => {
    expect(
      shouldIntercept(
        "fix the login redirect bug in the session handler",
        "claude-opus-4-8",
        "claude:claude-haiku-4-5",
      ),
    ).toBe(true);
  });
});

describe("isStale", () => {
  it("treats a fresh record as live and an old one as dead", () => {
    const now = 10_000_000;
    expect(isStale({ created_ms: now - 1000 }, now)).toBe(false);
    expect(isStale({ created_ms: now - STALE_MS - 1 }, now)).toBe(true);
    // Malformed record (no created_ms) counts as stale, not as a blocker.
    expect(isStale({}, now)).toBe(true);
  });
});

describe("finalEnriched", () => {
  it("keeps the model's message when it contains the original verbatim", () => {
    const original = "fix the login bug";
    const enriched = "fix the login bug\n\n## Context (pre-gathered)\n- src/auth.rs:42";
    expect(finalEnriched(original, enriched)).toBe(enriched);
  });

  it("prepends the original when the model paraphrased it away", () => {
    const out = finalEnriched("fix the login bug", "## Context\n- src/auth.rs:42");
    expect(out.startsWith("fix the login bug\n\n")).toBe(true);
    expect(out).toContain("src/auth.rs:42");
  });
});

describe("userEventData", () => {
  it("carries the rendered text plus the original for the expandable view", () => {
    const d = userEventData("enriched text", "original text", true, "temp-1");
    expect(d.text).toBe("enriched text");
    expect(d.pre_hatch.original).toBe("original text");
    expect(d.pre_hatch.enriched).toBe(true);
    expect(d.pre_hatch.temp_session_id).toBe("temp-1");
  });

  it("marks a cancelled delivery without touching the normal shape", () => {
    const d = userEventData("original", "original", false, "temp-1", true);
    expect(d.pre_hatch.cancelled).toBe(true);
    expect(d.pre_hatch.enriched).toBe(false);
    // The flag is absent — not false — on ordinary deliveries, so old
    // readers see the exact shape they always did.
    const plain = userEventData("original", "original", false, "temp-1");
    expect("cancelled" in plain.pre_hatch).toBe(false);
  });
});

describe("cancel", () => {
  it("carries structured data when given, and omits it when not", () => {
    const bare = JSON.parse(cancel("pre-hatching"));
    expect(bare).toEqual({ verdict: "cancel", reason: "pre-hatching" });
    const withData = JSON.parse(
      cancel("pre-hatching", { temp_session_id: "temp-1", model: "claude:claude-haiku-4-5" }),
    );
    expect(withData.data.temp_session_id).toBe("temp-1");
    expect(withData.data.model).toBe("claude:claude-haiku-4-5");
  });
});

describe("researchPrompt", () => {
  it("embeds the user message between markers and names the tool", () => {
    const p = researchPrompt("what does the orchestrator do?");
    expect(p).toContain("---BEGIN USER MESSAGE---");
    expect(p).toContain("what does the orchestrator do?");
    expect(p).toContain("---END USER MESSAGE---");
    expect(p).toContain("pre_hatch_result");
  });

  it("declares the session read-only, context-only, and names the blocked tools", () => {
    const p = researchPrompt("fix the login bug");
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("NEVER make code changes");
    expect(p).toContain("that work belongs to the main model");
    for (const tool of ["write_file", "edit_file", "run_command", "run_tests"]) {
      expect(p).toContain(tool);
    }
    // The prompt must tell the model enforcement is server-side, not
    // just advisory.
    expect(p).toContain("the server refuses them");
  });

  it("tells the model it is DONE after enrich — no finalize round-trip", () => {
    const p = researchPrompt("fix the login bug");
    expect(p).toContain("After you call enrich you are DONE");
    expect(p).not.toContain("finalize");
  });
});

describe("approvalQuestion", () => {
  it("embeds the proposal, clipped for the card", () => {
    const q = approvalQuestion("fix the bug\n\n## Context (pre-gathered)\n- src/a.rs:1");
    expect(q).toContain("Send");
    expect(q).toContain("## Context (pre-gathered)");
    const long = approvalQuestion("x".repeat(5000));
    expect(Array.from(long).length).toBeLessThan(1400);
    expect(long).toContain("…");
  });
});

describe("isApproved", () => {
  it("approves only an explicit, unrejected 'send expanded' answer", () => {
    expect(isApproved(APPROVE_SEND, false)).toBe(true);
  });

  it("falls back to the original on decline, dismissal, or anything else", () => {
    expect(isApproved(APPROVE_ORIGINAL, false)).toBe(false);
    expect(isApproved(APPROVE_SEND, true)).toBe(false);
    expect(isApproved("", true)).toBe(false);
    expect(isApproved("something else", false)).toBe(false);
  });
});

describe("cancelPlan", () => {
  const pending = { temp_session_id: "temp-1", original_text: "fix the login bug" };

  it("delivers the recorded original for the matching pre-hatch", () => {
    expect(cancelPlan(pending, "temp-1")).toBe("deliver");
    // A cancel that doesn't name a temp session (legacy event) still hits
    // the chat's only pending record.
    expect(cancelPlan(pending, "")).toBe("deliver");
  });

  it("does nothing when no record is pending or a newer pre-hatch owns it", () => {
    expect(cancelPlan(null, "temp-1")).toBe("not-pending");
    expect(cancelPlan(pending, "temp-2")).toBe("not-pending");
  });

  it("falls back to core delivery when the record is unusable", () => {
    expect(cancelPlan({ temp_session_id: "temp-1" }, "temp-1")).toBe("fallback");
    expect(cancelPlan({ temp_session_id: "temp-1", original_text: "  " }, "temp-1")).toBe(
      "fallback",
    );
  });
});

describe("researchPrompt with session context", () => {
  it("embeds the full chat transcript when history is supplied", () => {
    const history = "User: earlier question\n\nAssistant: earlier answer";
    const p = researchPrompt("and now fix that", history);
    expect(p).toContain("---BEGIN CONVERSATION---");
    expect(p).toContain("earlier question");
    expect(p).toContain("earlier answer");
    expect(p).toContain("---END CONVERSATION---");
    // The new message stays clearly separated from the transcript.
    expect(p).toContain("---BEGIN USER MESSAGE---");
    expect(p).toContain("and now fix that");
  });

  it("omits the conversation block when there is no history", () => {
    const p = researchPrompt("standalone question");
    expect(p).not.toContain("---BEGIN CONVERSATION---");
  });

  it("instructs the model to ALWAYS ask when the request is ambiguous", () => {
    const p = researchPrompt("do the thing");
    expect(p).toContain("ALWAYS resolve ambiguity by ASKING");
    expect(p).toContain('{"action":"ask"');
  });
});

// The end-to-end control flow: the tool reports research; every yes/no
// decision and the actual delivery happen in CODE, in `handleAnswer`.
describe("pre-hatch control flow is decided in code, not by the model", () => {
  beforeEach(() => {
    h.store.clear();
    h.calls.deliver.length = 0;
    h.calls.ask.length = 0;
    h.calls.dispatch.length = 0;
    h.calls.terminate.length = 0;
    vi.clearAllMocks();
  });

  function seedOptIn(temp: string, chat: string, text: string, history = "") {
    h.store.set(`${BY_TEMP_COLLECTION}:${temp}`, {
      chat_session_id: chat,
      original_text: text,
      history,
      phase: PHASE_OPT_IN,
      token: "tok-opt",
    });
    h.store.set(`${PENDING_COLLECTION}:${chat}`, {
      temp_session_id: temp,
      original_text: text,
      created_ms: 1000,
    });
  }

  it("opt-in accept dispatches read-only research in code and delivers nothing yet", () => {
    seedOptIn("temp-9", "chat-9", "refactor the parser", "prior turns");
    const v = handleAnswer({
      chat_session_id: "chat-9",
      temp_session_id: "temp-9",
      token: "tok-opt",
      answer: OPT_IN_YES,
      rejected: false,
    });
    expect(v.verdict).toBe("cancel");
    expect(h.calls.deliver).toHaveLength(0);
    expect(h.calls.dispatch).toHaveLength(1);
    expect(h.calls.dispatch[0].session_id).toBe("temp-9");
    expect(h.calls.dispatch[0].prompt).toContain("---BEGIN USER MESSAGE---");
    expect(h.calls.dispatch[0].prompt).toContain("refactor the parser");
    expect(h.calls.dispatch[0].prompt).toContain("prior turns");
    const rec = h.store.get(`${BY_TEMP_COLLECTION}:temp-9`) as any;
    expect(rec.phase).toBe(PHASE_RESEARCH);
  });

  it("opt-in decline delivers the original untouched and stops the temp agent", () => {
    seedOptIn("temp-8", "chat-8", "explain the parser");
    const v = handleAnswer({
      chat_session_id: "chat-8",
      temp_session_id: "temp-8",
      token: "tok-opt",
      answer: OPT_IN_NO,
      rejected: false,
    });
    expect(v.verdict).toBe("cancel");
    expect(v.data.delivered).toBe("original");
    expect(h.calls.deliver).toHaveLength(1);
    expect(h.calls.deliver[0].text).toBe("explain the parser");
    expect(h.calls.dispatch).toHaveLength(0);
    expect(h.calls.terminate).toContainEqual({ session_id: "temp-8" });
    expect(h.store.has(`${BY_TEMP_COLLECTION}:temp-8`)).toBe(false);
    expect(h.store.has(`${PENDING_COLLECTION}:chat-8`)).toBe(false);
  });

  it("opt-in dismissal (rejected) delivers the original", () => {
    seedOptIn("temp-7", "chat-7", "do the thing");
    const v = handleAnswer({
      chat_session_id: "chat-7",
      temp_session_id: "temp-7",
      token: "tok-opt",
      answer: "",
      rejected: true,
    });
    expect(v.data.delivered).toBe("original");
    expect(h.calls.deliver[0].text).toBe("do the thing");
    expect(h.calls.dispatch).toHaveLength(0);
  });

  it("enrich proposes; approving delivers the hatched prompt once via the answer hook, then stops", () => {
    h.store.set(`${BY_TEMP_COLLECTION}:temp-1`, {
      chat_session_id: "chat-1",
      original_text: "fix the login bug",
      history: "",
      phase: PHASE_RESEARCH,
      token: "",
    });
    h.store.set(`${PENDING_COLLECTION}:chat-1`, {
      temp_session_id: "temp-1",
      original_text: "fix the login bug",
      created_ms: 1000,
    });

    // enrich: PROPOSES the expanded ("hatched") message. Nothing is delivered
    // yet — only the approval card is raised, and by_temp now awaits approval.
    const enriched = "fix the login bug\n\n## Context (pre-gathered)\n- src/auth.rs:42";
    const r1 = preHatchResult({ action: "enrich", message: enriched }, "temp-1");
    expect(r1.status).toBe("waiting_for_user");
    expect(h.calls.deliver).toHaveLength(0);
    expect(h.calls.ask).toHaveLength(1);
    const rec = h.store.get(`${BY_TEMP_COLLECTION}:temp-1`) as any;
    expect(rec.phase).toBe(PHASE_AWAIT_APPROVAL);
    expect(rec.proposed_text).toBe(enriched);
    expect(rec.token).toBe("tok-1");

    // The user approves — the answer hook delivers the hatched prompt EXACTLY
    // once, from the recorded answer, and stops the flow.
    const v = handleAnswer({
      chat_session_id: "chat-1",
      temp_session_id: "temp-1",
      token: "tok-1",
      answer: APPROVE_SEND,
      rejected: false,
    });
    expect(v.verdict).toBe("cancel");
    expect(v.data.delivered).toBe("enriched");
    expect(h.calls.deliver).toHaveLength(1);
    expect(h.calls.deliver[0].text).toBe(enriched);

    // STOPPED: both records cleared, temp agent terminated, and no dispatch or
    // second question that could re-run the temp research agent.
    expect(h.store.has(`${BY_TEMP_COLLECTION}:temp-1`)).toBe(false);
    expect(h.store.has(`${PENDING_COLLECTION}:chat-1`)).toBe(false);
    expect(h.calls.terminate).toContainEqual({ session_id: "temp-1" });
    expect(h.calls.dispatch).toHaveLength(0);
    expect(h.calls.ask).toHaveLength(1);
  });

  it("enrich then decline delivers the original, not the proposal", () => {
    h.store.set(`${BY_TEMP_COLLECTION}:temp-2`, {
      chat_session_id: "chat-2",
      original_text: "add a flag",
      phase: PHASE_RESEARCH,
      token: "",
    });
    preHatchResult({ action: "enrich", message: "add a flag\n\n## Context\n- x" }, "temp-2");
    const v = handleAnswer({
      chat_session_id: "chat-2",
      temp_session_id: "temp-2",
      token: "tok-1",
      answer: APPROVE_ORIGINAL,
      rejected: false,
    });
    expect(v.data.delivered).toBe("original");
    expect(h.calls.deliver).toHaveLength(1);
    expect(h.calls.deliver[0].text).toBe("add a flag");
  });

  it("pass delivers the original once and then stops", () => {
    h.store.set(`${BY_TEMP_COLLECTION}:temp-3`, {
      chat_session_id: "chat-3",
      original_text: "explain the parser",
      phase: PHASE_RESEARCH,
      token: "",
    });
    h.store.set(`${PENDING_COLLECTION}:chat-3`, {
      temp_session_id: "temp-3",
      original_text: "explain the parser",
      created_ms: 1000,
    });
    const r = preHatchResult({ action: "pass" }, "temp-3");
    expect(r).toEqual({ ok: true, delivered: "original" });
    expect(h.calls.deliver).toHaveLength(1);
    expect(h.calls.dispatch).toHaveLength(0);
    expect(h.store.has(`${BY_TEMP_COLLECTION}:temp-3`)).toBe(false);
    expect(h.store.has(`${PENDING_COLLECTION}:chat-3`)).toBe(false);
  });

  it("a clarifying answer is left for core to resume the research agent (skip)", () => {
    h.store.set(`${BY_TEMP_COLLECTION}:temp-6`, {
      chat_session_id: "chat-6",
      original_text: "q",
      history: "h",
      phase: PHASE_AWAIT_CLARIFY,
      token: "tok-ask",
    });
    const v = handleAnswer({
      chat_session_id: "chat-6",
      temp_session_id: "temp-6",
      token: "tok-ask",
      answer: "some option",
      rejected: false,
    });
    expect(v.verdict).toBe("skip");
    expect(h.calls.deliver).toHaveLength(0);
    const rec = h.store.get(`${BY_TEMP_COLLECTION}:temp-6`) as any;
    expect(rec.phase).toBe(PHASE_RESEARCH);
  });

  it("owns an answer with no pending record so core never resumes a stale temp agent", () => {
    const v = handleAnswer({
      chat_session_id: "chat-x",
      temp_session_id: "temp-x",
      token: "t",
      answer: OPT_IN_YES,
      rejected: false,
    });
    expect(v.verdict).toBe("cancel");
    expect(v.data.delivered).toBe("none");
    expect(h.calls.deliver).toHaveLength(0);
    expect(h.calls.dispatch).toHaveLength(0);
  });

  it("ignores a stale answer whose token no longer matches the outstanding question", () => {
    h.store.set(`${BY_TEMP_COLLECTION}:temp-5`, {
      chat_session_id: "chat-5",
      original_text: "q",
      phase: PHASE_AWAIT_APPROVAL,
      proposed_text: "q\n\n## Context",
      token: "current",
    });
    const v = handleAnswer({
      chat_session_id: "chat-5",
      temp_session_id: "temp-5",
      token: "stale",
      answer: APPROVE_SEND,
      rejected: false,
    });
    expect(v.verdict).toBe("cancel");
    expect(h.calls.deliver).toHaveLength(0);
  });
});
