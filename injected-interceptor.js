/**
 * GSM Diff - Injected MAIN World Interceptor
 * Runs in the webpage execution context (window) of Google Cloud Console.
 * Intercepts Bearer tokens and API responses from Cloud Console network activity.
 */

(function () {
  'use strict';

  // Prevent duplicate execution
  if (window.__GSM_INTERCEPTOR_INJECTED__) return;
  window.__GSM_INTERCEPTOR_INJECTED__ = true;

  function broadcastToken(token) {
    if (!token || typeof token !== 'string') return;
    const clean = token.trim().replace(/^Bearer\s+/i, '');
    if (clean.startsWith('ya29.')) {
      window.postMessage({ type: 'GSM_DIFF_TOKEN_FOUND', token: clean }, '*');
    }
  }

  // 1. Check window.gapi or global objects for existing tokens
  function scanWindowForToken() {
    try {
      if (window.gapi?.auth?.getToken) {
        const tok = window.gapi.auth.getToken();
        if (tok?.access_token) {
          broadcastToken(tok.access_token);
          return;
        }
      }
      if (window.gapi?.client?.getToken) {
        const tok = window.gapi.client.getToken();
        if (tok?.access_token) {
          broadcastToken(tok.access_token);
          return;
        }
      }
    } catch (e) {}
  }

  scanWindowForToken();
  // Check periodically in case gapi initializes late
  const scanInterval = setInterval(scanWindowForToken, 2000);
  setTimeout(() => clearInterval(scanInterval), 30000);

  // 2. Intercept window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const config = args[1];
      if (config && config.headers) {
        let auth = null;
        if (typeof Headers !== 'undefined' && config.headers instanceof Headers) {
          auth = config.headers.get('authorization') || config.headers.get('Authorization');
        } else if (typeof config.headers === 'object') {
          auth = config.headers['authorization'] || config.headers['Authorization'];
        }
        if (auth) {
          broadcastToken(auth);
        }
      }
    } catch (e) {}

    const response = await originalFetch.apply(this, args);

    // Intercept Secret Manager responses if user views a secret value
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (url.includes('secretmanager.googleapis.com') && url.includes(':access')) {
        const clone = response.clone();
        clone.json().then(data => {
          if (data?.payload?.data) {
            window.postMessage({
              type: 'GSM_DIFF_PAYLOAD_INTERCEPTED',
              url,
              name: data.name,
              base64Data: data.payload.data
            }, '*');
          }
        }).catch(() => {});
      }
    } catch (e) {}

    return response;
  };

  // 3. Intercept XMLHttpRequest
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    try {
      if (header && header.toLowerCase() === 'authorization' && value) {
        broadcastToken(value);
      }
    } catch (e) {}
    return originalSetRequestHeader.apply(this, arguments);
  };

})();
