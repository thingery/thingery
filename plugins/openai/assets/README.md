# assets/

Board-approved icon set (THI-217, Set A, confirmed 2026-10-16), referenced by
`../plugin.json`. Regenerate with the `make-thingery-icons.py` work product on
THI-217.

| File            | Manifest field                          | Rules                              |
| --------------- | --------------------------------------- | ---------------------------------- |
| `icon.png`      | `interface.composerIcon`                | square PNG, ≥ 48×48, ≤ 5 MiB       |
| `logo.png`      | `interface.logo`                        | square PNG, ≥ 48×48, ≤ 5 MiB (primary listing icon — required for submission) |
| `icon-dark.png` | `interface.composerIconDark` (optional) | dark-theme variant                 |
| `logo-dark.png` | `interface.logoDark` (optional)         | dark-theme variant                 |
| `screenshot.png`| `interface.screenshots` (optional)      | MCP-only plugin: omit screenshots  |

`validate.mjs` checks presence, format, squareness and size limits of every
file referenced by the manifest.
