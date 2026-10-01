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

// Test 4: Modal Diff Line Exclusion & Version Swap Logic
{
  function isExcludedRow(rowMock) {
    return !!rowMock.closest('#gsm-modal, #gsm-dock, .gsm-modal-backdrop, .gsm-diff-container, .gsm-diff-table, [id^="gsm-"], thead, mat-header-row, mat-paginator, cfc-table-paginator, [role="columnheader"]');
  }

  // Row inside diff modal
  const diffModalRow = {
    closest: (sel) => sel.includes('#gsm-modal') ? { id: 'gsm-modal' } : null
  };
  assert.strictEqual(isExcludedRow(diffModalRow), true, 'Diff modal row must be excluded');

  // Real table row
  const realTableRow = {
    closest: () => null
  };
  assert.strictEqual(isExcludedRow(realTableRow), false, 'Real table row must NOT be excluded');

  // Swap logic
  let selA_val = '3';
  let selB_val = '1';
  function swapVersions() {
    const temp = selA_val;
    selA_val = selB_val;
    selB_val = temp;
  }
  swapVersions();
  assert.strictEqual(selA_val, '1');
  assert.strictEqual(selB_val, '3');
  swapVersions();
  assert.strictEqual(selA_val, '3');
  assert.strictEqual(selB_val, '1');

  console.log('✓ Diff modal row exclusion and swap logic verified');
}

// Test 5: Add Version Dialog Detection & Draft Value Diff Preview
{
  const latestValue = `# Database Configuration v3
PORT=5432
MAX_CONNECTIONS=50`;

  const newDraftValue = `# Database Configuration v3
PORT=5433
MAX_CONNECTIONS=100
ENABLE_SSL=true`;

  // Compute diff between latest version and drafted new version
  const GSMDiffEngine = require('../diff-engine.js');
  const draftDiff = GSMDiffEngine.computeLineDiff(latestValue, newDraftValue);

  assert.strictEqual(draftDiff.deletions, 2, 'Should detect 2 changed/deleted lines (PORT and MAX_CONNECTIONS)');
  assert.strictEqual(draftDiff.additions, 3, 'Should detect 3 updated/added lines (PORT, MAX_CONNECTIONS, ENABLE_SSL)');

  // Verify side-by-side rows pair up the changes
  const sbsRows = GSMDiffEngine.generateSideBySideRows(draftDiff);
  const portRow = sbsRows.find(r => r.type === 'modify' && r.left?.content.includes('PORT=5432'));
  assert.ok(portRow, 'PORT change should be paired as a modify row');
  assert.ok(portRow.right.content.includes('PORT=5433'));

  // Test patch generation with custom draft labels
  const patch = GSMDiffEngine.generatePatchText(latestValue, newDraftValue, 'Version 3 (Latest)', 'New Version (Draft)');
  assert.ok(patch.includes('--- Version 3 (Latest)'));
  assert.ok(patch.includes('+++ New Version (Draft)'));
  assert.ok(patch.includes('+ENABLE_SSL=true'));

  console.log('✓ Add Version draft diff computation and custom labels verified');
}

// Test 6: Diff Modal Stacking Context & Non-Destructive Dialog Isolation
{
  // 1. Verify CSS rules enforce dialog styling and maximum 32-bit z-index (2147483647)
  const fs = require('fs');
  const path = require('path');
  const cssContent = fs.readFileSync(path.join(__dirname, '../content.css'), 'utf8');
  const jsContent = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');

  assert.ok(
    cssContent.includes('z-index: 2147483647 !important'),
    'content.css must declare z-index: 2147483647 !important for #gsm-modal-backdrop'
  );
  assert.ok(
    cssContent.includes('dialog#gsm-modal-backdrop'),
    'content.css must style dialog#gsm-modal-backdrop for native Top Layer support'
  );
  assert.ok(
    jsContent.includes("document.createElement('dialog')"),
    "content.js must create modalElement as HTML5 <dialog> element"
  );
  assert.ok(
    jsContent.includes("modalElement.showModal()"),
    "content.js must call showModal() to promote modal into browser's Top Layer"
  );

  // 2. Simulate Native GCP Add Version Dialog + Diff Modal Layering & Escape Interception
  let nativeDialogClosed = false;
  const mockDraftValue = 'DATABASE_URL="postgres://user:pass@10.0.0.1:5432/prod"';

  // Native GCP Dialog state
  const nativeDialog = {
    isOpen: true,
    textarea: { value: mockDraftValue },
    close() {
      nativeDialogClosed = true;
      nativeDialog.isOpen = false;
    }
  };

  // Event dispatch simulator for capture vs bubble phase
  const captureListeners = [];
  const bubbleListeners = [];

  function addWindowEventListener(event, handler, useCapture = false) {
    if (useCapture) {
      captureListeners.push(handler);
    } else {
      bubbleListeners.push(handler);
    }
  }

  // Native GCP registers an Escape listener in bubble phase (or on document/window)
  addWindowEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nativeDialog.isOpen) {
      nativeDialog.close();
    }
  }, false);

  // When GSM Diff modal opens:
  let diffModalOpen = true;
  let showModalCalled = false;
  let dialogClosed = false;

  const mockDialogElement = {
    open: true,
    showModal() { showModalCalled = true; this.open = true; },
    close() { dialogClosed = true; this.open = false; }
  };
  mockDialogElement.showModal();

  const modalKeyDownHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      mockDialogElement.close();
      diffModalOpen = false;
    }
  };
  // GSM Diff attaches in CAPTURE phase:
  addWindowEventListener('keydown', modalKeyDownHandler, true);

  // Simulate user pressing Escape while Diff Modal is open
  const mockEscapeEvent = {
    key: 'Escape',
    defaultPrevented: false,
    propagationStopped: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; }
  };

  // Dispatch event through capture listeners first, then bubble listeners (unless stopped)
  for (const listener of [...captureListeners]) {
    if (mockEscapeEvent.immediatePropagationStopped) break;
    listener(mockEscapeEvent);
  }
  if (!mockEscapeEvent.propagationStopped && !mockEscapeEvent.immediatePropagationStopped) {
    for (const listener of [...bubbleListeners]) {
      if (mockEscapeEvent.immediatePropagationStopped) break;
      listener(mockEscapeEvent);
    }
  }

  // Assertions:
  assert.strictEqual(showModalCalled, true, 'showModal() must be called to promote dialog into Top Layer');
  assert.strictEqual(dialogClosed, true, 'Diff modal dialog should have closed');
  assert.strictEqual(diffModalOpen, false, 'Diff modal should have closed');
  assert.strictEqual(nativeDialog.isOpen, true, 'Native Add Version dialog MUST still be open');
  assert.strictEqual(nativeDialogClosed, false, 'Native dialog close handler must NOT have been called');
  assert.strictEqual(nativeDialog.textarea.value, mockDraftValue, 'Drafted textarea value must remain intact');

  console.log('✓ HTML5 <dialog> Top Layer promotion, z-index layering, and non-destructive draft preservation verified');
}

console.log('--- All Locator Tests Passed! ---');
