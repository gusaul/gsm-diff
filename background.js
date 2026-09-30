/**
 * GSM Diff - Background Service Worker
 * Intercepts Google Cloud Console OAuth token and communicates with Secret Manager / Cloud Logging APIs.
 */

try {
  importScripts('diff-engine.js');
} catch (e) {
  console.warn('[GSM Diff] Could not importScripts diff-engine.js in service worker:', e);
}

// In-memory token cache
let cachedToken = null;
let tokenCapturedTime = 0;

// Base64 to UTF-8 decoder supporting multi-byte unicode characters
function base64ToUtf8(str) {
  try {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch (err) {
    try {
      return atob(str);
    } catch (e) {
      return str;
    }
  }
}

// Helper to save token in memory and session/local storage
async function saveToken(token) {
  if (!token || typeof token !== 'string') return;
  const clean = token.trim().replace(/^Bearer\s+/i, '');
  if (!clean.startsWith('ya29.')) return;

  if (clean !== cachedToken) {
    cachedToken = clean;
    tokenCapturedTime = Date.now();
    console.log('[GSM Diff] Google Cloud OAuth session token captured!');

    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({
        gcpAccessToken: clean,
        tokenCapturedTime: tokenCapturedTime
      });
    } else if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        gcpAccessToken: clean,
        tokenCapturedTime: tokenCapturedTime
      });
    }
  }
}

// Intercept headers from all relevant Google domains
function extractTokenFromHeaders(headers) {
  if (!headers || !Array.isArray(headers)) return;
  for (const header of headers) {
    if (
      header.name &&
      header.name.toLowerCase() === 'authorization' &&
      header.value &&
      header.value.startsWith('Bearer ya29.')
    ) {
      saveToken(header.value);
      break;
    }
  }
}

const GCP_URL_PATTERNS = [
  '*://*.clients6.google.com/*',
  '*://clients6.google.com/*',
  '*://*.googleapis.com/*',
  '*://*.google.com/*',
  '*://console.cloud.google.com/*'
];

if (chrome.webRequest) {
  // Listen on both onBeforeSendHeaders and onSendHeaders for maximum capture reliability
  if (chrome.webRequest.onBeforeSendHeaders) {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => extractTokenFromHeaders(details.requestHeaders),
      { urls: GCP_URL_PATTERNS },
      ['requestHeaders', 'extraHeaders']
    );
  }

  if (chrome.webRequest.onSendHeaders) {
    chrome.webRequest.onSendHeaders.addListener(
      (details) => extractTokenFromHeaders(details.requestHeaders),
      { urls: GCP_URL_PATTERNS },
      ['requestHeaders', 'extraHeaders']
    );
  }
}

// Helper to get active token from memory or storage
async function getActiveToken() {
  if (cachedToken && (Date.now() - tokenCapturedTime < 55 * 60 * 1000)) {
    return cachedToken;
  }

  // Check session storage
  if (chrome.storage && chrome.storage.session) {
    try {
      const stored = await chrome.storage.session.get(['gcpAccessToken', 'tokenCapturedTime']);
      if (stored.gcpAccessToken) {
        cachedToken = stored.gcpAccessToken;
        tokenCapturedTime = stored.tokenCapturedTime || Date.now();
        return cachedToken;
      }
    } catch (e) {}
  }

  // Check local storage fallback
  if (chrome.storage && chrome.storage.local) {
    try {
      const stored = await chrome.storage.local.get(['gcpAccessToken', 'tokenCapturedTime']);
      if (stored.gcpAccessToken && (Date.now() - (stored.tokenCapturedTime || 0) < 55 * 60 * 1000)) {
        cachedToken = stored.gcpAccessToken;
        tokenCapturedTime = stored.tokenCapturedTime || Date.now();
        return cachedToken;
      }
    } catch (e) {}
  }

  return null;
}

