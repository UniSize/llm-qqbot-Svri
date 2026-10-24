# LLM QQ 机器人

把大模型接入 QQ 的对话机器人：私聊直接对话，群聊中 `@机器人` 或直接称呼机器人名字即可唤起。当前版本 **v0.2.0**。

只支持 **OneBot 11（QQ）** 一种接入方式，通过 NapCat / LLOneBot / go-cqhttp 接入。Node.js ESM 实现，**零运行时依赖**（仅使用 `node:` 内置模块）。

| `WECHAT_PUPPET` | 平台 | 收发能力 | 原理 |
| --- | --- | --- | --- |
| **`onebot`（唯一支持）** | **QQ** | **收发均可用** | OneBot 11 协议（HTTP + WebSocket），收发均为结构化数据 |

选择 OneBot 的原因：QQ 生态已有既定的机器人协议标准，NapCat / LLOneBot / go-cqhttp 把 QQ 包装成 HTTP + WebSocket 接口，收发消息就是普通 JSON，不需要点击坐标、抢占前台、操作剪贴板或依赖 OCR。早期尝试过的两条微信路线（4.x 客户端 UI 自动化、wechaty）均已移除，仓库中不再包含相关代码。

---

## 功能特性

- **接入方式单一明确**：OneBot 11，发送走 HTTP（`send_private_msg` / `send_group_msg`），接收走正向 WebSocket，不绑定任何具体实现。
- **多人格**：`personas/*.json` 一个文件一个人格；某个聊天首次对话时先收到人格菜单，选定后记住；每个人格使用独立上下文。
- **会话隔离**：私聊独立；群聊默认每人独立，可用 `GROUP_CONTEXT=shared` 改为全群共享；按轮数与 token 双层裁剪，空闲超时后清理，可选落盘。
- **群聊触发可控**：`mention-or-name`（默认）/ `name` / `mention` / `all` 四种取值；支持群名白名单。私聊不受此项影响。
- **长回复自动分片**：依次在段落、换行、句末标点、空格处寻找断点，切成多条并附加 `(1/3)` 形式的序号。
- **打断机制**：同一会话连续发消息时中断上一轮请求，只回答最新一条。
- **限流**：按「聊天」计数的滑动窗口，超限时回复提示；计数不含人格维度，切换人格不能绕过。
- **连接自愈**：事件通道断开后按 1s 起、上限 30s 的指数退避重连；另有周期性健康探测，用于区分「仅事件通道断开」与「NapCat 整体掉线」，后者恢复后自动接上，无需重启。
- **@ 识别名单自动注册**：桥接启动时用 `get_login_info` 取回账号的真实昵称与 QQ 号并入识别名单，修改 QQ 昵称后无需改配置。
- **控制台（WebUI）**：独立进程，仅监听 `127.0.0.1`，token 鉴权；可查看状态、增删改人格、按人格试聊、查看日志、查看用量与余额、把运行参数写回 `.env`、触发一键启动与重载。
- **用量与余额**：统计请求数、输入/输出 tokens、缓存命中率，并按官方定价估算花费；账户余额直连 `/user/balance`。
- **零运行时依赖**：仅使用 `node:` 内置模块；Node 22 及以上直接使用内置 WebSocket。
- **离线自测**：`npm test` 含 63 项用例，使用本地 mock DeepSeek 与 mock OneBot 跑通全链路，不需要真实 API Key 与外网。

---

## 快速开始

### 前置条件

| 项目 | 要求 |
| --- | --- |
| Node.js | 18.17 及以上；建议 22 及以上（内置 WebSocket，无需额外依赖） |
| OneBot 实现 | NapCat（推荐，https://napneko.github.io/）、LLOneBot、go-cqhttp（已停止维护） |
| QQ 账号 | 建议使用备用账号，风险见「风险与合规提示」 |
| DeepSeek | API Key，申请地址 https://platform.deepseek.com/api_keys |

OneBot 实现需自行安装并登录，并在其配置中**同时开启 HTTP 服务与正向 WebSocket**，记下地址与 `access_token`。

### 安装

```bash
git clone <仓库地址>
cd llm-qqbot-Svri
cp .env.example .env
```

无运行时依赖，`npm install` 可跳过。若 Node 低于 22 且当前环境没有内置 WebSocket，需自行安装 `ws`（`npm i ws`）。

