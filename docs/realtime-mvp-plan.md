# 语音小鲸鱼娘 · Qwen Audio Realtime MVP 接入方案

> 目标：用阿里云百炼 `qwen-audio-3.1-realtime-plus` 作为语音对话主链路（理解 + 生成 + 打断判定），MVP 阶段**只接 Realtime**，不做 TTS 混音。保留现有分段链路与多 Provider 配置，作为可切换的后备。

---

## 1. 一句话定位

把「说话 → 识别 → 理解 → 回复 → 播放 → 打断」整条链路交给 Realtime 的 WebSocket，前端只负责采集 PCM、播放 PCM、转发事件和展示字幕。现有 DSH 工具/审批通过 Function Calling 桥接回来。

---

## 2. 架构总览

```
浏览器 (插件前端)
  │  getUserMedia 采集 16kHz/16bit/单声道 PCM
  │  ↓  input_audio_buffer.append (持续每 20~40ms 一帧)
  │  ↓  response.audio.delta → 客户端 PCM 播放队列
  │
  ▼
DSH 插件后端 (src/service.js 新增 realtime 会话管理)
  │  持有 WebSocket (wss://…/api-ws/v1/realtime?model=qwen-audio-3.1-realtime-plus)
  │  Authorization: Bearer <DASHSCOPE_API_KEY>
  │  事件转发 / Function Calling 工具执行 / 审批
  │
  ▼
阿里云百炼 Qwen Audio 3.1 Realtime Plus
  · server_vad / smart_turn 打断判定
  · 语音→文本→语音 端到端
```

**关键决策**：WebSocket 建在**后端**（Node），而不是浏览器直连。理由：
- API Key 只能存在服务端，绝不暴露到浏览器；
- Function Calling 要执行 DSH 工具、走审批，必须后端；
- 后端统一管理重连、超时、限流和事件回放，前端只做「采集 + 播放 + 展示」。

---

## 3. 会话生命周期与事件时序（MVP 主流程）

### 3.1 建立连接

```
前端点击「开始对话」
  → POST /api/voice-workbench/realtime/start
  → 后端校验配置 → 新建 WebSocket
  → 返回 sessionId（前端用 sessionId 轮询/订阅事件）
```

WebSocket URL：
```
wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.1-realtime-plus
```
> 兼容旧域名 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=…`，MVP 可先用旧域名，后续引导迁移业务空间专属域名。

### 3.2 session.update（首次、仅一次生效的音色等）

```json
{
  "type": "session.update",
  "session": {
    "modalities": ["text", "audio"],
    "voice": "<复刻音色ID>",          // MVP 先用系统音色 longanqian_v3.1，后续换设计音色
    "instructions": "<鲸鱼娘人格+回复语言+语气>",
    "input_audio_transcription": { "language": "zh" },
    "output_audio": { "language": "zh" },
    "output_audio_format": "pcm",
    "enable_speech_emotion": true,
    "turn_detection": { "type": "smart_turn" }   // 语义打断：嗯啊不触发
  }
}
```

注意：
- `voice` 只能在**第一次** `session.update` 设置，之后改要新建连接；
- `turn_detection` 只能在首次发音频前（IDLE）设置；
- `instructions` 可随时更新（改人格/语言/语气）。

### 3.3 音频采集与输入

前端每 20~40ms 采集一帧 16kHz/16bit/单声道，base64 后发：
```json
{ "type": "input_audio_buffer.append", "audio": "<base64>" }
```
经后端转发给 WebSocket。

### 3.4 输出事件（服务端 → 前端）

| 事件 | 含义 | 前端处理 |
|---|---|---|
| `response.audio.delta` | PCM 音频增量（base64） | 追加到播放队列，实时播放 |
| `response.audio_transcript.delta` | 字幕增量 | 滚动字幕 |
| `response.audio_transcript.done` | 完整回复文本 | 定格字幕 |
| `conversation.item.input_audio_transcription.delta` | 用户语音转写增量 | 显示「你说的话」 |
| `input_audio_buffer.speech_started` | 检测到用户开口 | 进入「用户在说话」状态 |
| `input_audio_buffer.speech_stopped` | 用户说完 | 准备触发回复 |
| `response.done` | 本轮回复完成 | 结束本轮，恢复监听 |

音频格式：**输出 PCM 24kHz/16bit/单声道**，前端播放时按 24kHz 处理（或转成 WebAudio buffer 播放）。

### 3.5 打断（核心收益）

- **smart_turn**：模型边播边听，用户一开口有语义 → 服务端自动 `response.cancel`（状态 `cancelled`）→ 前端**立即清空播放队列** → 开始新一轮输入。
- 前端只需监听 `response.done` 的 `cancelled` 状态，停止当前音频播放，无需自己写 VAD 语义判定。

---

## 4. Function Calling 桥接（工具/审批）

### 4.1 声明工具

`session.update` 里加 `tools`：
```json
"tools": [{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "读取工作区文件",
    "parameters": { "type": "object", "properties": { "file_path": {"type":"string"} }, "required": ["file_path"] }
  }
}]
```
MVP 只暴露白名单内的只读工具，与现有 `enabled_tools` 一致。

### 4.2 执行与写回

```
收到 function_call（含 call_id）
  → 后端走 DSH 工具执行 + 审批 + 文件策略（复用现有 safeToolCall/recordToolEvent）
  → 执行完写回：
     { "type":"conversation.item.create", "item":{
         "type":"function_call_output", "call_id":"<call_id>",
         "output":"<JSON字符串>" } }
  → 发 response.create 触发模型基于结果继续回复
