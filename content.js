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
   * Create or update the Floating Action Dock
   */
  function ensureDock(context) {
    if (!context.isSecretManager) {
      if (dockElement) {
        dockElement.remove();
        dockElement = null;
      }
      return;
    }

    if (!dockElement) {
      dockElement = document.createElement('div');
      dockElement.id = 'gsm-dock';
      document.body.appendChild(dockElement);
    }

    renderDockContent(context);
  }

  function renderDockContent(context) {
    if (!dockElement) return;

    const vA = Array.from(selectedVersionIds)[0] || (availableVersions[0]?.id || '');
    const vB = Array.from(selectedVersionIds)[1] || (availableVersions[1]?.id || '');

    const optionsHtml = availableVersions.map(v => 
      `<option value="${v.id}">Version ${v.id} (${v.state || 'ENABLED'})</option>`
    ).join('');

    dockElement.innerHTML = `
      <div class="gsm-dock-header" id="gsm-dock-toggle">
        <div class="gsm-dock-title">
          ${ICONS.key}
          <span>GSM Diff</span>
          <span class="gsm-badge">${selectedVersionIds.size} Selected</span>
        </div>
        <div class="gsm-dock-controls">
          <button class="gsm-icon-btn" id="gsm-dock-min-btn" title="Toggle minimize">
            ${ICONS.minimize}
          </button>
        </div>
      </div>
      <div class="gsm-dock-body">
        <div class="gsm-secret-meta">
          <span class="gsm-secret-name">${context.secret}</span>
          <span class="gsm-secret-sub">Project: ${context.project || 'current'}</span>
        </div>

        <div class="gsm-selection-bar">
          <select id="gsm-select-va" class="gsm-select" title="First Version">
            <option value="">Select Version A</option>
            ${optionsHtml}
          </select>
          <span style="font-weight: bold; color: var(--gsm-text-muted);">vs</span>
          <select id="gsm-select-vb" class="gsm-select" title="Second Version">
            <option value="">Select Version B</option>
            ${optionsHtml}
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

    // Set select values
    const selA = dockElement.querySelector('#gsm-select-va');
    const selB = dockElement.querySelector('#gsm-select-vb');
    if (selA && vA) selA.value = vA;
    if (selB && vB) selB.value = vB;

    // Attach listeners
    dockElement.querySelector('#gsm-dock-toggle')?.addEventListener('click', (e) => {
      if (e.target.closest('#gsm-dock-min-btn')) {
        dockElement.classList.toggle('gsm-minimized');
      }
    });

    selA?.addEventListener('change', (e) => {
      selectedVersionIds.clear();
      if (e.target.value) selectedVersionIds.add(e.target.value);
      if (selB?.value) selectedVersionIds.add(selB.value);
      updateRowCheckboxes();
    });

    selB?.addEventListener('change', (e) => {
      selectedVersionIds.clear();
      if (selA?.value) selectedVersionIds.add(selA.value);
      if (e.target.value) selectedVersionIds.add(e.target.value);
      updateRowCheckboxes();
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
      // Sort numerically descending
      const sorted = [...availableVersions].sort((a, b) => Number(b.id) - Number(a.id));
      openDiffModal(context.project, context.secret, sorted[1].id, sorted[0].id);
    });
  }

  /**
   * Scan Console DOM for Version Rows and inject checkboxes & diff buttons
   */
  function scanAndEnhanceVersionTable(context) {
    if (!context.isSecretManager) return;

    // Secret versions table row selectors in Google Cloud Console
    const rows = document.querySelectorAll('mat-row, tr, div[role="row"]');
    const detected = new Map();

    rows.forEach(row => {
      // Find cells or links containing version number
      // e.g. text "Version 2" or link ".../versions/2"
      let versionNumber = null;

      const link = row.querySelector('a[href*="/versions/"]');
      if (link) {
        const m = link.href.match(/\/versions\/(\d+)/);
        if (m) versionNumber = m[1];
      }

      if (!versionNumber) {
        // Search text content for Version X or standalone number cell
        const cells = row.querySelectorAll('mat-cell, td, div[role="gridcell"]');
        for (const cell of cells) {
          const txt = cell.textContent.trim();
          const match = txt.match(/^Version\s*(\d+)$/i) || txt.match(/^(\d+)$/);
          if (match && Number(match[1]) > 0 && Number(match[1]) < 100000) {
            versionNumber = match[1];
            break;
          }
        }
      }

      if (versionNumber) {
        detected.set(versionNumber, { id: versionNumber, row });

        // Inject checkbox if not already injected
        if (!row.querySelector('.gsm-row-checkbox-wrapper')) {
          const firstCell = row.querySelector('mat-cell, td, div[role="gridcell"]') || row.firstElementChild;
          if (firstCell) {
            const wrapper = document.createElement('span');
            wrapper.className = 'gsm-row-checkbox-wrapper';
            wrapper.innerHTML = `
              <input type="checkbox" class="gsm-row-checkbox" data-version="${versionNumber}" title="Select for GSM Diff">
            `;

            const cb = wrapper.querySelector('input');
            cb.addEventListener('change', (e) => {
              e.stopPropagation();
              if (cb.checked) {
                if (selectedVersionIds.size >= 2) {
                  // Keep the latest checked one and replace the first
                  const arr = Array.from(selectedVersionIds);
                  selectedVersionIds.delete(arr[0]);
                }
                selectedVersionIds.add(versionNumber);
              } else {
                selectedVersionIds.delete(versionNumber);
              }
              updateRowCheckboxes();
              renderDockContent(context);
            });

            firstCell.prepend(wrapper);
          }
        }

        // Inject row "Diff with prev" button if not already present
        if (!row.querySelector('.gsm-row-diff-btn')) {
          const actionCell = row.querySelector('button[aria-label*="Action"], button[aria-label*="More"], mat-icon, cfc-icon')?.parentElement || row.lastElementChild;
          if (actionCell && Number(versionNumber) > 1) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'gsm-row-diff-btn';
            diffBtn.title = `Compare Version ${versionNumber} with previous version (${Number(versionNumber) - 1})`;
            diffBtn.innerHTML = `⇄ Diff`;
            diffBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              e.preventDefault();
              openDiffModal(context.project, context.secret, String(Number(versionNumber) - 1), versionNumber);
            });
            actionCell.appendChild(diffBtn);
          }
        }
      }
    });

    if (detected.size > 0) {
      // Update availableVersions list
      const sorted = Array.from(detected.values())
        .map(v => ({ id: v.id, state: 'ENABLED' }))
        .sort((a, b) => Number(b.id) - Number(a.id));

      if (sorted.length !== availableVersions.length) {
        availableVersions = sorted;
        renderDockContent(context);
      }
    }
  }

  function updateRowCheckboxes() {
    document.querySelectorAll('.gsm-row-checkbox').forEach(cb => {
      const ver = cb.getAttribute('data-version');
      cb.checked = selectedVersionIds.has(ver);
    });
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

    try {
      [valA, valB] = await Promise.all([
        fetchSecretValue(project, secret, verA),
        fetchSecretValue(project, secret, verB)
      ]);

      renderActiveDiff(valA, valB, verA, verB);
    } catch (err) {
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
   * Automate DOM clicks to fetch secret value via Console's 'View secret value' dialog
   */
  async function autoFetchViaDom(targetVersion) {
    const rows = Array.from(document.querySelectorAll('mat-row, tr, div[role="row"]'));
    let targetRow = null;
    for (const r of rows) {
      const text = r.textContent;
      if (text.includes(`Version ${targetVersion}`) || text.match(new RegExp(`\\b${targetVersion}\\b`))) {
        targetRow = r;
        break;
      }
    }

    if (!targetRow) {
      throw new Error(`Could not locate table row for Version ${targetVersion}.`);
    }

    // Find action button on row
    const actionBtn = targetRow.querySelector('button[aria-label*="Action"], button[aria-label*="More"], mat-icon, cfc-icon')?.closest('button') || targetRow.querySelector('button');
    if (!actionBtn) {
      throw new Error(`Could not find Actions button on row for Version ${targetVersion}.`);
    }

    actionBtn.click();
    await new Promise(r => setTimeout(r, 450));

    // Look for menu item with "View secret value"
    const menuItems = Array.from(document.querySelectorAll('button[role="menuitem"], .mat-menu-item, .cfc-menu-item, div[role="menuitem"]'));
    const viewItem = menuItems.find(el => el.textContent.toLowerCase().includes('view secret value'));
    if (!viewItem) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new Error('Menu opened, but "View secret value" option was not found.');
    }

    viewItem.click();
    await new Promise(r => setTimeout(r, 800));

    // Wait for dialog
    const dialog = document.querySelector('mat-dialog-container, div[role="dialog"]');
    if (!dialog) {
      throw new Error('Secret value dialog did not open.');
    }

    // Extract value from dialog
    let secretText = '';
    const textarea = dialog.querySelector('textarea, pre, code');
    if (textarea) {
      secretText = textarea.value || textarea.textContent;
    } else {
      const contentEl = dialog.querySelector('.mat-dialog-content, div[class*="content"]') || dialog;
      secretText = contentEl.textContent.trim();
    }

    // Close dialog
    const closeBtn = Array.from(dialog.querySelectorAll('button')).find(b => {
      const t = b.textContent.toLowerCase();
      return t.includes('done') || t.includes('close') || t.includes('ok');
    });

    if (closeBtn) {
      closeBtn.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    await new Promise(r => setTimeout(r, 400));
    return secretText;
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
          <strong>Unable to automatically fetch secret values via API:</strong><br>
          <span style="font-size: 12px; opacity: 0.95;">${escapeHtml(errorMessage)}</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; width: 100%; margin-bottom: 16px;">
          <!-- Option 1: DOM Auto-Fetch -->
          <div style="background: var(--gsm-bg-panel); border: 1px solid var(--gsm-border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <strong style="display: flex; align-items: center; gap: 6px; font-size: 13px;">
                ⚡ Try UI Auto-Fetch (No Token Needed)
              </strong>
              <p style="font-size: 11.5px; color: var(--gsm-text-muted); margin: 6px 0 12px 0;">
                Automatically opens the console's "View secret value" dialog for Version ${verA} and Version ${verB} to extract values.
              </p>
            </div>
            <button class="gsm-btn gsm-btn-primary" id="gsm-btn-try-dom-autofetch" style="width: 100%;">
              ⚡ Run UI Auto-Fetch
            </button>
          </div>

          <!-- Option 2: Reload Page -->
          <div style="background: var(--gsm-bg-panel); border: 1px solid var(--gsm-border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <strong style="display: flex; align-items: center; gap: 6px; font-size: 13px;">
                🔄 Reload Page to Capture Token
              </strong>
              <p style="font-size: 11.5px; color: var(--gsm-text-muted); margin: 6px 0 12px 0;">
                Google Cloud Console sends authentication tokens during page load. Reloading the tab allows the extension to capture it.
              </p>
            </div>
            <button class="gsm-btn gsm-btn-secondary" id="gsm-btn-reload-page" style="width: 100%;">
              🔄 Reload Tab
            </button>
          </div>
        </div>

        <!-- Option 3: gcloud token input -->
        <div style="background: var(--gsm-bg-panel); border: 1px solid var(--gsm-border); border-radius: 8px; padding: 14px; width: 100%; margin-bottom: 16px;">
          <strong style="font-size: 13px;">🔑 Or Paste gcloud Access Token</strong>
          <p style="font-size: 11.5px; color: var(--gsm-text-muted); margin: 4px 0 8px 0;">
            Run <code style="background: var(--gsm-bg-surface); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--gsm-border); font-family: var(--gsm-font-mono);">gcloud auth print-access-token</code> in terminal and paste below:
          </p>
          <div style="display: flex; gap: 8px;">
            <input type="password" id="gsm-modal-input-token" placeholder="Paste ya29... access token" style="flex: 1; padding: 6px 10px; font-family: var(--gsm-font-mono); font-size: 12px; border: 1px solid var(--gsm-border); border-radius: 6px; background: var(--gsm-bg-surface); color: var(--gsm-text-main); outline: none;">
            <button class="gsm-btn gsm-btn-primary" id="gsm-btn-save-modal-token">
              Save & Compare
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

    // Handler 1: UI Auto-Fetch
    container.querySelector('#gsm-btn-try-dom-autofetch')?.addEventListener('click', async () => {
      const btn = container.querySelector('#gsm-btn-try-dom-autofetch');
      btn.disabled = true;
      btn.textContent = 'Fetching Version ' + verA + ' via UI...';
      try {
        const vA = await autoFetchViaDom(verA);
        btn.textContent = 'Fetching Version ' + verB + ' via UI...';
        const vB = await autoFetchViaDom(verB);

        secretValueCache.set(`${project}/${secret}/${verA}`, vA);
        secretValueCache.set(`${project}/${secret}/${verB}`, vB);
        renderActiveDiff(vA, vB, verA, verB);
      } catch (domErr) {
        alert('UI Auto-Fetch failed: ' + domErr.message + '\nPlease use the gcloud token or manual paste option.');
        btn.disabled = false;
        btn.textContent = '⚡ Run UI Auto-Fetch';
      }
    });

    // Handler 2: Reload Page
    container.querySelector('#gsm-btn-reload-page')?.addEventListener('click', () => {
      window.location.reload();
    });

    // Handler 3: gcloud token save
    container.querySelector('#gsm-btn-save-modal-token')?.addEventListener('click', () => {
      const tok = container.querySelector('#gsm-modal-input-token')?.value?.trim();
      if (!tok) {
        alert('Please enter a valid token (starts with ya29...)');
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
    }

    ensureDock(context);
    scanAndEnhanceVersionTable(context);
  }

  // Periodic polling to catch SPA navigation & async table loading
  setInterval(checkAndSyncPage, 1200);

  // MutationObserver for instant DOM updates
  observer = new MutationObserver(() => {
    const context = parseConsoleUrl();
    if (context.isSecretManager) {
      scanAndEnhanceVersionTable(context);
    }
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

  // Initial check
  checkAndSyncPage();

})();
