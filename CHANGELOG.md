# Changelog

All notable user-facing changes to Palette Mimicry are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-17

Initial release.

### Added

- **Semantic theme remapping** — websites are repainted into a chosen visual
  palette. The engine analyzes each page and automatically picks the best
  remapping approach: CSS custom-property override, authored-CSS rewrite,
  computed-color fallback, or a generic baseline — alone or combined.
- **Three built-in themes** — Catppuccin Frappé, Ayu Mirage, Everforest Dark.
- **Theme import** — bring the theme you already live in. Supported sources:
  JetBrains IDEs (`.theme.json` UI themes and `.icls` editor schemes), VS Code
  theme JSON, iTerm2 color presets, Alacritty, kitty, and Ghostty configs.
  Files are recognized by content, previewed with all 14 palette slots (derived
  slots are marked), and can be renamed before saving. Drag-and-drop several
  files at once or paste a config straight from your editor.
- **Per-site control** — enable/disable, theme choice, and remapping strategy
  per site from the popup, with a diagnostics panel explaining which strategies
  ran and why.
- **Deep remap (opt-in)** — an extra layer for SVG icon colors, inline-styled
  elements, and open shadow-root content. Never enabled automatically; picking
  it composes on top of the automatic plan.
- **Brand color preservation** — vivid accent colors (logos, brand buttons)
  are left untouched by default; toggle per site.
- **Readability guard** — text colors remapped from a page's own palette are
  checked for WCAG contrast and repaired without shifting their hue; imported
  themes are validated for readable text/background pairing at import time.
- **Full reversibility** — disabling the extension restores the page exactly;
  live theme or setting changes apply to open tabs without reload.

[0.1.0]: https://github.com/barad1tos/MimicEngine/releases/tag/v0.1.0
