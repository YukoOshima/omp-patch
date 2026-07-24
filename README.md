# omp-patch

oh-my-pi extension that improves transient failure recovery, advisor visibility, compact tool UI, and goal-mode magic-keyword stickiness.

## Stream retry

Auto-continues the main session after:

- Cursor Connect `resource_exhausted` (stock classifier often fail-fasts via `retry.maxDelayMs`)
- Stock fail-fast when the provider asks to wait longer than `retry.maxDelayMs` (e.g. 30m > 5m) — continue starts on `auto_retry_end`, waiting **at most 5 minutes** (never the full provider window)
- HTTP/2 stream resets: `Stream closed with error code NGHTTP2_INTERNAL_ERROR` (stock auto-retry skips when the failed turn already has `toolCall` blocks)
- Stream idle stall / first-event timeout
- Thinking-loop errors that include `stream stall`

**How:** Retries are scheduled with the host managed timer API (`ctx.setTimeout`) so the extension handler returns immediately — omp hard-times out handlers at 30s and discards their return value, which would silently drop long backoffs under a sleep-in-handler design. Managed timers are contained (a throwing/rejecting callback is routed to the extension error channel instead of crashing the process) and are cleared automatically on `session_shutdown`, so a pending retry can never fire into an unloaded runtime (`Extension runtime not initialized`). Continue is always triggered from `agent_end` / `auto_retry_end` via `pi.sendMessage(..., { triggerTurn: true, deliverAs: "nextTurn" })`.

**Dedupe:** One terminal failure fans out to multiple events; continues are keyed by error class and the key resets on `agent_start`, so the same failure fanout continues once while an identical failure on a later turn retries normally. **Cap:** 5 consecutive continues (truly effective under this dedupe).

**Session:** `session_start` / `session_switch` / `session_shutdown` cancel any pending retry and reset the consecutive count.

**Backoff:** ~5s first continue for ordinary blips, then ~45–75s. When the provider requests a longer wait (e.g. 30m), sleep `min(requested, 5m)`. **Never** wait more than 5 minutes per continue.

Keep stock `retry.maxDelayMs` at the default (~5m) so omp fail-fasts instead of sleeping multi-hour rate-limit windows; omp-patch then continues with the 5m cap above.

## Advisor UI

While advisors review a finished turn (stock omp only shows a static `++` until cards appear):

- Footer status: `Advisor reviewing… Ns`
- Above-editor widget explaining review is in progress
- Clears when notes arrive, after silent timeout (~120s), or when the main agent starts again


## Compact tool UI

Claude Code–style tool display:

- **Collapsed:** one line — status icon + tool name + short args (`✓ bash · git status`)
- **Expanded:** `Ctrl+O` restores the original rich output (diffs, full bash, etc.)
- **`task`:** patches the live `TaskTool` instance (`create` + `prototype.renderCall`), not only `toolRenderers.task` — because omp's tool-execution prefers instance renderers for task

Toggle at runtime: `/compact-tools`

`task` is patched on the live `TaskTool` class (prefer `api.pi.TaskTool`, else literal import `@oh-my-pi/pi-coding-agent/task`), not only `toolRenderers.task` — because the TUI prefers instance renderers for task.

`task` patching is **best-effort**: if the host class cannot be resolved or patched (e.g. plugins resolve a different `@oh-my-pi/pi-coding-agent` copy than the running omp), compact `task` UI is skipped and the rest of omp-patch (stream retry, advisor) still loads.



## Advisor autoresume

When omp 16.5.2+ **preserves** a `concern`/`blocker` card after the primary already finished with a terminal text answer (stock waits for you to type 继续 / `. `/`c`), this extension auto-continues one turn so the agent can weigh and act on the advice.

- **Default:** on
- **Toggle:** `/advisor-autoresume`
- **Scope:** `concern`/`blocker` only (`nit` stays aside)
- **Skips:** live steered turns, plan mode, Esc/cancel preserves (no recent terminal answer), and caps at 3 consecutive autoresumes

This does **not** replace `advisor.immuneTurns` tuning. Set `immuneTurns: 0` separately if dual advisors are cooldown-downgrading each other to asides.

## Goal magic sticky

Stock omp only injects `ultrathink` / `orchestrate` / `workflowz` notices when a **user** prompt contains the standalone keyword. Goal auto-continuations skip that path, so keywords in `/goal set …` would only fire once.

This extension re-injects the matching notices on later goal turns when:

- the **active** goal objective contains the keyword(s) (paused/dropped → off)
- `magicKeywords.*` still allows them (unreadable config → no inject)
- stock would **not** already inject on this turn (no double notice on the first auto-submit)
- for `workflowz`: the `task` tool is active
- main session only (keyed by session id; subagents never sticky-inject)

No extra slash command — writing the keyword into the objective is the enable switch.

Example:

```text
/goal set 研究 auth 存储路径 workflowz orchestrate；交付结构化地图与证据
```

## Requirements

Requires oh-my-pi **>= 17.0.2** (managed timer API: `ctx.setTimeout` / `ctx.clearTimer`).

## Install


```bash
# from GitHub
cd ~/.omp/plugins && bun add github:YukoOshima/omp-patch

# or link a local checkout
omp plugin link /path/to/omp-patch
```

Then start a **new session** (or `--resume`) so the extension module loads. `/reload-plugins` alone is not enough for extension code changes.
