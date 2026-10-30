// 能量 VAD 断句策略：零依赖兜底实现。
//
// 它不做语义理解，只在"连续有声 → 静音超过阈值"时判定说完。
// 用途：断网、provider 不含语义断句、本地模型加载失败时的最后一级。

function rootMeanSquare(frame) {
  if (!frame || frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i] / 32768
    sum += sample * sample
  }
  return Math.sqrt(sum / frame.length)
}

/**
 * @param {Object} [options]
 * @param {number} [options.threshold] 归一化 RMS 阈值（0–1），默认 0.012 ≈ -38dBFS
 * @param {number} [options.frameMs] 单帧时长，默认 20
 * @param {number} [options.speechFrames] 连续多少帧有声才算开口
 * @param {number} [options.minSpeechMs] 少于该时长的"说话"不触发 stopped
 * @param {number} [options.silenceMs] 静音多久算说完
 * @param {number} [options.maxSpeechMs] 单回合上限，防止一直不结束
 */
export function createEnergyVadStrategy({
  threshold = 0.012,
  frameMs = 20,
  speechFrames = 3,
  minSpeechMs = 250,
  silenceMs = 700,
  maxSpeechMs = 30000,
} = {}) {
  let speaking = false
  let voicedRun = 0
  let speechMs = 0
  let silenceMsAcc = 0

  function reset() {
    speaking = false
    voicedRun = 0
    speechMs = 0
    silenceMsAcc = 0
  }

  return {
    id: 'energy-vad',
    reset,
    push(frame, ctx = {}) {
      const step = ctx.frameMs || frameMs
      const energy = rootMeanSquare(frame)
      const voiced = energy >= threshold
      const decision = {}

      voicedRun = voiced ? voicedRun + 1 : 0

      if (!speaking && voicedRun >= speechFrames) {
        speaking = true
        speechMs = 0
        silenceMsAcc = 0
        decision.speechStarted = true
      }

      if (speaking) {
        speechMs += step
        silenceMsAcc = voiced ? 0 : silenceMsAcc + step
        const longEnough = speechMs - silenceMsAcc >= minSpeechMs
        if ((silenceMsAcc >= silenceMs && longEnough) || speechMs >= maxSpeechMs) {
          decision.speechStopped = true
          decision.confidence = Math.min(1, silenceMsAcc / Math.max(1, silenceMs))
          speaking = false
          voicedRun = 0
          speechMs = 0
          silenceMsAcc = 0
        }
      }

      decision.energy = Number(energy.toFixed(4))
      return decision
    },
  }
}
