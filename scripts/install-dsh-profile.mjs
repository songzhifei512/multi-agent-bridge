#!/usr/bin/env node
// install-dsh-profile.mjs -- patch a DSH profile's package.json so the bundle
// is recognized by the cordis bundle loader.
//
// We do this in node because editing JSON from a .bat is error-prone
// (escaping, trailing commas, UTF-8 vs UTF-16).
//
// What it does:
//   1. Insert `"dsh-bridge-panel": "link:<path>"` into `dependencies` if absent
//   2. Insert `"dsh-bridge-panel"` into `dsh.profile.bundles` if absent
//   3. Insert `"patchReload": "live"` if missing (so future edits hot-reload)
//
// Args (via process.argv):
//   --profile <dir>      Profile directory containing package.json
//   --panel-pkg <path>   Path to the dsh-bridge-panel package.json (for safety check)
//   --link    <path>     Absolute Windows path that pnpm will use as link target
//   --id      <name>     Bundle id (default: dsh-bridge-panel)
//
// Idempotent: rerunning is safe (no duplicate keys, no array duplicates).

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) out[k.slice(2)] = argv[++i];
  }
  return out;
}

function fail(msg, code = 1) {
  console.error('[install-dsh-profile] ' + msg);
  process.exit(code);
}

const args = parseArgs(process.argv);
const profileDir = args.profile && resolve(args.profile);
const panelPkgPath = args['panel-pkg'] && resolve(args['panel-pkg']);
const linkPath = args.link;            // already escaped \\ in caller
const bundleId = args.id || 'dsh-bridge-panel';

if (!profileDir) fail('missing --profile');
if (!panelPkgPath) fail('missing --panel-pkg');
if (!linkPath) fail('missing --link');

const profilePkg = join(profileDir, 'package.json');

if (!existsSync(profilePkg)) {
  fail('profile package.json not found: ' + profilePkg);
}

// Load panel package.json to validate name
let panelName;
try {
  const panelPkg = JSON.parse(readFileSync(panelPkgPath, 'utf8'));
  panelName = panelPkg.name;
  if (panelName !== bundleId) {
    fail(`panel package name ${JSON.stringify(panelName)} != bundle id ${JSON.stringify(bundleId)}`);
  }
} catch (e) {
  fail('cannot read/parse panel package.json: ' + e.message);
}

// Load profile package.json
let profile;
try {
  profile = JSON.parse(readFileSync(profilePkg, 'utf8'));
} catch (e) {
  fail('cannot read/parse profile package.json: ' + e.message);
}

let modified = false;

// 1) dependencies."<bundleId>": "link:<path>"
profile.dependencies = profile.dependencies || {};
if (!Object.prototype.hasOwnProperty.call(profile.dependencies, bundleId)) {
  profile.dependencies[bundleId] = `link:${linkPath}`;
  modified = true;
  console.log(`[OK] added dependency ${bundleId} = link:${linkPath}`);
} else {
  // ensure value matches (in case link target changed)
  if (profile.dependencies[bundleId] !== `link:${linkPath}`) {
    profile.dependencies[bundleId] = `link:${linkPath}`;
    modified = true;
    console.log(`[OK] updated dependency ${bundleId}`);
  } else {
    console.log(`[skip] dependency ${bundleId} already set`);
  }
}

// 2) dsh.profile.bundles += "<bundleId>"
profile.dsh = profile.dsh || {};
profile.dsh.profile = profile.dsh.profile || {};
profile.dsh.profile.bundles = profile.dsh.profile.bundles || [];
if (!profile.dsh.profile.bundles.includes(bundleId)) {
  profile.dsh.profile.bundles.push(bundleId);
  modified = true;
  console.log(`[OK] appended bundle ${bundleId}`);
} else {
  console.log(`[skip] bundle ${bundleId} already in bundles`);
}

// 3) patchReload = "live" so future edits hot-reload
if (profile.dsh.profile.patchReload !== 'live') {
  profile.dsh.profile.patchReload = 'live';
  modified = true;
  console.log(`[OK] set patchReload = live`);
} else {
  console.log(`[skip] patchReload already = live`);
}

if (!modified) {
  console.log(`[info] profile already up-to-date`);
  process.exit(0);
}

// Write back: 2-space indent, trailing newline, UTF-8.
const out = JSON.stringify(profile, null, 2) + '\n';
writeFileSync(profilePkg, out, 'utf8');
console.log(`[OK] wrote ${profilePkg} (${out.length} bytes)`);
