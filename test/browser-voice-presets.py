"""Editable preset browser regression. Build frontend first; all APIs/audio are fake.
Run: ~/.dsh/tools/venv/bin/python test/browser-voice-presets.py
"""
import asyncio
import copy
import json
import mimetypes
import os
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = {item['id']:item['designPrompt'] for item in json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {VOICE_PRESETS} from './web/src/lib/voice-layer.js'; console.log(JSON.stringify(VOICE_PRESETS))"],cwd=ROOT))}
ORIGIN = 'http://voice-presets.test'
FAKE_AUDIO = """
window.__audio = {plays: [], instances: [], blocked: false, ended: 0, paused: 0};
window.Audio = class {
 constructor(src) { this.src = src; window.__audio.instances.push(this); }
 async play() {
  window.__audio.plays.push(this.src);
  if (window.__audio.blocked) {
   window.__audio.blocked = false;
   throw new DOMException('Synthetic autoplay denial', 'NotAllowedError');
  }
  this.onplaying?.();
 }
 pause() { window.__audio.paused++; }
 finish() { window.__audio.ended++; this.onended?.(); }
};
"""

async def main():
    settings = {
        'system_prompt': '已保存的对话设置', 'workspace': '',
        'enabled_tools': [], 'tools_configured': True,
        'tts_voice_provider': 'qwen',
        'tts_profiles': {'qwen': {'voice': 'original-voice'}},
        'realtime': {'credential_source': 'provider', 'use_tts_voice': True},
    }
    presets = [
        {'id': key, 'name': name, 'prompt': '自然清晰、温柔明亮的中文女声。',
         'candidate': None, 'applied': False}
        for key, name in [('preset-bright', '清亮灵动'), ('preset-warm', '柔甜亲近'), ('preset-calm', '清冷知性')]
    ]
    calls, errors, unexpected = [], [], []
    save_gate = asyncio.Event()
    save_gate.set()
    fail_generation = True
    fail_greeting = False
    greeting = {'audio': 'UklGRgAAAAABAA==', 'mime': 'audio/wav'}

    async def route(r):
        nonlocal fail_generation
        request = r.request
        parsed = urlparse(request.url)
        if f'{parsed.scheme}://{parsed.netloc}' != ORIGIN:
            unexpected.append(request.url)
            await r.abort()
            return
        path = unquote(parsed.path)
        if path.startswith('/api/'):
            action = path.removeprefix('/api/')
            body = request.post_data_json if request.post_data else {}
            calls.append((action, copy.deepcopy(body)))
            status, result = 200, {}
            if action == 'config' and request.method == 'GET':
                result = {'settings': settings, 'voicePresets': presets,
                          'credentials': {'bailian': {'ready': True, 'source': 'provider'}},
                          'capabilities': {}, 'models': {}}
            elif action == 'catalog':
                result = {'tools': [], 'toolExecutionAvailable': True,
                          'currentWorkspace': '/synthetic/workspace'}
            elif action.startswith('voice-presets/'):
                assert request.method == 'POST', request.method
                preset = next(row for row in presets if row['id'] == body['presetId'])
                if action == 'voice-presets/save':
                    assert set(body) == {'presetId', 'prompt'}, body
                    await save_gate.wait()
                    if preset['prompt'] != body['prompt']:
                        preset.update(prompt=body['prompt'], candidate=None, applied=False)
                    result = {'voicePresets': presets}
                else:
                    assert set(body) == {'presetId'}, body
                    if action == 'voice-presets/generate':
                        if fail_generation:
                            fail_generation = False
                            status, result = 503, {'error': '模拟生成失败，请重试'}
                        else:
                            preset['candidate'] = {'voiceId': 'synthetic-' + preset['id'],
                                                   'prompt': preset['prompt']}
                            result = {'voicePresets': presets, 'candidate': preset['candidate']}
                            result.update({'greetingError': '模拟试听合成失败'} if fail_greeting else {'greeting': greeting})
                    elif action in ('voice-presets/apply', 'voice-presets/greeting'):
                        assert preset['candidate'], 'Cannot apply without a candidate'
                        if action.endswith('/apply'):
                            for row in presets:
                                row['applied'] = row is preset
                            settings['tts_profiles']['qwen'] = {
                                'voice': preset['candidate']['voiceId'], 'model': 'qwen3-tts-vd-realtime'}
                        result = {'settings': settings, 'voicePresets': presets}
                        result.update({'greetingError': '模拟问候语合成失败'} if fail_greeting else {'greeting': greeting})
                    else:
                        raise AssertionError(f'Unexpected preset endpoint: {action}')
            else:
                unexpected.append(f'{request.method} {path}')
                status, result = 500, {'error': 'Unexpected mocked API'}
            await r.fulfill(status=status, content_type='application/json',
                            body=json.dumps(result, ensure_ascii=False))
            return
        asset = (ROOT / 'dist/web' / (path.lstrip('/') or 'index.html')).resolve()
        assert asset.is_relative_to((ROOT / 'dist/web').resolve()), path
        if not asset.is_file():
            unexpected.append(path)
        await r.fulfill(status=200 if asset.is_file() else 404,
                        content_type=mimetypes.guess_type(str(asset))[0] or 'application/octet-stream',
                        body=asset.read_bytes() if asset.is_file() else b'missing')

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or p.chromium.executable_path)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, service_workers='block')
        await context.add_init_script(FAKE_AUDIO)
        await context.route('**/*', route)
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))

        async def open_voice():
            mobile = page.viewport_size['width'] < 768
            if mobile:
                await page.get_by_role('button', name='折叠/展开菜单', exact=True).click()
            await page.get_by_role('button', name='设置', exact=True).click()
            if mobile:
                await page.keyboard.press('Escape')
            await page.get_by_role('tab', name='声音', exact=True).click()
            await expect(page.get_by_role('region', name='音色预设', exact=True)).to_be_visible()

        editor = page.get_by_role('region', name='音色预设', exact=True)
        prompt = editor.get_by_role('textbox', name='音色提示词', exact=True)
        templates = editor.get_by_label('音色提示词模板', exact=True)

        async def finish_audio():
            await page.evaluate('window.__audio.instances.at(-1).finish()')
            await expect(page.get_by_text('正在播放新音色…', exact=True)).to_have_count(0)

        await page.goto(ORIGIN)
        await open_voice()
        await expect(editor.locator('textarea')).to_have_count(1)
        await expect(prompt).to_be_editable()
        await expect(templates).to_be_visible()
        await expect(templates.get_by_role('button')).to_have_count(3)
        (ROOT / '.tools').mkdir(exist_ok=True)
        await page.screenshot(path=str(ROOT / '.tools/single-prompt-desktop.png'), full_page=True)
        assert await templates.evaluate("el => getComputedStyle(el).overflowX === 'auto'")
        initial_prompts = [row['prompt'] for row in presets]
        api_count = len(calls)
        await templates.get_by_role('button', name='填入清亮灵动模板', exact=True).click()
        bright_prompt = TEMPLATES['preset-bright']
        await expect(prompt).to_have_value(bright_prompt)
        await templates.get_by_role('button', name='填入柔甜亲近模板', exact=True).click()
        await expect(prompt).to_have_value(TEMPLATES['preset-warm'])
        assert len(calls) == api_count, 'Templates must not call save/generate APIs'
        assert [row['prompt'] for row in presets] == initial_prompts
        generate = editor.get_by_role('button', name='保存并生成音色', exact=True)
        apply = editor.get_by_role('button', name='应用音色', exact=True)
        await expect(apply).to_be_disabled()
        await prompt.fill('短')
        await expect(generate).to_be_disabled()
        edited = '声音明亮自然，带一点俏皮笑意，中文发音清晰，语气欢快。'
        await prompt.fill('  ' + edited + '  ')
        await expect(editor.get_by_text('未保存', exact=True)).to_be_visible()
        save_gate.clear()
        await generate.click()
        await expect(editor.get_by_role('button', name='保存中…', exact=True)).to_be_disabled()
        assert not any(action.endswith('/generate') for action, _ in calls), calls
        await expect(prompt).to_be_disabled()
        save_gate.set()
        await expect(editor.get_by_role('alert')).to_have_text('模拟生成失败，请重试')
        await expect(prompt).to_have_value(edited)
        assert presets[1]['prompt'] == edited
        await expect(apply).to_be_disabled()
        await generate.click()
        await expect(apply).to_be_enabled()
        preset_calls = [(action, body) for action, body in calls if action.startswith('voice-presets/')]
        assert [action for action, _ in preset_calls] == [
            'voice-presets/save', 'voice-presets/generate', 'voice-presets/generate'], preset_calls
        assert all(body['prompt'] == edited for action, body in preset_calls if action.endswith('/save'))
        await page.wait_for_function('window.__audio.plays.length === 1')
        assert not presets[1]['applied'], 'Generate must not apply'
        await expect(editor.get_by_role('button', name='再听一次', exact=True)).to_be_enabled()
        paused = await page.evaluate('window.__audio.paused')
        await prompt.fill(edited + '再轻柔一点。')
        assert await page.evaluate('window.__audio.paused') > paused
        await expect(editor.get_by_role('button', name='再听一次', exact=True)).to_have_count(0)
        await expect(apply).to_be_disabled()
        assert not any(action.endswith('/apply') for action, _ in calls)

        # Reload restores saved prompt/candidate and discards the dirty edit.
        await page.reload()
        await open_voice()
        await expect(prompt).to_have_value(edited)
        await expect(apply).to_be_enabled()
        await expect(editor.get_by_role('button', name='已生成', exact=True)).to_be_disabled()
        api_count = len(calls)
        await editor.get_by_role('button', name='试听音色', exact=True).click()
        await page.wait_for_function('window.__audio.plays.length === 1')
        assert calls[api_count:] == [('voice-presets/generate', {'presetId': 'preset-warm'})], calls[api_count:]
        assert not presets[1]['applied'], 'Reloaded candidate preview must not apply'
        await finish_audio()
        await page.get_by_role('tab', name='对话', exact=True).click()
        draft = '尚未保存的独立对话草稿，应用音色时必须保留。'
        await page.get_by_label('补充提示词', exact=True).fill(draft)
        await page.get_by_role('tab', name='声音', exact=True).click()
        await apply.click()
        await expect(editor.get_by_role('button', name='已应用', exact=True)).to_be_disabled()
        await page.wait_for_function('window.__audio.plays.length === 2')
        await expect(editor.get_by_text('正在播放新音色…', exact=True)).to_be_visible()
        await finish_audio()
        await page.get_by_role('tab', name='对话', exact=True).click()
        await expect(page.get_by_label('补充提示词', exact=True)).to_have_value(draft)
        await expect(page.get_by_text('有未保存更改', exact=True)).to_be_visible()
        assert settings['system_prompt'] == '已保存的对话设置'
        assert not any(action == 'config' and body for action, body in calls)
        await page.get_by_role('tab', name='声音', exact=True).click()

        # Generate autoplays before apply; denial retries the same local audio.
        await templates.get_by_role('button', name='填入清亮灵动模板', exact=True).click()
        await expect(prompt).to_have_value(bright_prompt)
        await page.evaluate('window.__audio.blocked = true')
        await generate.click()
        await expect(editor.get_by_text('浏览器阻止了语音播放，请点击「重试播放」允许出声。', exact=True)).to_be_visible()
        await page.wait_for_function('window.__audio.plays.length === 3')
        assert not presets[1]['applied']
        api_count = len(calls)
        await editor.get_by_role('button', name='重试播放', exact=True).click()
        await page.wait_for_function('window.__audio.plays.length === 4')
        assert len(calls) == api_count, 'Playback retry must reuse existing audio'
        await expect(editor.get_by_role('button', name='重试播放', exact=True)).to_have_count(0)
        await finish_audio()

        # Synthesis failure keeps the candidate unapplied; retry only fetches its preview.
        await templates.get_by_role('button', name='填入清冷知性模板', exact=True).click()
        calm_prompt = await prompt.input_value()
        assert calm_prompt == TEMPLATES['preset-calm']
        fail_greeting = True
        await generate.click()
        await expect(editor.get_by_role('alert')).to_have_text('音色已生成，试听暂不可用。模拟试听合成失败')
        await expect(editor.get_by_role('button', name='应用音色', exact=True)).to_be_enabled()
        assert not presets[1]['applied']
        assert await page.evaluate('window.__audio.plays.length') == 4
        fail_greeting = False
        api_count = len(calls)
        await editor.get_by_role('button', name='重试试听', exact=True).click()
        await page.wait_for_function('window.__audio.plays.length === 5')
        assert calls[api_count:] == [('voice-presets/greeting', {'presetId': 'preset-warm'})], calls[api_count:]
        assert not presets[1]['applied']
        await expect(editor.get_by_role('button', name='重试试听', exact=True)).to_have_count(0)
        await finish_audio()
        api_count = len(calls)
        await editor.get_by_role('button', name='再听一次', exact=True).click()
        await page.wait_for_function('window.__audio.plays.length === 6')
        assert len(calls) == api_count, 'Replay must reuse audio'
        await finish_audio()
        await editor.get_by_role('button', name='应用音色', exact=True).click()
        await expect(editor.get_by_role('button', name='已应用', exact=True)).to_be_disabled()
        await page.wait_for_function('window.__audio.plays.length === 7')
        await finish_audio()

        await page.set_viewport_size({'width': 390, 'height': 844})
        await prompt.fill('移动端长提示词布局测试。' * 35)
        await expect(prompt).to_be_editable()
        await expect(editor.locator('textarea')).to_have_count(1)
        assert await templates.evaluate("el => getComputedStyle(el).overflowX === 'auto'")
        await templates.evaluate('el => { el.scrollLeft = el.scrollWidth; }')
        assert await templates.evaluate('el => el.scrollWidth <= el.clientWidth || el.scrollLeft > 0'), 'Template strip must scroll horizontally'
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile page overflow'
        assert await editor.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), 'Mobile preset overflow'
        await page.reload()
        await open_voice()
        await expect(prompt).to_have_value(calm_prompt)
        await page.screenshot(path=str(ROOT / '.tools/single-prompt-mobile.png'), full_page=True)
        await expect(editor.get_by_role('button', name='已应用', exact=True)).to_be_disabled()
        assert await page.evaluate('window.__audio.plays.length') == 0, 'Reload must not autoplay stale greeting'
        preset_calls = [(action, body) for action, body in calls if action.startswith('voice-presets/')]
        assert all(body['presetId'] == 'preset-warm' for _, body in preset_calls), 'Templates must not switch saved slots'
        assert presets[0]['prompt'] == initial_prompts[0] and presets[2]['prompt'] == initial_prompts[2]
        assert not errors, errors
        assert not unexpected, unexpected
        print(json.dumps({'singlePrompt': True, 'templatesFillWithoutApi': True,
                          'templatesKeepWarmSlot': True, 'horizontalTemplates': True, 'editablePrompt': True, 'saveBeforeGenerate': True,
                          'failedGenerationRetry': True, 'dirtyApplyBlocked': True,
                          'automaticGreetingPlayback': True, 'autoplayRetry': True,
                          'greetingRetry': True, 'unrelatedDraftPreserved': True,
                          'reloadPersistence': True, 'mobileNoOverflow': True,
                          'apiCalls': len(calls), 'errors': errors}, ensure_ascii=False))
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
