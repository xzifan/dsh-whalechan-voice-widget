"""Editable voice preset regression: save-before-generate, autoplay/retry, no cross-slot writes.

Runs through the production mount path (`browser_harness.Harness`): host page -> `lib/client.js`
bridge -> iframe -> mocked `/api/voice-workbench/*`, so the bridge's method whitelist and abort
handling are exercised too. No network, no screenshots, nothing written into the repo tree.

Template prompts are read from `web/src/lib/voice-layer.js` instead of being copied here, so
re-wording a template cannot leave this script asserting yesterday's text.

Run after build with `.tools/pw-venv/bin/python test/browser-voice-presets.py`.
"""
import asyncio
import copy
import json
import subprocess

from playwright.async_api import expect

from browser_harness import ROOT, Harness

AUDIO_STUB = """
window.__audio={plays:[],instances:[],blocked:false,ended:0,paused:0};
window.Audio=class{constructor(src){this.src=src;window.__audio.instances.push(this)}
async play(){window.__audio.plays.push(this.src);
 if(window.__audio.blocked){window.__audio.blocked=false;
  throw new DOMException('Synthetic autoplay denial','NotAllowedError')}
 this.onplaying?.()}
pause(){window.__audio.paused++}
finish(){window.__audio.ended++;this.onended?.()}};
"""


def templates():
    """The prompt text each template button fills, straight from the UI's own table."""
    script = f"import('{(ROOT / 'web/src/lib/voice-layer.js').as_uri()}').then(m=>console.log(JSON.stringify(m.VOICE_PRESETS)))"
    run = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    return {item['id']: item['designPrompt'] for item in json.loads(run.stdout)}


