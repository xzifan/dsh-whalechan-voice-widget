"""Page-level assertions (statistics / history / audit) against mocked plugin APIs.

Runs through the production mount path (`browser_harness.Harness`): host page -> bridge -> iframe.
No network, no voice calls, nothing written into the repo tree.
"""
import asyncio
import json

from playwright.async_api import expect

from browser_harness import Harness

SAMPLE = {'total': 235, 'sessions': 12, 'transcriptionCharacters': 12580, 'outputAudioSeconds': 3661.2,
          'audioKnown': 40, 'audioMissing': 2,
          'counts': {'transcription': 50, 'response': 60, 'synthesis': 42, 'usage': 60, 'tool': 20, 'error': 3},
          'failed': 5, 'tokens': 48200, 'tokenKnown': 80, 'tokenMissing': 22,
          'firstAt': 1793100000000, 'lastAt': 1793110000000}
EMPTY = {**{key: 0 for key in SAMPLE}, 'counts': dict.fromkeys(SAMPLE['counts'], 0),
         'outputAudioSeconds': None, 'tokens': None, 'firstAt': None, 'lastAt': None}


async def statistics(harness, frame):
    """Metric formatting, range filter, 500 -> retry, empty state, storage banner, 390px layout."""
    state = {'mode': 'normal', 'windows': []}

    async def stats(method, body):
        if 'since' in body:
            state['windows'].append(body['until'] - body['since'])
        if state['mode'] == 'error':
            return 500, {'error': '测试读取失败'}
        return SAMPLE if state['mode'] == 'normal' else EMPTY

    harness.routes['statistics'] = stats
    await harness.nav('使用统计')
    await expect(frame.get_by_text('12,580', exact=True)).to_be_visible()
    await expect(frame.get_by_text('1 小时 1 分 1.2 秒', exact=True)).to_be_visible()
    await expect(frame.get_by_text('48,200', exact=True)).to_be_visible()
    # 全量范围不带 since，是"全部保留记录"的唯一表达方式
    assert state['windows'] == [], state['windows']
    await frame.get_by_label('统计时间范围').click()
    await frame.get_by_role('option', name='最近 24 小时', exact=True).click()
    await expect(frame.get_by_text('12,580', exact=True)).to_be_visible()
    assert 86399000 <= state['windows'][-1] <= 86401000, state['windows']
    state['mode'] = 'error'
    await frame.get_by_role('button', name='刷新', exact=True).click()
    await expect(frame.get_by_text('测试读取失败', exact=True)).to_be_visible()
    state['mode'] = 'normal'
    await frame.get_by_role('button', name='重试', exact=True).click()
    await expect(frame.get_by_text('12,580', exact=True)).to_be_visible()
    await harness.page.set_viewport_size({'width': 390, 'height': 844})
    await expect(frame.get_by_label('统计时间范围')).to_be_visible()
    bounds = await harness.child.evaluate("()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})")
    assert bounds['scroll'] <= bounds['width'] + 2, bounds
    await harness.page.set_viewport_size({'width': 1440, 'height': 1000})
    state['mode'] = 'empty'
    await frame.get_by_role('button', name='刷新', exact=True).click()
    await expect(frame.get_by_text('所选时间内暂无记录，开始对话后刷新查看。')).to_be_visible()
    # 空数据时输出语音时长必须显示"未知"而不是 0 秒
    await expect(frame.get_by_text('未知', exact=True).first).to_be_visible()
    return {'statistics': True}


async def main():
    harness = Harness()
    try:
        frame = await harness.start()
        results = await statistics(harness, frame)
        assert not harness.errors, harness.errors
        print(json.dumps({**results, 'pageErrors': harness.errors}))
    finally:
        await harness.close()


asyncio.run(main())
