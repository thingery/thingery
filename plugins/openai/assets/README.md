# assets/

Icon files for the OpenAI plugin manifest. **Pending [THI-217]** (board
approval gate): this directory is empty until the approved icon assets land.

Expected files (referenced by `../plugin.json`):

| File            | Manifest field                          | Rules                              |
| --------------- | --------------------------------------- | ---------------------------------- |
| `icon.png`      | `interface.composerIcon`                | square PNG, ≥ 48×48, ≤ 5 MiB       |
| `logo.png`      | `interface.logo`                        | square PNG, ≥ 48×48, ≤ 5 MiB (primary listing icon — required for submission) |
| `icon-dark.png` | `interface.composerIconDark` (optional) | dark-theme variant                 |
| `logo-dark.png` | `interface.logoDark` (optional)         | dark-theme variant                 |
| `screenshot.png`| `interface.screenshots` (optional)      | MCP-only plugin: omit screenshots  |

`validate.mjs` checks presence, format, squareness and size limits of every
file referenced by the manifest.
