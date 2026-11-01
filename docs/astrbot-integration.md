# 把 DSH（带人设）接到 AstrBot

目标：让 AstrBot 当消息入口（QQ / Telegram / 飞书…），DSH 当大脑（人设 + 工具 + 会话），AstrBot 的插件生态补上语音收发、多平台、内容审核这些外围能力。

## 一、结论

**不要让 AstrBot 通过 OpenAI 兼容接口调 DSH**，也不要在 DSH 里反向调 AstrBot 的接口。

正确做法：**在 AstrBot 里写一个 Star 插件，用 DSH 官方 Python SDK（`deepseek-harness-sdk`）拉起 `dsh --profile <name>`，走 stdio JSON-RPC 驱动一个会话。**

理由：

1. DSH 已经提供了官方协议层（`@deepseek-ai/dsh-sdk-protocol`），方法是 `initialize` / `session/prompt` / `session/resume` / `session/wait` / `shutdown`，另有三类通知（`session.event`、`session.status`、`subagent.*`）。
2. Python SDK 已在 PyPI：**`deepseek-harness-sdk 0.2.1rc2`**，它就是"起子进程 + 说 JSON-RPC"，不需要我们自己写桥。
3. `dsh` 自带 `sdk` profile 模板（`dsh --dump-default-config --profile sdk` 可见 agent / agent-instructions / subagent / tools），**人设、工具、持久化都由 profile 决定**，正好对上"带人设"这个要求。
4. 走 OpenAI 兼容接口会丢掉 DSH 的会话语义（持久化、工具审批、子 agent），而且需要额外写一个 HTTP 服务把 chat/completions 翻译成 agent 会话——多一层、少一半能力。

## 二、已核实的事实

| 事实 | 证据 |
| --- | --- |
| DSH 有 stdio JSON-RPC 协议与 TS/Python 客户端 | 本机 `@deepseek-ai/dsh-sdk-protocol` README.zh.md；PyPI 有 `deepseek-harness-sdk 0.2.1rc2` |
| `sdk` profile 模板存在且含 agent / agent-instructions / subagent / tools | `dsh --dump-default-config --profile sdk` 实跑 |
| Python SDK 用法：`DeepSeekHarness(provider, model, cwd, dsh_home, profile)` + `harness.run(text, session_id=...)` | 官方文档 `deepseek-harness.github.io/.../guide/python-sdk` |
| 人设可用 `DSH_SYSTEM_PROMPT` 覆盖；会话持久化在 `<dsh_home>/sessions` 的 JSONL | 同上 |
| AstrBot 是 Python 框架，插件叫 Star，装 `pip` 依赖用插件目录下 `requirements.txt` | `docs.astrbot.app/dev/star/plugin-new.html` |
| AstrBot 自带 STT（Whisper/SenseVoice）与 TTS（Edge-TTS / OpenAI TTS / GSVI / Fishaudio） | AstrBot README 提供商表 |
| AstrBot 发语音用 `Record` 组件，`Record(file=path)` / `Record.fromBase64(b64)`，**只接受 wav** | 官方 wiki 与平台适配器文档 |
| 本机已有 QQ 通道插件 `@tencent-connect/dsh-qqbot 0.5.2` | `~/.dsh/profiles/web/package.json` |

## 二·五、实测记录（2026-10-29，本机跑通）

装 `deepseek-harness-sdk 0.2.1rc2`（Python 3.11 venv；**系统自带的 3.9 不行，要求 >=3.10**），用真实 key 跑了四次：

| 测试 | 命令要点 | 结果 |
| --- | --- | --- |
| 基础对话 | `profile="sdk"`，`run("用一句话介绍你自己")` | ✅ `RunResult(final_response='你好！我是 DeepSeek Harness 的编程助手。', finish_reason='completed')` |
| 会话记忆 | 同一 `session_id` 连问两轮 | ✅ 第二轮正确复述"你上一条问的是'你是谁'" |
| 人设注入 | `profile="sdk"` + `DSH_SYSTEM_PROMPT=鲸鱼娘…` | ❌ **不生效**，仍自述为编码助手 |
| 人设注入 | `profile="sdk-minimal"` + 同一个 `DSH_SYSTEM_PROMPT` | ✅ `本鲸是住在主人电脑里的鲸鱼娘，不许随便乱戳哦。` |

**两条关键结论**：

