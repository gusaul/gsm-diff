/**
 * GSM Diff - Content Script
 * Injected into Google Cloud Console to enable comparison between Secret Manager versions and log entries.
 */

(function () {
  'use strict';

  // Prevent duplicate injection
  if (window.__GSM_DIFF_INJECTED__) return;
  window.__GSM_DIFF_INJECTED__ = true;

  console.log('[GSM Diff] Extension content script loaded.');

  // Current state
  let currentProject = null;
  let currentSecret = null;
  let availableVersions = [];
  let selectedVersionIds = new Set();
  let dockElement = null;
  let modalElement = null;
  let observer = null;
  let isNavigating = false;

  // Diff display settings
  let diffSettings = {
    viewMode: 'split', // 'split' | 'unified'
    prettifyJson: true,
    ignoreWhitespace: false,
    maskSecrets: false,
    searchQuery: ''
  };

  // Cache of fetched secret values: key: `${project}/${secret}/${version}` -> string
  const secretValueCache = new Map();

  /**
   * Parse GCP Console URL
   */
  function parseConsoleUrl() {
    const url = new URL(window.location.href);
    const pathname = url.pathname;
    let project = url.searchParams.get('project');

    // Check if on Secret Manager page
    // Pattern: /security/secret-manager/secret/<SECRET_NAME>(/versions)?
    const secretMatch = pathname.match(/\/security\/secret-manager\/secret\/([^/?#]+)/);
    let secret = secretMatch ? decodeURIComponent(secretMatch[1]) : null;

    // Check for mock testing environment (localhost or elements with data-gsm-secret)
    if (!secret && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      secret = url.searchParams.get('secret') || document.querySelector('[data-gsm-secret]')?.getAttribute('data-gsm-secret') || 'production-database-config';
      project = project || document.querySelector('[data-gsm-project]')?.getAttribute('data-gsm-project') || 'my-gcp-project-prod';
    }

    // Check if on Cloud Logging page
    const isLoggingPage = pathname.includes('/logs/');

    return {
      project,
      secret,
      isSecretManager: !!secret,
      isLoggingPage
    };
  }

  /**
   * SVG Icons Helper
   */
  const ICONS = {
    key: `<svg class="gsm-logo-icon" viewBox="0 0 24 24"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>`,
    swap: `⇄`,
    close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
    minimize: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>`,
    expand: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`,
    copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`
  };

  /**
  let manualVersionA = '';
  let manualVersionB = '';
  let lastRenderedOptionsKey = '';

  /**
   * Create or update the Floating Action Dock
   */
  function ensureDock(context) {
    if (!context.isSecretManager) {
      if (dockElement) {
        dockElement.remove();
        dockElement = null;
        lastRenderedOptionsKey = '';
      }
      return;
    }

    if (!dockElement) {
      dockElement = document.createElement('div');
      dockElement.id = 'gsm-dock';
      // Prevent clicks inside dock from bubbling to GCP Console document handlers
      dockElement.addEventListener('click', (e) => e.stopPropagation());
      dockElement.addEventListener('mousedown', (e) => e.stopPropagation());
      document.body.appendChild(dockElement);
      initDockDom(context);
    }

    updateDockState(context);
  }

  function initDockDom(context) {
    dockElement.innerHTML = `
      <div class="gsm-dock-header" id="gsm-dock-toggle">
        <div class="gsm-dock-title">
          ${ICONS.key}
          <span>GSM Diff</span>
          <span class="gsm-badge" id="gsm-dock-badge">0 Selected</span>
        </div>
        <div class="gsm-dock-controls">
          <button class="gsm-icon-btn" id="gsm-dock-min-btn" title="Toggle minimize">
            ${ICONS.minimize}
          </button>
        </div>
      </div>
      <div class="gsm-dock-body">
        <div class="gsm-secret-meta">
          <span class="gsm-secret-name" id="gsm-dock-secret-name">${escapeHtml(context.secret)}</span>
          <span class="gsm-secret-sub" id="gsm-dock-project-sub">Project: ${escapeHtml(context.project || 'current')}</span>
        </div>

        <div class="gsm-selection-bar">
          <select id="gsm-select-va" class="gsm-select" title="First Version (Left / Base)">
            <option value="">Select Version A</option>
          </select>
          <button type="button" class="gsm-swap-btn" id="gsm-btn-swap" title="Switch Version A and Version B">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/>
            </svg>
          </button>
          <select id="gsm-select-vb" class="gsm-select" title="Second Version (Right / Target)">
            <option value="">Select Version B</option>
          </select>
        </div>

        <div class="gsm-dock-actions">
          <button class="gsm-btn gsm-btn-primary" id="gsm-btn-compare" style="flex: 1;">
            ⚡ Compare Diff
          </button>
          <button class="gsm-btn gsm-btn-secondary" id="gsm-btn-quick-prev" title="Compare Latest vs Previous">
            Latest vs Prev
          </button>
        </div>
      </div>
    `;

    // Attach listeners once
    dockElement.querySelector('#gsm-dock-toggle')?.addEventListener('click', (e) => {
      if (e.target.closest('#gsm-dock-min-btn') || e.target.closest('.gsm-dock-title')) {
        dockElement.classList.toggle('gsm-minimized');
      }
    });

    const selA = dockElement.querySelector('#gsm-select-va');
    const selB = dockElement.querySelector('#gsm-select-vb');
    const swapBtn = dockElement.querySelector('#gsm-btn-swap');

    selA?.addEventListener('change', (e) => {
      manualVersionA = e.target.value;
      selectedVersionIds.clear();
      if (manualVersionA) selectedVersionIds.add(manualVersionA);
      if (selB?.value) selectedVersionIds.add(selB.value);
      updateNativeCheckboxesFromSelection();
      updateDockState(context);
    });

    selB?.addEventListener('change', (e) => {
      manualVersionB = e.target.value;
      selectedVersionIds.clear();
      if (selA?.value) selectedVersionIds.add(selA.value);
      if (manualVersionB) selectedVersionIds.add(manualVersionB);
      updateNativeCheckboxesFromSelection();
      updateDockState(context);
    });

    swapBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selA || !selB) return;

      const oldA = selA.value;
      const oldB = selB.value;
      selA.value = oldB;
      selB.value = oldA;

      manualVersionA = selA.value;
      manualVersionB = selB.value;

      swapBtn.classList.add('gsm-rotating');
      setTimeout(() => swapBtn.classList.remove('gsm-rotating'), 250);

      selectedVersionIds.clear();
      if (selA.value) selectedVersionIds.add(selA.value);
      if (selB.value) selectedVersionIds.add(selB.value);
      updateNativeCheckboxesFromSelection();
      updateDockState(context);
    });

    dockElement.querySelector('#gsm-btn-compare')?.addEventListener('click', () => {
      const verA = selA?.value;
      const verB = selB?.value;
      if (!verA || !verB) {
        alert('Please select two versions to compare.');
        return;
      }
      openDiffModal(context.project, context.secret, verA, verB);
    });

    dockElement.querySelector('#gsm-btn-quick-prev')?.addEventListener('click', () => {
      if (availableVersions.length < 2) {
        alert('At least two versions are needed to compare.');
        return;
      }
      const sorted = [...availableVersions].sort((a, b) => Number(b.id) - Number(a.id));
      const vLatest = sorted[0].id;
      const vPrev = sorted[1].id;
      manualVersionA = vPrev;
      manualVersionB = vLatest;
      if (selA) selA.value = vPrev;
      if (selB) selB.value = vLatest;
      selectedVersionIds.clear();
      selectedVersionIds.add(vPrev);
      selectedVersionIds.add(vLatest);
      updateNativeCheckboxesFromSelection();
      updateDockState(context);
      openDiffModal(context.project, context.secret, vPrev, vLatest);
    });
  }

  function updateDockState(context) {
    if (!dockElement) return;

    // Update badge
    const badge = dockElement.querySelector('#gsm-dock-badge');
    if (badge) {
      badge.textContent = `${selectedVersionIds.size} Selected`;
    }

    // Update secret meta
    const nameEl = dockElement.querySelector('#gsm-dock-secret-name');
    if (nameEl && nameEl.textContent !== context.secret) {
      nameEl.textContent = context.secret;
    }
    const subEl = dockElement.querySelector('#gsm-dock-project-sub');
    if (subEl) {
      const subText = `Project: ${context.project || 'current'}`;
      if (subEl.textContent !== subText) {
        subEl.textContent = subText;
      }
    }

    const selA = dockElement.querySelector('#gsm-select-va');
    const selB = dockElement.querySelector('#gsm-select-vb');
    if (!selA || !selB) return;

    // Determine target versions vA and vB
    let vA = '';
    let vB = '';
    const checked = Array.from(selectedVersionIds);

    if (manualVersionA && (selectedVersionIds.size === 0 || selectedVersionIds.has(manualVersionA))) {
      vA = manualVersionA;
    } else if (checked.length > 0) {
      vA = checked[0];
    } else {
      vA = availableVersions[0]?.id || '';
    }

    if (manualVersionB && manualVersionB !== vA && (selectedVersionIds.size === 0 || selectedVersionIds.has(manualVersionB))) {
      vB = manualVersionB;
    } else if (checked.length >= 2) {
      vB = checked.find(v => v !== vA) || checked[1];
    } else {
      const other = availableVersions.find(v => v.id !== vA);
      vB = other ? other.id : '';
    }

    // Update option list ONLY if availableVersions changed
    const currentOptionsKey = availableVersions.map(v => `${v.id}:${v.state || ''}`).join('|');
    if (currentOptionsKey !== lastRenderedOptionsKey) {
      lastRenderedOptionsKey = currentOptionsKey;
      const optsA = `<option value="">Select Version A</option>` + availableVersions.map(v =>
        `<option value="${v.id}">Version ${v.id} (${v.state || 'ENABLED'})</option>`
      ).join('');
      const optsB = `<option value="">Select Version B</option>` + availableVersions.map(v =>
        `<option value="${v.id}">Version ${v.id} (${v.state || 'ENABLED'})</option>`
      ).join('');

      const currValA = selA.value || vA;
      const currValB = selB.value || vB;
      selA.innerHTML = optsA;
      selB.innerHTML = optsB;
      selA.value = currValA;
      selB.value = currValB;
    }

    // Only set values if the user is NOT actively interacting with the select element
    if (document.activeElement !== selA && vA && selA.value !== vA) {
      selA.value = vA;
    }
    if (document.activeElement !== selB && vB && selB.value !== vB) {
      selB.value = vB;
    }
  }

  function renderDockContent(context) {
    updateDockState(context);
  }

  /**
   * Helper to check if a checkbox or Material Design checkbox element is checked
   */
  function isCheckboxChecked(el) {
    if (!el) return false;

    // Checkbox input directly
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      return el.checked;
    }

    // Nested native checkbox input
    const input = el.querySelector('input[type="checkbox"]');
    if (input && input.checked) {
      return true;
    }

    // ARIA checked attribute
    const ariaChecked = el.getAttribute('aria-checked') || input?.getAttribute('aria-checked');
    if (ariaChecked === 'true') {
      return true;
    }

    // Angular Material / MDC CSS classes
    if (
      el.classList.contains('mat-mdc-checkbox-checked') ||
      el.classList.contains('mat-checkbox-checked') ||
      el.classList.contains('mdc-checkbox--selected') ||
      el.classList.contains('checked')
    ) {
      return true;
    }

    return false;
  }

  let isUpdatingFromDock = false;

  /**
   * Synchronize selectedVersionIds from the native GSM table checkboxes
   */
  function syncSelectedVersionsFromTable(context) {
    if (isUpdatingFromDock) return;

    const currentChecked = new Set();
    const rows = document.querySelectorAll('[data-gsm-version]');

    rows.forEach(row => {
      const ver = row.getAttribute('data-gsm-version');
      const cb = row.querySelector('mat-checkbox, mat-mdc-checkbox, input[type="checkbox"]:not(.gsm-row-checkbox), [role="checkbox"]');
      if (cb && isCheckboxChecked(cb)) {
        currentChecked.add(ver);
      }
    });

    let changed = currentChecked.size !== selectedVersionIds.size;
    if (!changed) {
      for (const v of currentChecked) {
        if (!selectedVersionIds.has(v)) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      selectedVersionIds = currentChecked;
      console.log('[GSM Diff] Synced selection from native GSM checkboxes:', Array.from(selectedVersionIds));
      renderDockContent(context);
    }
  }

  /**
   * Update the native table checkboxes when versions are changed via dock dropdowns
   */
  function updateNativeCheckboxesFromSelection() {
    isUpdatingFromDock = true;
    const rows = document.querySelectorAll('[data-gsm-version]');
    rows.forEach(row => {
      const ver = row.getAttribute('data-gsm-version');
      const cb = row.querySelector('mat-checkbox, mat-mdc-checkbox, input[type="checkbox"]:not(.gsm-row-checkbox), [role="checkbox"]');
      if (cb) {
        const shouldBeChecked = selectedVersionIds.has(ver);
        const isChecked = isCheckboxChecked(cb);
        if (shouldBeChecked !== isChecked) {
          cb.click();
        }
      }
    });
    setTimeout(() => { isUpdatingFromDock = false; }, 200);
  }

  /**
   * Scan Console DOM for Version Rows, attach listeners to native checkboxes, and inject diff buttons
   */
  function scanAndEnhanceVersionTable(context) {
    if (!context.isSecretManager) return;

    // Secret versions table row selectors in Google Cloud Console
    const rows = document.querySelectorAll('tbody tr, mat-row, tr[mat-row], div[role="row"]');
    const detected = new Map();

    rows.forEach(row => {
      // Exclude header rows, paginator rows, and any rows inside our dock / diff modal
      if (row.closest('#gsm-modal, #gsm-dock, .gsm-modal-backdrop, .gsm-diff-container, .gsm-diff-table, [id^="gsm-"], thead, mat-header-row, mat-paginator, cfc-table-paginator, [role="columnheader"]')) {
        return;
      }

      // Find cells or links containing version number
      // e.g. text "Version 2" or link ".../versions/2"
      let versionNumber = null;

      const link = row.querySelector('a[href*="/versions/"]');
      if (link) {
        const m = link.href.match(/\/versions\/(\d+)/);
        if (m) versionNumber = m[1];
      }

      if (!versionNumber) {
        // Search first 2 cells for Version X or standalone number cell
        const cells = row.querySelectorAll('mat-cell, td, div[role="gridcell"], div[role="cell"]');
        for (let i = 0; i < Math.min(2, cells.length); i++) {
          const txt = cells[i].textContent.trim();
          const match = txt.match(/^Version\s*(\d+)$/i) || txt.match(/^(\d+)$/);
          if (match && Number(match[1]) > 0 && Number(match[1]) < 100000) {
            versionNumber = match[1];
            break;
          }
        }
      }

      if (versionNumber) {
        detected.set(versionNumber, { id: versionNumber, row });

        // Clean up any legacy custom injected checkbox wrapper or diff button
        row.querySelector('.gsm-row-checkbox-wrapper')?.remove();
        row.querySelectorAll('.gsm-row-diff-btn').forEach(btn => btn.remove());

        // Tag row with data-gsm-version for instant and reliable lookup
        row.setAttribute('data-gsm-version', versionNumber);

        // Find the native checkbox from Google Cloud Secret Manager UI
        const nativeCb = row.querySelector(
          'mat-checkbox, mat-mdc-checkbox, cfc-checkbox, input[type="checkbox"]:not(.gsm-row-checkbox), [role="checkbox"]'
        );

        if (nativeCb && !nativeCb.__gsm_listener_attached__) {
          nativeCb.__gsm_listener_attached__ = true;

          const onCheckboxToggle = () => {
            setTimeout(() => {
              syncSelectedVersionsFromTable(context);
            }, 50);
            setTimeout(() => {
              syncSelectedVersionsFromTable(context);
            }, 150);
          };

          nativeCb.addEventListener('click', onCheckboxToggle, true);
          nativeCb.addEventListener('change', onCheckboxToggle, true);

          const nativeInput = nativeCb.querySelector('input[type="checkbox"]');
          if (nativeInput && nativeInput !== nativeCb) {
            nativeInput.addEventListener('change', onCheckboxToggle, true);
            nativeInput.addEventListener('click', onCheckboxToggle, true);
          }

          // Observe class and aria-checked attribute changes on the native checkbox
          try {
            const cbObs = new MutationObserver(onCheckboxToggle);
            cbObs.observe(nativeCb, { attributes: true, attributeFilter: ['class', 'aria-checked'] });
            if (nativeInput) {
              cbObs.observe(nativeInput, { attributes: true, attributeFilter: ['checked', 'aria-checked'] });
            }
          } catch (e) {}
        }
      }
    });

    // Also attach listeners to any header select-all checkboxes
    const headerCbs = document.querySelectorAll(
      'thead mat-checkbox, thead mat-mdc-checkbox, thead cfc-checkbox, thead input[type="checkbox"], mat-header-row mat-checkbox, mat-header-row mat-mdc-checkbox, mat-header-row cfc-checkbox, mat-header-row input[type="checkbox"]'
    );
    headerCbs.forEach(headerCb => {
      if (!headerCb.__gsm_listener_attached__) {
        headerCb.__gsm_listener_attached__ = true;
        const onHeaderToggle = () => {
          setTimeout(() => syncSelectedVersionsFromTable(context), 50);
          setTimeout(() => syncSelectedVersionsFromTable(context), 150);
        };
        headerCb.addEventListener('click', onHeaderToggle, true);
        headerCb.addEventListener('change', onHeaderToggle, true);
      }
    });

    if (detected.size > 0) {
      // Update availableVersions list
      const sorted = Array.from(detected.values())
        .map(v => ({ id: v.id, state: 'ENABLED' }))
        .sort((a, b) => Number(b.id) - Number(a.id));

      const isDifferent = sorted.length !== availableVersions.length ||
        sorted.some((v, idx) => v.id !== availableVersions[idx]?.id);

      if (isDifferent) {
        availableVersions = sorted;
        updateDockState(context);
      }
    }
  }

  /**
   * Fetch secret version value via Background script (using Google OAuth token)
   */
  async function fetchSecretValue(project, secret, version) {
    const cacheKey = `${project}/${secret}/${version}`;
    if (secretValueCache.has(cacheKey)) {
      return secretValueCache.get(cacheKey);
    }

    // Check mock values for local testing environment
    if (window.__GSM_MOCK_VALUES__ && window.__GSM_MOCK_VALUES__[version]) {
      const val = window.__GSM_MOCK_VALUES__[version];
      secretValueCache.set(cacheKey, val);
      return val;
    }

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'FETCH_SECRET_VERSION_VALUE',
        project,
        secret,
        version
      }, (response) => {
        if (chrome.runtime.lastError) {
          if (window.__GSM_MOCK_VALUES__ && window.__GSM_MOCK_VALUES__[version]) {
            return resolve(window.__GSM_MOCK_VALUES__[version]);
          }
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response || !response.success) {
          if (window.__GSM_MOCK_VALUES__ && window.__GSM_MOCK_VALUES__[version]) {
            return resolve(window.__GSM_MOCK_VALUES__[version]);
          }
          return reject(new Error(response?.error || 'Failed to fetch secret value'));
        }
        secretValueCache.set(cacheKey, response.value);
        resolve(response.value);
      });
    });
  }

  /**
   * Open the Diff Modal
   */
  async function openDiffModal(project, secret, verA, verB) {
    closeDiffModal();

    modalElement = document.createElement('div');
    modalElement.id = 'gsm-modal-backdrop';

    modalElement.innerHTML = `
      <div class="gsm-modal">
        <div class="gsm-modal-header">
          <div class="gsm-modal-title-group">
            <span class="gsm-modal-title">${ICONS.key} GSM Diff: ${secret}</span>
            <div class="gsm-version-chip-group">
              <span class="gsm-version-chip">Version ${verA}</span>
              <button class="gsm-swap-btn" id="gsm-modal-swap" title="Swap Version A and B">${ICONS.swap}</button>
              <span class="gsm-version-chip">Version ${verB}</span>
            </div>
          </div>
          <button class="gsm-icon-btn" id="gsm-modal-close" title="Close (Esc)">
            ${ICONS.close}
          </button>
        </div>

        <div class="gsm-modal-toolbar">
          <div class="gsm-toolbar-left">
            <div class="gsm-toggle-group">
              <button class="gsm-toggle-btn ${diffSettings.viewMode === 'split' ? 'active' : ''}" id="gsm-toggle-split">Split</button>
              <button class="gsm-toggle-btn ${diffSettings.viewMode === 'unified' ? 'active' : ''}" id="gsm-toggle-unified">Unified</button>
            </div>
            <div class="gsm-toggle-group">
              <button class="gsm-toggle-btn ${diffSettings.prettifyJson ? 'active' : ''}" id="gsm-toggle-json" title="Prettify & sort keys in JSON for logical diff">Format JSON</button>
              <button class="gsm-toggle-btn ${diffSettings.ignoreWhitespace ? 'active' : ''}" id="gsm-toggle-ws" title="Ignore leading/trailing whitespace">Ignore Whitespace</button>
              <button class="gsm-toggle-btn ${diffSettings.maskSecrets ? 'active' : ''}" id="gsm-toggle-mask" title="Mask secret tokens for privacy/screen sharing">Mask Values</button>
            </div>
            <input type="text" class="gsm-search-input" id="gsm-diff-search" placeholder="Search diff..." value="${diffSettings.searchQuery}">
          </div>

          <div class="gsm-toolbar-right">
            <div class="gsm-diff-stats" id="gsm-diff-stats-box"></div>
            <button class="gsm-btn gsm-btn-secondary" id="gsm-btn-copy-patch" title="Copy unified diff to clipboard">
              ${ICONS.copy} Copy Patch
            </button>
            <button class="gsm-btn gsm-btn-secondary" id="gsm-btn-download-patch" title="Download .patch file">
              Download Diff
            </button>
          </div>
        </div>

        <div class="gsm-modal-body" id="gsm-modal-content">
          <div class="gsm-loading-state">
            <div class="gsm-spinner"></div>
            <p>Retrieving secret values for Version ${verA} and Version ${verB}...</p>
            <span style="font-size: 12px; color: var(--gsm-text-muted);">Accessing Secret Manager via Google Cloud session token</span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalElement);

    // Modal Events
    modalElement.querySelector('#gsm-modal-close')?.addEventListener('click', closeDiffModal);
    modalElement.addEventListener('click', (e) => {
      if (e.target === modalElement) closeDiffModal();
    });

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeDiffModal();
        window.removeEventListener('keydown', onKeyDown);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    modalElement.querySelector('#gsm-modal-swap')?.addEventListener('click', () => {
      openDiffModal(project, secret, verB, verA);
    });

    // Toolbar button event handlers
    modalElement.querySelector('#gsm-toggle-split')?.addEventListener('click', () => {
      diffSettings.viewMode = 'split';
      updateToolbarState();
      renderActiveDiff(valA, valB, verA, verB);
    });

    modalElement.querySelector('#gsm-toggle-unified')?.addEventListener('click', () => {
      diffSettings.viewMode = 'unified';
      updateToolbarState();
      renderActiveDiff(valA, valB, verA, verB);
    });

    modalElement.querySelector('#gsm-toggle-json')?.addEventListener('click', () => {
      diffSettings.prettifyJson = !diffSettings.prettifyJson;
      updateToolbarState();
      renderActiveDiff(valA, valB, verA, verB);
    });

    modalElement.querySelector('#gsm-toggle-ws')?.addEventListener('click', () => {
      diffSettings.ignoreWhitespace = !diffSettings.ignoreWhitespace;
      updateToolbarState();
      renderActiveDiff(valA, valB, verA, verB);
    });

    modalElement.querySelector('#gsm-toggle-mask')?.addEventListener('click', () => {
      diffSettings.maskSecrets = !diffSettings.maskSecrets;
      updateToolbarState();
      renderActiveDiff(valA, valB, verA, verB);
    });

    modalElement.querySelector('#gsm-diff-search')?.addEventListener('input', (e) => {
      diffSettings.searchQuery = e.target.value.toLowerCase();
      renderActiveDiff(valA, valB, verA, verB);
    });

    let valA = '';
    let valB = '';

    const statusP = modalElement?.querySelector('#gsm-modal-content p');
    const statusSub = modalElement?.querySelector('#gsm-modal-content span');

    try {
      // 1. Check if both versions are already cached (from previous fetch or network interceptor)
      const cachedA = secretValueCache.get(`${project}/${secret}/${verA}`);
      const cachedB = secretValueCache.get(`${project}/${secret}/${verB}`);

      if (cachedA && cachedB) {
        valA = cachedA;
        valB = cachedB;
      } else {
        // 2. Try fetching via API first (works if user set gcloud token or active OAuth token)
        try {
          [valA, valB] = await Promise.all([
            fetchSecretValue(project, secret, verA),
            fetchSecretValue(project, secret, verB)
          ]);
        } catch (apiErr) {
          // If API fails because no auth token is active, automatically run UI Auto-Fetch!
          if (apiErr.message.includes('NO_AUTH_TOKEN') || apiErr.code === 'NO_AUTH_TOKEN') {
            console.log('[GSM Diff] No API token available. Running UI Auto-Fetch directly via Console...');
            if (statusP) statusP.textContent = `Extracting Version ${verA} and Version ${verB} via Console UI...`;
            if (statusSub) statusSub.textContent = 'Automating native "View secret value" interaction (no token required)';

            let aVal = secretValueCache.get(`${project}/${secret}/${verA}`);
            let bVal = secretValueCache.get(`${project}/${secret}/${verB}`);

            if (!aVal) {
              if (statusP) statusP.textContent = `Extracting Version ${verA} via Console UI...`;
              aVal = await autoFetchViaDom(verA);
              secretValueCache.set(`${project}/${secret}/${verA}`, aVal);
            }

            if (!bVal) {
              if (statusP) statusP.textContent = `Extracting Version ${verB} via Console UI...`;
              bVal = await autoFetchViaDom(verB);
              secretValueCache.set(`${project}/${secret}/${verB}`, bVal);
            }

            valA = aVal;
            valB = bVal;
          } else {
            throw apiErr;
          }
        }
      }

      renderActiveDiff(valA, valB, verA, verB);
    } catch (err) {
      console.warn('[GSM Diff] Failed to fetch secret values:', err);
      renderErrorState(err.message, project, secret, verA, verB);
    }
  }

  function updateToolbarState() {
    if (!modalElement) return;
    const splitBtn = modalElement.querySelector('#gsm-toggle-split');
    const uniBtn = modalElement.querySelector('#gsm-toggle-unified');
    const jsonBtn = modalElement.querySelector('#gsm-toggle-json');
    const wsBtn = modalElement.querySelector('#gsm-toggle-ws');
    const maskBtn = modalElement.querySelector('#gsm-toggle-mask');

    if (splitBtn) splitBtn.className = `gsm-toggle-btn ${diffSettings.viewMode === 'split' ? 'active' : ''}`;
    if (uniBtn) uniBtn.className = `gsm-toggle-btn ${diffSettings.viewMode === 'unified' ? 'active' : ''}`;
    if (jsonBtn) jsonBtn.className = `gsm-toggle-btn ${diffSettings.prettifyJson ? 'active' : ''}`;
    if (wsBtn) wsBtn.className = `gsm-toggle-btn ${diffSettings.ignoreWhitespace ? 'active' : ''}`;
    if (maskBtn) maskBtn.className = `gsm-toggle-btn ${diffSettings.maskSecrets ? 'active' : ''}`;
  }

  /**
   * Render the active diff in either Split or Unified mode
   */
  function renderActiveDiff(rawA, rawB, verA, verB) {
    const container = modalElement?.querySelector('#gsm-modal-content');
    const statsBox = modalElement?.querySelector('#gsm-diff-stats-box');
    if (!container) return;

    let textA = diffSettings.maskSecrets ? window.GSMDiffEngine.maskSecretContent(rawA) : rawA;
    let textB = diffSettings.maskSecrets ? window.GSMDiffEngine.maskSecretContent(rawB) : rawB;

    const diff = window.GSMDiffEngine.computeLineDiff(textA, textB, {
      prettifyJson: diffSettings.prettifyJson,
      ignoreWhitespace: diffSettings.ignoreWhitespace
    });

    // Update stats
    if (statsBox) {
      statsBox.innerHTML = `
        <span class="gsm-stat-add">+${diff.additions}</span>
        <span class="gsm-stat-del">-${diff.deletions}</span>
      `;
    }

    // Attach copy & download patch listeners
    modalElement.querySelector('#gsm-btn-copy-patch').onclick = () => {
      const patch = window.GSMDiffEngine.generatePatchText(textA, textB, `Version ${verA}`, `Version ${verB}`);
      navigator.clipboard.writeText(patch);
      alert('Diff patch copied to clipboard!');
    };

    modalElement.querySelector('#gsm-btn-download-patch').onclick = () => {
      const patch = window.GSMDiffEngine.generatePatchText(textA, textB, `Version ${verA}`, `Version ${verB}`);
      const blob = new Blob([patch], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gsm-diff-${currentSecret}-v${verA}-v${verB}.patch`;
      a.click();
      URL.revokeObjectURL(url);
    };

    if (diffSettings.viewMode === 'split') {
      renderSplitDiff(diff, verA, verB, container);
    } else {
      renderUnifiedDiff(diff, container);
    }
  }

  /**
   * Render Side-by-Side (Split) Diff View
   */
  function renderSplitDiff(diff, verA, verB, container) {
    const rows = window.GSMDiffEngine.generateSideBySideRows(diff);
    const search = diffSettings.searchQuery;

    function highlightTokens(tokens, isDeleted) {
      if (!tokens) return '';
      return tokens.map(t => {
        let content = escapeHtml(t.text);
        if (search && content.toLowerCase().includes(search)) {
          content = `<mark class="gsm-highlight-search">${content}</mark>`;
        }
        if (t.type === 'deleted') {
          return `<span class="gsm-token-deleted">${content}</span>`;
        } else if (t.type === 'inserted') {
          return `<span class="gsm-token-inserted">${content}</span>`;
        }
        return content;
      }).join('');
    }

    function formatLineContent(text, search) {
      let escaped = escapeHtml(text);
      if (search && escaped.toLowerCase().includes(search)) {
        escaped = escaped.replaceAll(new RegExp(`(${search})`, 'gi'), `<mark class="gsm-highlight-search">$1</mark>`);
      }
      return escaped;
    }

    let leftRowsHtml = '';
    let rightRowsHtml = '';

    rows.forEach(r => {
      // Left Pane (Version A)
      if (r.left) {
        const cls = r.left.type === 'deleted' ? 'gsm-row-delete' : '';
        const body = r.left.tokens
          ? highlightTokens(r.left.tokens, true)
          : formatLineContent(r.left.content, search);

        leftRowsHtml += `
          <tr class="gsm-diff-row ${cls}">
            <td class="gsm-line-num">${r.left.lineNum}</td>
            <td class="gsm-line-content">${body}</td>
          </tr>
        `;
      } else {
        leftRowsHtml += `
          <tr class="gsm-diff-row gsm-empty-cell">
            <td class="gsm-line-num">&nbsp;</td>
            <td class="gsm-line-content">&nbsp;</td>
          </tr>
        `;
      }

      // Right Pane (Version B)
      if (r.right) {
        const cls = r.right.type === 'inserted' ? 'gsm-row-insert' : '';
        const body = r.right.tokens
          ? highlightTokens(r.right.tokens, false)
          : formatLineContent(r.right.content, search);

        rightRowsHtml += `
          <tr class="gsm-diff-row ${cls}">
            <td class="gsm-line-num">${r.right.lineNum}</td>
            <td class="gsm-line-content">${body}</td>
          </tr>
        `;
      } else {
        rightRowsHtml += `
          <tr class="gsm-diff-row gsm-empty-cell">
            <td class="gsm-line-num">&nbsp;</td>
            <td class="gsm-line-content">&nbsp;</td>
          </tr>
        `;
      }
    });

    container.innerHTML = `
      <div class="gsm-split-container">
        <div class="gsm-split-pane" id="gsm-pane-left">
          <div class="gsm-split-header">
            <span>Version ${verA} (Base / Old)</span>
            <button class="gsm-copy-btn" id="gsm-copy-left">Copy Value</button>
          </div>
          <table class="gsm-diff-table">
            <tbody>${leftRowsHtml}</tbody>
          </table>
        </div>

        <div class="gsm-split-pane" id="gsm-pane-right">
          <div class="gsm-split-header">
            <span>Version ${verB} (Target / New)</span>
            <button class="gsm-copy-btn" id="gsm-copy-right">Copy Value</button>
          </div>
          <table class="gsm-diff-table">
            <tbody>${rightRowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    // Synchronize scrolling between left and right panes
    const paneLeft = container.querySelector('#gsm-pane-left');
    const paneRight = container.querySelector('#gsm-pane-right');
    let isSyncing = false;

    paneLeft?.addEventListener('scroll', () => {
      if (!isSyncing && paneRight) {
        isSyncing = true;
        paneRight.scrollTop = paneLeft.scrollTop;
        paneRight.scrollLeft = paneLeft.scrollLeft;
        isSyncing = false;
      }
    });

    paneRight?.addEventListener('scroll', () => {
      if (!isSyncing && paneLeft) {
        isSyncing = true;
        paneLeft.scrollTop = paneRight.scrollTop;
        paneLeft.scrollLeft = paneRight.scrollLeft;
        isSyncing = false;
      }
    });

    // Copy buttons
    container.querySelector('#gsm-copy-left')?.addEventListener('click', () => {
      navigator.clipboard.writeText(secretValueCache.get(`${currentProject}/${currentSecret}/${verA}`) || '');
      alert(`Version ${verA} value copied!`);
    });

    container.querySelector('#gsm-copy-right')?.addEventListener('click', () => {
      navigator.clipboard.writeText(secretValueCache.get(`${currentProject}/${currentSecret}/${verB}`) || '');
      alert(`Version ${verB} value copied!`);
    });
  }

  /**
   * Render Unified (single-pane) Diff View
   */
  function renderUnifiedDiff(diff, container) {
    const rows = window.GSMDiffEngine.generateUnifiedRows(diff);
    const search = diffSettings.searchQuery;

    let rowsHtml = '';
    rows.forEach(r => {
      let cls = '';
      if (r.type === 'delete') cls = 'gsm-row-delete';
      else if (r.type === 'insert') cls = 'gsm-row-insert';

      let escaped = escapeHtml(r.content);
      if (search && escaped.toLowerCase().includes(search)) {
        escaped = escaped.replaceAll(new RegExp(`(${search})`, 'gi'), `<mark class="gsm-highlight-search">$1</mark>`);
      }

      rowsHtml += `
        <tr class="gsm-diff-row ${cls}">
          <td class="gsm-line-num">${r.oldLineNum ?? ''}</td>
          <td class="gsm-line-num">${r.newLineNum ?? ''}</td>
          <td style="width: 20px; text-align: center; font-weight: bold; user-select: none;">${r.prefix}</td>
          <td class="gsm-line-content">${escaped}</td>
        </tr>
      `;
    });

    container.innerHTML = `
      <table class="gsm-diff-table" style="width: 100%;">
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  }

  /**
   * Locate the table row specifically corresponding to targetVersion
   */
  function findVersionRow(targetVersion) {
    const vStr = String(targetVersion).trim();

    // Strategy 1: Check by tagged data-gsm-version attribute (set during row scanning)
    const taggedRow = document.querySelector(`[data-gsm-version="${vStr}"]`);
    if (taggedRow) return taggedRow;

    // Strategy 2: Scan all rows in the versions table (excluding header and paginator rows)
    const candidateRows = Array.from(document.querySelectorAll(
      'tbody tr, mat-row:not(mat-header-row), tr[mat-row]:not([mat-header-row]), div[role="row"]:not([role="columnheader"])'
    ));

    for (const row of candidateRows) {
      // Exclude header rows or paginator rows
      if (row.closest('thead, mat-header-row, mat-paginator, cfc-table-paginator, [role="columnheader"]')) {
        continue;
      }

      // Check for anchor link pointing to /versions/<vStr>
      const links = Array.from(row.querySelectorAll('a[href*="/versions/"]'));
      for (const link of links) {
        const match = link.href.match(/\/versions\/(\d+)(\b|[/?#]|$)/);
        if (match && match[1] === vStr) {
          return row;
        }
      }

      // Check first two cells for "Version X" or "X"
      const cells = Array.from(row.querySelectorAll('mat-cell, td, div[role="gridcell"], div[role="cell"]'));
      for (let i = 0; i < Math.min(2, cells.length); i++) {
        const txt = cells[i].textContent.trim();
        if (
          txt.toLowerCase() === `version ${vStr}`.toLowerCase() ||
          txt === vStr ||
          txt.match(new RegExp(`^Version\\s*${vStr}\\b`, 'i'))
        ) {
          return row;
        }
      }
    }

    return null;
  }

  /**
   * Find the three-dots (more_vert) Actions button on a version row
   */
  function findRowActionsButton(row) {
    if (!row) return null;

    // Filter out our injected buttons
    const buttons = Array.from(row.querySelectorAll('button:not(.gsm-row-diff-btn):not(.gsm-row-checkbox)'));

    // 1. By aria-label
    const ariaMatch = buttons.find(b => {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      return l.includes('action') || l.includes('more') || l.includes('tindakan') || l.includes('menu');
    });
    if (ariaMatch) return ariaMatch;

    // 2. By more_vert icon inside
    const iconMatch = buttons.find(b => {
      const icon = b.querySelector('mat-icon, cfc-icon, svg, [class*="icon"]');
      if (!icon) return false;
      const txt = (icon.textContent || '').trim();
      const attr = icon.getAttribute('data-mat-icon-name') || '';
      return txt === 'more_vert' || attr === 'more_vert';
    });
    if (iconMatch) return iconMatch;

    // 3. Button in the last column / cell
    const cells = Array.from(row.querySelectorAll('mat-cell, td, div[role="gridcell"]'));
    if (cells.length > 0) {
      const lastCell = cells[cells.length - 1];
      const lastBtn = lastCell.querySelector('button:not(.gsm-row-diff-btn):not(.gsm-row-checkbox)');
      if (lastBtn) return lastBtn;
    }

    return buttons[0] || null;
  }

  /**
   * Automate DOM clicks to fetch secret value via Console's 'View secret value' dialog
   */
  async function autoFetchViaDom(targetVersion) {
    const vStr = String(targetVersion).trim();
    const cacheKey = `${currentProject}/${currentSecret}/${vStr}`;

    // Return cached value if available
    if (secretValueCache.has(cacheKey)) {
      return secretValueCache.get(cacheKey);
    }

    // 1. Find the version's table row
    const targetRow = findVersionRow(vStr);
    if (!targetRow) {
      throw new Error(`Could not locate table row for Version ${vStr} in Secret Manager table.`);
    }

    // 2. Find the Actions (3 dots) button on that row
    const actionBtn = findRowActionsButton(targetRow);
    if (!actionBtn) {
      throw new Error(`Could not find Actions (⋮) button on row for Version ${vStr}.`);
    }

    // Scroll into view & click
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(r => setTimeout(r, 200));
    actionBtn.click();
    console.log(`[GSM Diff] Clicked Actions menu button for Version ${vStr}`);

    // 3. Wait for menu to appear in DOM (poll up to 2.5s)
    let menuItems = [];
    const menuStart = Date.now();
    while (Date.now() - menuStart < 2500) {
      const menus = Array.from(document.querySelectorAll(
        '.cdk-overlay-container [role="menu"], [role="menu"], .mat-mdc-menu-panel, .mat-menu-panel, cfc-menu'
      ));

      if (menus.length > 0) {
        const activeMenu = menus[menus.length - 1];
        menuItems = Array.from(activeMenu.querySelectorAll(
          '[role="menuitem"], button.mat-mdc-menu-item, button.mat-menu-item, button.cfc-menu-item, button'
        )).filter(el => el.offsetParent !== null || el.clientHeight > 0 || getComputedStyle(el).display !== 'none');

        if (menuItems.length > 0) break;
      }
      await new Promise(r => setTimeout(r, 80));
    }

    if (menuItems.length === 0) {
      // Check document-wide menu items
      menuItems = Array.from(document.querySelectorAll('[role="menuitem"], .mat-mdc-menu-item, .mat-menu-item'));
    }

    if (menuItems.length === 0) {
      throw new Error(`Actions menu for Version ${vStr} did not open.`);
    }

    const itemTexts = menuItems.map(m => m.textContent.trim().replace(/\s+/g, ' '));
    console.log(`[GSM Diff] Found menu items for Version ${vStr}:`, itemTexts);

    const negativeKeywords = ['disable', 'destroy', 'delete', 'nonaktif', 'hancur', 'hapus', 'desactivar', 'destruir', 'löschen', 'deaktivieren'];

    // Multi-language matching for "View secret value"
    const viewKeywords = [
      'view secret', 'view value', 'view payload', 'view',
      'lihat nilai', 'lihat rahasia', 'lihat',
      'ver valor', 'ver secreto',
      'afficher', 'anzeigen', 'visualizza', '表示', '查看'
    ];

    let viewItem = menuItems.find(item => {
      const txt = item.textContent.toLowerCase();
      // Must NOT be a destructive or disabling action
      if (negativeKeywords.some(neg => txt.includes(neg))) return false;
      return viewKeywords.some(kw => txt.includes(kw)) || txt.match(/\bver\b/);
    });

    // Check for visibility / eye icon
    if (!viewItem) {
      viewItem = menuItems.find(item => {
        const txt = item.textContent.toLowerCase();
        if (negativeKeywords.some(neg => txt.includes(neg))) return false;
        const icon = item.querySelector('mat-icon, cfc-icon, svg');
        if (!icon) return false;
        const name = (icon.textContent || '').trim();
        const attr = icon.getAttribute('data-mat-icon-name') || '';
        return name === 'visibility' || attr === 'visibility';
      });
    }

    // Negative filtering fallback (any item that is not disable/destroy/delete)
    if (!viewItem) {
      viewItem = menuItems.find(item => {
        const txt = item.textContent.toLowerCase();
        return !negativeKeywords.some(kw => txt.includes(kw));
      });
    }

    // Fallback to first item
    if (!viewItem && menuItems.length > 0) {
      viewItem = menuItems[0];
    }

    if (!viewItem) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new Error(`"View secret value" option not found among menu options: [${itemTexts.join(', ')}]`);
    }

    console.log(`[GSM Diff] Clicking menu item: "${viewItem.textContent.trim()}"`);
    viewItem.click();

    // 4. Wait for Secret Value dialog to appear (poll up to 3.5s)
    let dialog = null;
    const dialogStart = Date.now();
    while (Date.now() - dialogStart < 3500) {
      // Check if network interceptor already captured payload during click
      if (secretValueCache.has(cacheKey)) {
        console.log(`[GSM Diff] Intercepted payload for Version ${vStr} via network!`);
        break;
      }

      dialog = document.querySelector(
        '.cdk-overlay-container mat-dialog-container, mat-dialog-container, div[role="dialog"], .mat-mdc-dialog-container, cfc-dialog'
      );
      if (dialog && (dialog.offsetParent !== null || dialog.clientHeight > 0)) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // If network interceptor caught it, close any open dialog and return
    if (secretValueCache.has(cacheKey)) {
      if (dialog) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      return secretValueCache.get(cacheKey);
    }

    if (!dialog) {
      throw new Error(`Secret value dialog for Version ${vStr} did not open.`);
    }

    // Wait a brief moment for content to populate inside dialog
    await new Promise(r => setTimeout(r, 500));

    // Check if dialog has a reveal / show eye button
    const revealBtn = Array.from(dialog.querySelectorAll('button')).find(b => {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      const icon = b.querySelector('mat-icon, cfc-icon');
      const iconTxt = (icon?.textContent || '').trim();
      return l.includes('show') || l.includes('reveal') || l.includes('tampilkan') || iconTxt === 'visibility';
    });
    if (revealBtn) {
      revealBtn.click();
      await new Promise(r => setTimeout(r, 300));
    }

    // Extract secret value
    let secretText = '';
    const textarea = dialog.querySelector('textarea, pre, code');
    if (textarea) {
      secretText = textarea.value || textarea.textContent;
    } else {
      const contentEl = dialog.querySelector('.mat-dialog-content, .mat-mdc-dialog-content, div[class*="content"]') || dialog;
      const subPre = contentEl.querySelector('pre, code, textarea');
      secretText = subPre ? (subPre.value || subPre.textContent) : contentEl.textContent;
    }

    // Close dialog
    const closeBtn = Array.from(dialog.querySelectorAll('button')).find(b => {
      const t = b.textContent.toLowerCase().trim();
      return t.includes('done') || t.includes('close') || t.includes('selesai') || t.includes('tutup') || t.includes('ok');
    });

    if (closeBtn) {
      closeBtn.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    await new Promise(r => setTimeout(r, 350));

    const finalVal = (secretText || '').trim();
    secretValueCache.set(cacheKey, finalVal);
    console.log(`[GSM Diff] Successfully extracted Version ${vStr} payload (${finalVal.length} chars)`);
    return finalVal;
  }

  /**
   * Render Error and Resolution State
   */
  function renderErrorState(errorMessage, project, secret, verA, verB) {
    const container = modalElement?.querySelector('#gsm-modal-content');
    if (!container) return;

    container.innerHTML = `
      <div class="gsm-error-state" style="max-width: 900px; margin: 0 auto; text-align: left;">
        <div class="gsm-error-box" style="width: 100%; margin-bottom: 16px;">
          <strong>Unable to load secret values automatically:</strong><br>
          <span style="font-size: 12px; opacity: 0.95;">${escapeHtml(errorMessage)}</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; width: 100%; margin-bottom: 16px;">
          <!-- Option 1: Retry DOM Auto-Fetch -->
          <div style="background: var(--gsm-bg-panel); border: 1px solid var(--gsm-border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <strong style="display: flex; align-items: center; gap: 6px; font-size: 13px;">
                ⚡ Retry UI Auto-Fetch
              </strong>
              <p style="font-size: 11.5px; color: var(--gsm-text-muted); margin: 6px 0 12px 0;">
                Automates opening the "View secret value" dialog for Version ${verA} and Version ${verB}.
              </p>
            </div>
            <button class="gsm-btn gsm-btn-primary" id="gsm-btn-try-dom-autofetch" style="width: 100%;">
              ⚡ Run UI Auto-Fetch Now
            </button>
          </div>

          <!-- Option 2: Live Click-and-Capture Guide -->
          <div style="background: var(--gsm-bg-panel); border: 1px solid var(--gsm-border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <strong style="display: flex; align-items: center; gap: 6px; font-size: 13px;">
                👆 Live Click & Capture
              </strong>
              <p style="font-size: 11.5px; color: var(--gsm-text-muted); margin: 6px 0 12px 0;">
                Click "View secret value" on Version ${verA} and Version ${verB} in the table with your mouse. GSM Diff will auto-capture them!
              </p>
            </div>
            <button class="gsm-btn gsm-btn-secondary" id="gsm-btn-close-for-manual" style="width: 100%;">
              Return to Console Table
            </button>
          </div>
        </div>

        <!-- Option 3: gcloud token input -->
        <div style="background: var(--gsm-bg-panel); border: 1px solid var(--gsm-border); border-radius: 8px; padding: 14px; width: 100%; margin-bottom: 16px;">
          <strong style="font-size: 13px;">🔑 Or Paste gcloud Access Token (Instant 1-Click Access)</strong>
          <p style="font-size: 11.5px; color: var(--gsm-text-muted); margin: 4px 0 8px 0;">
            Run in your terminal: <code style="background: var(--gsm-bg-surface); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--gsm-border); font-family: var(--gsm-font-mono);">gcloud auth print-access-token</code>
          </p>
          <div style="display: flex; gap: 8px;">
            <input type="password" id="gsm-modal-input-token" placeholder="Paste ya29... token here" style="flex: 1; padding: 6px 10px; font-family: var(--gsm-font-mono); font-size: 12px; border: 1px solid var(--gsm-border); border-radius: 6px; background: var(--gsm-bg-surface); color: var(--gsm-text-main); outline: none;">
            <button class="gsm-btn gsm-btn-primary" id="gsm-btn-save-modal-token">
              Save & Diff
            </button>
          </div>
        </div>

        <!-- Option 4: Manual Textarea Paste -->
        <div style="width: 100%;">
          <strong style="font-size: 13px;">📝 Or Paste Secret Payloads Manually</strong>
          <div class="gsm-manual-inputs" style="margin-top: 8px;">
            <div class="gsm-manual-pane">
              <label style="font-weight: 600; font-size: 11.5px;">Version ${verA} Value:</label>
              <textarea class="gsm-textarea" id="gsm-manual-val-a" placeholder="Paste Version ${verA} payload here..."></textarea>
            </div>
            <div class="gsm-manual-pane">
              <label style="font-weight: 600; font-size: 11.5px;">Version ${verB} Value:</label>
              <textarea class="gsm-textarea" id="gsm-manual-val-b" placeholder="Paste Version ${verB} payload here..."></textarea>
            </div>
          </div>

          <button class="gsm-btn gsm-btn-secondary" id="gsm-btn-compare-manual" style="margin-top: 10px; width: 100%;">
            Compare Pasted Values
          </button>
        </div>
      </div>
    `;

    // Handler 1: UI Auto-Fetch Retry
    container.querySelector('#gsm-btn-try-dom-autofetch')?.addEventListener('click', async () => {
      const btn = container.querySelector('#gsm-btn-try-dom-autofetch');
      btn.disabled = true;
      btn.textContent = `Fetching Version ${verA}...`;
      try {
        const vA = await autoFetchViaDom(verA);
        btn.textContent = `Fetching Version ${verB}...`;
        const vB = await autoFetchViaDom(verB);

        secretValueCache.set(`${project}/${secret}/${verA}`, vA);
        secretValueCache.set(`${project}/${secret}/${verB}`, vB);
        renderActiveDiff(vA, vB, verA, verB);
      } catch (domErr) {
        alert('UI Auto-Fetch error: ' + domErr.message + '\n\nPlease use the gcloud token option or manual paste.');
        btn.disabled = false;
        btn.textContent = '⚡ Run UI Auto-Fetch Now';
      }
    });

    // Handler 2: Return to console for live click & capture
    container.querySelector('#gsm-btn-close-for-manual')?.addEventListener('click', () => {
      closeDiffModal();
    });

    // Handler 3: gcloud token save
    container.querySelector('#gsm-btn-save-modal-token')?.addEventListener('click', () => {
      const tok = container.querySelector('#gsm-modal-input-token')?.value?.trim();
      if (!tok) {
        alert('Please paste a valid access token (starts with ya29...)');
        return;
      }
      chrome.runtime.sendMessage({ type: 'SET_MANUAL_TOKEN', token: tok }, async (res) => {
        if (res && res.success) {
          openDiffModal(project, secret, verA, verB);
        } else {
          alert('Failed to save token: ' + (res?.error || 'Unknown error'));
        }
      });
    });

    // Handler 4: Manual Paste
    container.querySelector('#gsm-btn-compare-manual')?.addEventListener('click', () => {
      const mA = container.querySelector('#gsm-manual-val-a').value;
      const mB = container.querySelector('#gsm-manual-val-b').value;
      secretValueCache.set(`${project}/${secret}/${verA}`, mA);
      secretValueCache.set(`${project}/${secret}/${verB}`, mB);
      renderActiveDiff(mA, mB, verA, verB);
    });
  }

  function closeDiffModal() {
    if (modalElement) {
      modalElement.remove();
      modalElement = null;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Monitor DOM and URL changes
   */
  function checkAndSyncPage() {
    const context = parseConsoleUrl();

    if (context.project !== currentProject || context.secret !== currentSecret) {
      currentProject = context.project;
      currentSecret = context.secret;
      selectedVersionIds.clear();
      availableVersions = [];
      manualVersionA = '';
      manualVersionB = '';
      lastRenderedOptionsKey = '';
    }

    ensureDock(context);
    scanAndEnhanceVersionTable(context);
  }

  // Periodic polling to catch SPA navigation & async table loading
  setInterval(checkAndSyncPage, 1500);

  // Debounced MutationObserver that ignores mutations inside our own dock or modal
  let observerTimeout = null;
  observer = new MutationObserver((mutations) => {
    // If all mutations are inside our own dock or modal, ignore them
    const allInternal = mutations.every(m => {
      const t = m.target;
      return t && (t.closest?.('#gsm-dock, #gsm-modal') || t.id === 'gsm-dock' || t.id === 'gsm-modal');
    });
    if (allInternal) return;

    if (observerTimeout) clearTimeout(observerTimeout);
    observerTimeout = setTimeout(() => {
      const context = parseConsoleUrl();
      if (context.isSecretManager) {
        scanAndEnhanceVersionTable(context);
      }
    }, 120);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Listen for history state changes
  window.addEventListener('popstate', checkAndSyncPage);
  window.addEventListener('hashchange', checkAndSyncPage);

  // Listen for messages from popup or background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'TRIGGER_COMPARE_TOP') {
      const context = parseConsoleUrl();
      if (!context.isSecretManager) {
        alert('Please navigate to a Secret Manager secret versions page first.');
        return;
      }
      if (availableVersions.length < 2) {
        alert('Need at least 2 versions to compare.');
        return;
      }
      const sorted = [...availableVersions].sort((a, b) => Number(b.id) - Number(a.id));
      openDiffModal(context.project, context.secret, sorted[1].id, sorted[0].id);
    }
  });

  function base64ToUtf8(str) {
    try {
      const binary = atob(str);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return atob(str);
    }
  }

  // Listen to intercepted events from MAIN world interceptor
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'GSM_DIFF_TOKEN_FOUND' && event.data.token) {
      chrome.runtime.sendMessage({
        type: 'SET_MANUAL_TOKEN',
        token: event.data.token
      });
      const badge = dockElement?.querySelector('.gsm-badge');
      if (badge && !badge.textContent.includes('Selected')) {
        badge.textContent = 'Auth Active';
      }
    } else if (event.data.type === 'GSM_DIFF_PAYLOAD_INTERCEPTED') {
      const { url, name, base64Data } = event.data;
      if (base64Data) {
        const decoded = base64ToUtf8(base64Data);
        const match = (name || url).match(/versions\/(\d+)/);
        if (match && currentProject && currentSecret) {
          const verId = match[1];
          secretValueCache.set(`${currentProject}/${currentSecret}/${verId}`, decoded);
        }
      }
    }
  });

  // Live Dialog Observer: automatically capture secret payload whenever a dialog is open on the page
  const liveDialogObserver = new MutationObserver(() => {
    const dialog = document.querySelector('mat-dialog-container, div[role="dialog"], .mat-mdc-dialog-container, cfc-dialog');
    if (dialog && !dialog.__gsm_monitored__) {
      dialog.__gsm_monitored__ = true;
      setTimeout(() => {
        try {
          const textEl = dialog.querySelector('textarea, pre, code, .mat-dialog-content');
          if (textEl && currentProject && currentSecret) {
            const txt = (textEl.value || textEl.textContent || '').trim();
            if (txt) {
              const title = (dialog.querySelector('h1, h2, [class*="title"]')?.textContent || '').toLowerCase();
              const match = title.match(/version\s*(\d+)/i) || document.location.href.match(/versions\/(\d+)/);
              if (match) {
                const ver = match[1];
                secretValueCache.set(`${currentProject}/${currentSecret}/${ver}`, txt);
                console.log(`[GSM Diff] Live dialog captured Version ${ver} payload!`);
              }
            }
          }
        } catch (e) {}
      }, 500);
    }
  });
  liveDialogObserver.observe(document.body, { childList: true, subtree: true });

  // Initial check
  checkAndSyncPage();

})();
