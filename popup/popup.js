/**
 * GSM Diff - Popup Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Tab Switching
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // Check Auth Status with Background Worker
  checkAuthStatus();

  // Inspect Active Tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let currentProject = null;
  let currentSecret = null;

  if (activeTab && activeTab.url) {
    try {
      const url = new URL(activeTab.url);
      if (url.hostname.includes('console.cloud.google.com')) {
        currentProject = url.searchParams.get('project');
        const match = url.pathname.match(/\/security\/secret-manager\/secret\/([^/?#]+)/);
        if (match) {
          currentSecret = decodeURIComponent(match[1]);
        }
      }
    } catch (e) {}
  }

  // Update UI with detected context
  const secretEl = document.getElementById('current-secret-name');
  const projectEl = document.getElementById('current-project-name');
  const compareTopBtn = document.getElementById('btn-quick-compare-top');

  if (currentSecret) {
    secretEl.textContent = currentSecret;
    projectEl.textContent = currentProject || '(from URL)';
    compareTopBtn.disabled = false;
  } else {
    secretEl.textContent = 'No secret page active';
    projectEl.textContent = currentProject || 'N/A';
    compareTopBtn.disabled = true;
  }

  // Quick Compare Top 2 Versions button
  compareTopBtn.addEventListener('click', () => {
    if (!activeTab || !activeTab.id) return;
    chrome.tabs.sendMessage(activeTab.id, { type: 'TRIGGER_COMPARE_TOP' });
    window.close();
  });

  // Open Console button
  document.getElementById('btn-open-console')?.addEventListener('click', () => {
    const targetUrl = currentProject
      ? `https://console.cloud.google.com/security/secret-manager?project=${encodeURIComponent(currentProject)}`
      : 'https://console.cloud.google.com/security/secret-manager';
    chrome.tabs.create({ url: targetUrl });
  });

  // Reload Tab buttons
  const reloadActiveTab = () => {
    if (activeTab && activeTab.id) {
      chrome.tabs.reload(activeTab.id);
      window.close();
    }
  };
  document.getElementById('btn-reload-tab')?.addEventListener('click', reloadActiveTab);
  document.getElementById('btn-auth-reload-tab')?.addEventListener('click', reloadActiveTab);

  // Switch to Auth Tab button
  document.getElementById('btn-go-auth-tab')?.addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="tab-auth"]')?.click();
  });

  // Save manual gcloud token
  document.getElementById('btn-save-manual-token')?.addEventListener('click', () => {
    const input = document.getElementById('input-manual-token');
    const token = input?.value?.trim();
    if (!token) {
      alert('Please enter a valid token (starts with ya29...)');
      return;
    }
    chrome.runtime.sendMessage({ type: 'SET_MANUAL_TOKEN', token }, (res) => {
      if (res && res.success) {
        alert('Access token saved successfully! You can now compare secret versions.');
        checkAuthStatus();
        document.querySelector('.tab-btn[data-tab="tab-console"]')?.click();
      } else {
        alert('Failed to save token: ' + (res?.error || 'Unknown error'));
      }
    });
  });

  // Quick Diff Tool Logic
  document.getElementById('btn-run-quickdiff')?.addEventListener('click', () => {
    const textA = document.getElementById('qd-text-a').value;
    const textB = document.getElementById('qd-text-b').value;
    const prettifyJson = document.getElementById('qd-opt-json').checked;
    const ignoreWhitespace = document.getElementById('qd-opt-ws').checked;

    if (!window.GSMDiffEngine) {
      alert('Diff engine not ready.');
      return;
    }

    const diff = window.GSMDiffEngine.computeLineDiff(textA, textB, {
      prettifyJson,
      ignoreWhitespace
    });

    const resultBox = document.getElementById('qd-result-container');
    const statsBox = document.getElementById('qd-stats');
    const outputBox = document.getElementById('qd-output');

    resultBox.style.display = 'block';
    statsBox.innerHTML = `
      <span style="color: #137333;">+${diff.additions} additions</span>
      <span style="color: #c5221f;">-${diff.deletions} deletions</span>
      <span style="color: #5f6368;">${diff.unchanged} unchanged</span>
    `;

    const unified = window.GSMDiffEngine.generateUnifiedRows(diff);
    outputBox.innerHTML = unified.map(r => {
      const cls = r.type === 'delete' ? 'qd-del' : (r.type === 'insert' ? 'qd-ins' : '');
      return `<div class="${cls}">${escapeHtml(r.prefix + ' ' + r.content)}</div>`;
    }).join('');
  });

  function checkAuthStatus() {
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, (res) => {
      const dot = document.getElementById('auth-dot');
      const text = document.getElementById('auth-text');
      const warningBanner = document.getElementById('auth-warning-banner');

      if (res && res.hasToken) {
        dot.classList.add('active');
        text.textContent = `Auth Active (${res.ageSeconds}s ago)`;
        if (warningBanner) warningBanner.style.display = 'none';
      } else {
        dot.classList.remove('active');
        text.textContent = 'No Console Auth';
        if (warningBanner) warningBanner.style.display = 'block';
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
});
