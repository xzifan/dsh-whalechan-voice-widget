"""Render real plugin UI against simulated server capabilities; no live APIs or microphone."""
import asyncio,json,mimetypes,os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE'])
  for arch,supported in [('arm64',False),('x64',True)]:
   ctx=await browser.new_context(viewport={'width':1280,'height':1000},user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36')
   page=await ctx.new_page()
   reason='' if supported else '当前 DSH 服务端 Windows ARM64 不支持本地识别，请配置远端 ASR。'
   local={'platform':'win32','arch':arch,'supported':supported,'available':supported,'reasonCode':'unprepared' if supported else 'unsupported-platform','reason':reason}
   async def route(r):
    path=urlparse(r.request.url).path
    if path.startswith('/api/voice-workbench/'):
     if path.endswith('/config'):
      result={'settings':{'tts_model':'speech-2.8-turbo','asr_provider':'local'},'credentials':{'tts':True,'asr':False,'chat':True},'models':{'tts':{'model':'speech-2.8-turbo','credentialConfigured':True},'asr':{'provider':'local','model':'SenseVoiceSmall int8','ready':False,'localSupported':supported,'localAvailable':supported,'localUnavailableReason':reason,'platform':'win32','arch':arch}},'capabilities':{'chat':True,'asr':False,'asrPreparing':False,'asrPhase':'unprepared' if supported else 'unavailable','localAsr':local}}
     elif path.endswith('/catalog'):result={'tools':[],'currentWorkspace':'C:\\Users\\test','toolExecutionAvailable':False}
     else:result={'ok':True}
     await r.fulfill(status=200,content_type='application/json',body=json.dumps(result));return
    if path=='/':
     html='''<html><body><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(mod){const plugin=mod.factory(()=>React);const ctx={slots:{inject(n,fn){fn()},register(meta,Comp){if(meta.name==='main')ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Comp));return ()=>{}}},layout:{}};plugin.apply(ctx)}};</script><script src="/plugin.js"></script></body></html>'''
     await r.fulfill(status=200,content_type='text/html',body=html);return
    mapping={'/react.js':ROOT/'web/node_modules/react/umd/react.production.min.js','/react-dom.js':ROOT/'web/node_modules/react-dom/umd/react-dom.production.min.js','/plugin.js':ROOT/'lib/client.js'}
    file=mapping.get(path)
    if path.startswith('/voice-workbench/'):file=ROOT/'dist/web'/(path[len('/voice-workbench/'):] or 'index.html')
    if file and file.is_file():await r.fulfill(status=200,content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
    else:await r.fulfill(status=404,body='missing')
   await page.route('**/*',route);await page.goto('http://localhost:31099/')
   frame=page.frame_locator('iframe');await frame.get_by_role('tab',name='设置',exact=True).click();await frame.get_by_role('tab',name='模型配置',exact=True).click()
   prepare=frame.get_by_role('button',name='准备本地识别模型',exact=True)
   if supported:await expect(prepare).to_be_enabled()
   elif await prepare.count():await expect(prepare).to_be_disabled()
   await frame.get_by_role('combobox',name='语音识别方式',exact=True).click();option=frame.get_by_role('option',name='本地 SenseVoice',exact=True)
   if supported:await expect(option).to_be_enabled()
   else:await expect(option).to_be_disabled()
   await frame.get_by_role('option',name='OpenAI 兼容服务',exact=True).click();await expect(frame.get_by_label('ASR 服务地址',exact=True)).to_be_visible()
   print('Server Windows',arch,'local option',('enabled' if supported else 'disabled'),'; Mac browser does not determine support; remote configuration available')
   await ctx.close()
  await browser.close()
asyncio.run(main())
