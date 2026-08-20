# pi-token-speed

A pi extension that shows live model output speed (tok/s) with sliding-window estimation.

## Features

- Live streaming speed (tok/s) in the working indicator, estimated from stream deltas with a sliding window default 1s.
- Session-average speed published via `ctx.ui.setStatus("pi-token-speed")` for footer extensions like pi-footer.
- Sanitization guardrails: min-reliable-duration and max-display-speed, so burst artifacts don't show misleading numbers.
- `/pi-token-speed` toggles the extension, `/pi-token-speed stats` shows session stats.

## Install

Run inside pi:

```text
pi install git:github.com/<your-name>/pi-token-speed
```

Or use locally:

```text
pi -e ./pi-token-speed
```

Restart pi or `/reload` after install.

## Config

Config file: `~/.pi/agent/pi-token-speed.json`

```json
{
  "version": 1,
  "config": {
    "enabled": true,
    "footer": true,
    "working": true,
    "label": "tok/s",
    "footerPrefix": "session avg",
    "workingPrefix": "Working...",
    "renderIntervalMs": 250,
    "slidingWindowMs": 1000,
    "minReliableDurationMs": 1000,
    "maxDisplayTokS": 500,
    "useProviderTokens": true,
    "countStrategy": "estimate"
  }
}
```

| Key | Meaning |
| --- | --- |
| `label` | Speed unit label shown next to numbers. |
| `footerPrefix` | Prefix for the footer status string. |
| `slidingWindowMs` | Window length for live tok/s estimation. |
| `minReliableDurationMs` | Minimum message duration before a reading counts. |
| `maxDisplayTokS` | Speeds above this are considered invalid and hidden. |
| `useProviderTokens` | Prefer provider usage.output deltas vs. text estimation. |
| `countStrategy` | `estimate` splits on word/punctuation runs, `direct` counts each delta as 1 token. |

## Integrate in pi-footer

pi-footer users can add an "Extension Status" widget with the status key `pi-token-speed`, or add `output-speed`, `input-speed`, and `total-speed` widgets for per-minute averages.