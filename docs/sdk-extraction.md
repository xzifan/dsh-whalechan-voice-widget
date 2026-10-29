# 从 DSH 插件到独立 Agent Core SDK

目标：让这套语音 agent 不依赖 DSH 也能跑，同时保留 DSH 插件形态（宿主内嵌、复用会话与工具审批）。做法不是重写，而是**把已经存在的依赖注入缝切开，补一个独立适配器**。

## 一、现状：耦合面比想象中小

`createService(config, dependencies)` 早就把宿主能力收进了一个对象。全仓 3252 行里，真正调用宿主的只有 10 个成员：

| 依赖 | 用途 | 谁提供 |
| --- | --- | --- |
| `runTool(name, args, {workspace, signal, sessionKey, allow})` | 执行单个工具，走审批/guard/沙箱 | 宿主 `agents.create` + `tools.execute` |
| `catalog()` | 工具清单 + 是否有执行能力 + 当前工作区 | 同上 |
| `releaseToolSession(sessionId)` | 语音会话结束时释放复用 agent | 同上 |
| `status()` | `{chat, tools}` 就绪状态 | `agentDefaultModel` + `llm` |
| `resolveModelCredential(provider)` | 取百炼/Breeze/火山凭据 | `credentials` 服务 |
| `configureModelCredential(provider, key)` | 写入凭据 | `credentials.set/modifyRecord` |
| `resolveBailianProvider()` | 百炼路由与 key | 模型路由 |
| `generateFiller()` | 插话用的默认 LLM | `llm.prepareCall` |
| `realtimeWebSocket` | 可注入的 WebSocket 构造器（测试用） | 宿主或 globalThis |
| `fetch` | 可注入的 fetch（测试用） | globalThis |

其中 `runTool`、`catalog`、`resolveModelCredential` 是**必需项**；其余成员用 `?.` 调用，缺失即降级（例外是 `releaseToolSession`——缺了不会报错，但会漏掉复用的工具 agent，只能等 TTL 回收，所以适配器必须实现）。这条契约已由 `test/core-contract.test.js` 锁住，改依赖面必须同步改测试。

**关键结论**：`service.handle(method, path, body, signal)` 本身已经是**与传输无关**的——它只吃方法、路径、JSON body。DSH 的 `ctx.connection.fetch.register` 只是在 `index.js` 里把它挂到宿主路由上。也就是说：

- 业务逻辑（会话、打断、工具分派、音色、审计、统计）**没有** import 任何 DSH 模块；
- 耦合只在 `src/index.js`（约 60 行）与 `src/native-services.js`（约 90 行）两个文件。

## 二、目标分层

```
@whale/agent-core          无宿主依赖：realtime 会话、工具分派、声音层、插话、审计、配置校验
@whale/adapter-dsh         现有形态：ctx.effect / connection.fetch / webServer / agents
@whale/adapter-node        独立形态：HTTP+WS 服务、环境变量凭据、文件持久化、MCP 工具
@whale/client              浏览器客户端（PCM、字幕、打断、审计 UI）
```

四条边界：

1. **传输**：core 只暴露 `handle(method, path, body, signal)`；HTTP 路由、WebSocket、WebRTC 都是适配器的事。
2. **工具**：core 只认 `runTool/catalog`；DSH 适配器走宿主策略管道，node 适配器走 **MCP client**（标准协议，符合你之前定的方向），两者行为对等。
3. **凭据**：core 只认 `resolveModelCredential/configureModelCredential`；node 适配器读 env 或系统钥匙串，DSH 适配器走宿主 `credentials`。
4. **持久化**：core 只认 `stateDir`；DSH 用 `~/.dsh/storages/<plugin>`，node 用 `~/.whale/` 或注入任意目录。

## 三、接口契约（草案）

