# Peckboard pre-igniter plugin

Pre-warms interactive chat messages **before** they reach the main (expensive)
model: a temp session on the provider's cheapest priced model gathers
repository context, optionally asks the user one clarifying question, and then
delivers the enriched — or untouched — message to the chat session.

## Flow

1. **Intercept** — core fires `session.message.before` for every interactive
   chat message (never workers/experts, never turns with attachments), with
   the session's resolved model and the provider's cheapest priced model
   (`cheap_model`, ranked by `AgentProvider::model_price`). The plugin skips
   when there is no cheaper model, the message is trivially short, or a
   pre-ignite is already in flight for that chat; otherwise it creates a temp
   research session (`is_expert`, kind `pre-igniter`) on the cheap model,
   dispatches the research prompt, and cancels the hook. Core parks the
   message as a `pre-ignite` placeholder event — the UI renders the user's
   text with a "pre-igniting…" shimmer.
2. **Research** — the temp agent reads the repo (outline/search/targeted
   reads only) and reports through the `pre_ignite_result` MCP tool:
   - `pass` — the message is fine as-is;
   - `enrich` — send `message` instead: the original message verbatim plus a
     distilled `## Context (pre-gathered)` section (≤ ~400 words);
   - `ask` — raise ONE clarifying question on the chat session. The answer is
     redirected to the temp session (`redirectSessionId` on the question
     event), which then finishes with `enrich`/`pass`.
3. **Deliver** — `peckboard_deliver_message` persists the final `user` event
   (data carries `pre_ignite: {original, enriched}` so the UI swaps the
   placeholder for the final message, original expandable), broadcasts it,
   and resumes the chat session so the main model runs on the enriched text.

There is **no timeout**: an in-flight pre-ignite waits as long as the research
takes. A pending record older than 30 minutes is treated as dead (crashed temp
agent) and replaced on the next message; enrichment failures always fall back
to sending the original message untouched.

## Hooks & permissions

| Hook | Why |
| --- | --- |
| `session.message.before` | Intercept chat messages pre-dispatch (scoped user-authority context). |
| `mcp.tool.invoke` | Serve `pre_ignite_result` to the temp research agent. |

Permissions: `session_write` (create/tag the temp session), `session_dispatch`
(`dispatch_capture`, `deliver_message`), `ask_user` (clarifying questions),
`data_store` (pending-flow records), `user_authority` (act under the user in
the scoped hook).

## Layout

```
src/index.ts     wasm exports (manifest / init / shutdown / handle)
src/lib.ts       hook dispatch
src/ignite.ts    the pre-ignite flow (pure helpers vitest-covered)
src/manifest.ts  manifest JSON (hooks, tool, permissions)
src/host.ts      typed peckboard_* host-function wrappers
src/verdict.ts   verdict envelopes
test/            vitest for the pure logic
```

## Build

```
./build.sh   # esbuild bundle → extism-js compile → dist/plugin.wasm
npm test     # vitest (pure logic only; no wasm runtime needed)
```

Requires Node/npm and `extism-js` on PATH. Install the built
`dist/plugin.wasm` into Peckboard's plugins directory and approve its hooks
and permissions in Settings; the plugin is inert until approved.
