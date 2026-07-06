# Peckboard pre-hatcher plugin

Pre-warms interactive chat messages **before** they reach the main (expensive)
model. Each intercepted message first gets a plain opt-in question card (no AI
involved); on acceptance a temp session on a cheaper model (the provider's
cheapest priced one, or the model picked in Settings → Pre-hatcher) gathers
repository context, optionally asks the user one clarifying question, and then
delivers the enriched — or untouched — message to the chat session.

## Flow

1. **Intercept** — core fires `session.message.before` for every interactive
   chat message (never workers/experts, never turns with attachments), with
   the session's resolved model and the pre-hatch model (`cheap_model`: the
   Settings override when set, otherwise the provider's cheapest priced
   model, ranked by `AgentProvider::model_price`). The plugin skips when
   there is no cheaper model, the message is trivially short, or a
   pre-hatch is already in flight for that chat; otherwise it creates a temp
   research session (`is_expert`, kind `pre-hatcher`) on the cheap model,
   dispatches the gatekeeper prompt (the agent replies `ok` and holds — no
   research yet), raises the plugin-authored opt-in question on the chat
   session ("Expand this message with repository context…?"), and cancels
   the hook with `data: {temp_session_id, model}`. Core parks the message as
   a `pre-hatch` placeholder event carrying that data — the UI renders the
   user's text with a live feed of the temp session's actions.
2. **Opt-in** — the user's answer is redirected to the temp session
   (`redirectSessionId` on the question event): core resumes a question's
   target directly and never re-fires the hook, so the temp agent is the
   only place the answer can be acted on. "No, send as-is" (or a dismissal)
   makes it report `pass` immediately — the original message is delivered
   untouched, no research spend; "Yes, expand it" starts the research.
3. **Research** — on acceptance the temp agent reads the repo (outline/search/targeted
   reads only) and reports through the `pre_hatch_result` MCP tool:
   - `pass` — the message is fine as-is;
   - `enrich` — propose `message`: the original message verbatim plus a
     distilled `## Context (pre-gathered)` section (≤ ~400 words);
   - `ask` — raise ONE clarifying question on the chat session. The answer is
     redirected to the temp session (`redirectSessionId` on the question
     event), which then finishes with `enrich`/`pass`.
4. **Approve** — an enrich proposal is never delivered directly: the plugin
   stores it and raises a second plugin-authored question card on the chat
   session showing the expanded text ("Send expanded message" / "Send my
   original message"), answer redirected to the temp session. The agent then
   calls `finalize`; the plugin reads the user's recorded answer via
   `peckboard_get_answer` — core is the source of truth, so the agent can
   neither forge approval nor alter the delivered text — and delivers the
   stored expanded message on approval, the original otherwise.
5. **Deliver** — `peckboard_deliver_message` persists the final `user` event
   (data carries `pre_hatch: {original, enriched}` so the UI swaps the
   placeholder for the final message, original expandable), broadcasts it,
   and resumes the chat session so the main model runs on the enriched text.

There is **no timeout**: an accepted pre-hatch waits as long as the research
takes. A pending record older than 30 minutes is treated as dead (crashed temp
agent, or a question the user typed past — typing a new message dismisses the
card without resuming the temp agent, leaving the parked message undelivered)
and replaced on the next message; enrichment failures always fall back to
sending the original message untouched.

An in-flight pre-hatch can also be **cancelled** from the parked bubble
(`POST /api/sessions/:id/prehatch-cancel`): core terminates the temp research
agent and dismisses any question card, then fires `session.prehatch.cancel` —
the plugin clears its pending records and delivers the original message
untouched through its normal path (a `cancel` verdict; `skip` makes core
deliver the original itself so the message is never lost).

## Hooks & permissions

| Hook | Why |
| --- | --- |
| `session.message.before` | Intercept chat messages pre-dispatch (scoped user-authority context). |
| `session.prehatch.cancel` | Clean up + deliver the original when the user cancels a pre-hatch. |
| `mcp.tool.invoke` | Serve `pre_hatch_result` to the temp research agent. |

(`dispatch_capture`, `deliver_message`), `ask_user` (opt-in, approval, and
clarifying question cards, plus reading the recorded answers),
`session_write` (create/tag the temp session), `session_dispatch`
(`dispatch_capture`, `deliver_message`), `ask_user` (clarifying questions),
`data_store` (pending-flow records), `user_authority` (act under the user in
the scoped hook).

## Layout

```
src/index.ts     wasm exports (manifest / init / shutdown / handle)
src/lib.ts       hook dispatch
src/hatch.ts     the pre-hatch flow (pure helpers vitest-covered)
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
