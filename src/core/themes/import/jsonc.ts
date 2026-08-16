// Minimal, string-literal-aware JSONC stripper: removes `//` and `/* */`
// comments and trailing commas before `}`/`]`, without touching characters
// that appear inside a JSON string literal (e.g. `"https://x"`).

type StringScan = { text: string; nextIndex: number };

/** Copies a double-quoted JSON string literal verbatim, honoring `\`-escapes. */
function scanStringLiteral(content: string, startIndex: number): StringScan {
  let text = content.charAt(startIndex);
  let index = startIndex + 1;

  while (index < content.length) {
    const char = content.charAt(index);
    text += char;

    if (char === '\\') {
      text += content.charAt(index + 1);
      index += 2;
      continue;
    }

    index += 1;
    if (char === '"') break;
  }

  return { text, nextIndex: index };
}

/** Returns the index just past the end of the line, i.e. at `\n` or content.length. */
function skipLineComment(content: string, startIndex: number): number {
  let index = startIndex;
  while (index < content.length && content.charAt(index) !== '\n') index += 1;
  return index;
}

/** Returns the index just past the closing block-comment marker (or content.length if unterminated). */
function skipBlockComment(content: string, startIndex: number): number {
  let index = startIndex + 2;
  while (
    index < content.length &&
    !(content.charAt(index) === '*' && content.charAt(index + 1) === '/')
  ) {
    index += 1;
  }
  return index + 2;
}

function stripComments(content: string): string {
  let result = '';
  let index = 0;

  while (index < content.length) {
    const char = content.charAt(index);

    if (char === '"') {
      const { text, nextIndex } = scanStringLiteral(content, index);
      result += text;
      index = nextIndex;
      continue;
    }

    const next = content.charAt(index + 1);
    if (char === '/' && next === '/') {
      index = skipLineComment(content, index);
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(content, index);
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function stripTrailingCommas(content: string): string {
  let result = '';
  let index = 0;

  while (index < content.length) {
    const char = content.charAt(index);

    if (char === '"') {
      const { text, nextIndex } = scanStringLiteral(content, index);
      result += text;
      index = nextIndex;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < content.length && isWhitespace(content.charAt(lookahead))) {
        lookahead += 1;
      }
      const next = content.charAt(lookahead);
      if (next === '}' || next === ']') {
        index += 1;
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

export function stripJsonc(content: string): string {
  return stripTrailingCommas(stripComments(content));
}
