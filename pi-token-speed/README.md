# pi-token-speed

A pi extension that shows live model output speed (tok/s) with sliding-window estimation.

## Features

- Live streaming speed (tok/s) in the working indicator, estimated from stream deltas with a sliding window default 1s.
- Custom footer showing token stats + session-average speed right-aligned, or on its own line, or off.
- Sanitization guardrails: min-reliable-duration and max-display-speed, so burst artifacts don't show misleading numbers.
- `/pi-token-speed` toggles the extension; `/pi-token-speed working` toggles the working indicator; `/pi-token-speed position` cycles footer positions (right → line → off); `/pi-token-speed stats` shows session stats.

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
    "footerPosition": "right",
    "working": true,
    "label": "tok/s",
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
| `footer` | Show the footer speed. When false the built-in pi footer is left untouched. |
| `footerPosition` | `right` right-aligns speed at the end of the footer stats line; `line` puts it on its own line at the bottom; `off` disables the custom footer entirely (restores pi's default footer). |
| `working` | Show the live speed in the streaming working indicator. |
| `label` | Speed unit label shown next to numbers. |
| `slidingWindowMs` | Window length for live tok/s estimation. |
| `minReliableDurationMs` | Minimum message duration before a reading counts. |
| `maxDisplayTokS` | Speeds above this are considered invalid and hidden. |
| `useProviderTokens` | Prefer provider usage.output deltas vs. text estimation. |
| `countStrategy` | `estimate` splits on word/punctuation runs, `direct` counts each delta as 1 token. |

## Notes

- The custom footer (when `footerPosition` is `right` or `line`) replaces pi's built-in footer and re-renders the equivalent token stats line plus the speed indicator.
- With `footerPosition: "off"` or `footer: false`, pi's built-in footer shows again, but then the footer does not show the speed (the working indicator still does, if `working` is on).