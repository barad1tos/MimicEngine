// Splits a host-reported file path (HostFile.path, protocol.ts) into the
// display parts the options page's scan-results list needs: the file's own
// name, and its immediate parent directory's name (the "dirname tail") --
// enough to tell apart same-named files living in different folders (e.g.
// two JetBrains theme directories) without rendering the full absolute
// path. Pure string splitting only -- this module never touches the
// filesystem; the host is the only process that reads paths off disk.

const PATH_SEPARATOR_PATTERN = /[/\\]/;

export type ScanPathParts = { readonly baseName: string; readonly dirTail: string };

/**
 * `dirTail` is `''` when `path` has no parent segment (a bare filename, or
 * only separators). `baseName` falls back to the original `path` in that
 * same degenerate case, so the caller always has something displayable.
 */
export function splitScanPath(path: string): ScanPathParts {
  const segments = path.split(PATH_SEPARATOR_PATTERN).filter((segment) => segment.length > 0);
  const lastIndex = segments.length - 1;
  const baseName = lastIndex >= 0 ? segments[lastIndex] : undefined;
  const dirTail = lastIndex >= 1 ? segments[lastIndex - 1] : undefined;
  return { baseName: baseName ?? path, dirTail: dirTail ?? '' };
}