1. **`DSH_SYSTEM_PROMPT` 只对 `sdk-minimal` 生效**。`sdk` profile 的人设来自 `agent-instructions`（profile 配置 / `AGENTS.md`），环境变量被忽略。所以"带人设"要么用 `sdk-minimal` + 环境变量，要么自定义 profile 并把 prompt 写进 agent-instructions。
2. **不同 profile 不能共用同一个 `dsh_home`**：`sdk` 写 `.jsonl.zstd`，`sdk-minimal` 期望 `compression: none`，共用会直接报
   `session artifact … uses .jsonl.zstd, but this backend is configured for compression "none"`。每个 profile 配一个独立 `dsh_home` 即可。

## 三、推荐架构

```
QQ / Telegram / 飞书
        │  文本 / 语音(silk)
        ▼
AstrBot（Python）
  ├─ 平台适配器（aiocqhttp / telegram / lark …）
  ├─ STT：语音 → 文本（内置 Whisper / SenseVoice）
  ├─ Star 插件 astrbot_plugin_dsh_bridge   ← 本方案要写的唯一新代码
  │     └─ deepseek-harness-sdk ──stdio JSON-RPC──▶ dsh --profile astrbot
  │                                                   ├─ agent-instructions（人设）
  │                                                   ├─ 工具（只读白名单）
  │                                                   └─ sessions/*.jsonl（持久化）
  └─ TTS：回复文本 → wav → Record 组件 → 发出语音
```

数据流：`umo`（AstrBot 的 unified_msg_origin，含平台/群/用户）→ 稳定的 DSH `session_id`。同一个人在同一会话里连续说话，命中同一个 DSH 会话，记忆不断。

## 四、落地步骤

### 1. 准备一个专用 profile（约 30 分钟）

```sh
dsh --from-default-profile sdk        # 生成 $DSH_HOME/profiles/sdk
cp -r ~/.dsh/profiles/sdk ~/.dsh/profiles/astrbot
```

在 `astrbot` 里做三件事：

- **人设**：要么复用现有 `dsh-agent-persona/personas.json`（把该插件也挂进这个 profile），要么直接给 SDK 传 `DSH_SYSTEM_PROMPT`。
- **工具白名单**：聊天机器人不该有 `bash` / `edit`。只留 `web_search`、`web_fetch`、`read`、`todo_write` 这类。
- **工作目录**：指向一个空目录，别让它碰到主目录。

### 2. 写 AstrBot 插件（约半天，80–120 行）

```
data/plugins/astrbot_plugin_dsh_bridge/
  metadata.yaml
  requirements.txt        # deepseek-harness-sdk
  main.py
```

`metadata.yaml` 至少要 `name / desc / version / author`，建议加 `astrbot_version: ">=4.16,<5"`。

`main.py` 骨架：

```python
import asyncio, hashlib, json
from pathlib import Path
from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register
from astrbot.api.message_components import Record
from deepseek_harness import DeepSeekHarness

@register("dsh_bridge", "you", "把消息转给 DSH 会话", "0.1.0")
class DshBridge(Star):
    def __init__(self, context: Context, config: dict):
        super().__init__(context)
        self.cfg = config
        self.harness = None
        self.locks: dict[str, asyncio.Lock] = {}
        self.map_path = Path("data/plugin_data/dsh_bridge/sessions.json")

    async def _ensure(self):
        # 懒启动：第一条消息才 spawn，避免 AstrBot 启动时多一个 dsh 进程
        if self.harness is None:
            self.harness = DeepSeekHarness(
                profile="astrbot",
                cwd=self.cfg.get("workspace", "/tmp/dsh-bot-workspace"),
                dsh_home=self.cfg.get("dsh_home"),
                provider=self.cfg.get("provider", "deepseek-official"),
                model=self.cfg.get("model", "deepseek-v4-flash"),
            )
            self.harness.__enter__()
        return self.harness

    def _session_id(self, umo: str) -> str:
        # 稳定映射：同一个群/同一个人 → 同一个 DSH 会话
        return "astrbot-" + hashlib.sha1(umo.encode()).hexdigest()[:12]

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        text = (event.message_str or "").strip()
        if not text:
            return
        umo = event.unified_msg_origin
        lock = self.locks.setdefault(umo, asyncio.Lock())
        async with lock:                      # 同一会话串行，避免回复交错
            harness = await self._ensure()
            # SDK 是同步的，必须丢到线程里，否则阻塞 AstrBot 的事件循环
            result = await asyncio.to_thread(
                harness.run, text, session_id=self._session_id(umo)
            )
            reply = (getattr(result, "text", "") or "").strip()
        if not reply:
            return
        yield event.plain_result(reply)
```

要点：

- **同步 SDK 必须 `asyncio.to_thread`**，否则一个长任务卡死整个 AstrBot。
- **每个 `umo` 一把锁**：DSH 端同一会话是排队的，但 AstrBot 可以并发投递，不串行会出现"半句回复"。
- **会话映射落 `data/plugin_data/`**（AstrBot 明确要求持久化不要放插件目录）。
- 进程崩溃时捕获 `TransportClosedError`，`harness.close()` 后重建。

