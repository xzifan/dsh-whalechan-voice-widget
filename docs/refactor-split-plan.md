# service.js / realtime-service.js 拆分计划

> 由规划子代理（只读）于 2026-10-28 产出，主代理已采纳并拆成三张独立票。
> 基线：`npm test` 279 / `npm run test:web` 100 全绿。
> 现状行数（2026-10-29，步骤 1 完成后）：`src/service.js` **624 行**、`src/realtime-service.js` **506 行**、`src/realtime-protocol.js` **66 行**。
> 立项时为 617 / 558；步骤 1 于 2026-10-29 落地，`realtime-service.js` 565 → 506，后端 320 → 327。

## 分工原则

- 每步一次独立提交、可单独 revert，单步 ≤200 行。
- 对外行为零变化：HTTP 路径与字段、审计记录形状、测试断言都不动。
- `createRealtimeSession`（rt 85–556）与 `initializeSessionVoice`（svc 191–236）**本轮不动**，单独开票。

## 步骤 1 · `src/realtime-protocol.js`（先做 · 2026-10-29 已落地）

纯常量 / 提示词 / 工具 Schema，无状态：

- 搬：rt 17–21（MODEL / DEFAULT_HOST / SYSTEM_VOICE / DEFAULT_TOOLS / MAX_AUDIO_BYTES）、23–27（safeCode / redactText）、42–47（realtimeDefaults）、49–68（toolDefinitions）、70–78（REALTIME_INSTRUCTIONS / realtimeInstructions）、30–40（readEnvKey）。
- rt 保留同名 re-export（558 行已有该形式），补 `realtimeDefaults`、`REALTIME_INSTRUCTIONS`、`realtimeInstructions`、`readEnvKey`。
- 约 130 行改动。**收益/风险比最好，测试零改动。**

## 步骤 2 · `src/voice-tool-bridge.js`（收益最大的一刀）

- 搬：svc 171–173（breeze 视图）、303–410（runVoiceTool）、412–422（dispatchRealtimeTool），122 行。
- 注入 `{ getSettings, persistSettings, credential, synthVoiceLayer, fetch, audit, requireValue, RequestError }`；`settings.` 有 13 处读取，必须是 getter 不能传快照。
- 顺手把 413 行硬编码的 8 个工具名改成引用 `DEFAULT_TOOLS`（与 rt:20 的集合完全一致，消除漂移）。
- 约 175 行改动。切完 service.js 降到 ~470 行。

## 步骤 3 · `src/voice-synthesis.js`（最后做，风险最高）

- 搬：svc 238–255（readProviderKey）、257–264（voiceProfile）、266–301（synthVoiceLayer），62 行。
- 注入 `{ getSettings, credential, modelCredential, audit, fetch }`；保留同名导出，签名不变。
- 约 105 行改动。`realtime-tts.test.js` 有 24 条断言盯着 usage / requestId / audioDurationSeconds。

## 必须避开的坑（读代码时逐个确认）

1. **`mutate` 不可重入**：`commitSettings` 被三处调用（persistSettings 队列内、initializeSessionVoice 233 行、PUT /api/config 441 行）。封装"自带队列的 save()"会让后两者死锁——表现是测试挂起而不是失败。
2. **`settings` 是会被整体重赋值的闭包变量**（commitSettings 187 行）；`voicePresets` 用的是 `getSettings: () => settings`。传值快照会打挂 voice-presets-cache 与 voice-settings-persistence。
3. **`disposed` 是活标志**：225 行在异步回调里读，617 行才置位，必须 getter。
4. **`settingsLoad` 必须在 `handle` 最顶部 await**（425 行，与 `voicePresets.ready` 并列），抽出去的模块不得绕过。
5. **会话对象被就地改写**：`runTool` 306 行改的是 `handle` 537 行新建的 `rt`；传副本即行为变化。`const useTts`(90) 是建会话时快照，`ttsActive()` 又混用 `voiceState`，顺序不能挪。
6. **`invalidate()`（187–203）一次改 12 个变量**，本轮不要动。
7. **事件游标**：events 上限 256 且 `shift()`，`cursor` 必须单调；`/api/realtime/events` 依赖 `seq > after`。将来抽会话注册表时，`dispose()` 与 health 的 `activeSessions` 必须读同一个 Map。
8. **`WebSocket` 兜底 require（rt 11–15）**：`WebSocketCtor = WebSocket` 是默认参数、调用时求值；挪错会导致 `connect()` 在 522 行静默 return，而所有测试都注入 `WebSocketCtor`，**测试套件抓不到**。
9. **两套 key 解析器不要合并**：`readProviderKey`（按 protocol 优先级）与 `readEnvKey`（只认 DASHSCOPE_API_KEY）语义不同。
10. **`readEnvKey` 生产代码里无人调用**，只被测试 import；搬走时别顺手删导出。

## 每步的验收断言

**步骤 1**

- `newMod.toolDefinitions === rtMod.toolDefinitions`（同一引用，杜绝双份维护）。
- `realtimeDefaults()` 深比对 8 个键；`DEFAULT_TOOLS.length === 8` 且顺序不变。
- 经 `createService()` 的 `GET /api/config` 断言 `settings.realtime` 形状等于 `realtimeDefaults()`。
- `readEnvKey` 对缺文件 / 权限错误仍返回 `''` 而不抛。

**步骤 2**

- 同会话内 `set_tts_provider('mimo')` 后 `get_voice_config` 返回 `provider === 'mimo'`（证明注入的是 live getter）。
- Breeze 下 `design_voice` / `apply_voice` / `delete_voice` 抛 400 且 message 精确等于 `breezeDisabled`。
- 非 qwen 下 `list_voice_presets` 返回 `{presets:[],candidates:[],note}` 三键齐全。
- `design_voice` 失败时 audit 恰好追加 1 条 `kind:'error'`，`text` 匹配 `/^Voice design failed \(HTTP \d+\)$/`。
- `__settingsChanged` / `__voiceSettingsPatch` 仍被 session 转成 `voice-settings-changed` 事件。

**步骤 3**

- 一次 `synth_tts` 只产生 1 条 `kind:'synthesis'`，字段键集合冻结为 `{kind,role,text,provider,model,voice,status,usage,requestId,audioOutput,audioDurationSeconds}`。
- 取消 → `status:'cancelled'` 且不追加 error；真失败 → `failed` + 单独 `kind:'error'`。
- qwen → bailian 凭据、breeze → `modelCredential('breeze')` + 语言归一、custom → `readProviderKey`；三者的 key 字符串都不得出现在返回体与审计文本中。
- `voiceProfile()` 对 qwen 默认 `voice:'longanhuan_v3.1'`，model 的二选一逻辑不变。

**通用门禁**：`npm test` ≥279、`npm run test:web` ≥100、`npm run build`、`npm pack --dry-run` 确认新文件进包（`files` 含 `src`，自动生效）。

## 注意

`test/adapter.test.js` 锁死 `routes.length === 23` 与 `disposed === 24`。这三步都不该改 `src/index.js`；若不得不改，记得同步这两个数字。
