#!/usr/bin/env node
/**
 * 验证 qoder-panel 设置是否正确
 *
 * 环境变量（可选）：
 *   MULTI_AGENT_ROOT         multi-agent 仓库根目录（默认：脚本所在目录的上级）
 *   QODER_CN_DEV_EXTENSIONS  Qoder CN 开发扩展目录（默认：~/.qoder-cn/app/dev-extensions）
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const multiAgentRoot = process.env.MULTI_AGENT_ROOT || path.resolve(import.meta.dirname, '..');
const QODER_PANEL = path.join(multiAgentRoot, 'qoder-panel');
const BRIDGE = path.join(multiAgentRoot, 'bridge');
const devExtensions = process.env.QODER_CN_DEV_EXTENSIONS || path.join(homedir(), '.qoder-cn', 'app', 'dev-extensions');

console.log('🔍 Verifying qoder-panel setup...\n');

// 1. Check bridge-web-panel.mjs exists
const panelPath = path.join(BRIDGE, 'mcp', 'bridge-web-panel.mjs');
if (fs.existsSync(panelPath)) {
  console.log('✅ bridge-web-panel.mjs exists');
} else {
  console.error('❌ bridge-web-panel.mjs NOT found at:', panelPath);
  process.exit(1);
}

// 2. Check qoder-panel dist files
const distNode = path.join(QODER_PANEL, 'dist', 'node', 'main.cjs');
const distBrowser = path.join(QODER_PANEL, 'dist', 'browser', 'view.cjs');

if (fs.existsSync(distNode)) {
  console.log('✅ dist/node/main.cjs exists');
} else {
  console.error('❌ dist/node/main.cjs NOT found');
}

if (fs.existsSync(distBrowser)) {
  console.log('✅ dist/browser/view.cjs exists');
} else {
  console.error('❌ dist/browser/view.cjs NOT found');
}

// 3. Check plugin.json
const pluginJson = path.join(QODER_PANEL, '.qoder-app-plugin', 'plugin.json');
if (fs.existsSync(pluginJson)) {
  const manifest = JSON.parse(fs.readFileSync(pluginJson, 'utf-8'));
  console.log('✅ plugin.json exists, id:', manifest.id);
} else {
  console.error('❌ plugin.json NOT found');
}

// 4. Check dev-extensions junction
const junctionTarget = path.join(devExtensions, 'qoder-panel');
try {
  const stats = fs.lstatSync(junctionTarget);
  if (stats.isSymbolicLink()) {
    const target = fs.readlinkSync(junctionTarget);
    console.log('✅ dev-extensions junction exists →', target);
  } else {
    console.error('❌ dev-extensions is not a symlink');
  }
} catch (err) {
  console.error('❌ dev-extensions junction NOT found or inaccessible');
}

// 5. Check environment variable
const allowUnverified = process.env.QODER_APP_PLUGIN_ALLOW_UNVERIFIED;
if (allowUnverified === 'true') {
  console.log('✅ QODER_APP_PLUGIN_ALLOW_UNVERIFIED=true');
} else {
  console.warn('⚠️  QODER_APP_PLUGIN_ALLOW_UNVERIFIED not set (current:', allowUnverified || 'undefined', ')');
  console.warn('   Run start-qoder-cn.bat to launch with correct env vars');
}

console.log('\n✨ Verification complete');
