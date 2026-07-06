import { describe, expect, it } from "vitest";
import {
  APPROVE_ORIGINAL,
  APPROVE_SEND,
  OPT_IN_NO,
  OPT_IN_YES,
  STALE_MS,
  approvalQuestion,
  baseModel,
  cancelPlan,
  finalEnriched,
  gatekeeperPrompt,
  isApproved,
  isStale,
  researchPrompt,
  shouldIntercept,
  userEventData,
} from "../src/hatch";
import { cancel } from "../src/verdict";

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
});

describe("gatekeeperPrompt", () => {
  it("holds the first turn and embeds the full research prompt", () => {
    const p = gatekeeperPrompt("fix the login bug");
    expect(p).toContain("do NOT call pre_hatch_result");
    expect(p).toContain("reply with exactly: ok");
    expect(p).toContain(researchPrompt("fix the login bug"));
  });

  it("branches on the exact opt-in option labels and declines to pass", () => {
    const p = gatekeeperPrompt("fix the login bug");
    expect(p).toContain(OPT_IN_YES);
    expect(p).toContain(OPT_IN_NO);
    // A decline or dismissal must deliver the original, never drop it.
    expect(p).toContain('{"action":"pass"}');
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
    expect(isApproved({ status: "answered", rejected: false, answer: APPROVE_SEND })).toBe(true);
    expect(isApproved({ status: "answered", answer: APPROVE_SEND })).toBe(true);
  });

  it("falls back to the original on decline, dismissal, or anything else", () => {
    expect(isApproved({ status: "answered", answer: APPROVE_ORIGINAL })).toBe(false);
    expect(isApproved({ status: "answered", rejected: true, answer: APPROVE_SEND })).toBe(false);
    expect(isApproved({ status: "pending" })).toBe(false);
    expect(isApproved({ status: "unknown" })).toBe(false);
    expect(isApproved(null)).toBe(false);
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