### 配置

在 `.env` 中至少填写 DeepSeek 与 OneBot 两组参数：

```env
WECHAT_PUPPET=onebot
ONEBOT_HTTP_URL=http://127.0.0.1:3000
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=            # 框架配置了 token 时必须一致
BOT_NAME=小深                    # 群聊 @ 与名字触发使用的昵称
DEEPSEEK_API_KEY=sk-xxxx
```

其余参数见「配置说明」，完整默认值见 [`config/default.json`](config/default.json)。

### 运行

```bash
npm start
```

启动顺序：加载配置 → 校验必填项 → 调用 `get_login_info` 验证连通（失败会指出连不上的具体地址）→ 建立事件通道 → 启动健康探测。日志会打印 `@ 识别名单` 与当前生效的群聊触发规则。

没有 QQ 框架时可先验证模型链路，全程离线、不消耗额度：

```bash
npm run mock                     # 终端 1：本地 mock DeepSeek（默认 http://127.0.0.1:8788）
npm start -- --mock --console    # 终端 2：终端对话模式，直接与模型对话
```

含桥接与分片回复的完整链路由 `npm test` 覆盖：它同时启动 mock DeepSeek 与 mock OneBot，不需要真实 API Key 与外网。`npm run mock:onebot` 可单独启动 mock OneBot 服务（默认端口 5700，`ONEBOT_TOKEN` 可设置 token），其 WebSocket 服务端是零依赖的 RFC6455 实现。

### 在聊天中的用法

| 场景 | 行为 |
| --- | --- |
| 私聊 | 直接发消息即回复，**不需要提及** |
| 群聊（默认 `GROUP_TRIGGER=mention-or-name`） | `@机器人` 或消息中出现机器人名字/别名即回复，例如 `小深在吗`、`@鸽戏孤影 你好` |
| 群聊中完全未提及机器人 | 忽略，不参与无关对话 |
| 群聊（`GROUP_TRIGGER=all`） | 每条消息都回复 |
| `/reset`、`/clear`、`/清空`、`重置` | 清空当前会话上下文 |
| `/help`、`/帮助` | 使用说明 |
| `/人格`、`/人格 <序号或名字>` | 查看或切换人格，见「人格系统」 |
| 连续发多条 | 中断上一轮请求，只回答最新一条 |
| 回复过长 | 按段落与标点切成多条，附加 `(1/3)` 编号 |
| 上下文隔离 | 私聊独立；群聊默认每人独立，`GROUP_CONTEXT=shared` 时全群共享 |

### 命令行参数

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动机器人（接入方式由 `WECHAT_PUPPET` 决定） |
| `npm run ui` | 启动控制台（WebUI） |
| `npm test` | 离线自测，共 63 项（mock DeepSeek + mock OneBot，不需要 API Key 与外网） |
| `npm run mock` | 启动本地 mock DeepSeek 服务 |
| `npm run mock:onebot` | 启动本地 mock OneBot 服务（HTTP + WebSocket） |
| `npm start -- --console` | 终端对话模式，不连 QQ |
| `npm start -- --check` | 只检查 DeepSeek 连通性 |
| `npm start -- --dry-run` | 打印配置摘要后退出 |
| `npm start -- --mock` | 指向本地 mock DeepSeek（`http://127.0.0.1:8788`） |
| `npm start -- --config <文件>` | 使用指定的配置文件 |

### 部署辅助脚本

本仓库内提供：

| 脚本 | 作用 |
| --- | --- |
| `reload.ps1` / `reload.cmd` | 重载：停止当前机器人 → 重新读取 `.env` 与 `personas/` → 启动 → 等待事件通道连上 → 汇总结果。不需要管理员权限 |
| `webui.cmd` | 启动控制台 |

一键启动脚本与看门狗位于部署目录，不在本仓库内：

- `start-bot.ps1`：自检（Node / 项目 / `.env` / API Key）→ 确保 QQ 与 NapCat 在运行 → 必要时执行注入 → 验证 OneBot 接口 → 启动机器人 → 汇总结果并发送系统通知。控制台的「一键启动整套」按 `LAUNCHER_PATH`（缺省为项目同级的 `start-bot.ps1`）调用它。
- `watchdog.ps1`：守护进程。机器人进程退出或 NapCat 恢复后自动拉起机器人；重新注入 NapCat 需要管理员权限，看门狗本身不提权，长时间中断时只发出提示。

