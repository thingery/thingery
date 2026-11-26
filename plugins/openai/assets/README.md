# assets/

Icon set referenced by `../plugin.json`: the Thread mark glyph on a Sticker
yellow tile (light) / carbon tile (dark), generated from the brand system — the brand-token icon variant + colors
(Thread mark on Sticker yellow, THI-1191, 2026-11-24; replaces the THI-217
Set A green drafts).

| File            | Manifest field                          | Rules                              |
| --------------- | --------------------------------------- | ---------------------------------- |
| `icon.png`      | `interface.composerIcon`                | square PNG, ≥ 48×48, ≤ 5 MiB       |
| `logo.png`      | `interface.logo`                        | square PNG, ≥ 48×48, ≤ 5 MiB (primary listing icon — required for submission) |
| `icon-dark.png` | `interface.composerIconDark` (optional) | dark-theme variant                 |
| `logo-dark.png` | `interface.logoDark` (optional)         | dark-theme variant                 |
| `screenshot.png`| `interface.screenshots` (optional)      | MCP-only plugin: omit screenshots  |

Colors: sticker `#FFCE1F` tile with carbon `#14151A` glyph; dark variant is
carbon `#14151A` tile with sticker `#FFCE1F` glyph (`darkRoles.page`),
`stroke-linecap/join: round`, strokeWidth 11, viewBox 0 0 128 128.

`validate.mjs` checks presence, format, squareness and size limits of every
file referenced by the manifest.
