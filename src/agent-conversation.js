import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

// Cross-session/delegation capabilities could escape the per-agent allowlist.
const EXCLUDED = /(?:^|[./:])(?:run_code|subagent|subagent_fork|workflow|send_message|interrupt_agent|list_agents|create_goal|update_goal|get_goal|schedule_create|schedule_update|schedule_delete|schedule_list|qqbot_send_file)$/
const SECRET_KEY = /(?:api.?key|secret|token|password|authorization|cookie|credential)/i
function failure(message, status = 503) { return Object.assign(new Error(message), { name: 'VoiceNativeError', status }) }
function service(ctx, name) { try { return ctx.get?.(name) } catch { return undefined } }
export function safeToolValue(value, depth = 0) {
  if (depth > 5) return '[内容已截断]'
  if (typeof value === 'string') return value.slice(0, 6000)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|sk_|api_)[A-Za-z0-9_-]{16,}/g, '[已隐藏]')
    .replace(/((?:[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|authorization|cookie|credential)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)[^\r\n,;}]+/gi, '$1[已隐藏]')
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeToolValue(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[已隐藏]' : safeToolValue(item, depth + 1)]))
  return value === undefined ? null : value
}
export async function conversationWorkspace(value = '') {
  const input = value || process.cwd()
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0') || input.length > 4096) throw failure('工作区必须是已存在目录的绝对路径。', 400)
  try { const path = await realpath(input);if (!(await stat(path)).isDirectory()) throw new Error();return path } catch { throw failure('工作区不存在或不是可访问的目录。', 400) }
}
export function createAgentConversation(ctx) {
  const handles = new Set()
  let catalogPromise, cachedCatalog, cachedAt = 0
  const available = () => Boolean(service(ctx, 'agents')?.create && service(ctx, 'agentPresets')?.mount && service(ctx, 'agentPresets')?.resolve)
  async function create(workspace, signal, setup) {
    if (!available()) throw failure('当前 DSH 尚未提供原生工具对话服务；可先关闭工具继续聊天。')
    const presets = service(ctx, 'agentPresets'), agents = service(ctx, 'agents')
    const preset = await presets.resolve()
    if (preset.broken) throw failure('DSH 默认 Agent 预设不可用，请检查预设配置。')
    const selection = service(ctx, 'agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) throw failure('请先在 DSH 中配置默认对话模型。')
    const handle = await agents.create({
      sessionId: `voice-workbench-${randomUUID()}`, signal,
      agentOptions: { provider: selection.provider, model: selection.model, maxTokens: 2048, ...selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {} },
      meta: { cwd: workspace, agentPreset: preset.id },
      setup: async (agentCtx, agent) => {
        await presets.mount(agentCtx, preset.id)
        // Presentation changes schemas only, never approval or filesystem policy.
        agentCtx.tools.presentAs('native')
        await setup(agentCtx, agent)
      },
    })
    handles.add(handle)
    return handle
  }
  async function release(handle) { if (!handle) return;handles.delete(handle);await handle.dispose() }
  async function catalog() {
    const currentWorkspace = await conversationWorkspace()
    const base = { tools: [], currentWorkspace, toolExecutionAvailable: available(), interruption: { manual: true, voice: false } }
    if (!available()) return base
    if (cachedCatalog && Date.now() - cachedAt < 30000) return structuredClone({ ...cachedCatalog, currentWorkspace })
    if (!catalogPromise) catalogPromise = (async () => {
      let tools = [], handle
      try {
        handle = await create(currentWorkspace, undefined, (agentCtx, agent) => {
          tools = agentCtx.tools.schemas(agent).filter(tool => !EXCLUDED.test(tool.name)).map(tool => ({ name: tool.name, description: String(tool.description || '').slice(0, 1200), parameters: structuredClone(tool.parameters) }))
          agentCtx.tools.guard(() => '工具目录探测不会执行工具。')
        })
        cachedCatalog = { ...base, tools };cachedAt = Date.now()
        return cachedCatalog
      } finally { await release(handle);catalogPromise = undefined }
    })()
    return structuredClone(await catalogPromise)
  }
  /**
   * Execute a single tool directly through the DSH agent tool registry, without
   * running a full LLM turn. Mounts the agent preset, restricts to exactly the
   * named tool, then invokes `tools.execute()` — which still runs the complete
   * approval + guard + dispatch pipeline (never bypassing policy). Returns the
   * sanitized, JSON-serializable result.
   */
  async function runTool(name, args, { workspace, signal }) {
    if (typeof name !== 'string' || !name || EXCLUDED.test(name)) throw failure('该工具不能用于实时语音会话。', 400)
    if (!available()) throw failure('当前 DSH 尚未提供原生工具服务；可先关闭工具继续聊天。')
    const cwd = await conversationWorkspace(workspace)
    let handle
    try {
      const presets = service(ctx, 'agentPresets'), agents = service(ctx, 'agents')
      const preset = await presets.resolve()
      if (preset.broken) throw failure('DSH 默认 Agent 预设不可用，请检查预设配置。')
      const selection = service(ctx, 'agentDefaultModel')?.currentSelection?.()
      if (!selection?.provider || !selection?.model) throw failure('请先在 DSH 中配置默认对话模型。')
      let capturedTools, capturedAgent
      handle = await agents.create({
        sessionId: `voice-workbench-tool-${randomUUID()}`, signal,
        agentOptions: { provider: selection.provider, model: selection.model, maxTokens: 2048 },
        meta: { cwd, agentPreset: preset.id },
        setup: async (agentCtx, agent) => {
          await presets.mount(agentCtx, preset.id)
          agentCtx.tools.presentAs('native')
          const known = new Set(agentCtx.tools.schemas(agent).map(tool => tool.name))
          if (!known.has(name)) throw failure('该工具已不可用，请刷新工具列表重新选择。', 400)
          agentCtx.tools.restrict({ allow: [name] })
          capturedTools = agentCtx.tools; capturedAgent = agent
        },
      })
      handles.add(handle)
      if (!capturedTools) throw failure('工具执行未就绪。', 502)
      // Execute the single tool through the full policy pipeline (approval + guards + dispatch).
      const result = await capturedTools.execute({ name, arguments: args, agent: capturedAgent, signal })
      if (result.isError) {
        const message = result.error?.message || '工具执行失败'
        throw failure(String(message).slice(0, 1000), 502)
      }
      return safeToolValue(result.value !== undefined ? result.value : result.content)
    } finally {
      await release(handle)
    }
  }
  async function dispose() { await Promise.allSettled([...handles].map(release)) }
  return { catalog, runTool, dispose }
}
