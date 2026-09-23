import fs from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * 开发辅助脚本：在 DSH 插件目录下创建指向本仓库 dsh-panel 的符号链接。
 *
 * 用法：
 *   cd dsh-panel
 *   npm run link-dev
 *
 * 环境变量（可选，有默认值）：
 *   DSH_PLUGINS_DIR  DSH 插件目录（默认：%USERPROFILE%\.dsh\plugins）
 *   MULTI_AGENT_ROOT multi-agent 仓库根目录（默认：脚本所在目录的上级）
 *
 * 行为：
 *   - 探测 DSH 插件目录是否存在；不存在提示用户安装 DSH 后再跑
 *   - 在 <plugins>/dsh-bridge-panel 创建 junction（Windows）或 symlink（POSIX）
 *   - 幂等：链接已存在则跳过并打印状态（link/dir/other）
 *   - 自检：构建产物 + manifest 是否就位，缺则提示先 `npm run build`
 */

const isWin = platform() === 'win32';
const defaultDir = isWin
  ? path.join(process.env.USERPROFILE || homedir(), '.dsh', 'plugins')
  : path.join(homedir(), '.dsh', 'plugins');
const pluginsDir = process.env.DSH_PLUGINS_DIR || defaultDir;
const pluginName = 'dsh-bridge-panel';
const link = path.join(pluginsDir, pluginName);

const source = process.env.MULTI_AGENT_ROOT
  ? path.join(process.env.MULTI_AGENT_ROOT, 'dsh-panel')
  : path.resolve(import.meta.dirname, '.');

if (!fs.existsSync(pluginsDir)) {
  console.error('[X] DSH 插件目录不存在:', pluginsDir);
  console.error('    请先安装 DSH Desktop 并启动一次（生成 ~/.dsh 目录）后再重跑。');
  console.error('    或通过 DSH_PLUGINS_DIR 指向自定义目录：DSH_PLUGINS_DIR=/path npm run link-dev');
  process.exit(1);
}

fs.mkdirSync(pluginsDir, { recursive: true });

try {
  const st = fs.lstatSync(link);
  const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other';
  console.log(`[skip] 已存在: ${link} (${kind})`);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    console.log('       提示：实目录已占位；如需重新指向仓库，请先 rm -rf 后重跑。');
  }
} catch {
  // Windows 上 fs.symlinkSync 需要 SeCreateSymbolicLinkPrivilege；用 junction 兜底（无需管理员）
  const type = isWin ? 'junction' : 'dir';
  fs.symlinkSync(source, link, type);
  console.log(`[ok] 已创建 ${type}: ${link} -> ${source}`);
}

console.log('---');
console.log('contents :', fs.readdirSync(link).slice(0, 12).join(', '));
console.log('manifest :', fs.existsSync(path.join(link, 'package.json')));
console.log('dist     :', fs.existsSync(path.join(link, 'dist', 'index.js')));
console.log('client   :', fs.existsSync(path.join(link, 'dist', 'client.js')));
console.log('---');
console.log('下一步：重启 DSH Desktop，面板将出现在右侧侧边栏。');
console.log('如未出现：在 DSH 设置里确认插件目录已加载（设置 → 插件 → 刷新）。');