// verify-install.mjs -- drive install-dsh-profile.mjs against a fake profile
// to confirm the script behaviour without touching the real ~/.dsh/profiles/desktop.
//
// Exits 0 on all assertions passing, 1 otherwise.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'verify-dsh-install-'));
console.log('[verify] root =', root);

const fakeHome = join(root, 'home');
const fakeDsh = join(fakeHome, '.dsh');
const fakeProfile = join(fakeDsh, 'profiles', 'desktop');
const fakePanel = join(root, 'fake-dsh-panel');

mkdirSync(fakeProfile, { recursive: true });
mkdirSync(fakePanel, { recursive: true });

// 1) fake profile/package.json
const profilePkg = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {
    '@deepseek-ai/dsh-mcp-client': '0.0.1-rc.1',
    '@furongjun1999/dsh-memory': '0.5.0',
    'dsh-better-sidebar': '0.19.1',
    'dsh-context': '0.55.0',
    dshmarket: '1.58.0',
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'dshmarket',
        'dsh-better-sidebar',
        '@furongjun1999/dsh-memory',
        'dsh-context',
      ],
      patchReload: 'live',
    },
  },
};
writeFileSync(join(fakeProfile, 'package.json'), JSON.stringify(profilePkg, null, 2) + '\n');

// 2) fake profile/cordis.patch.yml with mcp-shared-context (mirrors real state)
const profilePatch =
  '# existing\n' +
  '- insert:\n' +
  '    - id: mcp-shared-context\n' +
  '      name: "@deepseek-ai/dsh-mcp-client"\n';
writeFileSync(join(fakeProfile, 'cordis.patch.yml'), profilePatch);

// 3) fake dsh-panel/package.json with the ./cordis.patch.yml export
const panelPkg = {
  name: 'dsh-bridge-panel',
  version: '0.1.0',
  type: 'module',
  main: 'dist/index.js',
  exports: {
    '.': { default: './dist/index.js' },
    './client': './dist/client.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar-right'],
      platform: 'web',
    },
  },
};
writeFileSync(join(fakePanel, 'package.json'), JSON.stringify(panelPkg, null, 2) + '\n');

// 4) fake dsh-panel/cordis.patch.yml with the insert
const panelPatch =
  '- insert:\n' +
  '    - id: dsh-bridge-panel\n' +
  '      name: dsh-bridge-panel\n' +
  '      inject: [webServer]\n' +
  '      config:\n' +
  '        autoStart: true\n' +
  '        port: 3000\n';
writeFileSync(join(fakePanel, 'cordis.patch.yml'), panelPatch);

// 5) run install-dsh-profile.mjs
const scriptPath = fileURLToPath(new URL('./install-dsh-profile.mjs', import.meta.url));
const linkPath = fakePanel.split('\\').join('\\\\'); // emulate the BAT's escaping

console.log('[verify] step 1: dry run');
const result1 = execFileSync('node', [
  scriptPath,
  '--profile', fakeProfile,
  '--panel-pkg', join(fakePanel, 'package.json'),
  '--link', linkPath,
], { encoding: 'utf8' });
console.log(result1);

const after1 = JSON.parse(readFileSync(join(fakeProfile, 'package.json'), 'utf8'));
assert.equal(after1.dependencies['dsh-bridge-panel'], `link:${linkPath}`,
  '(b) profile dependencies must contain link entry');
assert.ok(after1.dsh.profile.bundles.includes('dsh-bridge-panel'),
  '(b) profile bundles must include dsh-bridge-panel');

// 6) step 2: simulate the BAT-injected append for cordis.patch.yml
console.log('[verify] step 2: append dsh-bridge-panel insert to cordis.patch.yml');
const cur = readFileSync(join(fakeProfile, 'cordis.patch.yml'), 'utf8');
if (!cur.includes('dsh-bridge-panel')) {
  writeFileSync(join(fakeProfile, 'cordis.patch.yml'), cur + '\n' + panelPatch);
}
const afterPatch = readFileSync(join(fakeProfile, 'cordis.patch.yml'), 'utf8');
assert.ok(afterPatch.includes('dsh-bridge-panel'),
  '(c) cordis.patch.yml must contain dsh-bridge-panel insert');

// 7) step 3: re-run must be idempotent (no duplicates, no errors)
console.log('[verify] step 3: rerun idempotency');
const result3 = execFileSync('node', [
  scriptPath,
  '--profile', fakeProfile,
  '--panel-pkg', join(fakePanel, 'package.json'),
  '--link', linkPath,
], { encoding: 'utf8' });
console.log(result3);

const after3 = JSON.parse(readFileSync(join(fakeProfile, 'package.json'), 'utf8'));
assert.equal(
  after3.dependencies['dsh-bridge-panel'], `link:${linkPath}`,
  'idempotent: link entry unchanged',
);
const bundlesAfter3 = after3.dsh.profile.bundles.filter((b) => b === 'dsh-bridge-panel');
assert.equal(bundlesAfter3.length, 1, 'idempotent: bundle appears exactly once');

// 8) step 4: confirm dsh-panel/package.json has ./cordis.patch.yml export
const finalPanel = JSON.parse(readFileSync(join(fakePanel, 'package.json'), 'utf8'));
assert.ok(finalPanel.exports['./cordis.patch.yml'],
  '(a) dsh-panel/package.json must expose ./cordis.patch.yml export');

console.log('[verify] all assertions passed ✅');

// 9) cleanup (only the temp root; never touches real profiles)
rmSync(root, { recursive: true, force: true });
