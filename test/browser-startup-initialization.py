"""Realtime startup initialization / cancellation regressions, through the production mount path.

Runs via `browser_harness.Harness`: host page -> `lib/client.js` bridge -> iframe -> mocked
`/api/voice-workbench/*`, so the bridge's method whitelist, concurrency lanes and abort handling are
covered too. Five cases keep the four behaviours that only the browser can prove:

* start race: the button is disabled while connecting, and a synthetic DOM click cannot create a
  second `realtime/start`;
* cancel: a session that resolves after the user cancelled must be ended, and only that one;
* `voiceSettingsPatch` from `realtime/start` lands in the draft and is what gets saved;
* failure: no microphone, no session polling, no `realtime/end`.

The microphone counter has to live in the plugin iframe (`harness.child`); reading it from the host
page silently returned 0 for every case.
"""

import asyncio

from playwright.async_api import expect

from browser_harness import Harness

DRAFT = '尚未保存的聊天草稿'
CONNECTING = '准备声音并连接' + '\u2026'
MIC_SCRIPT = """window.__micCalls=0;const capture=navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);if(capture)navigator.mediaDevices.getUserMedia=options=>{window.__micCalls++;return capture(options)};"""
CASES = [('qwen', 'normal'), ('qwen', 'success'), ('breeze', 'success'), ('qwen', 'failure'), ('qwen', 'cancel'),
         ('qwen', 'closed'), ('qwen', 'closed404')]


async def until(predicate, timeout=5.0, interval=0.1):
    """Poll for the recorded side effect instead of trusting an already-visible DOM value."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


async def until_async(predicate, timeout=5.0, interval=0.1):
    """Same, for predicates that must read the plugin iframe (an awaitable)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(interval)
    return await predicate()


def settings_for(provider, mode):
    profile = {
        'model': 'breeze-tts-2-multilingual' if provider == 'breeze' else 'qwen-audio-3.1-tts-flash',
        'voice': 'existing-voice' if mode == 'normal' else '',
    }
    if provider == 'breeze':
        profile.update({'protocol': 'breeze-tts', 'endpoint': 'https://api.breeze.blue/v1/text-to-speech/{voice_id}',
                        'key_file': '/synthetic/breeze.env'})
    return {
        'system_prompt': '已保存的对话设置', 'workspace': '', 'enabled_tools': [],
        # tools_configured 必须是 True：否则挂载时 loadConfig 会用 catalog 初始化工具选择，
        # 一进设置页就 dirty，“草稿保留”断言就失去意义了。
        'tools_configured': True,
        'tts_voice_provider': provider, 'tts_profiles': {provider: profile},
        'realtime': {'credential_source': 'provider', 'use_tts_voice': True},
    }


def routes_for(provider, mode, starts, ended, release):
    async def realtime_start(method, body):
        starts.append(body)
        index = len(starts)
        if index == 1:
            await release.wait()
        if mode == 'failure':
            return 502, {'error': '默认音色初始化失败'}
        if mode == 'normal':
            return {'sessionId': f'{mode}-{index}'}
        # 不带 tts_voice_provider：这一条要证明的是“只 patch profile”，不是切提供方
        return {'sessionId': f'{mode}-{index}', 'voiceSettingsPatch': {
            'tts_profiles': {provider: {'voice': f'initialized-{index}', 'model': settings_for(provider, mode)['tts_profiles'][provider]['model']}}}}

    async def realtime_events(method, body):
        # Harness 的默认 mock 会在 >2 帧音频后灌脚本化事件，本用例的上下文需要空流
        if mode == 'closed':
            # 上游断连：只有一条 closed，done 仍是 false —— 客户端必须自己认这个事件
            return {'events': [{'seq': 1, 'type': 'closed'}], 'cursor': 1, 'done': False}
        if mode == 'closed404':
            # 服务端已回收会话（墓碑被淘汰）：轮询拿到 404，必须当成正常结束而不是报错
            return 404, {'error': '实时语音会话不存在或已结束'}
        return {'events': [], 'cursor': 0, 'done': False}

    async def realtime_end(method, body):
        ended.append(body.get('sessionId'))
        return {'ok': True}

    return {'realtime/start': realtime_start, 'realtime/events': realtime_events, 'realtime/end': realtime_end}


async def mic_calls(harness):
    return await harness.child.evaluate('window.__micCalls')


async def mic_is(harness, expected):
    return await mic_calls(harness) == expected


