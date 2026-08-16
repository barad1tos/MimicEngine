import { describe, expect, it } from 'vitest';
import { detectFormat } from './formatDetection';

describe('detectFormat', () => {
  it('detects jetbrains-ui from a top-level "ui" object', () => {
    const content = JSON.stringify({ name: 'Test', ui: { 'Button.background': '#112233' } });
    expect(detectFormat(content)).toBe('jetbrains-ui');
  });

  it('detects vscode from a "colors" object with dotted keys', () => {
    const content = JSON.stringify({ colors: { 'editor.background': '#112233' } });
    expect(detectFormat(content)).toBe('vscode');
  });

  it('detects iterm from a plist root containing Ansi N Color keys', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Ansi 0 Color</key>
  <dict><key>Red Component</key><real>0</real></dict>
</dict>
</plist>`;
    expect(detectFormat(content)).toBe('iterm');
  });

  it('detects jetbrains-editor from a scheme root', () => {
    const content = `<scheme name="Test" version="1" parent_scheme="Default">
  <colors/>
</scheme>`;
    expect(detectFormat(content)).toBe('jetbrains-editor');
  });

  it('detects alacritty from a [colors.primary] section', () => {
    const content = `[colors.primary]
background = "#1e1e2e"
foreground = "#cdd6f4"`;
    expect(detectFormat(content)).toBe('alacritty');
  });

  it('detects alacritty from a [colors.normal] section', () => {
    const content = `[colors.normal]
black = "#45475a"
red = "#f38ba8"`;
    expect(detectFormat(content)).toBe('alacritty');
  });

  it('detects ghostty from "key = value" pairs', () => {
    const content = `background = #1e1e2e
foreground = #cdd6f4`;
    expect(detectFormat(content)).toBe('ghostty');
  });

  it('detects kitty from "key value" pairs (no separator)', () => {
    const content = `background #1e1e2e
foreground #cdd6f4`;
    expect(detectFormat(content)).toBe('kitty');
  });

  it('returns a detect error for valid JSON matching neither jetbrains-ui nor vscode', () => {
    const content = JSON.stringify({ name: 'Test', mode: 'dark' });
    expect(detectFormat(content)).toEqual({
      stage: 'detect',
      message: 'unrecognized theme format',
    });
  });

  it('returns a detect error for JSON whose top-level value is not an object', () => {
    expect(detectFormat('[1, 2, 3]')).toEqual({
      stage: 'detect',
      message: 'unrecognized theme format',
    });
  });

  it('returns a detect error for an XML document whose root is neither plist nor scheme', () => {
    const content = `<theme name="Test"><color name="foo" value="#112233"/></theme>`;
    expect(detectFormat(content)).toEqual({
      stage: 'detect',
      message: 'unrecognized theme format',
    });
  });

  it('returns a detect error for unrecognized garbage text', () => {
    const content = 'this is not a theme file at all, just some prose.';
    expect(detectFormat(content)).toEqual({
      stage: 'detect',
      message: 'unrecognized theme format',
    });
  });

  it('disambiguates ghostty ("=" separator) from kitty (whitespace separator)', () => {
    expect(detectFormat('background = #111')).toBe('ghostty');
    expect(detectFormat('background #111')).toBe('kitty');
  });
});
