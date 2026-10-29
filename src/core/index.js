// 与宿主无关的语音 agent 核心。
//
// 这一层不 import 任何宿主包（DSH / @deepseek-ai/*），宿主能力全部通过
// createService(config, dependencies) 注入。见 docs/sdk-extraction.md。
//
// 可以直接在 Node 服务、边缘主机或测试里使用：
//   import { createService } from './core/index.js'

export { createService, defaults, RequestError } from './service.js'
export { createRealtimeSession } from './realtime-service.js'
export { createAuditLog, percentile, numericUsage, sanitizeAuditValue, sanitizeAuditRecord } from './audit-log.js'
export { MODEL, toolDefinitions } from './realtime-protocol.js'
