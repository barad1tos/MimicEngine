// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportError, ThemeSlots } from '../importTypes';
import { parseItermColors } from './iterm';

// `new URL(relative, import.meta.url)` resolves against happy-dom's fake
// `http://localhost:3000` window location instead of import.meta.url's real
// `file:` base under Vitest's happy-dom environment (verified empirically --
// see jetbrainsEditorScheme.test.ts). path.join + fileURLToPath sidesteps it.
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/ayu-mirage.itermcolors',
);
const AYU_MIRAGE_FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function expectSlots(result: ThemeSlots | ImportError): ThemeSlots {
  if ('stage' in result) throw new Error(`expected success, got error: ${result.message}`);
  return result;
}

function expectError(result: ThemeSlots | ImportError): ImportError {
  if (!('stage' in result)) throw new Error('expected an ImportError, got ThemeSlots');
  return result;
}

describe('parseItermColors', () => {
  it('maps the real ayu-mirage fixture: hand-verified hexes, full ansi palette, no Link Color present', () => {
    const slots = expectSlots(parseItermColors(AYU_MIRAGE_FIXTURE));

    expect(slots.sourceFormat).toBe('iterm');
    // Real .itermcolors presets carry no name field of their own (confirmed
    // by reading this fixture: it's a flat dict of color entries only, no
    // metadata key) -- same kind of format default the other terminal-style
    // adapters use.
    expect(slots.name).toBe('iTerm theme');

    // Hand-verified against the fixture's Red/Green/Blue Component floats
    // (all Alpha Component = 1, so each is round(component * 255) directly,
    // no compositing involved):
    //   background <- Background Color (0.1216, 0.1412, 0.1882) -> #1f2430
    //   foreground <- Foreground Color (0.8, 0.7922, 0.7608)     -> #cccac2
    //   selection  <- Selection Color (0.251, 0.6235, 1.0)       -> #409fff
    expect(slots.background).toBe('#1f2430');
    expect(slots.foreground).toBe('#cccac2');
    expect(slots.tokens.selection).toBe('#409fff');

    // The fixture has no "Link Color" key at all -- stays unset.
    expect(slots.tokens.link).toBeUndefined();

    // Full 16-slot ANSI palette, hand-verified the same way (all opaque):
    expect(slots.ansi).toHaveLength(16);
    expect(slots.ansi?.[0]).toBe('#171b24');
    expect(slots.ansi?.[1]).toBe('#ed8274');
    expect(slots.ansi?.[2]).toBe('#87d96c');
    expect(slots.ansi?.[3]).toBe('#facc6e');
    expect(slots.ansi?.[4]).toBe('#6dcbfa');
    expect(slots.ansi?.[5]).toBe('#dabafa');
    expect(slots.ansi?.[6]).toBe('#90e1c6');
    expect(slots.ansi?.[7]).toBe('#c7c7c7');
    expect(slots.ansi?.[8]).toBe('#686868');
    expect(slots.ansi?.[9]).toBe('#f28779');
    expect(slots.ansi?.[10]).toBe('#d5ff80');
    expect(slots.ansi?.[11]).toBe('#ffd173');
    expect(slots.ansi?.[12]).toBe('#73d0ff');
    expect(slots.ansi?.[13]).toBe('#dfbfff');
    expect(slots.ansi?.[14]).toBe('#95e6cb');
    expect(slots.ansi?.[15]).toBe('#ffffff');
  });

  it('preserves index positions in a sparse ansi array: missing slots stay undefined, present ones keep their index', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Ansi 0 Color</key>
  <dict>
    <key>Red Component</key><real>0</real>
    <key>Green Component</key><real>0</real>
    <key>Blue Component</key><real>0</real>
    <key>Alpha Component</key><real>1</real>
  </dict>
  <key>Ansi 5 Color</key>
  <dict>
    <key>Red Component</key><real>0.4</real>
    <key>Green Component</key><real>0.4</real>
    <key>Blue Component</key><real>0.4</real>
    <key>Alpha Component</key><real>1</real>
  </dict>
</dict>
</plist>`;

    const slots = expectSlots(parseItermColors(content));
    expect(slots.ansi).toHaveLength(16);
    expect(slots.ansi?.[0]).toBe('#000000');
    expect(slots.ansi?.[1]).toBeUndefined();
    expect(slots.ansi?.[4]).toBeUndefined();
    expect(slots.ansi?.[5]).toBe('#666666');
    expect(slots.ansi?.[6]).toBeUndefined();
    expect(slots.ansi?.[15]).toBeUndefined();
  });

  it('composites a translucent ansi color over the resolved background', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Background Color</key>
  <dict>
    <key>Red Component</key><real>0.1</real>
    <key>Green Component</key><real>0.2</real>
    <key>Blue Component</key><real>0.3</real>
    <key>Alpha Component</key><real>1</real>
  </dict>
  <key>Ansi 0 Color</key>
  <dict>
    <key>Red Component</key><real>1.0</real>
    <key>Green Component</key><real>0.5</real>
    <key>Blue Component</key><real>0.25</real>
    <key>Alpha Component</key><real>0.5</real>
  </dict>
</dict>
</plist>`;

    const slots = expectSlots(parseItermColors(content));
    // background: round(0.1*255,0.2*255,0.3*255) = (26,51,77) -> #1a334d
    expect(slots.background).toBe('#1a334d');
    // ansi 0 fg (255,128,64) @ alpha 0.5 over (26,51,77):
    //   r = round(255*0.5 + 26*0.5) = round(140.5) = 141 = 0x8d
    //   g = round(128*0.5 + 51*0.5) = round(89.5)  = 90  = 0x5a
    //   b = round(64*0.5 + 77*0.5)  = round(70.5)  = 71  = 0x47
    expect(slots.ansi?.[0]).toBe('#8d5a47');
  });

  it('treats a fully-transparent color as absent, not as a slot value', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Link Color</key>
  <dict>
    <key>Red Component</key><real>1</real>
    <key>Green Component</key><real>1</real>
    <key>Blue Component</key><real>1</real>
    <key>Alpha Component</key><real>0</real>
  </dict>
</dict>
</plist>`;

    const slots = expectSlots(parseItermColors(content));
    expect(slots.tokens.link).toBeUndefined();
  });

  it('resolves a present Link Color into tokens.link', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Link Color</key>
  <dict>
    <key>Red Component</key><real>0.4</real>
    <key>Green Component</key><real>0.6</real>
    <key>Blue Component</key><real>0.8</real>
    <key>Alpha Component</key><real>1</real>
  </dict>
</dict>
</plist>`;

    const slots = expectSlots(parseItermColors(content));
    // round(0.4*255, 0.6*255, 0.8*255) = (102, 153, 204) -> #6699cc
    expect(slots.tokens.link).toBe('#6699cc');
  });

  it('leaves a translucent candidate unresolved when no background is known yet to composite over', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Selection Color</key>
  <dict>
    <key>Red Component</key><real>1</real>
    <key>Green Component</key><real>1</real>
    <key>Blue Component</key><real>1</real>
    <key>Alpha Component</key><real>0.5</real>
  </dict>
</dict>
</plist>`;

    const slots = expectSlots(parseItermColors(content));
    expect(slots.background).toBeUndefined();
    expect(slots.tokens.selection).toBeUndefined();
  });

  it('leaves ansi unset entirely when the plist has no Ansi N Color entries', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Background Color</key>
  <dict>
    <key>Red Component</key><real>0.1</real>
    <key>Green Component</key><real>0.1</real>
    <key>Blue Component</key><real>0.1</real>
    <key>Alpha Component</key><real>1</real>
  </dict>
</dict>
</plist>`;

    const slots = expectSlots(parseItermColors(content));
    expect(slots.ansi).toBeUndefined();
  });

  it('returns a parse error for malformed XML', () => {
    const error = expectError(parseItermColors('<plist><dict></plist>'));
    expect(error.stage).toBe('parse');
  });

  it('returns a parse error when the plist has no root dict', () => {
    const error = expectError(
      parseItermColors('<?xml version="1.0"?><plist version="1.0"></plist>'),
    );
    expect(error.stage).toBe('parse');
  });
});
