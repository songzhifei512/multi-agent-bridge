#环境变量配置指南（公网版）

本文档说明如何配置 multi-agent-bridge所需的 API密钥和端点。

##核心原则

1. **密钥不入包、不入仓库**：所有 API密钥和端点配置在用户级 `~/.agents/.env`（Windows: `%USERPROFILE%\.agents\.env`）
2. **运行时读取**：bridge核心在运行时从环境变量读取，内存中处理
3. **缺失即失败**：读不到配置时显式失败，绝不 fallback到硬编码密钥

---

##配置方式（三选一）

###方式一：安装向导交互式配置（推荐）

运行安装向导后，会提示输入：

```bash
# Linux/macOS
bash launchers/install.sh

# Windows
launchers\install-win.bat
```

向导会：
1.询问 Anthropic端点 URL
2.询问 API Token
3.自动写入 `~/.agents/.env`

###方式二：手动编辑.env文件

创建或编辑 `~/.agents/.env`（Windows: `%USERPROFILE%\.agents\.env`）：

```bash
# ====================必填（主控 agent） ====================

# Anthropic (Claude Code) -主控/队长
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

#模型配置（按实际可用填写）
ANTHROPIC_MODEL=claude-sonnet-4-20250514
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-20250514
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-20250514
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-20250514

# ====================可选 worker ====================

# OpenAI (Codex CLI) -执行/批量代码生成
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Qwen -写文档/PPT +图像分析
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# DSH -模型中立多后端执行者
DSH_BASE_URL=https://api.deepseek.com
DSH_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ====================其他配置 ====================

#主控选择（决定哪个 CLI当队长）
BRIDGE_CONTROLLER=claude

#状态目录（默认 ~/.agents/{state,work}，通常无需修改）
# BRIDGE_STATE_DIR=~/.agents/state
# BRIDGE_WORK_ROOT=~/.agents/work

# Web面板端口（默认3000）
# BRIDGE_WEB_PORT=3000
```

###方式三：系统环境变量

**Linux/macOS**（添加到 `~/.bashrc`或 `~/.zshrc`）：

```bash
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-20250514"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export QWEN_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export BRIDGE_CONTROLLER="claude"
```

**Windows PowerShell**（添加到 `$PROFILE`）：

```powershell
$env:ANTHROPIC_BASE_URL = "https://api.anthropic.com"
$env:ANTHROPIC_AUTH_TOKEN = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:ANTHROPIC_MODEL = "claude-sonnet-4-20250514"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_API_KEY = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:QWEN_API_KEY = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:BRIDGE_CONTROLLER = "claude"
```

**Windows CMD**（临时会话）：

```cmd
set ANTHROPIC_BASE_URL=https://api.anthropic.com
set ANTHROPIC_AUTH_TOKEN=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
set ANTHROPIC_MODEL=claude-sonnet-4-20250514
set OPENAI_BASE_URL=https://api.openai.com/v1
set OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
set QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
set QWEN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
set BRIDGE_CONTROLLER=claude
```

---

##各 Provider配置示例

###1. Anthropic（Claude Code）-必填

**适用**：主控 agent，推理/架构/审查

|字段 |说明 |示例 |
|------|------|------|
| `ANTHROPIC_BASE_URL` | API端点 | `https://api.anthropic.com`（官方云） |
| `ANTHROPIC_AUTH_TOKEN` | API密钥 | `sk-ant-...`（从 https://console.anthropic.com获取） |
| `ANTHROPIC_MODEL` |默认模型 | `claude-sonnet-4-20250514` |

**获取密钥**：
1.访问 https://console.anthropic.com
2.登录/注册账号
3.进入 "API Keys"页面
4.创建新密钥（复制保存，只显示一次）

**模型推荐**：
- `claude-opus-4-20250514`：最强推理，适合架构设计/复杂分析
- `claude-sonnet-4-20250514`：平衡性能与成本，适合日常使用
- `claude-haiku-4-20250514`：最快最便宜，适合简单任务

###2. OpenAI（Codex CLI）-可选

**适用**：执行/批量代码生成/长流程

|字段 |说明 |示例 |
|------|------|------|
| `OPENAI_BASE_URL` | API端点 | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | API密钥 | `sk-...`（从 https://platform.openai.com获取） |

**获取密钥**：
1.访问 https://platform.openai.com
2.登录/注册账号
3.进入 "API Keys"页面
4.创建新密钥

