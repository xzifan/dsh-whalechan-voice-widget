"""CI smoke: the real plugin mounts in the host page and the core flow works against mock APIs (no network, no screenshots)."""
import asyncio,base64,io,json,math,mimetypes,os,struct,wave
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
SETTINGS={'tts_model':'speech-2.6-hd','speed':1.05,'emotion':'happy','voice_mix':[{'voice_id':'female-shaonv','weight':60},{'voice_id':'female-tianmei','weight':40},{'voice_id':'female-yujie','weight':0}],'chat_model':'','asr_model':'whisper-1','system_prompt':'测试'}
def recording():
    stream=io.BytesIO()
    with wave.open(stream,'wb') as out:
        out.setnchannels(1);out.setsampwidth(2);out.setframerate(16000)
        out.writeframes(b''.join(struct.pack('<h',int(9000*math.sin(i*math.tau*440/16000)) if i<24000 else 0) for i in range(48000)))
    return stream.getvalue()
async def main():
  fixture=ROOT/'.tools/browser-tone.wav';fixture.parent.mkdir(exist_ok=True);fixture.write_bytes(recording())
  audio=base64.b64encode(recording()).decode()
  async with async_playwright() as p:
    options={'headless':True,'args':['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+str(fixture)+'%noloop','--autoplay-policy=no-user-gesture-required']}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):options['executable_path']=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser=await p.chromium.launch(**options)
    context=await browser.new_context(viewport={'width':1440,'height':1000},permissions=['microphone'])
    await context.add_init_script("""window.__testTracks=[];const original=navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);if(original)navigator.mediaDevices.getUserMedia=async options=>{const stream=await original(options);window.__testTracks.push(...stream.getTracks());return stream};""")
    page=await context.new_page();calls=[];errors=[]
    stored_settings=json.loads(json.dumps(SETTINGS))
    page.on('pageerror',lambda error:errors.append(str(error)))
    async def route(r):
      path=urlparse(r.request.url).path
      if path.startswith('/api/voice-workbench/'):
        action=path[len('/api/voice-workbench/'):];body=r.request.post_data_json if r.request.post_data else {}
        calls.append((r.request.method,action,body))
        if action=='config':
          if r.request.method=='PUT':stored_settings.update(body['settings'])
          result={'settings':stored_settings,'credentials':{'tts':True,'asr':True,'chat':True},'capabilities':{'asr':True,'chat':True,'asrPreparing':False,'asrPhase':'ready'}}
        elif action=='config/check':result={'valid':True,'errors':{},'warnings':{},'checked':'configuration','networkTested':False}
        elif action=='catalog':result={'tools':[{'name':'read','description':'读取测试工作区文件'},{'name':'glob','description':'搜索文件路径'}],'currentWorkspace':'/test/workspace','toolExecutionAvailable':True,'interruption':{'manual':True,'voice':False}}
        elif action=='realtime/events':
          scripted=[{'seq':1,'type':'user-transcript-done','text':'测试输入'},
                    {'seq':2,'type':'tool-start','callId':'call-1','name':'read'},
                    {'seq':3,'type':'tool-end','callId':'call-1','status':'ok','durationMs':120},
                    {'seq':4,'type':'transcript-done','text':'在呢，主人。'},
                    {'seq':5,'type':'done'}]
          heard=len([c for c in calls if c[1]=='realtime/audio'])>2
          after=body.get('after',0)
          result={'events':[event for event in scripted if heard and event['seq']>after],'cursor':5,'done':False}
        elif action=='filler/prepare':result={'phase':'ready','completed':1,'total':1,'language':body.get('language','zh')}
        elif action=='filler':result={'audio':audio,'mime':'audio/wav','text':'嗯，我想想。','language':'zh'}
        elif action=='realtime/start':result={'sessionId':'mock-session','ok':True}
        elif action=='preview':result={'audio':audio,'mime':'audio/wav'}
        else:result={'ok':True,'audio':audio,'mime':'audio/wav'}
        try:await r.fulfill(status=200,content_type='application/json',body=json.dumps(result))
        except Exception:pass
        return
      if path=='/':
        html='''<html><body style="margin:0"><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(mod){const plugin=mod.factory(()=>React);const ctx={slots:{inject(n,fn){fn()},register(meta,Comp){if(meta.name==='main')ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Comp));return ()=>{}}},layout:{}};plugin.apply(ctx)}};</script><script src="/plugin.js"></script></body></html>'''
        await r.fulfill(status=200,content_type='text/html',body=html);return
      mapping={'/react.js':ROOT/'web/node_modules/react/umd/react.production.min.js','/react-dom.js':ROOT/'web/node_modules/react-dom/umd/react-dom.production.min.js','/plugin.js':ROOT/'lib/client.js'}
      file=mapping.get(path)
      if path.startswith('/voice-workbench/'):file=ROOT/'dist/web'/(path[len('/voice-workbench/'):] or 'index.html')
      if file and file.is_file():await r.fulfill(status=200,content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
      else:await r.fulfill(status=404,body='missing')
    await page.route('**/*',route);await page.goto('http://localhost:31099/')
    frame=page.frame_locator('iframe')
    async def nav(name):await frame.get_by_role('button',name=name,exact=True).click()
    try:await frame.get_by_role('heading',name='和小鲸鱼娘聊一会儿',exact=True).wait_for(timeout=15000)
    except Exception:raise AssertionError('plugin did not render inside the host iframe; page errors: '+repr(errors))
    await expect(frame.get_by_label('主导航')).to_be_visible()
    start=frame.get_by_role('button',name='开始对话',exact=True);await expect(start).to_be_enabled()
    await nav('设置')
    await expect(frame.get_by_role('tab',name='对话',exact=True)).to_be_visible()
    await frame.get_by_label('补充提示词',exact=True).fill('先给结论，保持简短。')
    await frame.get_by_role('tab',name='工具',exact=True).click()
    await frame.get_by_role('checkbox',name='read',exact=True).check()
    await frame.get_by_role('checkbox',name='glob',exact=True).uncheck()
    await frame.get_by_label('工作区路径',exact=True).fill('/test/workspace')
    async with page.expect_response(lambda response:response.url.endswith('/config') and response.request.method=='PUT'):
      await frame.get_by_role('button',name='保存设置',exact=True).click()
    saved=[c[2]['settings'] for c in calls if c[0]=='PUT'][-1]
    assert saved['system_prompt']=='先给结论，保持简短。' and saved['enabled_tools']==['read'] and saved['workspace']=='/test/workspace',saved
    await nav('实时对话')
    await frame.get_by_role('button',name='开始对话',exact=True).click()
    await frame.get_by_role('heading',name='和小鲸鱼娘对话中',exact=True).wait_for(timeout=15000)
    await frame.get_by_text('在呢，主人。',exact=True).wait_for(timeout=20000)
    await frame.get_by_text('已完成',exact=True).wait_for()
    await frame.locator('summary').filter(has_text='read').click()
    await frame.get_by_text('Call ID: call-1',exact=True).wait_for()
    assert any(c[1]=='realtime/audio' for c in calls),'microphone frames never reached the audio bridge'
    child=page.frames[1]
    assert await child.evaluate('window.__testTracks.length>0'),'synthetic microphone was never opened'
    async with page.expect_response(lambda response:response.url.endswith('/realtime/end')):
      await frame.get_by_role('button',name='结束对话',exact=True).click()
    await frame.get_by_role('heading',name='和小鲸鱼娘聊一会儿',exact=True).wait_for(timeout=10000)
    assert await child.evaluate('window.__testTracks.every(track=>track.readyState==="ended")'),'microphone tracks not released'
    for width in [110,390]:
      await page.set_viewport_size({'width':width,'height':844})
      bounds=await child.evaluate("""()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.body.querySelectorAll('*')].map(e=>({tag:e.tagName,cls:e.className?.baseVal||e.className,width:Math.round(e.getBoundingClientRect().width),right:Math.round(e.getBoundingClientRect().right)})).filter(e=>e.right>innerWidth+2&&e.width>0).slice(0,18)})""")
      assert bounds['scroll']<=bounds['width']+2,bounds
    assert not errors,errors
    print('PASS: plugin mounts in the host iframe, sidebar navigation, settings save round-trip, realtime turn with tool timeline, mic release and 110/390px layout; zero live API calls')
    await browser.close()
asyncio.run(main())