"""Breeze fixed trilingual voices and the Breeze credential round-trip, against mocked plugin APIs.

Runs through the production mount path (`browser_harness.Harness`): host page -> `lib/client.js`
bridge -> iframe -> mocked `/api/voice-workbench/*`, so the bridge's method whitelist and abort
handling are exercised too. No network, no screenshots, nothing written into the repo tree.

Fixed voice ids are read from `src/breeze-voices.js` / `src/tts-config.js` rather than copied here:
a voice swap must not be able to leave this script asserting yesterday's id (it did before).

Run after build with `.tools/pw-venv/bin/python test/browser-breeze-voice.py`.
"""
import asyncio
import copy
import json
import subprocess

from playwright.async_api import expect

from browser_harness import ROOT, Harness


def breeze_source():
    """The single source of truth for the fixed voice table, endpoint and model."""
    script = (
        f"Promise.all([import('{(ROOT / 'src/breeze-voices.js').as_uri()}'),"
        f"import('{(ROOT / 'src/tts-config.js').as_uri()}')])"
        '.then(([voices,config])=>console.log(JSON.stringify({preset:voices.BREEZE_PRESET_VOICES,'
        'zh:voices.BREEZE_ZH_VOICES,endpoint:config.TTS_BUILTINS.breeze.endpoint,'
        'model:config.TTS_BUILTINS.breeze.model})))'
    )
    run = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


