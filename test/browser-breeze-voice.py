"""Breeze fixed voices and Qwen prompt generation; all APIs/audio are fake.
Run after build with ~/.dsh/tools/venv/bin/python test/browser-breeze-voice.py.
"""
import asyncio
import copy
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://breeze-voice.test'
ENDPOINT = 'https://api.breeze.blue/v1/text-to-speech/{voice_id}'
VOICES = {'zh': 'voc_47j4uzfyuxqc', 'ja': 'voc_2qzsatyfq3fg', 'en': 'voc_7va7papsrurz'}
FAKE_AUDIO = """
window.__audio = {plays: [], instances: []};
window.Audio = class {
 constructor(src) { this.src = src; window.__audio.instances.push(this); }
 async play() { window.__audio.plays.push(this.src); this.onplaying?.(); }
 pause() {}
 finish() { this.onended?.(); }
};
"""


async def main():
    qwen_prompt = 'Qwen 独立保存的提示词，温柔自然、咬字清楚。'
    settings = {
        'system_prompt': '已保存的对话设置', 'workspace': '',
        'enabled_tools': [], 'tools_configured': True,
        'tts_voice_provider': 'qwen',
        'tts_profiles': {
            'qwen': {'voice': 'qwen-existing-voice', 'model': 'qwen-audio-3.1-tts-plus'},
            'breeze': {'extra': {'speed': 1.05}, 'voice': 'legacy-generated-breeze-voice'},
        },
        'realtime': {'credential_source': 'provider', 'use_tts_voice': True},
    }
    presets = [
        {'id': key, 'name': name, 'prompt': qwen_prompt, 'candidate': None, 'applied': False}
        for key, name in [('preset-bright', '清亮灵动'), ('preset-warm', '柔甜亲近'), ('preset-calm', '清冷知性')]
    ]
    presets[1]['candidate'] = {'voiceId': 'qwen-existing-candidate', 'prompt': qwen_prompt}
    original_qwen = copy.deepcopy(presets)
    original_qwen_profile = copy.deepcopy(settings['tts_profiles']['qwen'])
    calls, errors, unexpected = [], [], []
    fail_greeting = False
    credential_providers = {
        'bailian': {'ready': True, 'source': 'provider', 'routeAvailable': True, 'credentialRef': 'DASHSCOPE_API_KEY', 'recordKey': 'llm-pi-ai/bailian', 'writable': False, 'networkTested': False},
        'breeze': {'ready': False, 'source': 'provider', 'routeAvailable': False, 'credentialRef': 'BREEZE_API_KEY', 'writable': True, 'networkTested': False},
        'volcengine': {'ready': False, 'source': 'provider', 'routeAvailable': False, 'credentialRef': 'VOLCENGINE_API_KEY', 'writable': True, 'networkTested': False},
    }
    greeting = {'audio': 'UklGRgAAAAABAA==', 'mime': 'audio/wav'}

    async def route(r):
        nonlocal settings
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
                # Breeze no longer has a design hook or preset response dependency.
                result = {'settings': settings, 'voicePresets': presets,
                          'credentials': {'providers': credential_providers},
                          'capabilities': {}, 'models': {}}
            elif action == 'credentials/status':
                assert body == {}, body
                result = {'providers': credential_providers}
            elif action == 'credentials/save':
                assert set(body) == {'provider', 'key'}, body
                assert body['provider'] == 'breeze', body
                assert body['key'] == 'synthetic-breeze-credential', 'Only synthetic keys are used'
                credential_providers['breeze']['ready'] = True
                result = {'providers': credential_providers}
            elif action == 'config/check':
                result = {'valid': True, 'errors': {}, 'warnings': {}}
            elif action == 'config' and request.method == 'PUT':
                settings = copy.deepcopy(body['settings'])
                result = {'settings': settings}
            elif action == 'catalog':
                result = {'tools': [], 'toolExecutionAvailable': True, 'currentWorkspace': '/synthetic/workspace'}
            elif action.startswith('voice-presets/'):
                assert request.method == 'POST', request.method
                assert body.get('provider', 'qwen') == 'qwen', 'Breeze design APIs must never be called'
                preset = next(row for row in presets if row['id'] == body['presetId'])
                if action == 'voice-presets/save':
                    assert set(body) - {'provider'} == {'presetId', 'prompt'}, body
                    if preset['prompt'] != body['prompt']:
                        preset.update(prompt=body['prompt'], candidate=None, applied=False)
                    result = {'voicePresets': presets}
                else:
                    assert set(body) - {'provider'} == {'presetId'}, body
                    if action == 'voice-presets/generate':
                        preset['candidate'] = {'voiceId': 'qwen-generated-candidate', 'prompt': preset['prompt']}
                        result = {'voicePresets': presets, 'candidate': preset['candidate'], 'greeting': greeting}
                    elif action in ('voice-presets/apply', 'voice-presets/greeting'):
                        assert preset['candidate'], 'Cannot apply without a candidate'
                        if action.endswith('/apply'):
                            for row in presets:
                                row['applied'] = row is preset
                            settings['tts_voice_provider'] = 'qwen'
                            settings['tts_profiles']['qwen']['voice'] = preset['candidate']['voiceId']
                        else:
                            assert preset['applied'], 'Greeting must retain applied voice'
                        result = {'settings': settings, 'voicePresets': presets}
                        result.update({'greetingError': '模拟百炼问候语失败'} if fail_greeting else {'greeting': greeting})
                    else:
                        raise AssertionError(f'Unexpected preset action: {action}')
            else:
                unexpected.append(f'{request.method} {path}')
                status, result = 500, {'error': 'Unexpected mocked API'}
            await r.fulfill(status=status, content_type='application/json', body=json.dumps(result, ensure_ascii=False))
            return
        asset = (ROOT / 'dist/web' / (path.lstrip('/') or 'index.html')).resolve()
        assert asset.is_relative_to((ROOT / 'dist/web').resolve()), path
        if not asset.is_file():
            unexpected.append(path)
        await r.fulfill(status=200 if asset.is_file() else 404,
                        content_type=mimetypes.guess_type(str(asset))[0] or 'application/octet-stream',
                        body=asset.read_bytes() if asset.is_file() else b'missing')

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True,
            executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or p.chromium.executable_path)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, service_workers='block')
        await context.add_init_script(FAKE_AUDIO)
        await context.route('**/*', route)
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN)
        await page.get_by_role('button', name='设置', exact=True).click()
        await page.get_by_role('tab', name='声音', exact=True).click()
        editor = page.get_by_role('region', name='音色预设', exact=True)
        prompt = editor.get_by_role('textbox', name='音色提示词', exact=True)
        templates = editor.get_by_label('音色提示词模板', exact=True)
        realtime = page.locator('#realtime-provider')
        provider = page.get_by_role('combobox', name='语音提供方', exact=True)
        save = page.get_by_role('button', name='保存设置', exact=True)
        await expect(prompt).to_have_value(qwen_prompt)
        await expect(editor.get_by_role('button', name='应用音色', exact=True)).to_be_enabled()
        await editor.get_by_role('button', name='使用内置默认提示词', exact=True).click()
        default_prompt = await prompt.input_value()
        assert default_prompt.startswith('日本动漫中初中女生角色的配音风格。')
        assert 4 <= len(default_prompt) <= 500
        assert not any(action.startswith('voice-presets/') for action, _ in calls), 'Choosing default must only edit the prompt'

        bailian_credentials = page.get_by_role('region', name='百炼凭据', exact=True)
        await expect(bailian_credentials.get_by_role('button', name='更新凭据', exact=True)).to_be_disabled()
        await expect(bailian_credentials.get_by_text('请在 DSH 设置 → 模型 → 已有的百炼提供方中管理凭据，然后回来检查状态。', exact=True)).to_be_visible()
        await bailian_credentials.get_by_text('如何获取凭据', exact=True).click()
        await expect(bailian_credentials.get_by_role('link', name='百炼 API Key 控制台', exact=True)).to_have_attribute('href', 'https://bailian.console.aliyun.com/model/settings/api-key')
        await expect(bailian_credentials.get_by_role('link', name='官方获取说明', exact=True)).to_have_attribute('href', 'https://help.aliyun.com/zh/model-studio/get-api-key')
        await bailian_credentials.get_by_text('凭据绑定', exact=True).click()
        await expect(bailian_credentials.get_by_text('llm-pi-ai/bailian', exact=True)).to_be_visible()
        await expect(bailian_credentials.get_by_text('DASHSCOPE_API_KEY', exact=True)).to_have_count(0)
        await realtime.click()
        volcano = page.get_by_role('option', name='火山引擎 · WorkInProgress', exact=True)
        await expect(volcano).to_have_attribute('aria-disabled', 'true')
        await volcano.dispatch_event('click')
        await expect(realtime).to_have_text('百炼 · Qwen-Audio-Realtime')
        await page.keyboard.press('Escape')
        await realtime.click()
        await page.keyboard.press('End')
        await page.keyboard.press('Enter')
        await expect(realtime).to_have_text('百炼 · Qwen-Audio-Realtime')
        await page.keyboard.press('Escape')

        async def choose_provider(name):
            await provider.click()
            await page.get_by_role('option', name=name, exact=True).click()

        await choose_provider('Breeze Blue')
        fixed = page.get_by_role('region', name='Breeze 三语预设音色', exact=True)
        await expect(fixed).to_be_visible()
        for voice in VOICES.values():
            await expect(fixed.get_by_text(voice, exact=True)).to_be_visible()
        await expect(fixed.get_by_text('按合成语言自动匹配中文、日语或英语预设，暂不支持提示词生成或音色复刻。', exact=True)).to_be_visible()
        await expect(editor).to_have_count(0)
        await expect(page.get_by_role('button', name='保存并生成音色', exact=True)).to_have_count(0)
        await expect(page.get_by_text('legacy-generated-breeze-voice', exact=True)).to_have_count(0)
        await expect(page.get_by_text('先保存设置，再生成或应用音色。', exact=True)).to_have_count(0)
        await expect(page.locator('#tts-params')).not_to_be_visible()
        await page.get_by_text('高级设置', exact=True).click()
        await expect(page.get_by_label('模型', exact=True)).not_to_have_value('')
        await expect(page.get_by_label('合成接口', exact=True)).to_have_value(ENDPOINT)
        params = page.get_by_label('合成参数（JSON）', exact=True)
        await params.fill('{')
        await expect(save).to_be_disabled()
        await expect(params).to_have_attribute('aria-invalid', 'true')
        await params.fill('[1]')
        await expect(save).to_be_disabled()
        await params.fill('{"speed": 1.05}')
        await expect(params).to_have_attribute('aria-invalid', 'false')

        breeze_credentials = page.get_by_role('region', name='Breeze凭据', exact=True)
        await expect(page.get_by_label('Breeze 凭据文件', exact=True)).to_have_count(0)
        await breeze_credentials.get_by_text('如何获取凭据', exact=True).click()
        await expect(breeze_credentials.get_by_role('link', name='Breeze 官方鉴权说明', exact=True)).to_have_attribute('href', 'https://docs.breezeblue.ai/authentication')
        await breeze_credentials.get_by_role('button', name='配置凭据', exact=True).click()
        credential = page.get_by_label('Breeze API Key', exact=True)
        assert await credential.get_attribute('type') == 'pass' + 'word'
        await credential.fill('discard-on-cancel')
        await breeze_credentials.get_by_role('button', name='取消', exact=True).click()
        await breeze_credentials.get_by_role('button', name='配置凭据', exact=True).click()
        await expect(credential).to_have_value('')
        await credential.fill('synthetic-breeze-credential')
        await breeze_credentials.get_by_role('button', name='保存到 DSH', exact=True).click()
        await expect(breeze_credentials.get_by_text('可读取', exact=True)).to_be_visible()
        await breeze_credentials.get_by_role('button', name='更新凭据', exact=True).click()
        await expect(credential).to_have_value('')
        await breeze_credentials.get_by_role('button', name='取消', exact=True).click()
        await breeze_credentials.get_by_role('button', name='检查状态', exact=True).click()
        await expect(breeze_credentials.get_by_text('状态已刷新；未发起模型请求。', exact=True)).to_be_visible()
        assert await page.evaluate('Object.keys(localStorage).length') == 0
        await expect(page.get_by_text('有未保存更改', exact=True)).to_be_visible()
        assert not any(action.startswith('voice-presets/') for action, _ in calls)
        await save.click()
        await expect(page.get_by_text('有未保存更改', exact=True)).to_have_count(0)
        assert settings['tts_profiles']['breeze']['voice'] == VOICES['zh']
        assert settings['tts_profiles']['breeze']['endpoint'] == ENDPOINT
        assert settings['tts_profiles']['breeze']['extra'] == {'speed': 1.05}
        assert settings['tts_profiles']['qwen'] == original_qwen_profile
        assert presets == original_qwen

        # Qwen retains editable templates, explicit default generation, replay/apply/retry.
        await choose_provider('Qwen TTS（默认）')
        await expect(prompt).to_have_value(default_prompt)
        await expect(templates.get_by_role('button')).to_have_count(3)
        await expect(editor.get_by_role('button', name='保存并生成音色', exact=True)).to_be_enabled()
        await editor.get_by_role('button', name='保存并生成音色', exact=True).click()
        apply = editor.get_by_role('button', name='应用音色', exact=True)
        await expect(apply).to_be_enabled()
        fail_greeting = True
        await apply.click()
        await expect(editor.get_by_role('button', name='已应用', exact=True)).to_be_disabled()
        await expect(editor.get_by_role('alert')).to_have_text('音色已应用，试听暂不可用。模拟百炼问候语失败')
        fail_greeting = False
        await editor.get_by_role('button', name='重试试听', exact=True).click()
        await page.wait_for_function('window.__audio.plays.length === 2')
        await page.evaluate('window.__audio.instances.at(-1).finish()')
        preset_calls = [(action, body) for action, body in calls if action.startswith('voice-presets/')]
        assert [action for action, _ in preset_calls] == ['voice-presets/save', 'voice-presets/generate', 'voice-presets/apply', 'voice-presets/greeting'], preset_calls
        assert all(body.get('provider', 'qwen') == 'qwen' for _, body in preset_calls)
        assert preset_calls[0][1]['prompt'] == default_prompt
        assert settings['tts_profiles']['qwen']['voice'] == 'qwen-generated-candidate'
        assert settings['tts_profiles']['breeze']['voice'] == VOICES['zh']
        await templates.get_by_role('button', name='填入清亮灵动模板', exact=True).click()
        await expect(prompt).not_to_have_value(default_prompt)
        await editor.get_by_role('button', name='使用内置默认提示词', exact=True).click()
        await expect(prompt).to_have_value(default_prompt)

        await choose_provider('Breeze Blue')
        await expect(editor).to_have_count(0)
        await expect(fixed).to_be_visible()
        await page.set_viewport_size({'width': 390, 'height': 844})
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile Breeze overflow'
        assert await fixed.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), 'Fixed voice mapping overflow'
        await choose_provider('Qwen TTS（默认）')
        await prompt.fill('移动端百炼长提示词布局测试。' * 20)
        await expect(prompt).to_be_editable()
        await expect(editor.locator('textarea')).to_have_count(1)
        assert await templates.evaluate("el => getComputedStyle(el).overflowX === 'auto'")
        await templates.evaluate('el => { el.scrollLeft = el.scrollWidth; }')
        assert await templates.evaluate('el => el.scrollWidth <= el.clientWidth || el.scrollLeft > 0')
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile Qwen overflow'
        assert not any(action.startswith('realtime/') for action, _ in calls)
        assert not any(action.startswith('voice-presets/') and body.get('provider') == 'breeze' for action, body in calls)
        assert not errors, errors
        assert not unexpected, unexpected
        await browser.close()
    print('PASS: Breeze fixed trilingual IDs; no Breeze design API; Qwen explicit default prompt generation/apply/retry; shared credential save/status/cancel and official guidance; disabled Volcano; mobile layout; zero external requests')


if __name__ == '__main__':
    asyncio.run(main())
