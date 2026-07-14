# omp-patch

oh-my-pi extension that auto-continues the main session after transient provider/stream failures:

- Cursor Connect `resource_exhausted` (stock classifier often fail-fasts via `retry.maxDelayMs`)
- Stream idle stall: `...stream stalled while waiting for the next event`
- First-event timeout: `...timed out while waiting for the first event`
- Thinking-loop errors that include `stream stall`

**Backoff:** ~5s on the first continue, then ~45–75s. **Cap:** 3 consecutive continues.

This does **not** patch `parseRateLimitReason` inside omp — it recovers after `session_stop` when the last assistant message matches those error patterns.

## Install

**Plugin link (local clone):**

```bash
git clone https://github.com/YukoOshima/omp-patch.git ~/Code/omp-patch
omp plugin link ~/Code/omp-patch
```

**Plugin install from GitHub:**

```bash
omp plugin install github:YukoOshima/omp-patch
```

**Or drop / symlink into user extensions:**

```bash
ln -sfn ~/Code/omp-patch ~/.omp/agent/extensions/omp-patch
```

Restart `omp` after installing.

## Stall timeouts

Stall / first-event recovery only fires if the watchdog is enabled:

```bash
omp config set providers.streamIdleTimeoutSeconds 120
omp config set providers.streamFirstEventTimeoutSeconds 120
```

`0` disables those watchdogs.

## License

MIT