async def main():
    prompts = templates()
    edited = '声音明亮自然，带一点俏皮笑意，中文发音清晰，语气欢快。'
    greeting = {'audio': 'UklGRgAAAAABAA==', 'mime': 'audio/wav'}
    gate = asyncio.Event()
    gate.set()
    fail = {'generation': True, 'greeting': False}
    state = {
        'settings': {
            'system_prompt': '已保存的对话设置', 'workspace': '', 'enabled_tools': [], 'tools_configured': True,
            'tts_voice_provider': 'qwen', 'tts_profiles': {'qwen': {'voice': 'original-voice'}},
            'realtime': {'credential_source': 'provider', 'use_tts_voice': True},
        },
        'presets': [{'id': key, 'name': name, 'prompt': '自然清晰、温柔明亮的中文女声。', 'candidate': None, 'applied': False}
                    for key, name in [('preset-bright', '清亮灵动'), ('preset-warm', '柔甜亲近'), ('preset-calm', '清冷知性')]],
    }
    initial = [row['prompt'] for row in state['presets']]

    def slot(body, keys):
        assert set(body) == keys, body
        return next(row for row in state['presets'] if row['id'] == body['presetId'])

    async def config(method, body):
        if method == 'PUT':
            state['settings'] = copy.deepcopy(body['settings'])
        return {'settings': state['settings'], 'voicePresets': state['presets'],
                'credentials': {'bailian': {'ready': True, 'source': 'provider'}},
                'capabilities': {}, 'models': {}}

    async def save(method, body):
        preset = slot(body, {'presetId', 'prompt'})
        await gate.wait()
        if preset['prompt'] != body['prompt']:
            preset.update(prompt=body['prompt'], candidate=None, applied=False)
        return {'voicePresets': state['presets']}

    async def generate(method, body):
        preset = slot(body, {'presetId'})
        if fail['generation']:
            fail['generation'] = False
            return 503, {'error': '模拟生成失败，请重试'}
        preset['candidate'] = {'voiceId': 'synthetic-' + preset['id'], 'prompt': preset['prompt']}
        result = {'voicePresets': state['presets'], 'candidate': preset['candidate']}
        if fail['greeting']:
            result['greetingError'] = '模拟试听合成失败'
        else:
            result['greeting'] = greeting
        return result

    def preview(apply):
        async def handle(method, body):
            preset = slot(body, {'presetId'})
            assert preset['candidate'], '没有候选音色的槽位不该被应用/试听'
            if apply:
                for row in state['presets']:
                    row['applied'] = row is preset
                state['settings']['tts_profiles']['qwen'] = {'voice': preset['candidate']['voiceId'], 'model': 'qwen3-tts-vd-realtime'}
            result = {'settings': state['settings'], 'voicePresets': state['presets']}
            if fail['greeting']:
                result['greetingError'] = '模拟问候语合成失败'
            else:
                result['greeting'] = greeting
            return result
        return handle

    harness = Harness(routes={'config': config, 'voice-presets/save': save, 'voice-presets/generate': generate,
                              'voice-presets/apply': preview(True), 'voice-presets/greeting': preview(False)},
                      settings=state['settings'], init_scripts=[AUDIO_STUB])
    try:
        frame = await harness.start()
        editor = frame.get_by_role('region', name='音色预设', exact=True)
        prompt = editor.get_by_role('textbox', name='音色提示词', exact=True)
        strip = editor.get_by_role('group', name='音色提示词模板', exact=True)
        save_generate = editor.get_by_role('button', name='保存并生成音色', exact=True)
        apply_voice = editor.get_by_role('button', name='应用音色', exact=True)

        async def open_voice():
            mobile = harness.page.viewport_size['width'] < 768
            if mobile:
                await frame.get_by_role('button', name='折叠/展开菜单', exact=True).click()
            await harness.nav('设置')
            if mobile:  # 抽屉式侧栏在窄屏要靠 Escape 收起，否则设置视图被盖住
                await harness.page.keyboard.press('Escape')
            await frame.get_by_role('tab', name='声音', exact=True).click()
            await expect(editor).to_be_visible()

        async def plays(count):
            await harness.child.wait_for_function('n => window.__audio.plays.length === n', arg=count, timeout=8000)

        async def replay_count():
            return await harness.child.evaluate('window.__audio.plays.length')

        async def finish_audio():
            await harness.child.evaluate('window.__audio.instances.at(-1).finish()')
            await expect(editor.get_by_text('正在播放新音色…', exact=True)).to_have_count(0)

        def preset_calls():
            return [(action, body) for _, action, body in harness.calls if action.startswith('voice-presets/')]

        # 单槽位编辑器：一个提示词框 + 模板条，模板只填字不发请求、不切槽位
        await open_voice()
        await expect(editor.locator('textarea')).to_have_count(1)
        await expect(prompt).to_be_editable()
        await expect(strip.get_by_role('button')).to_have_count(len(prompts))
        api_before = len(harness.calls)
        await strip.get_by_role('button', name='填入清亮灵动模板', exact=True).click()
        await expect(prompt).to_have_value(prompts['preset-bright'])
        await strip.get_by_role('button', name='填入柔甜亲近模板', exact=True).click()
        await expect(prompt).to_have_value(prompts['preset-warm'])
        assert len(harness.calls) == api_before, '填模板不该发任何请求'
        assert [row['prompt'] for row in state['presets']] == initial, '填模板不该改服务端槽位'

        # 门槛：没候选音色不能应用；提示词太短不能生成
        await expect(apply_voice).to_be_disabled()
        await prompt.fill('短')
        await expect(save_generate).to_be_disabled()

        # 先保存再生成：保存未返回时按钮停在「保存中…」且不得发生成请求
        await prompt.fill('  ' + edited + '  ')
        await expect(editor.get_by_text('未保存', exact=True)).to_be_visible()
        gate.clear()
        await save_generate.click()
        await expect(editor.get_by_role('button', name='保存中…', exact=True)).to_be_disabled()
        assert not [call for call in preset_calls() if call[0] == 'voice-presets/generate'], '保存未完成就发生了生成'
        await expect(prompt).to_be_disabled()
        gate.set()
        await expect(editor.get_by_role('alert')).to_have_text('模拟生成失败，请重试')
        await expect(prompt).to_have_value(edited)
        assert state['presets'][1]['prompt'] == edited, '保存应落盘被 trim 后的提示词'
        await expect(apply_voice).to_be_disabled()

        # 重试生成成功：自动试听但不等于应用
        await save_generate.click()
        await expect(apply_voice).to_be_enabled()
        assert [action for action, _ in preset_calls()] == ['voice-presets/save', 'voice-presets/generate', 'voice-presets/generate'], preset_calls()
        assert preset_calls()[0][1] == {'presetId': 'preset-warm', 'prompt': edited}, preset_calls()[0]
        await plays(1)
        assert not state['presets'][1]['applied'], '生成不等于应用'
        await expect(editor.get_by_role('button', name='再听一次', exact=True)).to_be_enabled()

        # 再改字：停掉正在播的旧音色、收走重听入口、应用重新禁用
        paused = await harness.child.evaluate('window.__audio.paused')
        await prompt.fill(edited + '再轻柔一点。')
        assert await harness.child.evaluate('window.__audio.paused') > paused, '改提示词必须停掉旧音色'
        await expect(editor.get_by_role('button', name='再听一次', exact=True)).to_have_count(0)
        await expect(apply_voice).to_be_disabled()
        assert not [call for call in preset_calls() if call[0] == 'voice-presets/apply'], '脏草稿下不该发出应用请求'

        # 刷新：保留已保存提示词与候选音色，丢掉未保存的编辑
        await harness.page.reload()
        await frame.get_by_role('heading', name='和小鲸鱼娘聊一会儿', exact=True).wait_for(timeout=15000)
        await open_voice()
        await expect(prompt).to_have_value(edited)
        await expect(apply_voice).to_be_enabled()
        await expect(editor.get_by_role('button', name='已生成', exact=True)).to_be_disabled()

        # 「试听音色」在本地没有音频时只重取试听，不重新应用
        api_before = len(harness.calls)
        await editor.get_by_role('button', name='试听音色', exact=True).click()
        await plays(1)
        assert harness.calls[api_before:] == [('POST', 'voice-presets/generate', {'presetId': 'preset-warm'})], harness.calls[api_before:]
        assert not state['presets'][1]['applied'], '重新试听不等于应用'
        await finish_audio()

        # 应用音色：播放新音色、保留无关的对话草稿、不顺手写设置
        await frame.get_by_role('tab', name='对话', exact=True).click()
        draft = '尚未保存的独立对话草稿，应用音色时必须保留。'
        await frame.get_by_label('补充提示词', exact=True).fill(draft)
        await frame.get_by_role('tab', name='声音', exact=True).click()
        await apply_voice.click()
        await expect(editor.get_by_role('button', name='已应用', exact=True)).to_be_disabled()
        await plays(2)
        await expect(editor.get_by_text('正在播放新音色…', exact=True)).to_be_visible()
        await finish_audio()
        await frame.get_by_role('tab', name='对话', exact=True).click()
        await expect(frame.get_by_label('补充提示词', exact=True)).to_have_value(draft)
        await expect(frame.get_by_text('有未保存更改', exact=True)).to_be_visible()
        assert state['settings']['system_prompt'] == '已保存的对话设置'
        assert not [call for call in harness.calls if call[0] == 'PUT' and call[1] == 'config'], '应用音色不得写设置'
        await frame.get_by_role('tab', name='声音', exact=True).click()

        # 浏览器拦截自动播放：报错可重试，重试用同一份本地音频（零请求）
        await strip.get_by_role('button', name='填入清亮灵动模板', exact=True).click()
        await expect(prompt).to_have_value(prompts['preset-bright'])
        await harness.child.evaluate('window.__audio.blocked = true')
        await save_generate.click()
        await expect(editor.get_by_text('浏览器阻止了语音播放，请点击「重试播放」允许出声。', exact=True)).to_be_visible()
        await plays(3)
        assert not state['presets'][1]['applied']
        api_before = len(harness.calls)
        await editor.get_by_role('button', name='重试播放', exact=True).click()
        await plays(4)
        assert len(harness.calls) == api_before, '重试播放必须复用已拿到的音频'
        await expect(editor.get_by_role('button', name='重试播放', exact=True)).to_have_count(0)
        await finish_audio()

        # 试听合成失败：候选音色保留、可应用；「重试试听」只补试听
        await strip.get_by_role('button', name='填入清冷知性模板', exact=True).click()
        calm = await prompt.input_value()
        assert calm == prompts['preset-calm']
        fail['greeting'] = True
        await save_generate.click()
        await expect(editor.get_by_role('alert')).to_have_text('音色已生成，试听暂不可用。模拟试听合成失败')
        await expect(apply_voice).to_be_enabled()
        assert not state['presets'][1]['applied']
        assert await replay_count() == 4, '试听合成失败不该播放'
        fail['greeting'] = False
        api_before = len(harness.calls)
        await editor.get_by_role('button', name='重试试听', exact=True).click()
        await plays(5)
        assert harness.calls[api_before:] == [('POST', 'voice-presets/greeting', {'presetId': 'preset-warm'})], harness.calls[api_before:]
        assert not state['presets'][1]['applied']
        await expect(editor.get_by_role('button', name='重试试听', exact=True)).to_have_count(0)
        await finish_audio()
        api_before = len(harness.calls)
        await editor.get_by_role('button', name='再听一次', exact=True).click()
        await plays(6)
        assert len(harness.calls) == api_before, '再听一次必须复用本地音频'
        await finish_audio()
        await apply_voice.click()
        await expect(editor.get_by_role('button', name='已应用', exact=True)).to_be_disabled()
        await plays(7)
        await finish_audio()

        # 窄屏：长提示词仍可编辑，页面与预设区都不横向溢出
        await harness.page.set_viewport_size({'width': 390, 'height': 844})
        await prompt.fill('移动端长提示词布局测试。' * 35)
        await expect(prompt).to_be_editable()
        await expect(editor.locator('textarea')).to_have_count(1)
        bounds = await harness.child.evaluate('()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})')
        assert bounds['scroll'] <= bounds['width'] + 2, bounds
        assert await editor.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), '窄屏音色预设溢出'

        # 刷新后回到已应用状态：不自动播放旧试听，模板始终只写 preset-warm 一个槽位
        await harness.page.reload()
        await frame.get_by_role('heading', name='和小鲸鱼娘聊一会儿', exact=True).wait_for(timeout=15000)
        await open_voice()
        await expect(prompt).to_have_value(calm)
        await expect(editor.get_by_role('button', name='已应用', exact=True)).to_be_disabled()
        assert await replay_count() == 0, '刷新后不得自动播放旧试听'
        assert all(body['presetId'] == 'preset-warm' for _, body in preset_calls()), '模板只改当前槽位'
        assert [state['presets'][0]['prompt'], state['presets'][2]['prompt']] == [initial[0], initial[2]]
        assert not harness.errors, harness.errors
    finally:
        await harness.close()
    print('PASS: single prompt slot with source-backed templates; save-before-generate ordering and 503 retry; '
          'greeting autoplay with NotAllowedError retry on the same audio; dirty edit stops playback and blocks apply; '
          'reload keeps prompt/candidate; apply keeps the unrelated conversation draft and writes no settings; '
          'greeting failure keeps the candidate and retries only the preview; 390px layout; only preset-warm written')


asyncio.run(main())
