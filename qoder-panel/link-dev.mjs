import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

/**
 * 开发辅助脚本：在 Qoder CN 的 dev-extensions 目录下创建指向本仓库的符号链接。
 *
 * 用法：
 *   node link-dev.mjs
 *
 * 环境变量（可选，有默认值）：
 *   QODER_CN_DEV_EXTENSIONS  Qoder CN 开发扩展目录（默认：%USERPROFILE%\.qoder-cn\app\dev-extensions）
 *   MULTI_AGENT_ROOT         multi-agent 仓库根目录（默认：脚本所在目录的上级）
 */

const devRoot = process.env.QODER_CN_DEV_EXTENSIONS || path.join(homedir(), '.qoder-cn', 'app', 'dev-extensions');
const link = path.join(devRoot, 'qoder-panel');
const source = process.env.MULTI_AGENT_ROOT
  ? path.join(process.env.MULTI_AGENT_ROOT, 'qoder-panel')
  : path.resolve(import.meta.dirname, '.');

fs.mkdirSync(devRoot, { recursive: true });

try {
  const st = fs.lstatSync(link);
  console.log('already exists:', st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other');
} catch {
  fs.symlinkSync(source, link, 'junction');
  console.log('junction created');
}

console.log('contents:', fs.readdirSync(link).join(', '));
console.log('manifest:', fs.existsSync(path.join(link, '.qoder-app-plugin', 'plugin.json')));
console.log('main.cjs:', fs.existsSync(path.join(link, 'dist', 'node', 'main.cjs')));
console.log('view.cjs:', fs.existsSync(path.join(link, 'dist', 'browser', 'view.cjs')));