async def until(predicate, timeout=5.0, interval=0.1):
    """Poll for the recorded side effect instead of trusting an already-visible DOM value."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


async def main():
    source = breeze_source()
    voices, zh_voices = source['preset'], source['zh']
    # 默认中文音色必须是表里的第一条，这条不变量变了 UI 的默认值也会跟着变
    assert voices['zh'] == zh_voices[0]['voiceId'], (voices, zh_voices)

    qwen_prompt = 'Qwen 独立保存的提示词，温柔自然、咬字清楚。'
    state = {
        'settings': {
            'system_prompt': '已保存的对话设置', 'workspace': '', 'enabled_tools': [], 'tools_configured': True,
            'tts_voice_provider': 'qwen',
            'tts_profiles': {
                'qwen': {'voice': 'qwen-existing-voice', 'model': 'qwen-audio-3.1-tts-plus'},
                'breeze': {'extra': {'speed': 1.05}, 'voice': 'legacy-generated-breeze-voice'},
            },
            'realtime': {'credential_source': 'provider', 'use_tts_voice': True},
        },
        'presets': [{'id': key, 'name': name, 'prompt': qwen_prompt, 'candidate': None, 'applied': False}
                    for key, name in [('preset-bright', '清亮灵动'), ('preset-warm', '柔甜亲近'), ('preset-calm', '清冷知性')]],
        'providers': {
            'bailian': {'ready': True, 'source': 'provider', 'routeAvailable': True, 'credentialRef': 'DASHSCOPE_API_KEY',
                        'recordKey': 'llm-pi-ai/bailian', 'writable': False, 'networkTested': False},
            'breeze': {'ready': False, 'source': 'provider', 'routeAvailable': False, 'credentialRef': 'BREEZE_API_KEY',
                       'writable': True, 'networkTested': False},
            'volcengine': {'ready': False, 'source': 'provider', 'routeAvailable': False, 'credentialRef': 'VOLCENGINE_API_KEY',
                           'writable': True, 'networkTested': False},
        },
    }
    state['presets'][1]['candidate'] = {'voiceId': 'qwen-existing-candidate', 'prompt': qwen_prompt}
    original_presets = copy.deepcopy(state['presets'])
    original_qwen_profile = copy.deepcopy(state['settings']['tts_profiles']['qwen'])

    def config_result():
        return {'settings': state['settings'], 'voicePresets': state['presets'],
                'credentials': {'providers': state['providers']}, 'capabilities': {}, 'models': {}}

    async def config(method, body):
        if method == 'PUT':
            state['settings'] = copy.deepcopy(body['settings'])
        return config_result()

    async def credentials_save(method, body):
        # 只允许合成凭据；任何真实 key 都不该出现在测试里
        assert method == 'POST' and body.get('provider') == 'breeze', body
        assert body.get('key') == 'synthetic-breeze-credential', body
        state['providers']['breeze']['ready'] = True
        return {'providers': state['providers']}

    async def credentials_status(method, body):
        assert body == {}, body
        return {'providers': state['providers']}

    harness = Harness(routes={'config': config, 'credentials/save': credentials_save,
                              'credentials/status': credentials_status}, settings=state['settings'])
    try:
        frame = await harness.start()
        await harness.nav('设置')
        await frame.get_by_role('tab', name='声音', exact=True).click()
        editor = frame.get_by_role('region', name='音色预设', exact=True)
        prompt = editor.get_by_role('textbox', name='音色提示词', exact=True)
        provider = frame.get_by_role('combobox', name='语音提供方', exact=True)
        save = frame.get_by_role('button', name='保存设置', exact=True)

        async def choose(label):
            await provider.click()
            await frame.get_by_role('option', name=label, exact=True).click()

        # 默认提供方是 Qwen：音色预设编辑器在场，服务端提示词原样显示
        await expect(prompt).to_have_value(qwen_prompt)
        await expect(editor.get_by_role('button', name='应用音色', exact=True)).to_be_enabled()

        # 百炼凭据由 DSH 提供方托管：只读、给出指引，不提供本地填写入口
        bailian = frame.get_by_role('region', name='百炼凭据', exact=True)
        await expect(bailian.get_by_role('button', name='更新凭据', exact=True)).to_be_disabled()
        await expect(bailian.get_by_text(
            '请在 DSH 设置 → 模型 → 已有的百炼提供方中管理凭据，然后回来检查状态。', exact=True)).to_be_visible()
        await bailian.get_by_text('如何获取凭据', exact=True).click()
        await expect(bailian.get_by_role('link', name='百炼 API Key 控制台', exact=True)).to_have_attribute(
            'href', 'https://bailian.console.aliyun.com/model/settings/api-key')
        await expect(bailian.get_by_role('link', name='官方获取说明', exact=True)).to_have_attribute(
            'href', 'https://help.aliyun.com/zh/model-studio/get-api-key')
        await bailian.get_by_text('凭据绑定', exact=True).click()
        await expect(bailian.get_by_text('llm-pi-ai/bailian', exact=True)).to_be_visible()
        await expect(bailian.get_by_text('DASHSCOPE_API_KEY', exact=True)).to_have_count(0)

        # 火山引擎仍是 WorkInProgress：键盘和鼠标都选不中
        realtime = frame.locator('#realtime-provider')
        await realtime.click()
        volcano = frame.get_by_role('option', name='火山引擎 · WorkInProgress', exact=True)
        await expect(volcano).to_have_attribute('aria-disabled', 'true')
        await volcano.dispatch_event('click')
        await expect(realtime).to_have_text('百炼 · Qwen-Audio-Realtime')
        await harness.page.keyboard.press('Escape')
        await realtime.click()
        await harness.page.keyboard.press('End')
        await harness.page.keyboard.press('Enter')
        await expect(realtime).to_have_text('百炼 · Qwen-Audio-Realtime')
        await harness.page.keyboard.press('Escape')

        # ---- Breeze：固定三语预设音色 ------------------------------------------
        await choose('Breeze Blue')
        fixed = frame.get_by_role('region', name='Breeze 预设音色', exact=True)
        await expect(fixed).to_be_visible()
        await expect(fixed.get_by_text(
            '中文可在两种情绪间切换，日语与英语使用固定预设；暂不支持提示词生成或音色复刻。', exact=True)).to_be_visible()
        zh_trigger = frame.locator('#breeze-zh-voice')
        await expect(zh_trigger).to_have_text(f"{zh_voices[0]['name']} · {zh_voices[0]['voiceId']}")
        for language, label in (('ja', '日语'), ('en', '英语')):
            await expect(fixed.get_by_text(f'{label} · {language}', exact=True)).to_be_visible()
            await expect(fixed.get_by_text(voices[language], exact=True)).to_be_visible()
        # Breeze 没有提示词设计/复刻入口，所以音色预设编辑器整块不该出现
        await expect(editor).to_have_count(0)

        await zh_trigger.click()
        for voice in zh_voices:
            await expect(frame.get_by_role('option', name=f"{voice['name']} · {voice['voiceId']}", exact=True)).to_be_visible()
        await frame.get_by_role('option', name=f"{zh_voices[1]['name']} · {zh_voices[1]['voiceId']}", exact=True).click()
        await expect(zh_trigger).to_have_text(f"{zh_voices[1]['name']} · {zh_voices[1]['voiceId']}")

        await frame.get_by_text('高级设置', exact=True).click()
        await expect(frame.get_by_label('模型', exact=True)).to_have_value(source['model'])
        await expect(frame.get_by_label('合成接口', exact=True)).to_have_value(source['endpoint'])
        params = frame.get_by_label('合成参数（JSON）', exact=True)
        await params.fill('{')
        await expect(save).to_be_disabled()
        await expect(params).to_have_attribute('aria-invalid', 'true')
        await params.fill('[1]')
        await expect(save).to_be_disabled()
        await params.fill('{"speed": 1.05}')
        await expect(params).to_have_attribute('aria-invalid', 'false')

        # ---- Breeze 凭据：只写、取消即清空、保存后徽标变可读取 -------------------
        credentials = frame.get_by_role('region', name='Breeze凭据', exact=True)
        await expect(credentials.get_by_text('保存到 DSH 共享凭据，无需另外添加对话模型。', exact=True)).to_be_visible()
        await credentials.get_by_text('如何获取凭据', exact=True).click()
        await expect(credentials.get_by_role('link', name='Breeze 官方鉴权说明', exact=True)).to_have_attribute(
            'href', 'https://docs.breezeblue.ai/authentication')
        await credentials.get_by_role('button', name='配置凭据', exact=True).click()
        credential = frame.get_by_label('Breeze API Key', exact=True)
        assert await credential.get_attribute('type') == 'pass' + 'word', '凭据输入框不能是明文'
        await credential.fill('discard-on-cancel')
        await credentials.get_by_role('button', name='取消', exact=True).click()
        await expect(credential).to_have_count(0)
        assert not [c for c in harness.calls if c[1] == 'credentials/save'], '取消不得写出凭据'
        await credentials.get_by_role('button', name='配置凭据', exact=True).click()
        await expect(credential).to_have_value('')
        await credential.fill('synthetic-breeze-credential')
        await credentials.get_by_role('button', name='保存到 DSH', exact=True).click()
        await expect(credentials.get_by_text('已保存到 DSH；未测试远端鉴权。', exact=True)).to_be_visible()
        await expect(credentials.get_by_text('可读取', exact=True)).to_be_visible()
        await credentials.get_by_role('button', name='更新凭据', exact=True).click()
        await expect(credential).to_have_value('')
        await credentials.get_by_role('button', name='取消', exact=True).click()
        await credentials.get_by_role('button', name='检查状态', exact=True).click()
        await expect(credentials.get_by_text('状态已刷新；未发起模型请求。', exact=True)).to_be_visible()
        saved_keys = [body for _, action, body in harness.calls if action == 'credentials/save']
        assert saved_keys == [{'provider': 'breeze', 'key': 'synthetic-breeze-credential'}], saved_keys

        # ---- 保存：Breeze 落盘、Qwen 一律不动 ----------------------------------
        await expect(frame.get_by_text('有未保存更改', exact=True)).to_be_visible()
        await save.click()
        assert await until(lambda: any(m == 'PUT' and a == 'config' for m, a, _ in harness.calls)), harness.calls
        await expect(frame.get_by_text('已保存', exact=True)).to_be_visible()
        put = [body['settings'] for m, a, body in harness.calls if m == 'PUT' and a == 'config'][-1]
        assert put['tts_voice_provider'] == 'breeze', put['tts_voice_provider']
        assert put['tts_profiles']['breeze']['voice'] == voices['zh'], put['tts_profiles']['breeze']
        assert put['tts_profiles']['breeze']['zhVoice'] == zh_voices[1]['voiceId'], put['tts_profiles']['breeze']
        assert put['tts_profiles']['breeze']['endpoint'] == source['endpoint'], put['tts_profiles']['breeze']
        assert put['tts_profiles']['breeze']['extra'] == {'speed': 1.05}, put['tts_profiles']['breeze']
        assert put['tts_profiles']['qwen'] == original_qwen_profile, put['tts_profiles']['qwen']
        assert state['presets'] == original_presets, '配置音色不该写到提示词预设'
        assert not [c for c in harness.calls if c[1].startswith('voice-presets/')], 'Breeze 不得调用提示词生成接口'
        assert not [c for c in harness.calls if c[1].startswith('realtime/')], harness.calls

        await harness.page.set_viewport_size({'width': 390, 'height': 844})
        await expect(fixed).to_be_visible()
        bounds = await harness.child.evaluate("()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})")
        assert bounds['scroll'] <= bounds['width'] + 2, bounds
        assert await fixed.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), '固定音色表在窄屏溢出'
        await harness.page.set_viewport_size({'width': 1440, 'height': 1000})

        # 切回 Qwen：Breeze 的改动没有污染提示词预设，编辑器照旧
        await choose('Qwen TTS（默认）')
        await expect(editor).to_be_visible()
        await expect(prompt).to_have_value(qwen_prompt)
        await expect(fixed).to_have_count(0)

        assert not harness.errors, harness.errors
    finally:
        await harness.close()
    print('PASS: Breeze fixed trilingual voices read from src/breeze-voices.js; no prompt editor for Breeze; '
          'advanced model/endpoint/JSON validation; credential save/status/cancel; zh voice + profile persisted '
          'without touching Qwen; disabled Volcano; 390px layout; zero design API calls')


asyncio.run(main())
