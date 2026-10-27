"""Statistics UI with synthetic API data; no server or paid voice calls."""
import asyncio, json, mimetypes, os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
  page = await browser.new_page(viewport={'width':1440,'height':1000})
  errors=[]; calls=[]; mode='normal'
  page.on('pageerror',lambda e:errors.append(str(e)))
  sample={'total':235,'sessions':12,'transcriptionCharacters':12580,'outputAudioSeconds':3661.2,'audioKnown':40,'audioMissing':2,'counts':{'transcription':50,'response':60,'synthesis':42,'usage':60,'tool':20,'error':3},'failed':5,'tokens':48200,'tokenKnown':80,'tokenMissing':22,'firstAt':1793100000000,'lastAt':1793110000000}
  async def route(r):
   path=urlparse(r.request.url).path
   if '/api/' in path:
    action=path.split('/api/')[-1]; result={}
    if action=='statistics':
     calls.append(r.request.post_data_json)
     if mode=='error':
      await r.fulfill(status=500,content_type='application/json',body=json.dumps({'error':'测试读取失败'}));return
     result=sample if mode=='normal' else {**{k:0 for k in sample},'counts':dict.fromkeys(sample['counts'],0),'outputAudioSeconds':None,'tokens':None,'firstAt':None,'lastAt':None}
    elif action=='config':result={'settings':{},'capabilities':{},'credentials':{}}
    elif action=='catalog':result={'tools':[]}
    await r.fulfill(content_type='application/json',body=json.dumps(result));return
   file=ROOT/'dist/web'/(path.lstrip('/') or 'index.html')
   if file.is_file():await r.fulfill(content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
   else:await r.fulfill(status=404,body='missing')
  await page.route('http://statistics.test/**',route)
  await page.goto('http://statistics.test/')
  await page.get_by_role('button',name='使用统计',exact=True).click()
  await expect(page.get_by_text('12,580',exact=True)).to_be_visible()
  await expect(page.get_by_text('1 小时 1 分 1.2 秒',exact=True)).to_be_visible()
  await page.screenshot(path=str(ROOT/'.tools/statistics-desktop.png'))
  await page.get_by_label('统计时间范围').click()
  await page.get_by_role('option',name='最近 24 小时',exact=True).click()
  await expect(page.get_by_text('12,580',exact=True)).to_be_visible()
  assert 86399000 <= calls[-1]['until']-calls[-1]['since'] <= 86401000
  mode='error'
  await page.get_by_role('button',name='刷新',exact=True).click()
  await expect(page.get_by_text('测试读取失败',exact=True)).to_be_visible()
  mode='normal'
  await page.get_by_role('button',name='重试',exact=True).click()
  await expect(page.get_by_text('12,580',exact=True)).to_be_visible()
  await page.set_viewport_size({'width':390,'height':844})
  await page.screenshot(path=str(ROOT/'.tools/statistics-mobile.png'),full_page=True)
  assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
  mode='empty'
  await page.get_by_role('button',name='刷新',exact=True).click()
  await expect(page.get_by_text('所选时间内暂无记录，开始对话后刷新查看。')).to_be_visible()
  await expect(page.get_by_text('未知',exact=True)).to_be_visible()
  assert not errors,errors
  print(json.dumps({'metrics':True,'timeFilter':True,'retry':True,'empty':True,'mobileOverflow':False,'pageErrors':errors}))
  await browser.close()
asyncio.run(main())
