"""Audit table browser regression using built assets and synthetic log responses."""
import asyncio, json, mimetypes, os, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
  page = await browser.new_page(viewport={'width':1920,'height':1080})
  errors=[]; calls=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  records=[{'id':str(i),'seq':i,'at':int(time.time()*1000),'kind':'response' if i%2 else 'synthesis','status':'completed','text':'测试日志 '+str(i),'provider':'bailian' if i%2 else 'minimax','model':'test-model','sessionId':'session-a','messageId':'message-'+str(i),'usage':{'total_tokens':i}} for i in range(120,0,-1)]
  async def route(r):
   path=urlparse(r.request.url).path
   if '/api/' in path:
    action=path.split('/api/')[-1];q=r.request.post_data_json or {};result={}
    if action=='audit':
     calls.append(q)
     matches=[x for x in records if (not q.get('kind') or x['kind']==q['kind']) and all((x.get(k,'')==v if k=='status' else v.lower() in x.get(k,'').lower()) for k,v in q.get('columnFilters',{}).items())]
     eligible=[x for x in matches if not q.get('before') or x['seq']<q['before']];rows=eligible[:100]
     result={'records':rows,'total':len(matches),'hasMore':len(eligible)>100,'nextBefore':rows[-1]['seq'] if rows else None}
    elif action=='config':result={'settings':{},'capabilities':{},'credentials':{}}
    elif action=='catalog':result={'tools':[]}
    await r.fulfill(content_type='application/json',body=json.dumps(result));return
   file=ROOT/'dist/web'/ (path.lstrip('/') or 'index.html')
   if file.is_file():await r.fulfill(content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
   else:await r.fulfill(status=404,body='missing')
  await page.route('http://audit.test/**',route)
  await page.goto('http://audit.test/')
  await page.get_by_role('button',name='日志审计',exact=True).click()
  await expect(page.locator('tbody tr')).to_have_count(100)
  for label in ['时间','类型','状态']:
   trigger=page.get_by_label(label+'表头筛选')
   await expect(trigger).to_have_text('')
   await trigger.locator('..').locator('span').first.click()
   await expect(page.get_by_role('listbox')).to_have_count(0)
  for label in ['内容','会话 ID','消息 ID','模型','提供方']:
   await expect(page.get_by_role('button',name=label+'筛选菜单',exact=True)).to_have_text('')
  await page.get_by_role('button',name='加载更早记录').click()
  await expect(page.locator('tbody tr')).to_have_count(120)
  await page.get_by_role('button',name='提供方筛选菜单').click()
  await page.get_by_label('提供方表头筛选').fill('bailian')
  await expect(page.locator('tbody tr')).to_have_count(60)
  assert calls[-1]['columnFilters']=={'provider':'bailian'} and 'before' not in calls[-1]
  await page.keyboard.press('Escape')
  await page.get_by_role('complementary',name='日志类型筛选').get_by_role('button',name='语音合成').click()
  await expect(page.locator('tbody tr')).to_have_count(0)
  await page.get_by_label('类型表头筛选').click()
  await expect(page.get_by_role('option',name='语音合成',exact=True)).to_have_attribute('data-state','checked')
  await page.keyboard.press('Escape')
  await page.get_by_role('button',name='重置筛选').click()
  await expect(page.locator('tbody tr')).to_have_count(100)
  await page.get_by_role('button',name='提供方筛选菜单').click()
  await expect(page.get_by_label('提供方表头筛选')).to_have_value('')
  await page.keyboard.press('Escape')
  await page.get_by_label('状态表头筛选').click()
  await page.get_by_role('option',name='失败',exact=True).click()
  await expect(page.locator('tbody tr')).to_have_count(0)
  assert calls[-1]['columnFilters']=={'status':'failed'}
  await page.keyboard.press('Escape')
  await page.get_by_role('button',name='重置筛选').click()
  await expect(page.locator('tbody tr')).to_have_count(100)
  await page.get_by_label('时间表头筛选').click()
  await expect(page.get_by_role('option',name='最近1小时',exact=True)).to_be_visible()
  await page.keyboard.press('Escape')
  for label in ['内容', '会话 ID', '消息 ID', '模型']:
   await page.get_by_role('button',name=label+'筛选菜单',exact=True).click()
   await expect(page.get_by_label(label+'表头筛选',exact=True)).to_be_visible()
   await expect(page.locator('[data-slot=popover-content] input')).to_have_count(1)
   await page.keyboard.press('Escape')
  await page.screenshot(path=str(ROOT/'.tools/audit-shadcn-desktop.png'))
  await page.get_by_role('button',name='查看语音合成详情').first.click()
  await expect(page.get_by_role('heading',name='审计记录详情')).to_be_visible()
  await page.keyboard.press('Escape')
  await expect(page.get_by_role('heading',name='审计记录详情')).not_to_be_visible()
  await page.locator('table').evaluate('e=>e.parentElement.scrollLeft=0')
  await page.set_viewport_size({'width':390,'height':844})
  await page.screenshot(path=str(ROOT/'.tools/audit-shadcn-mobile.png'))
  assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
  assert not errors, errors
  print(json.dumps({'pagination':True,'columnFilters':True,'typeSync':True,'reset':True,'detail':True,'mobileOverflow':False,'errors':errors}))
  live=await browser.new_page()
  response=await live.goto('http://127.0.0.1:3080/',wait_until='domcontentloaded')
  print('Existing GUI HTTP status:', response.status)
  await browser.close()
asyncio.run(main())
