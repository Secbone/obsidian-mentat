export interface DiffLine {
  type: 'add' | 'remove' | 'keep';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

function longestCommonSubsequence(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function backtrack(
  dp: number[][], a: string[], b: string[],
  i: number, j: number, oldStart: number, newStart: number,
  result: DiffLine[]
): void {
  if (i === 0 && j === 0) return;
  if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
    backtrack(dp, a, b, i - 1, j - 1, oldStart, newStart, result);
    result.push({ type: 'keep', content: a[i - 1], oldLineNum: oldStart + i, newLineNum: newStart + j });
  } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
    backtrack(dp, a, b, i, j - 1, oldStart, newStart, result);
    result.push({ type: 'add', content: b[j - 1], newLineNum: newStart + j });
  } else if (i > 0) {
    backtrack(dp, a, b, i - 1, j, oldStart, newStart, result);
    result.push({ type: 'remove', content: a[i - 1], oldLineNum: oldStart + i });
  }
}

export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const dp = longestCommonSubsequence(oldLines, newLines);
  const result: DiffLine[] = [];
  backtrack(dp, oldLines, newLines, oldLines.length, newLines.length, 0, 0, result);
  return result;
}

export function formatDiffAsText(path: string, diff: DiffLine[]): string {
  const lines: string[] = [];
  const separator = '━'.repeat(30);
  lines.push(separator + ' ' + path + ' ' + separator);

  const lineNumWidth = String(
    Math.max(
      ...diff.map(l => l.oldLineNum ?? 0),
      ...diff.map(l => l.newLineNum ?? 0)
    )
  ).length || 1;

  for (const line of diff) {
    const num = line.type === 'add' ? ' '.repeat(lineNumWidth) : String(line.oldLineNum).padStart(lineNumWidth);
    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
    lines.push(` ${num} ${prefix} ${line.content}`);
  }

  const addCount = diff.filter(l => l.type === 'add').length;
  const removeCount = diff.filter(l => l.type === 'remove').length;
  const summary = ` ${addCount} insertion${addCount !== 1 ? 's' : ''}, ${removeCount} deletion${removeCount !== 1 ? 's' : ''}`;
  lines.push(separator + summary + separator);
  return lines.join('\n');
}
