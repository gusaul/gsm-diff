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
  const tagMatch = sel.match(/^([a-zA-Z0-9_\-]+)/);
  if (tagMatch && el.tagName !== tagMatch[1].toUpperCase()) {
    return false;
  }
  const attrMatch = sel.match(/\[([a-zA-Z0-9_\-]+)([\*~]?=)?"?([^"\]]*)"?\]/);
  if (attrMatch) {
    const [_, attr, op, val] = attrMatch;
    const elVal = el.getAttribute(attr);
    if (!elVal) return false;
    if (!op) return true;
    if (op === '=') return elVal === val;
    if (op === '*=') return elVal.includes(val);
  }
  return true;
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

// Test 3: Native Checkbox Detection & Version Selection Sync
{
  function isCheckboxChecked(el) {
    if (!el) return false;
    if (el.type === 'checkbox' && el.checked) return true;
    const input = el.querySelector ? el.querySelector('input[type="checkbox"]') : null;
    if (input && input.checked) return true;
    const ariaChecked = el.getAttribute ? (el.getAttribute('aria-checked') || input?.getAttribute?.('aria-checked')) : null;
    if (ariaChecked === 'true') return true;
    const classList = el.classList || (el.attributes?.class ? el.attributes.class.split(' ') : []);
    if (
      classList.includes('mat-mdc-checkbox-checked') ||
      classList.includes('mat-checkbox-checked') ||
      classList.includes('mdc-checkbox--selected') ||
      classList.includes('checked')
    ) {
      return true;
    }
    return false;
  }

  // 1. Direct input
  assert.strictEqual(isCheckboxChecked({ type: 'checkbox', checked: true }), true);
  assert.strictEqual(isCheckboxChecked({ type: 'checkbox', checked: false }), false);

  // 2. mat-checkbox container with inner input
  const matEl = createElement('mat-checkbox', {}, [
    createElement('input', { type: 'checkbox' })
  ]);
  assert.strictEqual(isCheckboxChecked(matEl), false);
  matEl.children[0].checked = true;
  assert.strictEqual(isCheckboxChecked(matEl), true);

  // 3. mat-mdc-checkbox with class
  const mdcEl = createElement('mat-mdc-checkbox', { class: 'mat-mdc-checkbox-checked' });
  assert.strictEqual(isCheckboxChecked(mdcEl), true);

  // 4. aria-checked
  const ariaEl = createElement('div', { 'aria-checked': 'true' });
  assert.strictEqual(isCheckboxChecked(ariaEl), true);

  // 5. Version pair resolution logic
  const availableVersions = [{ id: '3' }, { id: '2' }, { id: '1' }];
  
  function resolvePair(selectedSet) {
    let vA = '';
    let vB = '';
    const checked = Array.from(selectedSet);
    if (checked.length >= 2) {
      vA = checked[0];
      vB = checked[1];
    } else if (checked.length === 1) {
      vA = checked[0];
      const other = availableVersions.find(v => v.id !== vA);
      vB = other ? other.id : '';
    } else {
      vA = availableVersions[0]?.id || '';
      vB = availableVersions[1]?.id || '';
    }
    return [vA, vB];
  }

  // 0 checked -> defaults to 3 and 2
  assert.deepStrictEqual(resolvePair(new Set()), ['3', '2']);
  // 1 checked (Version 2) -> resolves to '2' and '3' (never duplicates '2' vs '2')
  assert.deepStrictEqual(resolvePair(new Set(['2'])), ['2', '3']);
  // 2 checked (Version 3 and Version 1) -> resolves to '3' and '1'
  assert.deepStrictEqual(resolvePair(new Set(['3', '1'])), ['3', '1']);

  console.log('✓ Native checkbox detection and version selection sync verified');
}

console.log('--- All Locator Tests Passed! ---');
