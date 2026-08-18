import { describe, expect, it } from 'vitest';
import { splitScanPath } from './scanPath';

describe('splitScanPath', () => {
  it('splits a POSIX path into basename and parent-directory tail', () => {
    expect(splitScanPath('/Users/roman/.config/kitty/current-theme.conf')).toEqual({
      baseName: 'current-theme.conf',
      dirTail: 'kitty',
    });
  });

  it('splits a Windows path (backslash separators) the same way', () => {
    expect(
      splitScanPath('C:\\Users\\roman\\.vscode\\extensions\\theme\\themes\\dracula.json'),
    ).toEqual({
      baseName: 'dracula.json',
      dirTail: 'themes',
    });
  });

  it('returns an empty dirTail for a bare filename with no separator', () => {
    expect(splitScanPath('a.theme.json')).toEqual({ baseName: 'a.theme.json', dirTail: '' });
  });

  it('returns an empty dirTail for a path with exactly one directory segment', () => {
    expect(splitScanPath('/dracula.itermcolors')).toEqual({
      baseName: 'dracula.itermcolors',
      dirTail: '',
    });
  });

  it('falls back to the original string when there is no segment to extract', () => {
    expect(splitScanPath('')).toEqual({ baseName: '', dirTail: '' });
    expect(splitScanPath('///')).toEqual({ baseName: '///', dirTail: '' });
  });
});
