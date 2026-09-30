/**
 * GSM Diff - Diff Engine
 * High-performance, zero-dependency diffing algorithm for text, JSON, and code.
 * Computes line-level and word/character-level diffs for side-by-side and unified views.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GSMDiffEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Computes the Longest Common Subsequence (LCS) matrix between two arrays.
   * Uses space-optimized or standard dynamic programming.
   */
  function computeLCS(arrA, arrB, equalsFn) {
    const eq = equalsFn || ((a, b) => a === b);
    const m = arrA.length;
    const n = arrB.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (eq(arrA[i - 1], arrB[j - 1])) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    return dp;
  }

  /**
   * Backtracks LCS table to generate diff operations:
   * 'equal', 'delete' (in A, not in B), 'insert' (in B, not in A)
   */
  function backtrackLCS(dp, arrA, arrB, equalsFn) {
    const eq = equalsFn || ((a, b) => a === b);
    let i = arrA.length;
    let j = arrB.length;
    const result = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && eq(arrA[i - 1], arrB[j - 1])) {
        result.push({ type: 'equal', value: arrA[i - 1], oldIndex: i - 1, newIndex: j - 1 });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.push({ type: 'insert', value: arrB[j - 1], newIndex: j - 1 });
        j--;
      } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
        result.push({ type: 'delete', value: arrA[i - 1], oldIndex: i - 1 });
        i--;
      }
    }

    return result.reverse();
  }

  /**
   * Splits text into lines, keeping or stripping line breaks.
   */
  function splitLines(text) {
    if (typeof text !== 'string') text = String(text ?? '');
    // Normalize CRLF to LF
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalized.split('\n');
  }

  /**
   * Splits a line into tokens (words, punctuation, whitespace) for intra-line diff.
   */
  function tokenizeLine(line) {
    // Matches words, whitespace sequences, or individual punctuation marks
    const regex = /(\s+|[a-zA-Z0-9_]+|[^\s\w])/g;
    const tokens = [];
    let match;
    while ((match = regex.exec(line)) !== null) {
      tokens.push(match[0]);
    }
    return tokens.length > 0 ? tokens : [line];
  }

  /**
   * Computes word/token diff between two lines for detailed intra-line highlighting.
   */
  function diffWords(lineA, lineB) {
    const tokensA = tokenizeLine(lineA);
    const tokensB = tokenizeLine(lineB);
    const dp = computeLCS(tokensA, tokensB);
    const diff = backtrackLCS(dp, tokensA, tokensB);

    return {
      tokensA: diff.filter(d => d.type !== 'insert').map(d => ({
        text: d.value,
        type: d.type === 'delete' ? 'deleted' : 'unchanged'
      })),
      tokensB: diff.filter(d => d.type !== 'delete').map(d => ({
        text: d.value,
        type: d.type === 'insert' ? 'inserted' : 'unchanged'
      }))
    };
  }

  /**
   * Parses and sorts keys of a JSON string recursively for normalized comparison.
   */
  function canonicalizeJson(jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      function sortObj(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(sortObj);
        const sorted = {};
        Object.keys(obj).sort().forEach(key => {
          sorted[key] = sortObj(obj[key]);
        });
        return sorted;
      }
      return JSON.stringify(sortObj(parsed), null, 2);
    } catch (e) {
      return null;
    }
  }

  /**
   * Check if text is valid JSON.
   */
  function isJson(str) {
    if (typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Computes the line-by-line diff between two strings.
   * Options:
   * - ignoreWhitespace: boolean
   * - prettifyJson: boolean
   */
  function computeLineDiff(textA, textB, options = {}) {
    let rawA = textA ?? '';
    let rawB = textB ?? '';

    let isJsonA = isJson(rawA);
    let isJsonB = isJson(rawB);
    let canPrettifyJson = isJsonA && isJsonB;

    if (options.prettifyJson && canPrettifyJson) {
      rawA = canonicalizeJson(rawA) || rawA;
      rawB = canonicalizeJson(rawB) || rawB;
    }

    const linesA = splitLines(rawA);
    const linesB = splitLines(rawB);

    const equalsFn = options.ignoreWhitespace
      ? (a, b) => a.trim() === b.trim()
      : (a, b) => a === b;

    const dp = computeLCS(linesA, linesB, equalsFn);
    const operations = backtrackLCS(dp, linesA, linesB, equalsFn);

    // Compute stats
    let additions = 0;
    let deletions = 0;
    let unchanged = 0;

    operations.forEach(op => {
      if (op.type === 'insert') additions++;
      else if (op.type === 'delete') deletions++;
      else unchanged++;
    });

    return {
      operations,
      linesA,
      linesB,
      additions,
      deletions,
      unchanged,
      isIdentical: additions === 0 && deletions === 0,
      isJson: canPrettifyJson
    };
  }

  /**
   * Generates paired rows for Side-by-Side (split) diff view.
   * Paired rows align deleted lines with corresponding inserted lines,
   * with intra-line token diffing.
   */
  function generateSideBySideRows(lineDiffResult) {
    const { operations } = lineDiffResult;
    const rows = [];
    let oldLineNum = 1;
    let newLineNum = 1;

    let i = 0;
    while (i < operations.length) {
      const op = operations[i];

      if (op.type === 'equal') {
        rows.push({
          type: 'equal',
          left: { lineNum: oldLineNum++, content: op.value, type: 'unchanged' },
          right: { lineNum: newLineNum++, content: op.value, type: 'unchanged' }
        });
        i++;
      } else {
        // Collect consecutive deletes and inserts to pair them
        const delBlock = [];
        const insBlock = [];

        while (i < operations.length && operations[i].type !== 'equal') {
          if (operations[i].type === 'delete') {
            delBlock.push({ lineNum: oldLineNum++, content: operations[i].value });
          } else if (operations[i].type === 'insert') {
            insBlock.push({ lineNum: newLineNum++, content: operations[i].value });
          }
          i++;
        }

        const maxLen = Math.max(delBlock.length, insBlock.length);
        for (let k = 0; k < maxLen; k++) {
          const leftItem = delBlock[k] || null;
          const rightItem = insBlock[k] || null;

          if (leftItem && rightItem) {
            // Modified line! Perform token diff
            const wordDiff = diffWords(leftItem.content, rightItem.content);
            rows.push({
              type: 'modify',
              left: {
                lineNum: leftItem.lineNum,
                content: leftItem.content,
                type: 'deleted',
                tokens: wordDiff.tokensA
              },
              right: {
                lineNum: rightItem.lineNum,
                content: rightItem.content,
                type: 'inserted',
                tokens: wordDiff.tokensB
              }
            });
          } else if (leftItem) {
            rows.push({
              type: 'delete',
              left: { lineNum: leftItem.lineNum, content: leftItem.content, type: 'deleted' },
              right: null
            });
          } else if (rightItem) {
            rows.push({
              type: 'insert',
              left: null,
              right: { lineNum: rightItem.lineNum, content: rightItem.content, type: 'inserted' }
            });
          }
        }
      }
    }

    return rows;
  }

  /**
   * Generates unified diff rows (single column with + and - markers).
   */
  function generateUnifiedRows(lineDiffResult) {
    const { operations } = lineDiffResult;
    const rows = [];
    let oldLineNum = 1;
    let newLineNum = 1;

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.type === 'equal') {
        rows.push({
          type: 'equal',
          oldLineNum: oldLineNum++,
          newLineNum: newLineNum++,
          prefix: ' ',
          content: op.value
        });
      } else if (op.type === 'delete') {
        rows.push({
          type: 'delete',
          oldLineNum: oldLineNum++,
          newLineNum: null,
          prefix: '-',
          content: op.value
        });
      } else if (op.type === 'insert') {
        rows.push({
          type: 'insert',
          oldLineNum: null,
          newLineNum: newLineNum++,
          prefix: '+',
          content: op.value
        });
      }
    }

    return rows;
  }

  /**
   * Generates a standard unified patch text (e.g. for copying or downloading as .patch).
   */
  function generatePatchText(textA, textB, labelA = 'Version A', labelB = 'Version B') {
    const diff = computeLineDiff(textA, textB);
    const unified = generateUnifiedRows(diff);
    const header = [
      `--- ${labelA}`,
      `+++ ${labelB}`,
      `@@ -1,${diff.linesA.length} +1,${diff.linesB.length} @@`
    ];

    const body = unified.map(row => `${row.prefix}${row.content}`);
    return [...header, ...body].join('\n');
  }

  /**
   * Compares two structured JSON objects or audit log records.
   * Returns a detailed object difference summary.
   */
  function diffJsonObjects(objA, objB) {
    const strA = JSON.stringify(objA, null, 2);
    const strB = JSON.stringify(objB, null, 2);
    const lineDiff = computeLineDiff(strA, strB, { prettifyJson: true });
    return {
      lineDiff,
      sideBySide: generateSideBySideRows(lineDiff),
      unified: generateUnifiedRows(lineDiff)
    };
  }

  /**
   * Masks secret text for privacy / screenshots mode, preserving line structure
   * but masking values after key/variable names (e.g. KEY="***").
   */
  function maskSecretContent(text) {
    if (!text) return '';
    return text.replace(/([a-zA-Z0-9_\-\.]+[\s:=]+)(['"]?)(.+?)\2(?=[\r\n,;]|$)/g, (match, prefix, quote, val) => {
      if (val.length <= 4) return `${prefix}${quote}****${quote}`;
      return `${prefix}${quote}${val.slice(0, 2)}••••••••${val.slice(-2)}${quote}`;
    });
  }

  return {
    computeLineDiff,
    generateSideBySideRows,
    generateUnifiedRows,
    generatePatchText,
    diffWords,
    canonicalizeJson,
    isJson,
    diffJsonObjects,
    maskSecretContent
  };
});
