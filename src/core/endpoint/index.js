// 断句策略注册表 + 降级链。
//
// 设计原则（见 docs/sdk-extraction.md）：
// - 断句是 provider 相关的可插拔能力，不是 if/else 分支；
// - provider 自己能判停（如 Qwen Realtime 的 smart_turn）就用 passthrough，本地不插手；
// - 本地策略按顺序降级，任何一级抛错/超时都被跳过并记录，链尾必须有一个零依赖兜底。
//
// 帧约定：16kHz 单声道 Int16Array，每帧 20–40ms。

import { createEnergyVadStrategy } from './energy-vad.js'

const registry = new Map()

/**
 * @typedef {Object} EndpointDecision
 * @property {boolean} [speechStarted]
 * @property {boolean} [speechStopped]
 * @property {number} [confidence]
 * @property {number} [energy]
 * @property {string} [strategy] 由链填充，实际做出判定的策略
 * @property {string} [fallbackFrom] 由链填充，说明上一级为何被跳过
 */

/**
 * @typedef {Object} EndpointStrategy
 * @property {string} id
 * @property {(frame: Int16Array, ctx?: {frameMs?: number, elapsedMs?: number}) => EndpointDecision | Promise<EndpointDecision>} push
 * @property {() => void} reset
 * @property {() => Promise<void> | void} [dispose]
 */

/**
 * @param {string} id
 * @param {() => EndpointStrategy} factory
 * @param {{override?: boolean}} [options]
 */
export function registerEndpointStrategy(id, factory, { override = false } = {}) {
  if (!id || typeof id !== 'string') throw new TypeError('endpoint strategy id must be a non-empty string')
  if (typeof factory !== 'function') throw new TypeError('endpoint strategy factory must be a function')
  if (registry.has(id) && !override) throw new Error(`endpoint strategy already registered: ${id}`)
  registry.set(id, factory)
  return id
}

export function unregisterEndpointStrategy(id) {
  return registry.delete(id)
}

export function listEndpointStrategies() {
  return [...registry.keys()]
}

/** provider 自己判停时使用的空策略：永远不下结论。 */
export function createPassthroughStrategy() {
  return {
    id: 'passthrough',
    push() {
      return {}
    },
    reset() {},
  }
}

export const DEFAULT_CHAIN = ['smart-turn-onnx', 'energy-vad']

function isThenable(value) {
  return Boolean(value && typeof value.then === 'function')
}

/**
 * @param {{strategies?: EndpointStrategy[], timeoutMs?: number}} [options]
 */
export function createEndpointChain({ strategies = [], timeoutMs = 120 } = {}) {
  if (!strategies.length) throw new Error('endpoint chain requires at least one strategy')
  const disabled = new Set()
  const failures = []

  function disable(strategy, error) {
    disabled.add(strategy.id)
    failures.push({ id: strategy.id, error: String(error && error.message ? error.message : error) })
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[endpoint] strategy ${strategy.id} disabled: ${error && error.message ? error.message : error}`)
    }
  }

  async function withTimeout(strategy, frame, ctx) {
    const out = strategy.push(frame, ctx)
    if (!isThenable(out)) return out
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      if (timer.unref) timer.unref()
    })
    try {
      return await Promise.race([out, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    strategies: strategies.map(s => s.id),
    get disabled() {
      return [...disabled]
    },
    get failures() {
      return [...failures]
    },
    /** @returns {Promise<EndpointDecision>} */
    async push(frame, ctx = {}) {
      let fallbackFrom
      for (const strategy of strategies) {
        if (disabled.has(strategy.id)) continue
        try {
          const decision = await withTimeout(strategy, frame, ctx)
          return { ...(decision || {}), strategy: strategy.id, ...(fallbackFrom ? { fallbackFrom } : {}) }
        } catch (error) {
          disable(strategy, error)
          fallbackFrom = strategy.id
        }
      }
      return { strategy: 'none', ...(fallbackFrom ? { fallbackFrom } : {}) }
    },
    reset() {
      for (const strategy of strategies) {
        try {
          strategy.reset()
        } catch {
          /* 重置失败不影响后续回合 */
        }
      }
    },
    async dispose() {
      for (const strategy of strategies) {
        if (typeof strategy.dispose !== 'function') continue
        try {
          await strategy.dispose()
        } catch {
          /* 释放失败不应阻断退出 */
        }
      }
    },
  }
}

/**
 * 按 provider 能力解析策略链。capabilities.semanticTurn 为真时本地不插嘴。
 */
export function resolveEndpointChain({ capabilities = {}, order, timeoutMs, ...strategyOptions } = {}) {
  const ids = capabilities.semanticTurn ? ['passthrough'] : order || DEFAULT_CHAIN
  const strategies = []
  for (const id of ids) {
    const factory = registry.get(id)
    if (!factory) continue
    strategies.push(factory(strategyOptions))
  }
  if (!strategies.length) strategies.push(createPassthroughStrategy())
  return createEndpointChain({ strategies, timeoutMs })
}

// 内置策略：passthrough 与零依赖兜底。
registerEndpointStrategy('passthrough', createPassthroughStrategy)
registerEndpointStrategy('energy-vad', createEnergyVadStrategy)
