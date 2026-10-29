"""Shared Playwright bootstrap: the real plugin mounted in a host page with every plugin API mocked.

Both `browser-smoke.py` and `browser-pages.py` fail through here so the mount path stays the
production one: host page -> `lib/client.js` bridge -> iframe `voice-workbench/` -> mocked
`/api/voice-workbench/*`. Nothing is written into the repo tree (fixtures and screenshots, when a
caller asks for them, land in a throwaway temp dir).
"""
import asyncio
import base64
import io
import json
import math
import mimetypes
import os
import struct
import tempfile
import wave
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://localhost:31099'
PREFIX = '/api/voice-workbench/'
SETTINGS = {
    'tts_model': 'speech-2.6-hd', 'speed': 1.05, 'emotion': 'happy',
    'voice_mix': [{'voice_id': 'female-shaonv', 'weight': 60}, {'voice_id': 'female-tianmei', 'weight': 40}, {'voice_id': 'female-yujie', 'weight': 0}],
    'chat_model': '', 'asr_model': 'whisper-1', 'system_prompt': '测试',
}
MOUNT_HTML = '''<html><body style="margin:0"><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(mod){const plugin=mod.factory(()=>React);const ctx={slots:{inject(n,fn){fn()},register(meta,Comp){if(meta.name==='main')ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Comp));return ()=>{}}},layout:{}};plugin.apply(ctx)}};</script><script src="/plugin.js"></script></body></html>'''
TRACK_SCRIPT = """window.__testTracks=[];const original=navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);if(original)navigator.mediaDevices.getUserMedia=async options=>{const stream=await original(options);window.__testTracks.push(...stream.getTracks());return stream};"""


def recording():
    """Half a second of 440 Hz followed by silence, so the upload path has real PCM to send."""
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(i * math.tau * 440 / 16000)) if i < 24000 else 0) for i in range(48000)))
    return stream.getvalue()


