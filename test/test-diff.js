/**
 * Test suite for GSMDiffEngine
 */

const assert = require('assert');
const GSMDiffEngine = require('../diff-engine.js');

console.log('--- Testing GSMDiffEngine ---');

// Test 1: Simple text diff
{
  const v1 = 'DATABASE_URL=postgres://user:oldpass@localhost:5432/mydb\nPORT=3000\nDEBUG=true';
  const v2 = 'DATABASE_URL=postgres://user:newpass@localhost:5432/mydb\nPORT=8080\nDEBUG=true';

  const diff = GSMDiffEngine.computeLineDiff(v1, v2);
  assert.strictEqual(diff.additions, 2, 'Should have 2 additions');
  assert.strictEqual(diff.deletions, 2, 'Should have 2 deletions');
  assert.strictEqual(diff.unchanged, 1, 'Should have 1 unchanged line (DEBUG=true)');

  const sbs = GSMDiffEngine.generateSideBySideRows(diff);
  assert.strictEqual(sbs.length, 3, 'Should generate 3 side-by-side rows');

  // Verify first row is paired modification with token highlighting
  assert.strictEqual(sbs[0].type, 'modify');
  assert.ok(sbs[0].left.tokens.some(t => t.text === 'oldpass' && t.type === 'deleted'), 'oldpass should be marked deleted');
  assert.ok(sbs[0].right.tokens.some(t => t.text === 'newpass' && t.type === 'inserted'), 'newpass should be marked inserted');

  console.log('✓ Test 1: Simple text diff with intra-line token highlighting passed');
}

// Test 2: JSON canonicalization and diff
{
  const jsonA = '{"database":{"host":"db1.gcp.internal","port":5432},"enabled":true}';
  const jsonB = '{\n  "enabled": true,\n  "database": {\n    "host": "db2.gcp.internal",\n    "port": 5432\n  }\n}';

  const diffRaw = GSMDiffEngine.computeLineDiff(jsonA, jsonB);
  // Without prettifyJson, it's 1 line vs 6 lines
  assert.strictEqual(diffRaw.isJson, true, 'Should detect valid JSON in both');

  // With prettifyJson
  const diffPrettified = GSMDiffEngine.computeLineDiff(jsonA, jsonB, { prettifyJson: true });
  assert.strictEqual(diffPrettified.unchanged > 3, true, 'Canonicalized JSON should match identical keys even with different key order');

  const sbs = GSMDiffEngine.generateSideBySideRows(diffPrettified);
  const modifiedHostRow = sbs.find(r => r.type === 'modify' && r.left?.content.includes('host'));
  assert.ok(modifiedHostRow, 'Should find modified host line');
  assert.ok(modifiedHostRow.left.tokens.some(t => t.text === 'db1' && t.type === 'deleted'));
  assert.ok(modifiedHostRow.right.tokens.some(t => t.text === 'db2' && t.type === 'inserted'));

  console.log('✓ Test 2: JSON canonicalization & structural diff passed');
}

// Test 3: Unified diff & Patch generation
{
  const a = 'Line 1\nLine 2\nLine 3';
  const b = 'Line 1\nLine 2 modified\nLine 3\nLine 4 added';

  const patch = GSMDiffEngine.generatePatchText(a, b, 'Version 1', 'Version 2');
  assert.ok(patch.includes('--- Version 1'), 'Patch header check');
  assert.ok(patch.includes('+++ Version 2'), 'Patch header check');
  assert.ok(patch.includes('-Line 2'), 'Patch deletion check');
  assert.ok(patch.includes('+Line 2 modified'), 'Patch modification check');
  assert.ok(patch.includes('+Line 4 added'), 'Patch addition check');

  console.log('✓ Test 3: Unified patch generation passed');
}

// Test 4: Secret value masking
{
  const secretEnv = 'API_SECRET_KEY="sk_test_1234567890abcdef"\nJWT_SECRET: supersecrettoken123\nDB_PASS=123';
  const masked = GSMDiffEngine.maskSecretContent(secretEnv);
  assert.ok(!masked.includes('sk_test_1234567890abcdef'), 'Original long secret should be masked');
  assert.ok(masked.includes('sk••••••••ef'), 'Partial mask should show first and last characters');
  assert.ok(masked.includes('****'), 'Short secret should be replaced with ****');

  console.log('✓ Test 4: Secret masking passed');
}

// Test 5: Identical versions
{
  const same = 'HELLO_WORLD=123\nANOTHER=test';
  const diff = GSMDiffEngine.computeLineDiff(same, same);
  assert.strictEqual(diff.isIdentical, true, 'Should detect identical content');
  assert.strictEqual(diff.additions, 0);
  assert.strictEqual(diff.deletions, 0);

  console.log('✓ Test 5: Identical content check passed');
}

// Test 6: Audit log objects comparison
{
  const logA = {
    protoPayload: {
      serviceName: "secretmanager.googleapis.com",
      methodName: "google.cloud.secretmanager.v1.SecretManagerService.CreateSecretVersion",
      resourceName: "projects/123/secrets/my-secret/versions/1",
      authenticationInfo: { principalEmail: "admin@company.com" }
    },
    timestamp: "2026-09-28T10:00:00Z"
  };

  const logB = {
    protoPayload: {
      serviceName: "secretmanager.googleapis.com",
      methodName: "google.cloud.secretmanager.v1.SecretManagerService.AccessSecretVersion",
      resourceName: "projects/123/secrets/my-secret/versions/2",
      authenticationInfo: { principalEmail: "backend-sa@company.iam.gserviceaccount.com" }
    },
    timestamp: "2026-09-30T10:00:00Z"
  };

  const logDiff = GSMDiffEngine.diffJsonObjects(logA, logB);
  assert.strictEqual(logDiff.lineDiff.isIdentical, false);
  assert.ok(logDiff.sideBySide.length > 5);

  console.log('✓ Test 6: Audit log comparison passed');
}

console.log('All 6 unit tests passed successfully!');