### 3. 语音（半天）

- 入：AstrBot 配置里打开 `provider_stt_settings`（Whisper 或 SenseVoice）。QQ 语音是 silk，AstrBot/协议端会先转码；插件拿到的 `event.message_str` 已经是文字。
- 出：回答后调 TTS，再作为语音发出去。

```python
tts = await self.context.get_using_tts_provider_async(umo=event.unified_msg_origin)
if tts:
    path = await tts.get_audio(reply)          # 返回音频文件路径
    yield event.chain_result([Record(file=path, url=path)])
else:
    yield event.plain_result(reply)
```

`Record` 只吃 wav，非 wav 要么让 TTS 直接出 wav（Edge-TTS 可指定格式），要么先转码。

### 4. 人设怎么"带过去"

三条路，选一条，**别叠**（实测结论见上节）：

1. **轻量聊天**：`profile="sdk-minimal"` + `DSH_SYSTEM_PROMPT` 环境变量。实测有效，工具面也最小。
2. **带工具/子 agent**：复制 `sdk` profile 成 `astrbot`，人设写进 `agent-instructions`（`AGENTS.md` 或 profile 配置）。`sdk` 会忽略 `DSH_SYSTEM_PROMPT`，这点别踩。
3. 复用现成的 `dsh-agent-persona/personas.json`：把该插件挂进第 2 条的 profile，和 web 端人设保持一致。

无论哪条，都要**关掉 AstrBot 自己的 persona / 系统提示**，否则两套人设互相污染。

**同时必须关掉 AstrBot 自己的 persona / 系统提示**，否则两套人设会互相污染——表现是"人设时而不稳、回复风格来回跳"。

## 五、风险清单（按踩坑概率排序）

| 风险 | 表现 | 处理 |
| --- | --- | --- |
| **QQ 账号双开冲突** | 两条链同时收同一条消息、或者登录被踢 | AstrBot 用 OneBot 接管 QQ，就把 `@tencent-connect/dsh-qqbot` 从该 profile 摘掉；两者只能一个在线 |
| **双人设污染** | 语气不稳定、偶尔出戏 | 关闭 AstrBot persona，人设只留 DSH 一处 |
| **并发回复交错** | 一条消息回两半、顺序乱 | 按 `umo` 加锁 + DSH 侧排队 |
| **冷启动慢** | 第一条消息 3–8 秒 | 懒启动 + 预热（AstrBot 启动后发一条空 prompt 或直接 `initialize`） |
| **阻塞事件循环** | 语音/命令延迟飙升，其它会话超时 | SDK 调用一律 `to_thread` |
| **工具越权** | 机器人能跑 shell、改文件 | 专用 profile + 白名单，工作目录指向空目录 |
| **消息过长** | QQ 单条限制导致截断 | 按段落切片，或超长转文件 |
| **profile 会话格式冲突** | 换 profile 后报 `.jsonl.zstd` / `compression "none"` 不匹配 | 每个 profile 用独立 `dsh_home` |
| **Python 版本** | AstrBot 宿主 Python 若 < 3.10，SDK 装不上 | 确认 AstrBot 跑在 3.11+（本机系统 Python 是 3.9.6） |
| **pre-release 漂移** | 升级后 SDK 方法变动 | `dsh-sdk-*` 是 `0.0.1-rc.x`；锁版本，升级前先跑一次冒烟 |
| **成本** | 每条消息都带系统提示 + 工具定义，token 比纯聊天高 | 长会话复用 session；简单寒暄走轻量模型 |

## 六、工作量

| 阶段 | 内容 | 估计 |
| --- | --- | --- |
| PoC | profile + 文本链路 + 会话映射 | 半天到 1 天 |
| 可用 | 语音进出、并发锁、错误重连 | +1 天 |
| 稳定 | 权限收敛、长消息、监控与日志 | +1 天 |

## 七、还没验证的（别当已实现）

- ~~SDK 安装与真实 prompt~~：已跑通（见"实测记录"）；
- ~~人设注入~~：已验证（`sdk-minimal` 生效、`sdk` 不生效）；
- AstrBot 本机未安装，插件 API 是照官方文档写的，**未做加载测试**；
- `Record` 对 wav 的强制转换、以及 QQ 侧 silk→mp3 的具体转码方，取决于所选协议端（NapCat / Lagrange）。

要把"未验证"清零，最小一步是：装 SDK → 生成 `sdk` profile → 跑一条 `harness.run("你好")`，确认 stdio 链路通。