---

## 配置说明

优先级：`config/default.json` → `--config` 指定的文件 → **环境变量（最高）**。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空 | **必填**，[申请地址](https://platform.deepseek.com/api_keys) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 可换 `deepseek-reasoner` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 兼容自建 / 中转网关 |
| `DEEPSEEK_TEMPERATURE` | `1` | 采样温度 |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | 单次请求超时（毫秒） |
| `MAX_TOKENS` | `1024` | 单次回复的最大 token 数 |
| `BOT_NAME` | `小深` | 群聊 `@` 与名字触发使用的昵称；也用于显示 |
| `SYSTEM_PROMPT` | 见默认配置 | 单人格模式下使用的人设正文 |
| `WECHAT_PUPPET` | `onebot` | 接入方式，目前只支持 `onebot`（QQ） |
| `GROUP_TRIGGER` | `mention-or-name` | 群聊触发方式，见下表；**私聊永远回复，不受此项影响** |
| `BOT_ALIASES` | 空 | 额外称呼，逗号分隔；出现这些词同样算「被提到」 |
| `GROUP_WHITELIST` | 空 | 只回复这些群（逗号分隔群名）；留空表示所有群 |
| `GROUP_CONTEXT` | `per-user` | 群聊上下文粒度：`per-user` 每人独立，`shared` 全群共享 |
| `MAX_HISTORY_TURNS` | `8` | 每个会话保留多少轮往返 |
| `MAX_HISTORY_TOKENS` | `0` | 单会话历史 token 上限，`0` = 只按轮数裁剪 |
| `RATE_LIMIT_PER_MINUTE` | `10` | 每用户每分钟提问上限，`0` = 不限 |
| `STREAM_MIN_DELTA` | `60` | 流式输出时，内容累计增长到该字符数才推送一次中间态 |
| `MAX_REPLY_CHARS` | `1200` | 单条消息字数上限，超出自动分片 |
| `PERSONA_DIR` | `./personas` | 人格目录 |
| `PERSONA` | 空 | 指定默认人格 id；配置后跳过首次选择菜单 |
| `PERSIST_SESSIONS` | `false` | 会话、人格选择与用量落盘到 `data/`（`sessions.json` / `personas.json` / `usage.json`） |
| `SESSION_TTL_MINUTES` | `120` | 会话空闲多久后清理 |
| `DATA_DIR` | `./data` | 数据目录 |
| `LOG_DIR` | `./logs` | 日志目录 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `ONEBOT_HTTP_URL` | `http://127.0.0.1:3000` | OneBot HTTP 服务地址（发送消息） |
| `ONEBOT_WS_URL` | `ws://127.0.0.1:3001` | OneBot 正向 WebSocket 地址（接收事件） |
| `ONEBOT_ACCESS_TOKEN` | 空 | 框架配置了 token 时必须与其一致 |
| `WEBUI_PORT` | `6180` | 控制台监听端口 |
| `WEBUI_TOKEN` | 空 | 控制台访问令牌；留空则自动生成并写入 `data/webui-token.txt` |

### 群聊触发方式 `GROUP_TRIGGER`

| 取值 | 行为 | 适用场景 |
| --- | --- | --- |
| `mention-or-name`（默认） | `@机器人` **或**消息中出现机器人名字/别名即回复 | 被叫到就答，不必每次都 `@` |
| `name` | 同上（`@` 同样触发） | 同上 |
| `mention` | 必须 `@` 才回复 | 群里人多的场景，避免插入无关对话 |
| `all` | 群里每条消息都回复 | 小群、专属群，或需要回复所有消息 |

### `@` 识别名单

判定依据是「`BOT_NAME` + `BOT_ALIASES` + 当前人格的 `name` 与 `aliases` + 登录后取回的真实昵称和 QQ 号」。桥接启动时通过 `get_login_info` 自动注册最后一项，因此修改 QQ 昵称后不需要改配置：

```
@ 识别名单：小深, 鸽戏孤影, 123456789
```

`@` 消息段中携带的是账号真实的昵称与 QQ 号，并非 `BOT_NAME`。识别名单同时包含两者，因此 `BOT_NAME` 与真实昵称不一致时（例如 `BOT_NAME` 为「小深」、QQ 昵称为「鸽戏孤影」），两个名字都能触发；启动日志会打印实际生效的名单，可直接核对。

靠名字触发时，开头的称呼会被自动剥离，不会污染提问：

```
用户: 小深帮我算 1+1        →  发给模型: 帮我算 1+1
用户: 鸽戏孤影在吗          →  发给模型: 在吗
用户: @鸽戏孤影 你好        →  发给模型: 你好
```

在本机验证触发规则（不连 QQ、不产生 API 费用）：

```bash
node tools/verify-trigger.mjs
```

---

## 更换 AI 服务商

客户端使用 **OpenAI 兼容的 `/chat/completions` 协议**，因此只要服务商提供兼容接口，
更换时**不需要改任何代码**，只改 `.env`：

```env
AI_PROVIDER=dashscope          # 选服务商（留空为 deepseek）
AI_API_KEY=你的密钥
# AI_BASE_URL=...              # 留空则用预设
# AI_MODEL=...                 # 留空则用预设
```

| `AI_PROVIDER` | 服务商 | 预设接口地址 | 预设模型 | 余额查询 |
| --- | --- | --- | --- | --- |
| `deepseek`（默认） | DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | ✅ |
| `openai` | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | ❌ |
| `dashscope` | 阿里云通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | ❌ |
| `moonshot` | 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | ❌ |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | ❌ |
| `siliconflow` | 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` | ❌ |
| `ark` | 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 需填接入点 ID | ❌ |
| `ollama` | 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | ❌ |
| `lmstudio` | 本地 LM Studio | `http://127.0.0.1:1234/v1` | 需填 | ❌ |
| `openai-compatible` | 其它任意兼容服务 | 需填 | 需填 | ❌ |

**不在表里也能用**：选 `openai-compatible`，自己填 `AI_BASE_URL` 与 `AI_MODEL` 即可
（one-api、new-api、vLLM、FastChat 等网关都属于这类）。

注意事项：

- **费用估算**只对内置了定价的模型准确；其他服务商显示为 0，控制台会标注"未内置定价"。
- **账户余额**只有 DeepSeek 提供查询接口，其他服务商会如实显示"未提供"，不会显示成 0。
- **上下文缓存的计价**（缓存命中单价远低于未命中）是 DeepSeek 的特性；多数服务商不报告缓存命中，此时命中率显示为空。
- 换服务商后**历史会话仍然有效**（上下文存在本地），但模型的风格与能力会变，建议重载机器人后开新会话。

## 更换 OneBot 实现

本项目只依赖 **OneBot 11 协议**，不绑定某一个具体实现。NapCat 只是默认推荐，换成
LLOneBot、Lagrange.OneBot、go-cqhttp、Shiro 等任何兼容实现都能直接跑，**无需改代码**：

```env
ONEBOT_HTTP_URL=http://127.0.0.1:3000    # 改成你的实现暴露的 HTTP 地址
ONEBOT_WS_URL=ws://127.0.0.1:3001        # 改成你的实现暴露的 WebSocket 地址
ONEBOT_ACCESS_TOKEN=                     # 有就填，没有留空
```

更换步骤：

1. 按你所选实现的文档启动它，并开启 OneBot 11 的 **HTTP 接口** 与 **正向 WebSocket**。
2. 记下它监听的端口，填到 `.env` 的两个 URL 里。
3. 该实现若要求鉴权，把令牌填到 `ONEBOT_ACCESS_TOKEN`。
4. 用 `npm start -- --check` 自检，全部通过即可运行。

> 项目只用到四个 OneBot 动作：`get_login_info`、`get_version_info`、`send_group_msg`、`send_private_msg`。
> 任何实现了这四个动作与消息事件上报的框架都可接入。
> 但**部署辅助脚本（一键启动、看门狗、注入）是 NapCat 专用的**；换实现后这些脚本不适用，需要自行托管进程。

## 人格系统

人格以「一个 JSON 一个文件」的形式放在 `personas/` 目录，机器人启动时读取。文件名以 `_` 开头的文件是模板，不会进入选择菜单。

工作方式：

- **首次选择**：某个聊天（私聊或群）第一次收到消息且尚未选定人格时，机器人发送带序号的人格列表；回复序号或名字即可选定，之后不再询问。若第一条消息本身是一个问题，选定人格后会直接回答该问题。
- **切换**：`/人格` 查看列表与当前人格，`/人格 <序号>`、`/人格 <名字>`、`/人格 <id>` 切换；也接受 `/persona`、`/切换人格`。匹配支持精确的 id / 名字 / 别名，以及唯一的部分匹配；多个候选时返回候选列表，不做猜测。
- **独立上下文**：会话 key 含人格指纹，切换人格即切换到另一段上下文；切回原人格可以继续原来的对话。`/reset` 只清空当前人格的上下文。
- **单人格模式**：`personas/` 中没有可用人格文件时，改用 `.env` 的 `SYSTEM_PROMPT`，不弹选择菜单，行为与旧版本一致。
- **跳过菜单**：设置 `PERSONA=<id>` 可直接使用指定人格。
- **`@` 识别**：当前人格的 `name` 与 `aliases` 会自动并入 `@` 识别名单，选定人格后按人格名呼叫也能触发。

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 否 | 唯一标识，用于 `/人格 <id>`；留空取文件名 |
| `name` | 是 | 显示名，也是 `/人格 <名字>` 的匹配依据，并自动并入 `@` 识别名单 |
| `aliases` | 否 | 额外可匹配的名字数组，同样并入 `@` 识别名单 |
| `description` | 否 | 菜单中显示的一行简介 |
| `systemPrompt` | **是** | 人格正文 |
| `greeting` | 否 | 选中该人格时先回复的一句话 |

`personas/` 目录内含 `_template.json` 模板与两份示例，写法与调优建议见 [`personas/README.md`](personas/README.md)。

控制台（WebUI）的「人格」页签提供等价的可视化操作：新建、编辑、删除，以及按「作品来源 + 角色名」由模型生成草稿再人工修改。

---

## 控制台

```bash
npm run ui                  # 启动并自动打开浏览器
npm run ui -- --port 6180   # 指定端口
npm run ui -- --no-open      # 不自动打开浏览器
```

控制台是**独立进程**，与机器人互不影响：机器人重载或重启时控制台不会中断，关掉控制台也不影响机器人。

访问控制：

- 只监听 `127.0.0.1`，局域网内其它机器无法访问。
- 所有请求都需要 token，地址形如 `http://127.0.0.1:6180/?token=…`，启动日志会直接打印带 token 的完整地址。
- token 来源：`.env` 的 `WEBUI_TOKEN`；留空则自动生成并保存到 `data/webui-token.txt`。
- 端口已被本控制台占用时，再次启动不会报错退出，而是直接打开已在运行的那个控制台。

页面构成：

| 页签 | 内容 |
| --- | --- |
| 状态 | 机器人进程、NapCat / QQ 端口、登录状态、当前配置；「一键启动整套」「重载机器人」；运行参数写入 `.env`；用量与余额 |
| 人格 | 人格列表与编辑器、新建 / 删除、按「作品来源 + 角色名称」生成草稿 |
| 测试对话 | 按人格试聊，使用与机器人相同的 DeepSeek 配置，因此效果即真实效果（不受群聊触发规则、限流与记忆轮数影响） |
| 日志 | `logs/bot-run.log`、`logs/launcher.log`、`logs/watchdog.log` 的尾部内容 |

运行参数写回：目前只开放 `MAX_HISTORY_TURNS`、`MAX_HISTORY_TOKENS`、`RATE_LIMIT_PER_MINUTE` 三项。写入时按 key 替换对应行，保留原有注释与顺序，写入前自动备份为 `.env.bak`；保存后需要点「重载机器人」才生效。

用量与余额有三个来源：

| 来源 | 数据 |
| --- | --- |
| 机器人进程 | 读取 `data/usage.json`，需要 `PERSIST_SESSIONS=true` |
| 控制台试聊 | 当前进程内存中的统计 |
| 账户余额 | 调用 DeepSeek 的 `/user/balance`，结果缓存 60 秒 |

---

## 常见问题 / 排错

### 启动与配置

| 症状 | 原因与处理 |
| --- | --- |
| 启动后立即退出，提示缺少 `DEEPSEEK_API_KEY` | 配置校验未通过；`--dry-run` 与 `--console` 不受此限制，可用于先确认配置结构 |
| 提示 `DEEPSEEK_API_KEY 看起来不像 sk- 开头的密钥` | 校验规则要求密钥以 `sk-` 开头 |
| 提示 `已有机器人在运行（单实例端口 39999 被占用）` | 单实例锁生效：另一个机器人进程仍持有锁端口。确认并结束后重试。锁以监听端口实现，进程退出即释放，不会残留 |
| 提示 `连不上 OneBot 的 HTTP 服务（http://…）` | NapCat / LLOneBot 未启动，或 `ONEBOT_HTTP_URL` 与其 HTTP 服务地址不一致 |
| 重载报告「端口 3000/3001 未监听」 | NapCat 未运行。重新注入需要管理员权限，需通过一键启动脚本执行 |

### 群聊与触发

| 症状 | 原因与处理 |
| --- | --- |
| 群里 `@` 了但没有回复 | 日志会记录忽略原因，如 `忽略消息(no-mention)`、`忽略消息(no-mention-or-name)`、`忽略消息(group-not-whitelisted)`。按原因检查 `GROUP_TRIGGER`、`GROUP_WHITELIST` 与 `@` 识别名单 |
| 用昵称呼叫没有反应 | 核对启动日志中的 `@ 识别名单`；需要额外称呼时写入 `BOT_ALIASES` |
| 首次对话一直停在人格菜单 | 该聊天尚未选定人格，回复序号或名字即可；此阶段 `@` 规则不生效，以免选择命令被过滤 |
| 想先确认规则再连 QQ | `node tools/verify-trigger.mjs`，不连 QQ、不产生 API 费用 |

### 运行期

| 症状 | 原因与处理 |
| --- | --- |
| 回复「API Key 无效或已过期」 | 上游返回 401，检查密钥与 `DEEPSEEK_BASE_URL` |
| 回复「账户余额不足」 | 上游返回 402，需充值或更换密钥 |
| 回复「请求太频繁」 | 上游返回 429，稍后重试或降低并发 |
| 回复「网络有点慢」 | 请求超时；检查网络与代理，或调大 `DEEPSEEK_TIMEOUT_MS` |
| 事件通道断开 | 自动按指数退避重连（1s 起，上限 30s）。NapCat 整体掉线时健康探测会告警，恢复后自动接上，不需要重启机器人 |
| 改了 `.env` 或 `personas/*.json` 不生效 | 两者只在进程启动时读取一次，需重载：双击 `reload.cmd`，或在控制台点「重载机器人」。`PERSIST_SESSIONS=true` 时会话落盘在 `data/sessions.json`，重载不丢上下文 |
| 控制台提示端口被占用 | 换端口：`npm run ui -- --port 6181` |
| 控制台返回 401 | 访问地址缺少 `?token=…`；令牌见启动日志或 `.env` 的 `WEBUI_TOKEN` |
| 一键启动或重载没有反应 | 需要能创建子进程的普通终端；受限环境会因禁止创建子进程而失败 |
| `.ps1` 报大量 `Unexpected token` | 含中文的 `.ps1` 必须保存为 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 会按本地代码页解码；`reload.ps1` 与 `npm test` 均守护这条约束 |

### NapCat 接入注意点

1. **`package.json` 不应手工修改。** QQ 有完整性校验，修改 `QQ\versions\<版本>\resources\app\package.json` 会提示「文件已损坏，请重新安装QQ」。注入应由 NapCat 的 boot hook 完成。
2. **hook 在运行时以 `loadNapCat.js` 作为入口注入，路径相对 QQ 的 app 目录解析**，`NAPCAT_LOAD_PATH` 环境变量无法传入 hook。Windows 上需把 `loadNapCat.js` 放到 `QQ\versions\<版本>\resources\app\`，并在其中写死 napcat.mjs 的绝对路径：

   ```js
   const { pathToFileURL } = require('url');
   const mainPath = process.env.NAPCAT_MAIN_PATH || 'C:/绝对路径/napcat/shell/napcat.mjs';
   (async () => { await import(pathToFileURL(mainPath).href); })();
   ```

3. **注入需要管理员权限，且需先结束所有 QQ 进程。** QQ 单实例互斥机制会把新进程转交给已有实例，导致环境变量丢失。调用方式为以管理员身份运行 `NapCatWinBootMain.exe <QQ.exe> <NapCatWinBootHook.dll>`。部署目录下的 `napcat/inject-napcat.ps1` 封装了这套流程（不在本仓库内）。

---

## 项目结构

```
bin/
  cli.js                    启动入口（机器人 / --check / --console / --dry-run）
  webui.js                  控制台入口（独立进程）
src/
  index.js                  包入口
  plugin.js                 插件注册器：createPlugin / attach / handleMessage / status / stop
  bridges.js                桥接工厂（只支持 OneBot）
  onebot-bridge.js          OneBot 11 桥接：HTTP 调用、WebSocket 事件、健康探测、断线重连
  engine.js                 对话引擎：准入 → 人格 → 限流 → 上下文 → 调模型 → 分片回复
  llm.js               LLM 客户端（OpenAI 兼容）：SSE 流式、指数退避重试、取消、用量与花费估算
  personas.js               读取人格文件、匹配人格、渲染菜单
  persona-store.js          人格文件增删改查（供控制台调用）
  persona-state.js          每个聊天选中的人格（可选落盘）
  session.js                多轮上下文（按会话隔离 + TTL + 轮数/token 裁剪 + 可选落盘）
  ratelimit.js              滑动窗口限流 + 同会话串行锁
  text.js                   @提及剥离、长文本分片、token 粗估
  usage-tracker.js          用量统计与落盘（data/usage.json）
  config.js / env.js        配置加载与校验（打印时脱敏）
  env-write.js              按键改写 .env（保留注释与顺序，写入前备份）
  logger.js                 控制台 + 文件日志
  webui/
    server.js               控制台 HTTP 服务（仅监听 127.0.0.1，token 鉴权）
    handlers.js             接口实现（状态 / 人格 / 试聊 / 用量 / 参数 / 重载 / 日志）
    status.js               进程、端口与登录状态采集
webui/
  index.html                控制台页面
personas/                   人格定义（_ 前缀为模板，不进入选择菜单）
config/default.json         默认配置
test/                       离线自测与 mock 服务（DeepSeek / OneBot / 零依赖 WebSocket）
tools/                      本机校验脚本（触发规则校验、人格流程演示、真实接口人格验证）
reload.ps1 / reload.cmd     重载脚本
webui.cmd                   控制台启动脚本
```

### 当成库使用

引擎层与接入层解耦，可以作为库嵌入其它宿主：

```js
import { bootstrap } from './src/index.js';

// 直接启动桥接（当前为 OneBot 11 / QQ）
const plugin = await bootstrap({ startWechat: true });
console.log(plugin.status());

// 或挂到自己的消息总线上
const p = await bootstrap();
p.attach({
  on: (evt, handler) => bus.on(evt, handler),
  sendMessage: async (msg, text) => ws.send(text),
});

// 或完全手动处理
await p.handleMessage(
  { text: '@小深 你好', talkerId: 'u1', talkerName: '小王', roomId: 'r1', roomTopic: '测试群' },
  { onReply: (t) => console.log(t) },
);
```

---

## 风险与合规提示

NapCat / LLOneBot 这类工具属于**第三方协议实现**，不是腾讯官方接口。用它们登录个人 QQ 号存在**被限权、冻结甚至封号**的风险。使用前应确认：

- 只使用备用账号测试，不使用主账号。
- 保持限流开启，`RATE_LIMIT_PER_MINUTE` 不应设得过高，也不应设为 `0`。
- 不用于群发、营销等骚扰行为。
- 接受账号可能被封停这一前提。

需要**稳定、合规、可商用**的场景应使用 **QQ 官方机器人开放平台**（https://bot.q.qq.com/）。它是官方 API，无封号风险，但只能在官方支持的群 / 频道内使用，不能私聊任意好友。本插件的引擎层是通用的，接入官方 API 只需再写一个桥接（约 100 行）。

其它约定：

- `.env` 已加入 `.gitignore`；日志与配置摘要中的 API Key 均脱敏显示，控制台接口从不返回明文密钥。
- 模型输出会原样转发给聊天对象，建议在 `SYSTEM_PROMPT` 或人格正文中加入必要的安全约束。
- 人格正文每次请求都会发送给 DeepSeek，不应写入真实姓名、住址、密码等隐私信息。
- 控制台只监听回环地址且要求 token，但 token 等同访问凭证，不应写入公开仓库或分享截图。

---

## License

MIT
