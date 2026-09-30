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

// Listen to network requests to intercept the Google Cloud Console Bearer token
if (chrome.webRequest && chrome.webRequest.onSendHeaders) {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.requestHeaders) {
        for (const header of details.requestHeaders) {
          if (
            header.name.toLowerCase() === 'authorization' &&
            header.value &&
            header.value.startsWith('Bearer ya29.')
          ) {
            const token = header.value.replace(/^Bearer\s+/i, '');
            if (token !== cachedToken) {
              cachedToken = token;
              tokenCapturedTime = Date.now();
              // Store in session storage so other contexts (popup, etc.) can access status
              if (chrome.storage && chrome.storage.session) {
                chrome.storage.session.set({
                  gcpAccessToken: token,
                  tokenCapturedTime: tokenCapturedTime
                });
              }
            }
            break;
          }
        }
      }
    },
    {
      urls: [
        '*://*.clients6.google.com/*',
        '*://*.googleapis.com/*',
        '*://console.cloud.google.com/*'
      ]
    },
    ['requestHeaders', 'extraHeaders']
  );
}

// Helper to get active token from memory or session storage
async function getActiveToken() {
  if (cachedToken && (Date.now() - tokenCapturedTime < 50 * 60 * 1000)) {
    return cachedToken;
  }
  if (chrome.storage && chrome.storage.session) {
    const stored = await chrome.storage.session.get(['gcpAccessToken', 'tokenCapturedTime']);
    if (stored.gcpAccessToken) {
      cachedToken = stored.gcpAccessToken;
      tokenCapturedTime = stored.tokenCapturedTime || Date.now();
      return cachedToken;
    }
  }
  return null;
}

// Fetch helper with error handling
async function callGcpApi(url, method = 'GET', body = null) {
  const token = await getActiveToken();
  if (!token) {
    throw new Error(
      'NO_AUTH_TOKEN: Google Cloud Console session token not detected yet. Please interact with the Secret Manager page or refresh once.'
    );
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
      throw new Error(`TOKEN_EXPIRED: Your Google Cloud Console session token expired. Please refresh the page. Details: ${message}`);
    } else if (res.status === 403) {
      throw new Error(`PERMISSION_DENIED: IAM Secret Accessor role ('roles/secretmanager.secretAccessor') is required. Details: ${message}`);
    } else if (res.status === 404) {
      throw new Error(`NOT_FOUND: The requested secret or version was not found. Details: ${message}`);
    } else {
      throw new Error(`API_ERROR: ${message}`);
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

        case 'LIST_SECRET_VERSIONS': {
          const { project, secret } = request;
          const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions?pageSize=50`;
          const data = await callGcpApi(url);
          return {
            success: true,
            versions: (data.versions || []).map(v => {
              // Extract version number from "projects/.../secrets/.../versions/1"
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
          // Fetch both versions concurrently
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
      return { success: false, error: err.message };
    }
  };

  handleAsync().then(sendResponse);
  return true; // Keep message channel open for async response
});
