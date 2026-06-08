/**
 * Note Manipulator Utility
 * Provides helper functions for matching and editing markdown note structures.
 */

export const getHeadingPattern = (heading: string, captureLevel = false): RegExp => {
  const normalized = heading.trim().replace(/\s+/g, ' ');
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexibleSpaces = escaped.replace(/ /g, '\\s+');
  const levelPattern = captureLevel ? '(#+)' : '#+';
  return new RegExp(`^${levelPattern}\\s+${flexibleSpaces}\\s*$`, 'i');
};

export const insertAfterHeading = (content: string, heading: string, newContent: string): string => {
  const lines = content.split('\n');
  const headingPattern = getHeadingPattern(heading);

  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      lines.splice(i + 1, 0, '', newContent);
      return lines.join('\n');
    }
  }

  return content;
};

export const replaceSection = (content: string, heading: string, newContent: string): string => {
  const lines = content.split('\n');
  const headingPattern = getHeadingPattern(heading, true);

  let startIndex = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      startIndex = i;
      const match = lines[i].match(/^(#+)/);
      startLevel = match ? match[1].length : 0;
      break;
    }
  }

  if (startIndex === -1) {
    return content;
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s/);
    if (match) {
      const level = match[1].length;
      if (level <= startLevel) {
        endIndex = i;
        break;
      }
    }
  }

  const result = [...lines];
  const newLines = newContent.split('\n');
  result.splice(startIndex + 1, endIndex - startIndex - 1, ...newLines);

  return result.join('\n');
};

export const exactReplaceString = (
  content: string,
  oldString: string,
  newString: string
): string => {
  // Find all occurrences using exact match
  const occurrences: number[] = [];
  let searchIndex = 0;

  while (true) {
    const foundIndex = content.indexOf(oldString, searchIndex);
    if (foundIndex === -1) break;

    occurrences.push(foundIndex);
    searchIndex = foundIndex + oldString.length;
  }

  // Exactly 1 occurrence - safe to replace
  if (occurrences.length === 1) {
    return content.replace(oldString, newString);
  }

  // Multiple occurrences exist - exact replacement requires unique match
  if (occurrences.length > 1) {
    const lines = content.split('\n');
    const locations = occurrences.map(pos => {
      const textBefore = content.substring(0, pos);
      const lineNum = textBefore.split('\n').length;
      return `line ${lineNum}`;
    }).join(', ');

    const previews = occurrences.slice(0, 3).map((pos, idx) => {
      const contextStart = Math.max(0, pos - 40);
      const contextEnd = Math.min(content.length, pos + oldString.length + 40);
      const preview = content.substring(contextStart, contextEnd);
      const lineNum = content.substring(0, pos).split('\n').length;
      return `  ${idx + 1}. Line ${lineNum}: ...${preview}...`;
    }).join('\n');

    throw new Error(
      `Text "${oldString}" appears ${occurrences.length} times in the file (at ${locations}).\n\n` +
      `Exact replacement requires a unique match. Please provide a longer string with more surrounding context to make it unique.\n\n` +
      `First ${Math.min(3, occurrences.length)} occurrence(s):\n${previews}`
    );
  }

  // 0 occurrences - Try Fuzzy/Flexible Matching Fallback (RAGP v2.3)
  const normalize = (str: string) => str.toLowerCase().replace(/\s+/g, ' ').trim();
  const normOld = normalize(oldString);
  
  if (normOld) {
    // Escape all regex special characters
    const escaped = normOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow flexible spacing (replace any space match with \s+)
    const flexibleSpaces = escaped.replace(/ /g, '\\s+');
    
    const flexibleRegex = new RegExp(flexibleSpaces, 'i');
    const flexibleGlobalRegex = new RegExp(flexibleSpaces, 'gi');
    
    const allMatches = content.match(flexibleGlobalRegex);
    if (allMatches && allMatches.length === 1) {
      const matchResult = content.match(flexibleRegex);
      if (matchResult && matchResult.index !== undefined) {
        console.log(`[EditNote] Found unique fuzzy/flexible match for: "${oldString.substring(0, 40)}..."`);
        const start = matchResult.index;
        const end = start + matchResult[0].length;
        return content.substring(0, start) + newString + content.substring(end);
      }
    } else if (allMatches && allMatches.length > 1) {
      throw new Error(
        `Fuzzy Match Conflict: Text "${oldString}" matches ${allMatches.length} times under flexible spacing/capitalization.\n` +
        `Fuzzy replacement requires a unique match. Please provide more surrounding context to perform the replacement.`
      );
    }
  }

  // If even fuzzy match failed, throw the standard exact-match error
  throw new Error(
    `Text not found in file: "${oldString}"\n\n` +
    `Tip: The text must match exactly including whitespace, capitalization, and line breaks.`
  );
};
