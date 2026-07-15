# omp-patch

oh-my-pi extension that improves transient failure recovery and advisor visibility.

## Stream retry

Auto-continues the main session after:

- Cursor Connect `resource_exhausted` (stock classifier often fail-fasts via `retry.maxDelayMs`)
- HTTP/2 stream resets: `Stream closed with error code NGHTTP2_INTERNAL_ERROR` (stock auto-retry skips when the failed turn already has `toolCall` blocks)
- Stream idle stall / first-event timeout
- Thinking-loop errors that include `stream stall`

**Backoff:** ~5s first continue, then ~45–75s. **Cap:** 3 consecutive continues.

## Advisor UI

While advisors review a finished turn (stock omp only shows a static `++` until cards appear):

- Footer status: `Advisor reviewing… Ns`
- Above-editor widget explaining review is in progress
- Clears when notes arrive, after silent timeout (~120s), or when the main agent starts again

## Install

```bash
cd ~/.omp/plugins
bun add github:YukoOshima/omp-patch
```

Then start a **new session** (or `--resume`) so the extension module loads. `/reload-plugins` alone is not enough for extension code changes.
