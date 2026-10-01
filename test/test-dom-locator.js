/**
 * Unit Test for DOM Locators in Secret Manager
 */

const assert = require('assert');

// Mock DOM elements
function createElement(tag, attrs = {}, children = []) {
  return {
    tagName: tag.toUpperCase(),
    attributes: attrs,
    children: [...children],
    getAttribute(name) { return attrs[name] || null; },
    querySelector(sel) {
      for (const child of this.children) {
        if (matchesSelector(child, sel)) return child;
        const res = child.querySelector?.(sel);
        if (res) return res;
      }
      return null;
    },
    querySelectorAll(sel) {
      let results = [];
      for (const child of this.children) {
        if (matchesSelector(child, sel)) results.push(child);
        if (child.querySelectorAll) results = results.concat(child.querySelectorAll(sel));
      }
      return results;
    },
    closest(sel) {
      return matchesSelector(this, sel) ? this : null;
    },
    textContent: attrs.textContent || ''
  };
}

function matchesSelector(el, sel) {
  if (sel.startsWith('.')) return el.attributes.class?.includes(sel.slice(1));
  if (sel.startsWith('[')) {
    const match = sel.match(/\[([a-zA-Z0-9_\-]+)([\*~]?=)?"?([^"\]]*)"?\]/);
    if (!match) return false;
    const [_, attr, op, val] = match;
    const elVal = el.getAttribute(attr);
    if (!elVal) return false;
    if (!op) return true;
    if (op === '=') return elVal === val;
    if (op === '*=') return elVal.includes(val);
  }
  return el.tagName === sel.toUpperCase();
}

console.log('--- Testing DOM Locator Logic ---');

// Test 1: Date containing '1' should NOT falsely match Version 1
{
  const vStr = '1';
  const falseRow = {
    textContent: 'Sep 1, 2026, 10:00 AM (Replication 1)',
    closest: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('mat-cell')) {
        return [{ textContent: 'Sep 1, 2026' }, { textContent: 'Enabled' }];
      }
      return [];
    }
  };

  const trueRow = {
    textContent: 'Version 1 Enabled Sep 15, 2026',
    closest: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('a[href*="/versions/"]')) {
        return [{ href: '/security/secret-manager/secret/my-sec/versions/1', textContent: 'Version 1' }];
      }
      if (sel.includes('mat-cell')) {
        return [{ textContent: 'Version 1' }, { textContent: 'Enabled' }];
      }
      return [];
    }
  };

  function testCheck(row) {
    const links = row.querySelectorAll('a[href*="/versions/"]');
    for (const link of links) {
      const match = link.href.match(/\/versions\/(\d+)(\b|[/?#]|$)/);
      if (match && match[1] === vStr) return true;
    }
    const cells = row.querySelectorAll('mat-cell');
    if (cells.length > 0) {
      const txt = cells[0].textContent.trim();
      if (txt.toLowerCase() === `version ${vStr}`.toLowerCase() || txt === vStr) return true;
    }
    return false;
  }

  assert.strictEqual(testCheck(falseRow), false, 'Date row should not match Version 1');
  assert.strictEqual(testCheck(trueRow), true, 'True row should match Version 1');
  console.log('✓ Row matching accurately rejects date false-positives');
}

// Test 2: Menu keywords multi-language matching
{
  const negativeKeywords = ['disable', 'destroy', 'delete', 'nonaktif', 'hancur', 'hapus', 'desactivar', 'destruir', 'löschen', 'deaktivieren'];
  const viewKeywords = [
    'view secret', 'view value', 'view payload', 'view',
    'lihat nilai', 'lihat rahasia', 'lihat',
    'ver valor', 'ver secreto',
    'afficher', 'anzeigen', 'visualizza'
  ];

  function matchesViewItem(text) {
    const lower = text.toLowerCase();
    if (negativeKeywords.some(neg => lower.includes(neg))) return false;
    return viewKeywords.some(kw => lower.includes(kw)) || !!lower.match(/\bver\b/);
  }

  const testTexts = [
    { text: 'View secret value', expected: true },
    { text: 'Lihat nilai rahasia', expected: true },
    { text: 'Ver valor del secreto', expected: true },
    { text: 'Afficher la valeur', expected: true },
    { text: 'Wert anzeigen', expected: true },
    { text: 'Destroy version', expected: false },
    { text: 'Nonaktifkan versi', expected: false },
    { text: 'Disable version', expected: false }
  ];

  testTexts.forEach(({ text, expected }) => {
    const matched = matchesViewItem(text);
    assert.strictEqual(matched, expected, `Matching for "${text}" should be ${expected}`);
  });

  console.log('✓ Multi-language menu matching verified with negative exclusion');
}

console.log('--- All Locator Tests Passed! ---');
