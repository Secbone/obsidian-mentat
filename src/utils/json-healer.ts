import JSON5 from 'json5';

/**
 * Escapes lone backslashes in a JSON string (e.g. for LaTeX or Windows paths)
 */
export function escapeLoneBackslashes(jsonStr: string): string {
  let result = '';
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    if (char === '\\') {
      const nextChar = jsonStr[i + 1];
      if (nextChar === undefined) {
        result += '\\\\';
      } else if (['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(nextChar)) {
        result += '\\' + nextChar;
        i++;
      } else if (nextChar === 'u') {
        const hex = jsonStr.substring(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += '\\u' + hex;
          i += 5;
        } else {
          result += '\\\\';
        }
      } else {
        result += '\\\\';
      }
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Preprocesses JSON string literals to heal unescaped Windows paths.
 */
export function healWindowsPaths(jsonStr: string): string {
  return jsonStr.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) => {
    const looksLikeWindowsPath = /^[a-zA-Z]:\\/.test(p1) || 
                                 /^[a-zA-Z]:\w/.test(p1) ||
                                 /^\\[a-zA-Z0-9_.-]+\\[a-zA-Z0-9_.-]+/.test(p1);
    if (looksLikeWindowsPath) {
      const unescaped = p1.replace(/\\\\/g, '\\');
      const reEscaped = unescaped.replace(/\\/g, '\\\\');
      return `"${reEscaped}"`;
    }
    return match;
  });
}

/**
 * Normalizes arguments by sorting keys of the JSON object alphabetically.
 * This guarantees consistent output formats regardless of key insertion order.
 */
export function normalizeJsonArguments(args: unknown): string {
  if (args === null || args === undefined) {
    return '';
  }
  if (Array.isArray(args)) {
    return '[' + args.map(item => normalizeJsonArguments(item)).join(',') + ']';
  }
  if (typeof args === 'object') {
    const sortedKeys = Object.keys(args).sort();
    const parts = sortedKeys.map(key => {
      const valStr = normalizeJsonArguments((args as Record<string, unknown>)[key]);
      return `"${key}":${valStr}`;
    });
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(args);
}

/**
 * Safely parses JSON string with path-healing and lenient fallback.
 */
/**
 * Typed wrapper around JSON.parse to avoid unsafe any-type propagation.
 * Use this instead of raw JSON.parse() call sites.
 */
export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function safeParseJson(
  jsonStr: string,
  onHealed?: (healedStr: string, errorMsg: string) => void,
  onFailed?: (errorMsg: string) => void
): Record<string, unknown> {
  const preHealedString = healWindowsPaths(jsonStr);

  try {
    return JSON.parse(preHealedString);
  } catch (error: unknown) {
    try {
      const healedArgsString = escapeLoneBackslashes(preHealedString);
      const parsed = JSON5.parse(healedArgsString);
      if (onHealed) {
        onHealed(healedArgsString, error instanceof Error ? error.message : String(error));
      }
      return parsed;
    } catch {
      if (onFailed) {
        onFailed(error instanceof Error ? error.message : String(error));
      }
      throw new Error(`Failed to parse JSON string: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
