/**
 * Integration Test: Simulates GSM Diff rendering against real-world GSM secret payloads.
 */

const assert = require('assert');
const GSMDiffEngine = require('../diff-engine.js');

console.log('--- Running Real-World Secret Diff Integration Test ---');

// Real world scenario 1: Secret environment variables diff
const envV1 = `DATABASE_URL="postgres://app_user:old_secret_pwd@db1.internal.gcp:5432/production"
REDIS_URL="redis://10.0.0.1:6379"
API_KEY="sk_test_1234567890abcdef1234567890"
DEBUG="false"
TIMEOUT_MS="5000"`;

const envV2 = `DATABASE_URL="postgres://app_user:new_rotated_pwd99@db1.internal.gcp:5432/production"
REDIS_URL="redis://10.0.0.2:6379"
API_KEY="sk_test_1234567890abcdef1234567890"
DEBUG="false"
TIMEOUT_MS="10000"
NEW_FEATURE_FLAG="true"`;

const diff = GSMDiffEngine.computeLineDiff(envV1, envV2);
assert.strictEqual(diff.unchanged, 2, 'DEBUG and API_KEY should be unchanged');
assert.strictEqual(diff.deletions, 3, 'Old DB, Redis, and Timeout should be deleted');
assert.strictEqual(diff.additions, 4, 'New DB, Redis, Timeout, and Feature flag should be added');

const sbsRows = GSMDiffEngine.generateSideBySideRows(diff);
// Check that DB URL row was paired as modify with intra-line token diff
const dbRow = sbsRows.find(r => r.type === 'modify' && r.left?.content.includes('DATABASE_URL'));
assert.ok(dbRow, 'DB row should be paired');
assert.ok(dbRow.left.tokens.some(t => t.text.includes('old_secret_pwd') && t.type === 'deleted'));
assert.ok(dbRow.right.tokens.some(t => t.text.includes('new_rotated_pwd99') && t.type === 'inserted'));

console.log('✓ Secret env comparison with intra-line token highlighting verified.');

// Real world scenario 2: JSON configuration (e.g. Service Account Key or Firebase config)
const jsonV1 = JSON.stringify({
  type: "service_account",
  project_id: "my-gcp-project",
  private_key_id: "key-id-1111",
  client_email: "service-account@my-gcp-project.iam.gserviceaccount.com",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token"
});

const jsonV2 = JSON.stringify({
  // Note different key order and rotated key ID
  token_uri: "https://oauth2.googleapis.com/token",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  client_email: "service-account@my-gcp-project.iam.gserviceaccount.com",
  private_key_id: "key-id-2222",
  project_id: "my-gcp-project",
  type: "service_account"
});

const jsonDiff = GSMDiffEngine.computeLineDiff(jsonV1, jsonV2, { prettifyJson: true });
assert.strictEqual(jsonDiff.additions, 1, 'Only private_key_id should be added in canonical JSON');
assert.strictEqual(jsonDiff.deletions, 1, 'Only private_key_id should be deleted in canonical JSON');

console.log('✓ JSON Canonicalization & Key-Order Insensitive Diff verified.');

// Real world scenario 3: Secret Masking (Privacy Mode)
const maskedV1 = GSMDiffEngine.maskSecretContent(envV1);
assert.ok(!maskedV1.includes('old_secret_pwd'));
assert.ok(!maskedV1.includes('1234567890abcdef1234567890'));
assert.ok(maskedV1.includes('DATABASE_URL='));
assert.ok(maskedV1.includes('API_KEY='));

console.log('✓ Privacy Mode Secret Masking verified.');

console.log('--- All Real-World Integration Tests Passed Successfully! ---');
