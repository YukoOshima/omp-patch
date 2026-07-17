# omp-patch

oh-my-pi extension that improves transient failure recovery and advisor visibility.

## Stream retry

Auto-continues the main session after:

- Cursor Connect `resource_exhausted` (stock classifier often fail-fasts via `retry.maxDelayMs`)
- Stock fail-fast when the provider asks to wait longer than `retry.maxDelayMs` (e.g. 30m > 5m) — continue starts on `auto_retry_end`, waiting **at most 5 minutes** (never the full provider window)
- HTTP/2 stream resets: `Stream closed with error code NGHTTP2_INTERNAL_ERROR` (stock auto-retry skips when the failed turn already has `toolCall` blocks)
- Stream idle stall / first-event timeout
- Thinking-loop errors that include `stream stall`

**How:** Retries are scheduled with `setTimeout` so the extension handler returns immediately — omp hard-times out handlers at 30s and discards their return value, which would silently drop long backoffs under a sleep-in-handler design. Continue is always triggered from `agent_end` / `auto_retry_end` via `pi.sendMessage(..., { triggerTurn: true, deliverAs: "nextTurn" })`.

**Dedupe:** One terminal failure fans out to multiple events; continues are keyed by error class and the key resets on `agent_start`, so the same failure fanout continues once while an identical failure on a later turn retries normally. **Cap:** 5 consecutive continues (truly effective under this dedupe).

**Session:** `session_start` / `session_switch` cancel any pending retry and reset the consecutive count.

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

## Install


```bash
# from GitHub
cd ~/.omp/plugins && bun add github:YukoOshima/omp-patch

# or link a local checkout
omp plugin link /path/to/omp-patch
```

Then start a **new session** (or `--resume`) so the extension module loads. `/reload-plugins` alone is not enough for extension code changes.
