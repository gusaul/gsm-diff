# 🔐 GSM Diff - Chrome Extension for Google Cloud Secret Manager

> **Compare historical changes and secret values between Google Secret Manager (GSM) versions and audit log records with zero setup.**

---

## 🌟 Why GSM Diff?

In Google Cloud Console Secret Manager, inspecting changes across historical versions is traditionally cumbersome:
1. You have to open Version 2, click actions, view secret value, reveal it, copy it.
2. Close the modal, open Version 1, view secret value, reveal it, copy it.
3. Paste both into an external diff tool to see what changed (which also poses a security risk of leaking sensitive tokens to third-party websites).

**GSM Diff solves this directly inside Google Cloud Console**:
- ⚡ **1-Click Diff**: Select any two versions with checkboxes in the console table or click `⇄ Diff`.
- ◫ **Side-by-Side & Unified Diffs**: Full-screen split view with synchronized scrolling and line numbers.
- 🔍 **Intra-Line Character/Word Highlighting**: Instantly spot modified credentials, ports, or environment variable values.
- 📦 **Smart JSON Formatting**: Canonicalizes and sorts JSON keys so structural differences are highlighted rather than indentation differences.
- 🔒 **Privacy / Mask Mode**: Hide or partially mask secret values for screen sharing or presentations.
- 📋 **Export & Patch**: Copy unified diff patches or download `.patch` files directly.
- 🛡️ **Zero External Traffic**: All processing is client-side. The extension intercepts the existing Google Cloud Console session token to query the Secret Manager API securely.

---

## 📂 Project Structure

```
gsm-diff/
├── manifest.json              # Chrome Extension Manifest V3
├── background.js              # Service Worker: intercepts GCP session token & queries GSM API
├── content.js                 # Injected script: monitors GCP DOM, injects checkboxes & diff modal
├── content.css                # GCP-themed responsive styling (Dark/Light mode support)
├── diff-engine.js             # High-performance diff algorithm (LCS, intra-line, JSON normalization)
├── popup/
│   ├── popup.html             # Extension toolbar popup
│   ├── popup.js               # Context detection, quick actions, standalone diff tool
│   └── popup.css              # Popup styling
├── icons/
│   ├── icon16.png             # Toolbar icon
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png            # Web Store & Extensions page icon
├── test/
│   ├── test-diff.js           # Unit test suite for diff engine
│   ├── test-dom-integration.js# Real-world integration test with realistic secret payloads
│   └── mock-console.html      # Local interactive mock GCP Console Secret Manager page
└── README.md
```

---

## 🚀 How to Install in Google Chrome

1. Clone or navigate to the repository directory:
   ```bash
   cd /Users/gusaul/Work/cekat/gsm-diff
   ```
2. Open Google Chrome and navigate to:
   ```
   chrome://extensions
   ```
3. Enable **Developer mode** toggle in the top-right corner.
4. Click **"Load unpacked"** in the top-left corner.
5. Select the `/Users/gusaul/Work/cekat/gsm-diff` folder.
6. The extension **"GCP Secret Manager & Log Diff (GSM Diff)"** is now active!

---

## 🎯 How to Use

### 1. In Google Cloud Console (Secret Manager)
1. Open the [Google Cloud Console Secret Manager](https://console.cloud.google.com/security/secret-manager).
2. Click on any secret to view its **Versions** tab.
3. You will notice:
   - **Checkboxes** injected into each row in the versions table.
   - A **`⇄ Diff`** button next to each version to compare with its predecessor.
   - A floating **GSM Diff Dock** at the bottom-right showing version selectors and quick actions.
4. Select any 2 versions and click **"⚡ Compare Diff"** (or click **"Latest vs Prev"**).
5. The full comparison modal opens immediately:
   - Toggle between **Split (Side-by-Side)** and **Unified** views.
   - Click **"Format JSON"** if the secret is a JSON configuration or service account key.
   - Click **"Mask Values"** to hide sensitive tokens while demonstrating diffs.
   - Click **"Copy Patch"** or **"Download Diff"** to save changes.

### 2. Standalone Quick Diff Tool (Popup)
- Click the **GSM Diff** icon in the Chrome extension toolbar.
- The popup displays:
  - Active GCP secret and project detected in the current tab.
  - Quick action: **"⚡ Compare Top 2 Versions"**.
  - **Quick Diff Tool** tab: Paste any two secrets, environment variables, or log records to diff them instantly without leaving your current view!

---

## 🧪 Testing Locally

You can test the entire UI and diff algorithm locally without needing an active GCP connection:

1. Open `test/mock-console.html` directly in your browser:
   ```bash
   open test/mock-console.html
   ```
2. Or run the unit test suite:
   ```bash
   npm test
   ```

---

## 🔐 Security & Permissions

- **Read-Only / Principle of Least Privilege**: GSM Diff only performs read-only requests (`:access`) to retrieve versions selected by the user. It never modifies, disables, or destroys secrets.
- **Client-Side Only**: Secret values are processed completely in memory in your browser. No secret or token is ever transmitted to any third-party server.
- **Session Auth**: Uses Google Cloud Console's native session authentication (`ya29...`) kept in memory session storage, expiring automatically when the browser closes.