// Fetch helper with error handling
async function callGcpApi(url, method = 'GET', body = null) {
  const token = await getActiveToken();
  if (!token) {
    const err = new Error(
      'NO_AUTH_TOKEN: Google Cloud Console session token not detected yet. Please refresh the Google Cloud Console tab (Cmd+R or F5), or paste a token from `gcloud auth print-access-token`.'
    );
    err.code = 'NO_AUTH_TOKEN';
    throw err;
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const errorText = await res.text();
    let parsedError;
    try {
      parsedError = JSON.parse(errorText);
    } catch (e) {
      parsedError = { error: { message: errorText } };
    }

    const message = parsedError?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
    if (res.status === 401) {
      cachedToken = null;
      const err = new Error(`TOKEN_EXPIRED: Your Google Cloud Console session token expired. Please refresh the page or run \`gcloud auth print-access-token\`. Details: ${message}`);
      err.code = 'TOKEN_EXPIRED';
      throw err;
    } else if (res.status === 403) {
      const err = new Error(`PERMISSION_DENIED: IAM Secret Accessor role ('roles/secretmanager.secretAccessor') is required to view the secret payload. Details: ${message}`);
      err.code = 'PERMISSION_DENIED';
      throw err;
    } else if (res.status === 404) {
      const err = new Error(`NOT_FOUND: The requested secret or version was not found. Details: ${message}`);
      err.code = 'NOT_FOUND';
      throw err;
    } else {
      const err = new Error(`API_ERROR: ${message}`);
      err.code = 'API_ERROR';
      throw err;
    }
  }

  return await res.json();
}

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handleAsync = async () => {
    try {
      switch (request.type) {
        case 'GET_AUTH_STATUS': {
          const token = await getActiveToken();
          return {
            hasToken: !!token,
            ageSeconds: token ? Math.round((Date.now() - tokenCapturedTime) / 1000) : null
          };
        }

        case 'SET_MANUAL_TOKEN': {
          const { token } = request;
          await saveToken(token);
          return { success: true };
        }

        case 'LIST_SECRET_VERSIONS': {
          const { project, secret } = request;
          const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions?pageSize=50`;
          const data = await callGcpApi(url);
          return {
            success: true,
            versions: (data.versions || []).map(v => {
              const parts = v.name.split('/');
              const versionNumber = parts[parts.length - 1];
              return {
                id: versionNumber,
                name: v.name,
                state: v.state,
                createTime: v.createTime,
                destroyTime: v.destroyTime
              };
            })
          };
        }

        case 'FETCH_SECRET_VERSION_VALUE': {
          const { project, secret, version } = request;
          const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions/${encodeURIComponent(version)}:access`;
          const data = await callGcpApi(url);
          const rawBase64 = data.payload?.data || '';
          const decodedValue = base64ToUtf8(rawBase64);
          return {
            success: true,
            version,
            value: decodedValue,
            name: data.name
          };
        }

        case 'COMPARE_SECRET_VERSIONS': {
          const { project, secret, versionA, versionB } = request;
          const [resA, resB] = await Promise.all([
            callGcpApi(`https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions/${encodeURIComponent(versionA)}:access`),
            callGcpApi(`https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions/${encodeURIComponent(versionB)}:access`)
          ]);

          const valueA = base64ToUtf8(resA.payload?.data || '');
          const valueB = base64ToUtf8(resB.payload?.data || '');

          return {
            success: true,
            versionA: { id: versionA, value: valueA, name: resA.name },
            versionB: { id: versionB, value: valueB, name: resB.name }
          };
        }

        case 'FETCH_SECRET_AUDIT_LOGS': {
          const { project, secret } = request;
          const url = 'https://logging.googleapis.com/v2/entries:list';
          const filter = `protoPayload.serviceName="secretmanager.googleapis.com" AND protoPayload.resourceName=~"projects/${project}/secrets/${secret}"`;
          const body = {
            resourceNames: [`projects/${project}`],
            filter,
            orderBy: 'timestamp desc',
            pageSize: 25
          };
          const data = await callGcpApi(url, 'POST', body);
          return {
            success: true,
            entries: data.entries || []
          };
        }

        default:
          return { error: 'Unknown message type: ' + request.type };
      }
    } catch (err) {
      console.error('[GSM Diff ServiceWorker Error]:', err);
      return { success: false, error: err.message, code: err.code || 'UNKNOWN_ERROR' };
    }
  };

  handleAsync().then(sendResponse);
  return true;
});
