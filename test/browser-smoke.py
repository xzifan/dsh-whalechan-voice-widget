"""CI smoke: the real plugin mounts in the host page and the core flow works against mock APIs (no network, no screenshots).

Bootstrap lives in `browser_harness.Harness`: the mount page, the route dispatcher and the fake
microphone exist once, so a mock change cannot land in this script and silently miss `browser-pages.py`.
"""
import asyncio

from playwright.async_api import expect

from browser_harness import Harness

# Overflow probe: runs in the plugin iframe, reports the viewport width, the widest scroll extent and
# the offenders, so a failing assertion says which element broke the 110/390px layout.
OVERFLOW = """()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
offenders:[...document.body.querySelectorAll('*')].map(e=>({tag:e.tagName,cls:e.className?.baseVal||e.className,width:Math.round(e.getBoundingClientRect().width),right:Math.round(e.getBoundingClientRect().right)})).filter(e=>e.right>innerWidth+2&&e.width>0).slice(0,18)})"""


async def main():
    harness = Harness()
    try:
        frame = await harness.start()
        page, calls, child = harness.page, harness.calls, harness.child
        await expect(frame.get_by_label('主导航')).to_be_visible()
        await expect(frame.get_by_role('button', name='开始对话', exact=True)).to_be_enabled()
        await harness.nav('设置')
        await expect(frame.get_by_role('tab', name='对话', exact=True)).to_be_visible()
        await frame.get_by_label('补充提示词', exact=True).fill('先给结论，保持简短。')
        await frame.get_by_role('tab', name='工具', exact=True).click()
        await frame.get_by_role('checkbox', name='read', exact=True).check()
        await frame.get_by_role('checkbox', name='glob', exact=True).uncheck()
        await frame.get_by_label('工作区路径', exact=True).fill('/test/workspace')
        async with page.expect_response(lambda r: r.url.endswith('/config') and r.request.method == 'PUT'):
            await frame.get_by_role('button', name='保存设置', exact=True).click()
        saved = [call[2]['settings'] for call in calls if call[0] == 'PUT'][-1]
        assert saved['system_prompt'] == '先给结论，保持简短。', saved
        assert saved['enabled_tools'] == ['read'], saved
        assert saved['workspace'] == '/test/workspace', saved
        await harness.nav('实时对话')
        await frame.get_by_role('button', name='开始对话', exact=True).click()
        await frame.get_by_role('heading', name='和小鲸鱼娘对话中', exact=True).wait_for(timeout=15000)
        await frame.get_by_text('在呢，主人。', exact=True).wait_for(timeout=20000)
        await frame.get_by_text('已完成', exact=True).wait_for()
        await frame.locator('summary').filter(has_text='read').click()
        await frame.get_by_text('Call ID: call-1', exact=True).wait_for()
        assert any(call[1] == 'realtime/audio' for call in calls), 'microphone frames never reached the audio bridge'
        assert await child.evaluate('window.__testTracks.length>0'), 'synthetic microphone was never opened'
        async with page.expect_response(lambda r: r.url.endswith('/realtime/end')):
            await frame.get_by_role('button', name='结束对话', exact=True).click()
        await frame.get_by_role('heading', name='和小鲸鱼娘聊一会儿', exact=True).wait_for(timeout=10000)
        assert await child.evaluate('window.__testTracks.every(track=>track.readyState==="ended")'), 'microphone tracks not released'
        for width in [110, 390]:
            await page.set_viewport_size({'width': width, 'height': 844})
            bounds = await child.evaluate(OVERFLOW)
            assert bounds['scroll'] <= bounds['width'] + 2, bounds
        assert not harness.errors, harness.errors
        print('PASS: plugin mounts in the host iframe, sidebar navigation, settings save round-trip, realtime turn with tool timeline, mic release and 110/390px layout; zero live API calls')
    finally:
        await harness.close()


asyncio.run(main())