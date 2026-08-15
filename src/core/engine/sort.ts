// Raw codepoint comparator, shared by every deterministic sort in the
// engine. Deliberately NOT `localeCompare`: ICU collation reorders strings
// by locale-specific rules (case, accents, ...) that vary across runtimes,
// which would make sorted output non-reproducible across environments.
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
