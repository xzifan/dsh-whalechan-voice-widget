import { createConversationFiller } from './conversation-filler.js'
import { createAgentConversation } from './agent-conversation.js'
import { createModelCredentialResolver } from './model-credentials.js'

function failure(message, status = 503) {
  const error = new Error(message)
  error.name = 'VoiceNativeError'
  error.status = status
  return error
}
function get(ctx, key) {
  try { return typeof ctx?.get === 'function' ? ctx.get(key) : undefined } catch { return undefined }
}

/**
 * Native-only backend for the Realtime architecture. Realtime does its own
 * server-side ASR + dialogue, so there is no local SenseVoice, no segmented
 * chat and no TTS here. This adapter exposes the DSH tool execution bridge,
 * the tool catalog, and optional short fillers via a direct default-model call.
 */
export function createNativeServices(ctx, _config = {}) {
  const toolConversation = createAgentConversation(ctx)
  const filler = createConversationFiller(ctx)
  let disposed = false

  function status() {
    let selection
    try { selection = get(ctx, 'agentDefaultModel')?.currentSelection?.() } catch { /* Not ready yet. */ }
    return {
      chat: !disposed && !!get(ctx, 'llm')?.prepareCall && !!selection?.provider && !!selection?.model,
      tools: !!get(ctx, 'agents')?.create,
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    filler.dispose()
    await toolConversation.dispose()
  }

  if (typeof ctx?.effect === 'function') ctx.effect(() => () => dispose())

  const resolveCredential = createModelCredentialResolver(ctx)
  // Explicit shared bindings for speech providers without a host model adapter.
  // Existing model routes stay authoritative; never fall back across accounts.
  const sharedRefs = { bailian: 'DASHSCOPE_API_KEY', breeze: 'BREEZE_API_KEY', volcengine: 'VOLCENGINE_API_KEY' }
  async function resolveModelCredential(provider) {
    if (!Object.hasOwn(sharedRefs, provider)) throw failure('不支持的凭据提供方', 400)
    let result = await resolveCredential(provider)
    if (!result.routeAvailable) result = await resolveCredential(provider, { credentialRef: sharedRefs[provider] })
    const credentials = get(ctx, 'credentials')
    const writable = result.recordKey ? typeof credentials?.modifyRecord === 'function' : !!result.credentialRef && typeof credentials?.set === 'function'
    return { ...result, writable }
  }
  async function configureModelCredential(provider, key) {
    const target = await resolveModelCredential(provider)
    const credentials = get(ctx, 'credentials')
    if (!target.writable) throw failure('当前模型凭据无法在此编辑，请在 DSH 模型设置中配置')
    if (target.recordKey) {
      await credentials.modifyRecord(target.recordKey, current => {
        if (current && current.kind !== 'api-key') throw failure('此模型正在使用账户授权，请在 DSH 模型设置中管理')
        return Promise.resolve({ ...current, kind: 'api-key', key })
      })
    } else await credentials.set(target.credentialRef, key)
  }
  return { status, generateFiller: filler.generateFiller, resolveModelCredential, configureModelCredential, catalog: toolConversation.catalog, runTool: toolConversation.runTool,
    releaseToolSession: toolConversation.releaseToolSession, dispose }
}

export const PROVIDER = 'sensevoice-local' // retained symbol for any legacy references
export { failure }