###3. Qwen（通义千问）-可选

**适用**：写文档/PPT +图像分析（VL）

|字段 |说明 |示例 |
|------|------|------|
| `QWEN_BASE_URL` | API端点 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_API_KEY` | API密钥 | `sk-...`（从阿里云百炼平台获取） |

**获取密钥**：
1.访问 https://bailian.console.aliyun.com
2.登录阿里云账号
3.进入 "API-KEY管理"页面
4.创建新密钥

**图像分析配置**：
Qwen支持视觉语言模型（VL），配置同上。使用时通过 `vision_analyze`工具调用。

###4. DSH（DeepSeek）-可选

**适用**：模型中立多后端执行者（轮换多个 provider 后端）

|字段 |说明 |示例 |
|------|------|------|
| `DSH_BASE_URL` | API端点 | `https://api.deepseek.com` |
| `DSH_API_KEY` | API密钥 | `sk-...`（从 https://platform.deepseek.com获取） |

**获取密钥**：
1.访问 https://platform.deepseek.com
2.登录/注册账号
3.进入 API Keys页面
4.创建新密钥

###5. opencode -可选

**适用**：限流备路/轻量并发推理

opencode通过 `OPENAI_BASE_URL`和 `OPENAI_API_KEY`配置（复用 OpenAI兼容端点）。

**安装**：
```bash
npm install -g opencode-ai
```

**启动优化**（跳过在线拉取）：
```bash
export OPENCODE_DISABLE_MODELS_FETCH=1
opencode run --format json
```

---

## Vision-Analyze图像分析配置

vision_analyze 工具使用 Qwen 的视觉语言模型（VL）进行图像分析。

###配置步骤

1. **获取 Qwen API密钥**（见上方"Qwen"部分）

2. **配置环境变量**：
```bash
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

3. **使用方式**：
在 Claude会话中调用：
```
/vision_analyze分析这张图片的内容
```

或通过 MCP工具调用 `vision_analyze`。

###宿主自读图模式

对于复杂多步推理，推荐：
1.宿主（当前会话 Agent）先读取图片
2.通过 resume传递给 Qwen worker
3. Qwen返回分析结果

这比裸 API调用更灵活，支持上下文恢复。

---

##配置验证

###1.检查.env文件是否存在

```bash
# Linux/macOS
cat ~/.agents/.env

# Windows
type %USERPROFILE%\.agents\.env
```

###2.探测 worker CLI

```bash
node scripts/probe-cli.mjs
```

输出示例：
```
[✔已装] claude — Anthropic Claude Code官方 CLI
[✔已装] codex — OpenAI Codex CLI
[✖缺失] qwen — Qwen推理 worker
     参考位：<QWEN_ENDPOINT_PLACEHOLDER>
     引导：qwen是端点而非独立 CLI...

缺1个 worker CLI（可选安装）。
```

###3.测试 API连接

```bash
# 测试 Anthropic连接
curl -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello"}]}' \
     "$ANTHROPIC_BASE_URL/v1/messages"
```

---

##安全提示

1. **不要提交.env到版本控制**
   ```bash
   #在.gitignore中添加
   .agents/.env
   ```

2. **定期轮换密钥**：建议每90天更换一次 API密钥

3. **限制密钥权限**：在 provider控制台设置密钥的使用范围和配额

4. **不要硬编码在代码中**：所有密钥只通过环境变量传递

---

##故障排查

###问题：提示 "ANTHROPIC_AUTH_TOKEN not found"

**解决**：
1.确认 `~/.agents/.env`文件存在
2.确认文件中包含 `ANTHROPIC_AUTH_TOKEN=sk-ant-...`
3.重启 bridge服务以重新加载环境变量

###问题：429 Too Many Requests

**解决**：
1. bridge会自动切换 model重试（按 fallback 模型池轮换）
2.等待几十秒后重试
3.考虑升级 API配额

###问题：qwen worker无法连接

**解决**：
1.确认 `QWEN_BASE_URL`配置正确
2.确认 `QWEN_API_KEY`有效
3.检查网络连接（可能需要配置代理）

---

##示例配置文件

完整示例见 [`agents-config-example/.env.example`](agents-config-example/.env.example)

```bash
#复制示例并编辑
cp agents-config-example/.env.example ~/.agents/.env
#然后编辑 ~/.agents/.env填入真实密钥
```
