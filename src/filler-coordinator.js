// Optional speech never blocks the main conversation. Every asynchronous stage
// belongs to one opportunity, and stale opportunities are silent.
export function createFillerCoordinator({ generate, synthesize, emit, context, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, delays = {} }) {
  const delay = { thinking: 1800, 'tool-wait': 1400, transition: 1100, interrupt: 180, ...delays }
  let pending = null, disposed = false, userSpeaking = false, mainPlaying = false
  let lastSpoken = -Infinity, turnId = '', count = 0, sequence = 0
  const previousFillers = []
  function cancel() {
    if (!pending) return
    const old = pending; pending = null
    clearTimer(old.timer); clearTimer(old.expiryTimer); old.controller.abort()
    emit({ type: 'filler-cancel', id: old.id })
  }
  function newTurn(id) { cancel(); turnId = id; count = 0 }
  function deliver(item) {
    if (pending !== item || disposed || item.delivered || item.controller.signal.aborted) return
    if (now() > item.deadline || mainPlaying) { cancel(); return }
    if (userSpeaking || !item.audio) return
    if (count >= 2 || now() - lastSpoken < (item.reason === 'interrupt' ? 2500 : 12000)) { cancel(); return }
    clearTimer(item.timer); clearTimer(item.expiryTimer)
    lastSpoken = now(); count++
    previousFillers.push(item.text); if (previousFillers.length > 6) previousFillers.shift()
    emit({ type: 'filler-audio', id: item.id, reason: item.reason, turnId,
      messageId: `${turnId}:filler:${item.id}`, text: item.text,
      data: item.audio.audio, mime: item.audio.mime || 'audio/wav', expiresAt: now() + 1800 })
    // Keep the delivered item cancellable until main speech/user speech starts.
    item.delivered = true
  }
  function schedule(reason, detail = {}) {
    if (disposed || typeof generate !== 'function' || typeof synthesize !== 'function' || mainPlaying) return
    if (pending && !pending.delivered) return
    if (count >= 2 || now() - lastSpoken < (reason === 'interrupt' ? 2500 : 12000)) return
    cancel()
    const item = { id: `filler-${++sequence}`, reason, controller: new AbortController(), deadline: now() + (reason === 'interrupt' ? 10000 : 8500) }
    pending = item
    item.expiryTimer = setTimer(() => { if (pending === item) cancel() }, item.deadline - now())
    item.expiryTimer?.unref?.()
    item.timer = setTimer(async () => {
      try {
        const snapshot = context()
        const text = await generate({ ...snapshot, ...detail, reason, previousFillers: [...previousFillers], signal: item.controller.signal,
          onOutcome: outcome => {
            if (pending === item && !disposed) emit({ type: 'filler-status', id: item.id, reason, status: outcome.status, latencyMs: outcome.latencyMs, ...(outcome.code ? { code: outcome.code } : {}) })
          },
        })
        if (pending !== item || item.controller.signal.aborted || disposed) return
        if (typeof text !== 'string' || !text.trim() || text.length > 120) { cancel(); return }
        item.text = text.trim()
        item.audio = await synthesize(item.text, { signal: item.controller.signal, turnId, messageId: `${turnId}:filler:${item.id}`, reason })
        if (!item.audio?.audio) { if (pending === item) cancel(); return }
        deliver(item)
      } catch { if (pending === item) cancel() }
    }, delay[reason] ?? 1500)
    item.timer?.unref?.()
  }
  return {
    schedule, cancel, newTurn,
    userStarted({ interrupted = false } = {}) {
      userSpeaking = true; mainPlaying = false; cancel()
      if (interrupted) schedule('interrupt')
    },
    userStopped() {
      userSpeaking = false
      if (pending?.reason === 'interrupt') {
        const item = pending
        // Only acknowledge within a short gap; never after a completed reply.
        item.deadline = Math.min(item.deadline, now() + 2200)
        clearTimer(item.expiryTimer)
        item.expiryTimer = setTimer(() => { if (pending === item) cancel() }, Math.max(0, item.deadline - now()))
        item.expiryTimer?.unref?.()
        deliver(item)
      } else schedule('thinking')
    },
    mainOutput() { cancel() },
    playback(active) { mainPlaying = active; if (active) cancel() },
    dispose() { disposed = true; cancel() },
  }
}