class Harness:
    """One browser, one host page. `routes` maps an action name to `callable(method, body)`."""
    def __init__(self, routes=None, settings=None, mic=True, viewport=None, init_scripts=None):
        self.routes = routes or {}
        self.settings = json.loads(json.dumps(settings if settings is not None else SETTINGS))
        self.mic = mic
        self.viewport = viewport or {'width': 1440, 'height': 1000}
        # Runs in every frame before any page script: a caller that needs to stub a browser
        # primitive (e.g. `window.Audio`) has no other seam, because `start()` navigates.
        self.init_scripts = list(init_scripts or [])
        self.calls, self.errors = [], []
        self.audio = base64.b64encode(recording()).decode()

    def default_result(self, method, action, body):
        if action == 'config':
            if method == 'PUT':
                self.settings.update(body['settings'])
            return {'settings': self.settings, 'credentials': {'tts': True, 'asr': True, 'chat': True},
                    'capabilities': {'asr': True, 'chat': True, 'asrPreparing': False, 'asrPhase': 'ready'}}
        if action == 'config/check':
            return {'valid': True, 'errors': {}, 'warnings': {}, 'checked': 'configuration', 'networkTested': False}
        if action == 'catalog':
            return {'tools': [{'name': 'read', 'description': '读取测试工作区文件'}, {'name': 'glob', 'description': '搜索文件路径'}],
                    'currentWorkspace': '/test/workspace', 'toolExecutionAvailable': True, 'interruption': {'manual': True, 'voice': False}}
        if action == 'filler/prepare':
            return {'phase': 'ready', 'completed': 1, 'total': 1, 'language': body.get('language', 'zh')}
        if action == 'filler':
            return {'audio': self.audio, 'mime': 'audio/wav', 'text': '嗯，我想想。', 'language': 'zh'}
        if action == 'realtime/start':
            return {'sessionId': 'mock-session', 'ok': True}
        if action == 'realtime/events':
            scripted = [{'seq': 1, 'type': 'user-transcript-done', 'text': '测试输入'},
                        {'seq': 2, 'type': 'tool-start', 'callId': 'call-1', 'name': 'read'},
                        {'seq': 3, 'type': 'tool-end', 'callId': 'call-1', 'status': 'ok', 'durationMs': 120},
                        {'seq': 4, 'type': 'transcript-done', 'text': '在呢，主人。'},
                        {'seq': 5, 'type': 'done'}]
            heard = len([c for c in self.calls if c[1] == 'realtime/audio']) > 2
            after = body.get('after', 0)
            return {'events': [e for e in scripted if heard and e['seq'] > after], 'cursor': 5, 'done': False}
        return {'ok': True, 'audio': self.audio, 'mime': 'audio/wav'}

    async def dispatch(self, route):
        path = urlparse(route.request.url).path
        if path.startswith(PREFIX):
            action = path[len(PREFIX):]
            body = route.request.post_data_json if route.request.post_data else {}
            self.calls.append((route.request.method, action, body))
            handler = self.routes.get(action)
            result = await handler(route.request.method, body) if handler else self.default_result(route.request.method, action, body)
            status, payload = result if isinstance(result, tuple) else (200, result)
            try:
                await route.fulfill(status=status, content_type='application/json', body=json.dumps(payload))
            except Exception:
                pass
            return
        if path == '/':
            await route.fulfill(status=200, content_type='text/html', body=MOUNT_HTML)
            return
        mapping = {'/react.js': ROOT / 'web/node_modules/react/umd/react.production.min.js',
                   '/react-dom.js': ROOT / 'web/node_modules/react-dom/umd/react-dom.production.min.js',
                   '/plugin.js': ROOT / 'lib/client.js'}
        file = mapping.get(path)
        if path.startswith('/voice-workbench/'):
            file = ROOT / 'dist/web' / (path[len('/voice-workbench/'):] or 'index.html')
        if file and file.is_file():
            await route.fulfill(status=200, content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream', body=file.read_bytes())
        else:
            await route.fulfill(status=404, body='missing')

    async def start(self, wait_for='和小鲸鱼娘聊一会儿'):
        """Launch, mount, and return the iframe frame locator once the plugin has rendered."""
        self.tmp = tempfile.mkdtemp(prefix='bw-browser-')
        self._playwright = await async_playwright().start()
        options: dict = {'headless': True}
        if self.mic:
            fixture = os.path.join(self.tmp, 'tone.wav')
            Path(fixture).write_bytes(recording())
            options['args'] = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                               '--use-file-for-fake-audio-capture=' + fixture + '%noloop', '--autoplay-policy=no-user-gesture-required']
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        self.browser = await self._playwright.chromium.launch(**options)
        self.context = await self.browser.new_context(viewport=self.viewport, permissions=['microphone'] if self.mic else [])
        await self.context.add_init_script(TRACK_SCRIPT)
        for script in self.init_scripts:
            await self.context.add_init_script(script)
        self.page = await self.context.new_page()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        await self.page.route('**/*', self.dispatch)
        await self.page.goto(ORIGIN + '/')
        self.frame = self.page.frame_locator('iframe')
        try:
            await self.frame.get_by_role('heading', name=wait_for, exact=True).wait_for(timeout=15000)
        except Exception:
            raise AssertionError('plugin did not render inside the host iframe; page errors: ' + repr(self.errors))
        return self.frame

    @property
    def child(self):
        """The plugin iframe, matched by URL rather than by frame index."""
        for frame in self.page.frames:
            if '/voice-workbench/' in frame.url:
                return frame
        raise AssertionError('plugin iframe not found; frames: ' + repr([f.url for f in self.page.frames]))

    async def nav(self, name):
        await self.frame.get_by_role('button', name=name, exact=True).click()

    async def until(self, predicate, timeout=5.0, interval=0.05):
        """Poll a side effect until it is truthy, and return its last value.

        A DOM value that is visible on the first paint is not evidence that a request landed:
        asserting it returns instantly, and the request list read on the next line is still empty.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            result = predicate()
            if result:
                return result
            await asyncio.sleep(interval)
        return predicate()

    async def wait_for_value(self, label, wanted, timeout=5.0, interval=0.05):
        """Wait until a labelled input holds `wanted`, i.e. the page really rendered server data.

        The settings tabs render before the config GET resolves, so acting on the form while it
        still shows defaults lets the late load overwrite the edit. Verified with a 500 ms mock:
        the tabs are visible at ~65 ms with an empty field, and the PUT then carried the seeded
        prompt plus the untouched tool set.
        """
        value = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            value = await self.frame.get_by_label(label).input_value()
            if value == wanted:
                return value
            await asyncio.sleep(interval)
        raise AssertionError(f'{label} 始终没有变成 {wanted!r}，实际读到 {value!r}')

    async def close(self):
        await self.browser.close()
        await self._playwright.stop()