async def run_case(provider, mode):
    release = asyncio.Event()
    starts, ended = [], []
    harness = Harness(routes=routes_for(provider, mode, starts, ended, release),
                      settings=settings_for(provider, mode), init_scripts=[MIC_SCRIPT])
    try:
        frame = await harness.start()
        # 配置没加载完就点开始，发出去的是 normalizeSettings() 的默认值，草稿断言会假通过
        await harness.nav('设置')
        await expect(frame.get_by_text('已保存', exact=True)).to_be_visible()
        await frame.get_by_role('tab', name='对话', exact=True).click()
        await frame.locator('#system-prompt').fill(DRAFT)
        await harness.nav('实时对话')

        start = frame.get_by_role('button', name='开始对话', exact=True)
        await expect(start).to_be_enabled()
        await start.click()
        assert await until(lambda: len(starts) == 1), starts
        await expect(frame.get_by_role('button', name=CONNECTING, exact=True)).to_be_disabled()
        await expect(frame.get_by_role('button', name='取消连接', exact=True)).to_be_visible()
        assert await mic_calls(harness) == 0, '连接尚未成功就不该开麦'
        # 未保存草稿与提供方必须原样进 start 请求
        assert starts[0]['settings']['system_prompt'] == DRAFT, starts[0]['settings'].get('system_prompt')
        assert starts[0]['settings']['tts_voice_provider'] == provider, starts[0]['settings'].get('tts_voice_provider')

        # 合成 DOM click 绕过 actionability：只证明 disabled 不会重复派发（JS 守卫另由 rtStartAttempt 兜）
        await frame.get_by_role('button', name=CONNECTING, exact=True).evaluate('(button) => button.click()')
        await asyncio.sleep(0.3)
        assert len(starts) == 1, '起始按钮 disabled 期间不得发出第二次 realtime/start'

        if mode == 'cancel':
            await frame.get_by_role('button', name='取消连接', exact=True).click()
            again = frame.get_by_role('button', name='再次开始', exact=True)
            await expect(again).to_be_visible()
            await again.click()
            assert await until(lambda: len(starts) == 2), starts
            assert await until_async(lambda: mic_is(harness, 1))
            release.set()
            # 取消后迟到的 session 必须被 end，而且只能 end 它（麦克风失败也会走 end，所以要精确断言）
            assert await until(lambda: ended == ['cancel-1']), ended
            await expect(frame.get_by_role('button', name='结束对话', exact=True)).to_be_visible()
        elif mode in ('closed', 'closed404'):
            release.set()
            assert await until_async(lambda: mic_is(harness, 1)), '开始对话后应恰好开麦一次'
            # 上游断连（closed 事件 / 轮询 404）必须由宿主收尾：退出通话视图、只 end 一次
            assert await until(lambda: ended == [f'{mode}-1']), ended
            await expect(frame.locator('[data-call-view="active"]')).to_have_count(0)
            await expect(frame.locator('[data-call-view="idle"]')).to_have_count(1)
            await expect(frame.get_by_role('button', name='再次开始', exact=True)).to_be_visible()
            # 麦克风必须真的释放（此前会一直「我在听」并继续采集）
            tracks = await harness.child.evaluate('(() => {const list=window.__testTracks||[];return {count:list.length,ended:list.every(t=>t.readyState==="ended")}})()')
            assert tracks == {'count': 1, 'ended': True}, tracks
            # 轮询与上传必须停下：0.3 s 让在途请求落地，再观察 0.6 s 不应有新请求
            await asyncio.sleep(0.3)
            settled = [call[1] for call in harness.calls if call[1] in ('realtime/events', 'realtime/audio')]
            await asyncio.sleep(0.6)
            after = [call[1] for call in harness.calls if call[1] in ('realtime/events', 'realtime/audio')]
            assert after == settled, f'会话结束后仍在轮询或上传：{settled} -> {after}'
            # 404 不得变成错误横幅
            await expect(frame.get_by_role('alert')).to_have_count(0)
        elif mode == 'failure':
            release.set()
            await expect(frame.get_by_role('alert').filter(has_text='默认音色初始化失败')).to_be_visible()
            assert await mic_calls(harness) == 0, '初始化失败不得开麦'
            await expect(frame.locator('[data-call-view="active"]')).to_have_count(0)
            assert not ended, ended
            assert not [call for call in harness.calls if call[1] in ('realtime/events', 'realtime/audio')], '会话没建立就不该轮询或上传'
        else:
            release.set()
            await expect(frame.get_by_role('button', name='结束对话', exact=True)).to_be_visible()
            assert await until_async(lambda: mic_is(harness, 1)), '开始对话后应恰好开麦一次'

        if mode in ('normal', 'success', 'cancel'):
            await frame.get_by_role('button', name='结束对话', exact=True).click()
            assert await until(lambda: ended == (['cancel-1', 'cancel-2'] if mode == 'cancel' else [f'{mode}-1'])), ended
            # 结束对话必须真的释放麦克风：一次通话只开一次，且轨道都已 ended
            tracks = await harness.child.evaluate('(() => {const list=window.__testTracks||[];return {count:list.length,ended:list.every(t=>t.readyState==="ended")}})()')
            assert tracks == {'count': 1, 'ended': True}, tracks

            await harness.nav('设置')
            await expect(frame.locator('#system-prompt')).to_have_value(DRAFT)
            save = frame.get_by_role('button', name='保存设置', exact=True)
            await expect(save).to_be_enabled()
            await save.click()
            assert await until(lambda: any(m == 'PUT' and a == 'config' for m, a, _ in harness.calls)), harness.calls
            put = [body['settings'] for m, a, body in harness.calls if (m, a) == ('PUT', 'config')][-1]
            expected = 'existing-voice' if mode == 'normal' else ('initialized-2' if mode == 'cancel' else 'initialized-1')
            assert put['tts_profiles'][provider]['voice'] == expected, put['tts_profiles'][provider]
            assert put['tts_voice_provider'] == provider, put['tts_voice_provider']
            assert put['system_prompt'] == DRAFT, put['system_prompt']
            # patch 是深合并：没在 patch 里的字段不能被整段覆盖掉
            assert put['realtime']['use_tts_voice'] is True, put['realtime']

        assert not harness.errors, harness.errors
        return {'provider': provider, 'mode': mode, 'starts': len(starts), 'ended': list(ended),
                'lateSessionEnded': mode != 'cancel' or ended[:1] == ['cancel-1']}
    finally:
        release.set()
        await harness.close()


async def main():
    results = [await run_case(provider, mode) for provider, mode in CASES]
    print({'startupRegressions': results, 'noRealApiCalls': True})


asyncio.run(main())