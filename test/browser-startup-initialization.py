"""Realtime startup initialization/browser cancellation regressions; synthetic APIs only."""
import asyncio,json,mimetypes,subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='http://localhost:39876'
DEFAULTS=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {defaults} from './src/service.js'; console.log(JSON.stringify(defaults))"],cwd=ROOT))
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path=p.chromium.executable_path,args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  async def scenario(provider='qwen',mode='success'):
   context=await browser.new_context(permissions=['microphone'],viewport={'width':1400,'height':950})
   await context.add_init_script("""window.__micCalls=0;const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{window.__micCalls++;return capture(...args)};""")
   page=await context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   settings=json.loads(json.dumps(DEFAULTS));settings['tools_configured']=True;settings['tts_voice_provider']=provider
   if provider=='breeze':settings['tts_profiles']['breeze']={'protocol':'breeze-tts','model':'breeze-tts-2-multilingual','endpoint':'https://api.breeze.blue/v1/text-to-speech/{voice_id}','voice':'','key_file':'/synthetic/breeze.env'}
   if mode=='normal':settings['tts_profiles'][provider]={'voice':'existing-voice','model':'qwen-audio-3.1-tts-flash'}
   starts=[];ended=[];saved=[];release=asyncio.Event();first_waiting=asyncio.Event()
   async def route(r):
    path=urlparse(r.request.url).path
    if path.startswith('/api/'):
     action=path.removeprefix('/api/');data=r.request.post_data_json if r.request.post_data else {};result={}
     if action=='config' and r.request.method=='GET':result={'settings':settings,'capabilities':{},'models':{'tts':{'ready':False,'provider':provider}},'credentials':{'bailian':{'ready':True}},'voicePresets':[],'breezeVoicePresets':[]}
     elif action=='config' and r.request.method=='PUT':saved.append(data['settings']);result={'settings':data['settings']}
     elif action=='config/check':result={'valid':True,'errors':{},'warnings':{}}
     elif action=='catalog':result={'tools':[],'toolExecutionAvailable':True}
     elif action=='realtime/start':
      index=len(starts)+1;starts.append(data);first_waiting.set()
      if index==1:await release.wait()
      if mode=='failure':await r.fulfill(status=502,content_type='application/json',body=json.dumps({'error':'默认音色初始化失败'}));return
      if mode=='normal':result={'sessionId':f'{mode}-{index}'}
      else:result={'sessionId':f'{mode}-{index}','voiceSettingsPatch':{'tts_profiles':{provider:{'voice':f'initialized-{index}','model':'qwen-audio-3.1-tts-flash' if provider=='qwen' else 'breeze-tts-2-multilingual'}}}}
     elif action=='realtime/end':ended.append(data['sessionId']);result={'ok':True}
     elif action=='realtime/events':result={'events':[],'cursor':0,'done':False}
     else:result={'ok':True}
     await r.fulfill(content_type='application/json',body=json.dumps(result));return
    file=ROOT/'dist/web'/(path.lstrip('/') or 'index.html')
    await r.fulfill(status=200 if file.is_file() else 404,content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes() if file.is_file() else b'missing')
   await page.route(ORIGIN+'/**',route)
   await page.goto(ORIGIN,wait_until='domcontentloaded')
   await page.get_by_role('button',name='设置',exact=True).click();await page.get_by_role('tab',name='对话',exact=True).click();await page.locator('#system-prompt').fill('尚未保存的聊天草稿')
   await page.get_by_role('button',name='实时对话',exact=True).click()
   start=page.get_by_role('button',name='开始对话',exact=True)
   await expect(start).to_be_enabled();await start.click();await asyncio.wait_for(first_waiting.wait(),5)
   await expect(page.get_by_role('button',name='准备声音并连接…',exact=True)).to_be_disabled()
   await expect(page.get_by_role('button',name='取消连接',exact=True)).to_be_visible()
   assert await page.evaluate('window.__micCalls')==0
   # Even a synthetic duplicate DOM click cannot create a second start request.
   await page.get_by_role('button',name='准备声音并连接…',exact=True).evaluate('(button)=>button.click()')
   assert len(starts)==1
   if mode=='cancel':
    await page.get_by_role('button',name='取消连接',exact=True).click()
    await page.get_by_role('button',name='再次开始',exact=True).click()
    await expect(page.get_by_role('button',name='结束对话',exact=True)).to_be_visible()
    for _ in range(100):
     if await page.evaluate('window.__micCalls')==1:break
     await asyncio.sleep(.02)
    release.set()
    for _ in range(100):
     if 'cancel-1' in ended:break
     await asyncio.sleep(.02)
    assert 'cancel-1' in ended,ended
    assert await page.evaluate('window.__micCalls')==1
    assert len(starts)==2
   else:release.set()
   if mode=='failure':
    await expect(page.get_by_role('alert')).to_contain_text('默认音色初始化失败')
    assert await page.evaluate('window.__micCalls')==0
    assert not ended
    await expect(page.locator('[data-call-view="active"]')).to_have_count(0)
   else:
    await expect(page.get_by_role('button',name='结束对话',exact=True)).to_be_visible()
    for _ in range(100):
     if await page.evaluate('window.__micCalls')==1:break
     await asyncio.sleep(.02)
    assert await page.evaluate('window.__micCalls')==1
    await page.get_by_role('button',name='结束对话',exact=True).click()
    await page.get_by_role('button',name='设置',exact=True).click();await page.get_by_role('tab',name='对话',exact=True).click()
    await expect(page.locator('#system-prompt')).to_have_value('尚未保存的聊天草稿')
    await page.get_by_role('button',name='保存设置',exact=True).click()
    for _ in range(100):
     if saved:break
     await asyncio.sleep(.02)
    assert saved,saved
    assert saved[-1]['tts_profiles'][provider]['voice']==('existing-voice' if mode=='normal' else 'initialized-2' if mode=='cancel' else 'initialized-1'),saved[-1]['tts_profiles']
    assert saved[-1]['system_prompt']=='尚未保存的聊天草稿'
   assert not errors,errors
   await context.close()
   return {'provider':provider,'mode':mode,'starts':len(starts),'lateSessionEnded':mode!='cancel' or 'cancel-1' in ended}
  results=[]
  for provider,mode in [('qwen','normal'),('qwen','success'),('breeze','success'),('qwen','failure'),('qwen','cancel')]:results.append(await scenario(provider,mode))
  print(json.dumps({'startupRegressions':results,'noRealApiCalls':True},ensure_ascii=False))
  await browser.close()
asyncio.run(main())
