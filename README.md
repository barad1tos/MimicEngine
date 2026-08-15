# Palette Mimicry

Palette Mimicry is a browser extension concept for remapping arbitrary websites into a chosen visual style such as Catppuccin Frappé, Ayu Mirage, Everforest, Gruvbox, Tokyo Night, or another editor/terminal-inspired palette.

The product is not only a dark-mode extension. It is a **web theme remapper**: it normalizes source palettes into semantic UI tokens, analyzes a page, injects contrast-safe CSS, and remembers per-site preferences.

## Current status

This repository is an **early-stage scaffold**, not a finished extension. It contains:

- product and technical context;
- MVP/GSD framing;
- architectural direction;
- a minimal TypeScript + WXT extension skeleton;
- built-in theme tokens;
- a basic CSS injection engine;
- placeholder modules for the future semantic analyzer.

## Recommended stack

- TypeScript
- WXT
- React for popup/options UI
- Manifest V3
- `browser.storage` / `chrome.storage` for settings
- Vitest for core logic tests
- Playwright later for extension/browser smoke tests

## Setup

```bash
pnpm install
pnpm prepare
pnpm dev
```

For Firefox development:

```bash
pnpm dev:firefox
```

Build and package:

```bash
pnpm build
pnpm zip
```

Run tests:

```bash
pnpm test
```

## Repository map

```text
README.md                       Human-facing project entry point
entrypoints/                    WXT extension entrypoints
src/core/                       Product engine modules
src/core/themes/                Built-in palettes and normalized theme types
src/core/storage/               Extension settings model
src/core/injector/              CSS generation and injection
src/core/analyzer/              Future computed-style and DOM analysis
src/core/mapper/                Future semantic mapping logic
src/core/live/                  DOM mutation handling
src/core/runtime/               Page-level orchestration
```

## Product principle

The extension should preserve meaning before aesthetics. A beautiful remap that destroys readability, data color semantics, or interaction states is a failed remap.
