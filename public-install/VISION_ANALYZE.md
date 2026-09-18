# Vision-Analyze图像分析配置指南

本文档说明如何配置和使用 vision_analyze 图像分析功能。

##概述

vision_analyze 工具使用 Qwen（通义千问）的视觉语言模型（VL）进行图像分析。

**核心特点**：
-使用 Qwen VL模型进行图像内容识别
-支持复杂多步推理（通过宿主 Agent中转）
-比裸 API调用更灵活，支持上下文恢复

---

##配置步骤

###步骤1：获取 Qwen API密钥

1.访问阿里云百炼平台：https://bailian.console.aliyun.com
2.登录/注册阿里云账号
3.进入 "API-KEY管理"页面
4.创建新密钥（复制保存，只显示一次）

###步骤2：配置环境变量

**方式一：编辑.env文件**（推荐）

编辑 `~/.agents/.env`（Windows: `%USERPROFILE%\.agents\.env`），添加：

```bash
# Qwen (通义千问) -图像分析 VL
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**方式二：系统环境变量**

**Linux/macOS**（添加到 `~/.bashrc`或 `~/.zshrc`）：
```bash
export QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export QWEN_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**Windows PowerShell**（添加到 `$PROFILE`）：
```powershell
$env:QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:QWEN_API_KEY = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

###步骤3：验证配置

```bash
#探测 qwen worker状态
node scripts/probe-cli.mjs

#输出应显示：
# [✔已装] qwen — Qwen推理 worker（端点方式：写文档/PPT +图像分析 VL）
```

---

##使用方式

###方式一：在 Claude会话中直接调用

在 Claude Code 会话中通过 MCP 工具调用 `vision_analyze`：

```javascript
vision_analyze({ image_path: "path/to/image.jpg" })   // 或 image_data_url: "data:image/jpeg;base64,..."
```

###方式二：通过 run_qwen工具调用

```javascript
run_qwen({
  prompt: "分析这张图片的内容，包括：1.主要物体2.场景3.文字信息（如有）",
  image: "path/to/image.jpg"
})
```

###方式三：宿主自读图模式（推荐用于复杂任务）

对于复杂多步推理，推荐流程：

1. **宿主（当前会话 Agent）先读取图片**
2. **通过 resume传递给 Qwen worker**
3. **Qwen返回分析结果**

**示例流程**：

```
用户：分析这张架构图

Claude（宿主）:
1.读取图片文件
2.调用 run_qwen({
   prompt: "分析这张架构图的组件和关系",
   resume: "<session_id>"
 })
3. Qwen返回分析结果
4. Claude整合结果并反馈
```

---

##支持的图像格式

|格式 |说明 |
|------|------|
| JPG/JPEG |最常用，推荐 |
| PNG |支持透明通道 |
| WEBP |高压缩比 |
| GIF |仅处理第一帧 |

**大小限制**：单张图片最大10MB

---

##API参考

### Qwen VL模型

|模型 |说明 |推荐用途 |
|------|------|----------|
| qwen-vl-max |最强视觉理解 |复杂图像分析、图表解读 |
| qwen-vl-plus |平衡性能与成本 |日常图像识别 |
| qwen-vl-max-latest |最新版本 |需要最新特性时 |

###请求示例

```bash
curl -X POST "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" \
  -H "Authorization: Bearer $QWEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-vl-max",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "分析这张图片"},
          {"type": "image_url", "image_url": "https://example.com/image.jpg"}
        ]
      }
    ]
  }'
```

---

##故障排查

###问题：提示 "QWEN_BASE_URL not configured"

**解决**：
1.确认 `~/.agents/.env`文件存在
2.确认文件中包含 `QWEN_BASE_URL=...`
3.重启 bridge服务以重新加载环境变量

###问题：429 Too Many Requests

**解决**：
1. Qwen API有速率限制
2.等待几十秒后重试
3.考虑升级 API配额

###问题：图像分析结果为空

**解决**：
1.检查图像格式是否支持
2.确认图像大小不超过限制
3.尝试使用更强的模型（qwen-vl-max）

---

##配置示例

完整示例见 `agents-config-example/.env.example`

```bash
#复制示例并编辑
cp agents-config-example/.env.example ~/.agents/.env
#然后编辑 ~/.agents/.env填入真实密钥
```

---

##更多资源

-阿里云百炼文档：https://help.aliyun.com/product/42154.html
- Qwen VL API文档：https://help.aliyun.com/zh/dashscope/developer-reference/api-details
-异常处理手册：`docs/cookbook/exception-handling.md`