```

### 4.3 关键限制

- `tools` 与 `enable_search` **互斥**，MVP 只开 tools；
- 工具执行期间模型暂停输出，审批超时/拒绝要能 `response.cancel` 兜底；
- 工具结果过大要截断脱敏（复用现有脱敏逻辑）。

---

## 5. 配置项（新增，独立于现有 TTS/ASR）

```
realtime:
  enabled: bool
  model: 'qwen-audio-3.1-realtime-plus'
  api_host: ''            # 空=用旧域名；填则用 {WorkspaceId}.cn-beijing.maas...
  key_file: ''            # 复用 ~/.dsh/secrets/bailian.env（DASHSCOPE_API_KEY）
  voice: 'longanqian_v3.1'  # 或复刻音色ID
  language: 'zh'          # 输入/输出语言
  turn_mode: 'smart_turn' # smart_turn | server_vad | push-to-talk
  instructions: ''        # 人格/语气（默认继承 system_prompt）
  tools: []               # 白名单工具
```

凭据复用：直接读现有 `bailian.env` 的 `DASHSCOPE_API_KEY`，**不新增密钥字段、不外泄**。

---

## 6. 与早期分段链路的关系

- 新增「实时对话」模式，与现有「分段链路（VAD→ASR→LLM→TTS）」**并存**，由配置开关切换。
- 现有 MiniMax / MiMo / Breeze / 自定义 HTTP Provider、三语混音、说话习惯缓存**全部保留**，MVP 不动它们。
- Realtime 模式下：跳过本地 ASR、DSH LLM 和 TTS 三段；但工具执行、审批、对话记录仍走现有 `turn-events.js`。

---

## 7. 新增/改动文件清单（预估）

| 文件 | 改动 |
|---|---|
| `src/realtime-service.js`（新） | WebSocket 会话管理、事件转发、重连、Function Calling 桥 |
| `src/realtime-events.js`（新） | 事件序列化、PCM 转发、字幕事件 |
| `src/service.js` | 新增 `/realtime/start`、`/realtime/audio`、`/realtime/cancel`、`/realtime/end` 路由 |
| `src/index.js` | 注册新路由 + 凭据读取 |
| `src/config-validation.js` | 新增 realtime 字段校验 |
| `web/src/main.jsx` | 新增 Realtime 采集/播放/字幕状态机 |
| `web/src/realtime-view.jsx`（新） | 实时对话界面 |
| `lib/client.js` | iframe 消息白名单加新路由 |
| 测试 | 后端事件时序 + 前端采集播放回归 |

---

## 8. MVP 交付范围（明确不做）

✅ 做：
- 单会话 Realtime 语音对话（server_vad 或 smart_turn）
- 打断（用户说话自动取消播报）
- 字幕（用户转写 + 回复转写）
- 只读工具 Function Calling（可选，先关或只开 read/glob）
- 凭据复用 bailian.env，系统音色起步

❌ 不做（后续阶段）：
- TTS 混音（「Realtime 大脑 + TTS 嘴巴」）
- 音色设计向导接入
- 说话人增强（voiceprint）
- AOQ/WebRTC 协议
- 多轮音频历史调优、历史轮次上限精细控制
- 联网搜索

---

## 9. 风险与注意

1. **音质**：Realtime 日语偏生硬，MVP 先接受；后续用「TTS 嘴巴」或调 instructions 缓解。
2. **首字延迟**：纯 Realtime 低延迟；一旦后续加 TTS 替换会变高，需单测。
3. **工具期间打断**：执行工具时用户打断，要处理「工具结果晚到」的竞态，MVP 需兜底。
4. **连接稳定性**：需实现断线重连、心跳、限流 429 退避；Key 失效返回 401 要可读提示。
5. **凭据安全**：Key 只在后端，前端永远拿不到；错误信息不回显原始 Key/正文。

---

## 10. 分阶段落地

- **P0（MVP）**：后端 WebSocket 会话 + 前端采集/播放/字幕 + server_vad 打断，系统音色，无工具。
- **P1**：smart_turn 语义打断 + 复刻音色接入 + 只读工具 Function Calling。
- **P2**：TTS 混音（Realtime 大脑 + TTS 嘴巴）+ 音色设计向导。
- **P3**：AOQ/声纹/历史调优/联网搜索。

---

## 附：关键官方文档

- [实时语音对话用户指南](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)
- [Realtime WebSocket 接入](https://help.aliyun.com/zh/model-studio/fun-audiochat-realtime-websocket-api)
- [客户端事件](https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events)
- [服务端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-server-events)
- [声音复刻（Realtime 音色）](https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide)
