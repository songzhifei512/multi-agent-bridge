# multi-agent-bridge公网分发包 v1.0.0安装指南

##快速开始（3步）

```bash
#1.解压到最终目录（移动会导致注册失效）
#2.运行安装向导（Windows）
launchers\install-win.bat
#或（Linux/macOS）
bash launchers/install.sh

#3.校验并启动
node scripts/probe-cli.mjs #确认已装 worker
node bridge/mcp/shared-context-server.mjs #启动桥服务
```

---

##目录结构

```
multi-agent-bridge-public-dist/
├─ bridge/mcp/ #核心 MCP Server（零三方依赖纯 JS）
│ ├─ shared-context-server.mjs # MCP服务入口（启动它）
│ ├─ agents-registry.mjs # worker注册/密钥运行时读取
│ ├─ run-driver.mjs # worker派发
│ ├─ state-store.mjs #队列/任务/状态
│ ├─ retry-safety.mjs #429/限流指数退避
│ ├─ vec_memory.mjs #向量记忆（可选，懒加载）
│ ├─ sediment.mjs #经验沉淀脚本（可选）
│ └─ bridge-web-panel.mjs #可视化面板（可选）
├─ scripts/
│ ├─ probe-cli.mjs #探测已装 worker CLI
│ └─ probe-vector.mjs #探测可选向量层是否就绪
├─ config/ #配置模板 + env模板
│ ├─ claude-mcp-config.json.tmpl
│ ├─ codex-mcp-config.toml.tmpl
│ └─ env.tmpl #密钥/端点占位（见 ENV_SETUP.md）
├─ launchers/
│ ├─ install-win.bat / install.sh #安装向导
│ └─ start-win.bat / start.sh #启动桥服务/面板
├─ assets-optional/ #可选向量层
│ ├─ vector-deps.json
│ └─ README.md
├─ public-install/ # 【公网版新增】公网安装指引
│ ├── INSTALL.md #本文件
│ ├── ENV_SETUP.md #环境变量配置指南
│ ├── agents-config-example/ #配置示例
│ │ └── .env.example #环境变量示例模板
│ └── scripts/ #公网安装脚本
│ ├── install-claude-cli.sh
│ ├── install-codex-cli.sh
│ └── install-all-workers.sh
└─ docs/ #文档
```

---

##前置要求

###1. Node.js18+

- Windows:从 https://nodejs.org下载安装器
- Linux: `curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs`
- macOS: `brew install node@18`

###2. Worker CLI（选择性安装）

bridge控制主控不依赖任意单个 worker，可根据需要选择性安装：

| Worker |用途 |安装方式 |
|--------|------|----------|
| **claude** |主控/队长（推理/架构/审查） | `npm install -g @anthropic-ai/claude-code` |
| **codex** |执行/批量代码生成 | `npm install -g @openai/codex` |
| **opencode** |限流备路/轻量并发 | `npm install -g opencode-ai` |
| **qwen** |写文档/PPT +图像分析 |需配置 `QWEN_BASE_URL`（见 ENV_SETUP.md） |
| **dsh** |模型中立多后端执行者 | `npm install -g @deepseek-ai/dsh` |

**一键安装所有 worker（可选）：**
```bash
# Linux/macOS
bash public-install/scripts/install-all-workers.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File public-install\scripts\install-all-workers.ps1
```

---

##安装步骤详解

###步骤1：解压到最终目录

**重要**：必须先解压到最终使用目录，再运行安装脚本。移动已安装的分发包会导致 MCP注册失效。

###步骤2：运行安装向导

安装向导会：
1.检测 Node.js是否已安装
2.探测本机已安装的 worker CLI
3.交互式配置 API端点和密钥
4.部署向量模型（可选）
5.提示如何注册到各 CLI的 MCP配置

**Windows:**
```cmd
launchers\install-win.bat
```

**Linux/macOS:**
```bash
bash launchers/install.sh
```

###步骤3：校验并启动

```bash
#校验已安装的 worker
node scripts/probe-cli.mjs

#启动桥服务
node bridge/mcp/shared-context-server.mjs

#可选：启动可视化面板
node bridge/mcp/bridge-web-panel.mjs
```

---

##配置 API密钥和端点

详见 [`public-install/ENV_SETUP.md`](public-install/ENV_SETUP.md)

**快速示例**（`.env`文件）：

```bash
# Anthropic (Claude) -必填（主控）
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# OpenAI (Codex) -可选
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Qwen -可选（文档/PPT/图像分析）
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

#模型配置
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-20250514
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-20250514
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-20250514

#主控选择
BRIDGE_CONTROLLER=claude
```

---

##注册到 CLI的 MCP配置

### Claude Code

编辑 `~/.claude.json`，添加：

```json
{
  "mcpServers": {
    "shared-context": {
      "command": "node",
      "args": ["<BRIDGE_DIR>/mcp/shared-context-server.mjs"]
    }
  }
}
```

完整示例见 `config/claude-mcp-config.json.tmpl`。

### Codex CLI

编辑 `~/.codex/config.toml`，追加：

```toml
[mcp.shared-context]
command = "node"
args = ["<BRIDGE_DIR>/mcp/shared-context-server.mjs"]
```

完整示例见 `config/codex-mcp-config.toml.tmpl`。

---

##向量记忆层（可选）

默认**纯文本运行**，核心功能完整。需要语义检索时：

```bash
#探测向量层状态
node scripts/probe-vector.mjs

#安装依赖
cd assets-optional
npm install onnxruntime-node
npm install sqlite-vec
```

包内已内置 MiniLM多语言向量模型（约120MB），安装向导会自动部署到用户目录。

---

##异常处理

详见 [`docs/cookbook/exception-handling.md`](docs/cookbook/exception-handling.md)

常见问题：
- **429限流**：自动切换 model重试，或等待几十秒
- **node未找到**：先安装 Node.js18+
- **worker CLI缺失**：可选安装，不影响核心功能
- **向量层未就绪**：纯文本兜底，功能完整

---

##版本说明

- **v1.0.0**：通用分发包（核心零依赖、可选向量层、选择性 worker注册）

---

##更多资源

-环境变量配置详解：[`public-install/ENV_SETUP.md`](public-install/ENV_SETUP.md)
-异常处理手册：[`docs/cookbook/exception-handling.md`](docs/cookbook/exception-handling.md)
