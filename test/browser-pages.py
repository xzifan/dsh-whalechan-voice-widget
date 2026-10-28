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
SESSIONS = [
    {'sessionId': 'session-a', 'title': '聊聊今天的计划', 'preview': '计划已经整理好了。',
     'firstAt': 1793110000000, 'lastAt': 1793110100000, 'messageCount': 3, 'recordCount': 5},
    {'sessionId': 'session-b', 'title': '明天的天气', 'preview': '第二场的独立回复',
     'firstAt': 1793100000000, 'lastAt': 1793100100000, 'messageCount': 1, 'recordCount': 2},
]
MESSAGES = {
    'session-a': [
        {'id': 'u', 'kind': 'user', 'text': '今天有什么安排？', 'at': 1793110000000, 'status': 'completed', 'messageId': 'user-a'},
        {'id': 't', 'kind': 'tool', 'text': '查询日程完成', 'at': 1793110001000, 'status': 'completed'},
        {'id': 'a', 'kind': 'assistant', 'text': '计划已经整理好了。\n先完成统计界面，再看看历史消息。',
         'at': 1793110002000, 'status': 'completed', 'messageId': 'assistant-a'},
    ],
    'session-b': [{'id': 'b', 'kind': 'assistant', 'text': '第二场的独立回复', 'at': 1793100100000, 'status': 'cancelled'}],
}


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


async def history(harness, frame):
    """Session list, message pane, search reset, 500 -> retry, audit deep link, 390px layout."""
    state = {'mode': 'normal', 'searches': []}

    async def sessions_route(method, body):
        state['searches'].append(body.get('search', ''))
        if state['mode'] == 'error':
            return 500, {'error': '历史读取失败'}
        query = body.get('search') or ''
        found = [s for s in SESSIONS if not query or query in s['title'] + s['preview']]
        return {'sessions': found, 'total': len(found)}

    async def messages_route(method, body):
        session = next(item for item in SESSIONS if item['sessionId'] == body['sessionId'])
        return {'session': session, 'messages': MESSAGES[body['sessionId']]}

    harness.routes['history/sessions'] = sessions_route
    harness.routes['history/messages'] = messages_route
    # 审计页要求 records 是数组，默认 mock 的 {ok,audio} 会让它报「审计服务返回了无效记录」
    async def audit_route(method, body):
        return {'records': [], 'total': 0}

    harness.routes['audit'] = audit_route
    await harness.nav('会话记录')
    await expect(frame.get_by_text('2 个会话', exact=True)).to_be_visible()
    assert state['searches'] == [''], state['searches']
    items = frame.locator('aside[aria-label="历史会话列表"] button[aria-pressed]')
    assert await items.count() == 2, await items.count()
    await frame.get_by_role('button', name='聊聊今天的计划', exact=False).click()
    await expect(frame.get_by_role('article')).to_have_count(3)
    await expect(frame.get_by_text('今天有什么安排？', exact=True)).to_be_visible()
    assert await items.nth(0).get_attribute('aria-pressed') == 'true', '选中的会话行要标记 aria-pressed'
    # 切会话：消息面板整体换掉，不能残留上一场的消息
    await frame.get_by_role('button', name='明天的天气', exact=False).click()
    await expect(frame.get_by_role('article')).to_have_count(1)
    await expect(frame.get_by_text('今天有什么安排？', exact=True)).to_have_count(0)
    await frame.get_by_label('搜索会话记录').fill('天气')
    await expect(frame.get_by_text('1 个会话', exact=True)).to_be_visible()
    await expect(items).to_have_count(1)
    await frame.get_by_label('搜索会话记录').fill('不存在')
    await expect(frame.get_by_text('没有匹配的会话，试试其他关键词。')).to_be_visible()
    # 清空搜索必须回到全量列表，而不是停在空结果
    await frame.get_by_label('搜索会话记录').fill('')
    await expect(frame.get_by_text('2 个会话', exact=True)).to_be_visible()
    await expect(items).to_have_count(2)
    state['mode'] = 'error'
    await frame.get_by_role('button', name='刷新记录', exact=True).click()
    await expect(frame.get_by_text('历史读取失败', exact=True)).to_be_visible()
    state['mode'] = 'normal'
    await frame.get_by_role('button', name='重试', exact=True).click()
    await expect(frame.get_by_text('2 个会话', exact=True)).to_be_visible()
    await harness.page.set_viewport_size({'width': 390, 'height': 844})
    await frame.get_by_role('button', name='聊聊今天的计划', exact=False).click()
    await expect(frame.get_by_role('article')).to_have_count(3)
    bounds = await harness.child.evaluate("()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})")
    assert bounds['scroll'] <= bounds['width'] + 2, bounds
    await frame.get_by_role('button', name='返回会话列表', exact=True).click()
    await expect(frame.get_by_label('搜索会话记录')).to_be_visible()
    await harness.page.set_viewport_size({'width': 1440, 'height': 1000})
    # 深链接：点消息上的「查看审计」既要把 messageId 填进审计搜索框，也要真带着它去查
    await frame.get_by_role('button', name='聊聊今天的计划', exact=False).click()
    await expect(frame.get_by_role('article')).to_have_count(3)
    await frame.get_by_role('button', name='查看审计', exact=True).first.click()
    await read_value(frame, '搜索审计记录', 'user-a')
    found = await until(lambda: any(a == 'audit' and b.get('search') == 'user-a' for _, a, b in harness.calls))
    assert found, [call for call in harness.calls if call[1] == 'audit']
    return {'history': True}


async def read_value(frame, label, wanted, timeout=5.0, interval=0.1):
    """轮询输入框直到等于 wanted——`expect(...).to_have_value` 在 1.60 的 async API 里不可 await。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    value = ''
    while loop.time() < deadline:
        value = await frame.get_by_label(label).input_value()
        if value == wanted:
            return value
        await asyncio.sleep(interval)
    raise AssertionError(f'{label} 始终没有变成 {wanted!r}，实际读到 {value!r}')


async def until(predicate, timeout=5.0, interval=0.1):
    """轮询等待副作用落地（审计请求有 300ms 防抖），比固定 sleep 稳。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


async def main():
    harness = Harness()
    try:
        frame = await harness.start()
        results = await statistics(harness, frame)
        results.update(await history(harness, frame))
        assert not harness.errors, harness.errors
        print(json.dumps({**results, 'pageErrors': harness.errors}))
    finally:
        await harness.close()


asyncio.run(main())
