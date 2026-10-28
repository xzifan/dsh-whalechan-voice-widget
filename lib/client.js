window.__ModuleLoader__.load({
  id: 'dsh-voice-workbench',
  factory(require) {
    const React = require('react')
    function Icon() {
      return React.createElement('span', { 'aria-hidden': true }, '♫')
    }
    function Workbench() {
      const frame = React.useRef(null)
      const [error, setError] = React.useState('')
      const url = new URL('voice-workbench/', document.baseURI)
      React.useEffect(() => {
        const pending = new Map()
        const methods = {
          '/api/credentials/status': ['POST'],
          '/api/credentials/save': ['POST'],
          '/api/voice-presets/save': ['POST'],
          '/api/voice-presets/generate': ['POST'],
          '/api/voice-presets/apply': ['POST'],
          '/api/voice-presets/greeting': ['POST'],
          '/api/history/sessions': ['POST'],
          '/api/history/messages': ['POST'],
          '/api/statistics': ['POST'],
          '/api/audit': ['POST'],
          '/api/config': ['GET', 'PUT'],
          '/api/catalog': ['POST'],
          '/api/models/check': ['POST'],
          '/api/config/check': ['POST'],
          '/api/realtime/start': ['POST'],
          '/api/realtime/audio': ['POST'],
          '/api/realtime/commit': ['POST'],
          '/api/realtime/response': ['POST'],
          '/api/realtime/cancel': ['POST'],
          '/api/realtime/end': ['POST'],
          '/api/realtime/events': ['POST'],
          '/api/realtime/playback': ['POST'],
        }
        const controlPaths = new Set([
          '/api/realtime/start',
          '/api/realtime/events',
          '/api/realtime/playback',
          '/api/realtime/commit',
          '/api/realtime/response',
          '/api/realtime/cancel',
          '/api/realtime/end',
        ])
        const laneFor = path =>
          path === '/api/realtime/audio' ? 'audio' : controlPaths.has(path) ? 'control' : 'other'
        const limits = { audio: 2, control: 4, other: 8 },
          counts = { audio: 0, control: 0, other: 0 }
        const listener = async event => {
          if (event.source !== frame.current?.contentWindow || event.origin !== url.origin) return
          const msg = event.data
          if (!msg || typeof msg.id !== 'string' || msg.id.length > 150) return
          if (msg.type === 'voice-workbench:abort') {
            pending.get(msg.id)?.abort()
            return
          }
          if (msg.type !== 'voice-workbench:request' || !methods[msg.path]?.includes(msg.method) || pending.has(msg.id))
            return
          const lane = laneFor(msg.path)
          if (counts[lane] >= limits[lane]) {
            event.source.postMessage(
              {
                type: 'voice-workbench:response',
                id: msg.id,
                status: 429,
                body: { error: '工作台请求过于密集，请稍后重试。' },
              },
              url.origin,
            )
            return
          }
          const controller = new AbortController()
          pending.set(msg.id, controller)
          counts[lane]++
          try {
            const target = new URL('api/voice-workbench/' + msg.path.slice('/api/'.length), document.baseURI)
            const response = await fetch(target, {
              method: msg.method,
              credentials: 'same-origin',
              signal: controller.signal,
              headers: msg.method === 'GET' ? {} : { 'Content-Type': 'application/json' },
              body: msg.method === 'GET' ? undefined : JSON.stringify(msg.body || {}),
            })
            let body
            try {
              body = await response.json()
            } catch {
              body = { error: '工作台接口响应无效，请重新连接 DSH' }
            }
            event.source.postMessage(
              { type: 'voice-workbench:response', id: msg.id, status: response.status, body },
              url.origin,
            )
          } catch (error) {
            if (!controller.signal.aborted)
              event.source.postMessage(
                { type: 'voice-workbench:response', id: msg.id, status: 502, body: { error: '无法连接工作台服务' } },
                url.origin,
              )
          } finally {
            pending.delete(msg.id)
            counts[lane]--
          }
        }
        window.addEventListener('message', listener)
        return () => {
          window.removeEventListener('message', listener)
          for (const c of pending.values()) c.abort()
        }
      }, [url.origin])
      if (!/^https?:$/.test(url.protocol)) return React.createElement('p', null, '请在 DSH Web 界面打开语音工作台。')
      return React.createElement(
        'div',
        { style: { height: '100%', minHeight: 500, display: 'flex', flexDirection: 'column' } },
        error && React.createElement('p', { role: 'alert' }, error),
        React.createElement('iframe', {
          ref: frame,
          title: '语音工作台',
          src: url.href,
          allow: 'microphone; autoplay',
          onError: () => setError('工作台页面加载失败，请检查插件构建产物'),
          style: { width: '100%', flex: 1, border: 0, minHeight: 500 },
        }),
      )
    }
    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'voice-workbench' }, Workbench))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'voice-workbench', order: 30, label: '语音小鲸鱼娘' },
            Icon,
          ),
        )
      },
    }
  },
})