```ts
export interface ToolCallContext { workspace: string; signal: AbortSignal; sessionKey: string; allow: string[] }

export interface AgentCoreDeps {
  fetch?: typeof fetch
  runTool(name: string, args: unknown, ctx: ToolCallContext): Promise<unknown>
  catalog(): Promise<{ tools: ToolSchema[]; currentWorkspace: string; toolExecutionAvailable: boolean }>
  releaseToolSession?(sessionId: string): Promise<void>
  status(): { chat: boolean; tools: boolean }
  resolveModelCredential(provider: 'bailian' | 'breeze' | 'volcengine'):
    Promise<{ provider: string; key: string; source: string; routeAvailable?: boolean }>
  configureModelCredential?(provider: string, key: string): Promise<void>
  generateFiller?(prompt: string, ctx: unknown): Promise<string>
  realtimeWebSocket?: WebSocketCtor
}
```

`createService(config, deps)` 保持不变；契约先用 JSDoc + 一条一致性测试锁住（`test/core-contract.test.js`），等真拆包时再迁到 `.d.ts`。

## 四、迁移三步（每步都能独立发布）

**P1 · 切开适配器（1–2 天）** — 物理分层已完成（2026-10-29）：21 个模块进 `src/core/`，6 个适配文件留在 `src/`，`./core` 已可作为 subpath 导出；剩下的 `server.js` + `bin/whale.js` 未做。
- `src/index.js` → `adapters/dsh/index.js`，只保留宿主注册与静态资源挂载。
- 新增 `src/server.js`：Node `http` + 一个 WS 升级处理，把 `handle()` 暴露成 REST，把 realtime 音频走 WS。
- `package.json` 加 subpath exports：`.`（DSH）、`./standalone`、`./core`。
- 验收：`node bin/whale.js --port 3081` 起服务，浏览器打开 `/voice-workbench/` 能完整对话一次，且不加载任何 DSH 模块。

**P2 · 工具层标准化（2–3 天）**
- `adapter-node` 用 MCP client 连工具服务器；`runTool` 变成 MCP `tools/call`。
- 本地工具（文件、bash）用 MCP 官方 filesystem/terminal server，不再自己实现沙箱。
- 这一步之后，"换宿主"不再等于"重写工具层"。

**P3 · 拆包与版本（按需）**
- pnpm workspace：`packages/core`、`packages/adapter-dsh`、`packages/adapter-node`、`packages/client`。
- core 独立 semver；适配器跟宿主版本走。第三方可以只装 core + 自写适配器。

## 五、不能照搬的东西（真实风险）

1. **工具审批语义**：DSH 的 `tools.execute` 带审批、guard、文件沙箱。node 适配器没有这层，照搬会变成"任意命令执行"。独立版必须自己定策略：工作区 jail + 命令白名单 + 每次写操作确认。这是拆包时最容易出事的地方。
2. **审计格式**：现在 `voice-audit.jsonl` 是产品数据（统计页在读），拆包时应当定义成 core 的稳定 schema，带 `schemaVersion`，不要跟着适配器漂。
3. **音色设计**：`design_voice` 深度依赖百炼的自定义音色配额与回放链路。独立版应把它降级为可选 provider 能力，缺省不影响主链路。
4. **模型凭据的写入**：DSH 有 `credentials.set/modifyRecord`，独立版只能读 env；"配置页面里保存 key"这个能力在独立版里要么写自己的 keychain，要么直接不提供。
5. **Node 版本**：core 保持 20.19/22.12 下限，但独立服务端想用内置 WebSocket 需要 Node 22+，这点要在 README 写清楚。

## 六、判断标准（什么时候算拆成了）

- 在没有任何 DSH 的环境里，`npm i @whale/agent-core @whale/adapter-node` 之后能跑通"麦克风 → 回复 → 工具调用 → 审计"，且不 import `@deepseek-ai/*`。
- DSH 插件形态不退化：审批、沙箱、会话复用照旧。
- 同一份 `src/realtime-service.js`、`src/audit-log.js`、`src/tts-http.js` 被两边共用，不出现分叉。

达到这三条，才叫"独立核心 + 两个适配器"；否则只是把一个插件复制了一份。
