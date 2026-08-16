// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseAlacrittyTheme } from './adapters/alacritty';
import { parseGhosttyTheme } from './adapters/ghostty';
import { parseItermColors } from './adapters/iterm';
import { parseKittyTheme } from './adapters/kitty';
import { parseVscodeTheme } from './adapters/vscode';
import { FORMAT_DEFAULT_THEME_NAMES, type ImportError, type ThemeSlots } from './importTypes';

function expectName(result: ThemeSlots | ImportError): string {
  if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
  return result.name;
}

// Minimal plist with just enough of a "Background Color" dict to make
// parseItermColors succeed; no top-level name field, so it falls back to
// its format default like the other terminal-style adapters.
const MINIMAL_ITERM_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Background Color</key>
  <dict>
    <key>Red Component</key>
    <real>0.1</real>
    <key>Green Component</key>
    <real>0.1</real>
    <key>Blue Component</key>
    <real>0.1</real>
  </dict>
</dict>
</plist>`;

describe('FORMAT_DEFAULT_THEME_NAMES', () => {
  it('contains exactly the format-default names each nameless-capable adapter actually produces', () => {
    // Falsifiable against drift: if an adapter's own default name literal
    // ever diverges from the constant it imports, this fails -- unlike a
    // hand-copied list of the same five strings, which would drift silently.
    const actualDefaults = new Set([
      expectName(parseVscodeTheme('{"colors": {}}')),
      expectName(parseItermColors(MINIMAL_ITERM_PLIST)),
      expectName(parseAlacrittyTheme('[colors.primary]\nbackground = "#101010"\n')),
      expectName(parseKittyTheme('background #101010\n')),
      expectName(parseGhosttyTheme('background = 101010\n')),
    ]);

    expect(FORMAT_DEFAULT_THEME_NAMES).toEqual(actualDefaults);
  });
});
