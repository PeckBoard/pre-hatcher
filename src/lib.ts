// Hook dispatch: parses the `{ hook, payload }` envelope and routes each hook
// to its handler. The wasm export functions themselves live in `index.ts`.

import { allow, cancel, skip } from "./verdict";
import { handleHatchCancel, handleMessageBefore, preHatchResult } from "./hatch";

/// Dispatch a hook call to the right handler, returning a verdict JSON string.
export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "session.message.before": {
      const v = handleMessageBefore(payload);
      return v.verdict === "cancel" ? cancel(v.reason ?? "pre-hatching", v.data) : skip();
    }
    case "session.prehatch.cancel": {
      const v = handleHatchCancel(payload);
      return v.verdict === "cancel" ? cancel(v.reason ?? "pre-hatch cancelled", v.data) : skip();
    }
    case "mcp.tool.invoke":
      return handleInvoke(payload);
    default:
      return skip();
  }
}

/// Dispatch an `mcp.tool.invoke` to the plugin's single tool. A tool-level
/// failure becomes an `{"error": ...}` value; an unknown tool is a Cancel.
function handleInvoke(payload: any): string {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return cancel("malformed invoke payload: not an object");
  }
  const tool: string = typeof payload.tool === "string" ? payload.tool : "";
  if (tool !== "pre_hatch_result") {
    return cancel(`pre-hatcher plugin does not provide tool '${tool}'`);
  }
  const args = payload.arguments ?? {};
  const callerSessionId: string =
    typeof payload.context?.sessionId === "string" ? payload.context.sessionId : "";

  let value: any;
  try {
    value = preHatchResult(args, callerSessionId);
  } catch (e) {
    value = { error: e instanceof Error ? e.message : String(e) };
  }
  return allow(value);
}
