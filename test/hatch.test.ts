import { describe, expect, it } from "vitest";
import {
  STALE_MS,
  baseModel,
  finalEnriched,
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
