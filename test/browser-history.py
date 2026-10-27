"""Conversation history browser regression, synthetic data and no voice calls."""
import asyncio, json, mimetypes, os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
  page=await browser.new_page(viewport={'width':1440,'height':1000})
  errors=[]; calls=[]; mode='normal'
  page.on('pageerror',lambda e:errors.append(str(e)))
  sessions=[{'sessionId':'session-a','title':'聊聊今天的计划','preview':'计划已经整理好了。','firstAt':1793110000000,'lastAt':1793110100000,'messageCount':3,'recordCount':5},{'sessionId':'session-b','title':'明天的天气','preview':'第二场的独立回复','firstAt':1793100000000,'lastAt':1793100100000,'messageCount':1,'recordCount':2}]
  async def route(r):
   path=urlparse(r.request.url).path
   if '/api/' in path:
    action=path.split('/api/')[-1];q=r.request.post_data_json or {};result={}
    calls.append((action,q))
    if action=='history/sessions':
     if mode=='error':
      await r.fulfill(status=500,content_type='application/json',body=json.dumps({'error':'历史读取失败'}));return
     found=[] if q.get('search')=='不存在' else sessions[1:] if q.get('search') else sessions
     result={'sessions':found,'total':len(found)}
    elif action=='history/messages':
     s=next(x for x in sessions if x['sessionId']==q['sessionId'])
     result={'session':s,'messages':[{'id':'u','kind':'user','text':'今天有什么安排？','at':1793110000000,'status':'completed','messageId':'user-a'},{'id':'t','kind':'tool','text':'查询日程完成','at':1793110001000,'status':'completed'},{'id':'a','kind':'assistant','text':'计划已经整理好了。\n先完成统计界面，再看看历史消息。','at':1793110002000,'status':'completed','messageId':'assistant-a'}] if s['sessionId']=='session-a' else [{'id':'b','kind':'assistant','text':'第二场的独立回复','at':1793100100000,'status':'cancelled'}]}
    elif action=='audit':result={'records':[],'total':0}
    elif action=='config':result={'settings':{},'capabilities':{},'credentials':{}}
    elif action=='catalog':result={'tools':[]}
    await r.fulfill(content_type='application/json',body=json.dumps(result));return
   f=ROOT/'dist/web'/(path.lstrip('/') or 'index.html')
   await r.fulfill(status=200 if f.is_file() else 404,content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream',body=f.read_bytes() if f.is_file() else b'missing')
  await page.route('http://history.test/**',route)
  await page.goto('http://history.test/')
  await page.get_by_role('button',name='会话记录',exact=True).click()
  await expect(page.get_by_text('2 个会话',exact=True)).to_be_visible()
  await page.get_by_role('button',name='聊聊今天的计划',exact=False).click()
  await expect(page.get_by_role('article')).to_have_count(3)
  await expect(page.get_by_text('今天有什么安排？',exact=True)).to_be_visible()
  await page.screenshot(path=str(ROOT/'.tools/history-desktop.png'))
  await page.get_by_role('button',name='明天的天气',exact=False).click()
  await expect(page.get_by_role('article')).to_have_count(1)
  await expect(page.get_by_text('今天有什么安排？',exact=True)).not_to_be_visible()
  await page.get_by_label('搜索会话记录').fill('天气')
  await expect(page.get_by_text('1 个会话',exact=True)).to_be_visible()
  await page.get_by_label('搜索会话记录').fill('不存在')
  await expect(page.get_by_text('没有匹配的会话，试试其他关键词。')).to_be_visible()
  await page.get_by_label('搜索会话记录').fill('')
  await expect(page.get_by_text('2 个会话',exact=True)).to_be_visible()
  mode='error'
  await page.get_by_role('button',name='刷新记录',exact=True).click()
  await expect(page.get_by_text('历史读取失败',exact=True)).to_be_visible()
  mode='normal'
  await page.get_by_role('button',name='重试',exact=True).click()
  await expect(page.get_by_text('2 个会话',exact=True)).to_be_visible()
  await page.set_viewport_size({'width':390,'height':844})
  await page.get_by_role('button',name='聊聊今天的计划',exact=False).click()
  await expect(page.get_by_role('article')).to_have_count(3)
  await page.screenshot(path=str(ROOT/'.tools/history-mobile.png'))
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  await page.get_by_role('button',name='返回会话列表',exact=True).click()
  await expect(page.get_by_label('搜索会话记录')).to_be_visible()
  await page.get_by_role('button',name='聊聊今天的计划',exact=False).click()
  await page.get_by_role('button',name='查看审计',exact=True).first.click()
  await expect(page.get_by_label('搜索审计记录')).to_have_value('user-a')
  assert not errors,errors
  print(json.dumps({'sessionSwitch':True,'messages':True,'search':True,'retry':True,'mobile':True,'auditLink':True,'errors':errors}))
  await browser.close()
asyncio.run(main())
