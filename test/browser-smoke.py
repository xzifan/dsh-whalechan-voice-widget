"""Offline companion browser check: real client/iframe, synthetic mic, mock APIs; no screenshots."""
import asyncio,base64,io,json,math,mimetypes,os,struct,wave,time
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
SETTINGS={'tts_model':'speech-2.6-hd','speed':1.05,'emotion':'happy','voice_mix':[{'voice_id':'female-shaonv','weight':60},{'voice_id':'female-tianmei','weight':40},{'voice_id':'female-yujie','weight':0}],'chat_model':'','asr_model':'whisper-1','system_prompt':'测试'}
def recording(tone=False):
    stream=io.BytesIO()
    with wave.open(stream,'wb') as out:
        out.setnchannels(1);out.setsampwidth(2);out.setframerate(16000)
        count=48000 if tone else 3200
        out.writeframes(b''.join(struct.pack('<h',int(9000*math.sin(i*math.tau*440/16000)) if tone and i<24000 else 0) for i in range(count)))
    return stream.getvalue()
async def main():
  fixture=ROOT/'.tools/browser-tone.wav';fixture.parent.mkdir(exist_ok=True);fixture.write_bytes(recording(True))
  audio=base64.b64encode(recording()).decode()
  async with async_playwright() as p:
    options={'headless':True,'args':['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+str(fixture)+'%noloop','--autoplay-policy=no-user-gesture-required']}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):options['executable_path']=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser=await p.chromium.launch(**options)
    context=await browser.new_context(viewport={'width':1440,'height':1000},permissions=['microphone'])
    await context.add_init_script("""window.__testTracks=[];const original=navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);if(original)navigator.mediaDevices.getUserMedia=async options=>{const stream=await original(options);window.__testTracks.push(...stream.getTracks());return stream};""")
    page=await context.new_page();calls=[];errors=[];vertex_tuned=asyncio.Event();bilingual_tuned=asyncio.Event();japanese_tuned=asyncio.Event();english_tuned=asyncio.Event()
    stored_settings=json.loads(json.dumps(SETTINGS));turns={}
    page.on('pageerror',lambda error:errors.append(str(error)))
    async def route(r):
      path=urlparse(r.request.url).path
      if path.startswith('/api/voice-workbench/'):
        action=path[len('/api/voice-workbench/'):];body=r.request.post_data_json if r.request.post_data else {}
        calls.append((r.request.method,action,body))
        if action=='tune':
          tuning=body.get('settings',{})
          if tuning.get('voice_mix',[{}])[0].get('weight')==100:vertex_tuned.set()
          if tuning.get('language_mode')=='zh-ja':bilingual_tuned.set()
          if tuning.get('japanese_voice_mix',[{}])[0].get('weight')==100:japanese_tuned.set()
          if tuning.get('english_voice_mix',[{}, {}, {}])[2].get('weight')==100:english_tuned.set()
        if action=='config':
          if r.request.method=='PUT':stored_settings.update(body['settings'])
          result={'settings':stored_settings,'credentials':{'tts':True,'asr':True,'chat':True},'capabilities':{'asr':True,'chat':True,'asrPreparing':False,'asrPhase':'ready'}}
        elif action=='config/check':result={'valid':True,'errors':{},'warnings':{},'checked':'configuration','networkTested':False}
        elif action=='catalog':result={'tools':[{'name':'read','description':'读取测试工作区文件'},{'name':'glob','description':'搜索文件路径'}],'currentWorkspace':'/test/workspace','toolExecutionAvailable':True,'interruption':{'manual':True,'voice':False}}
        elif action=='events':
          turn=turns.get(body.get('requestId'),{'events':[],'done':False})
          result={'events':[event for event in turn['events'] if event['seq']>body.get('after',0)],'cursor':len(turn['events']),'done':turn['done']}
        elif action=='filler/prepare':result={'phase':'ready','completed':1,'total':1,'language':body.get('language','zh')}
        elif action=='filler':result={'audio':audio,'mime':'audio/wav','text':'嗯，我想想。','language':'zh'}
        elif action=='debug':
          stamp=int(time.time()*1000);call={'id':'mock-call-'+body['requestId'],'name':'read','status':'running','arguments':{'file_path':'voice-test.txt'},'startedAt':stamp}
          turn={'events':[{'seq':1,'type':'input','text':'测试输入','source':'voice' if body.get('audio') else 'text','at':stamp},{'seq':2,'type':'tool-start','toolCall':call,'at':stamp}],'done':False};turns[body['requestId']]=turn
          await asyncio.sleep(1.5)
          final={**call,'status':'succeeded','result':'只读工具检查通过','endedAt':int(time.time()*1000)}
          reply='迟到回复' if body.get('text')=='取消这句' else '在呢，主人。'
          turn['events'].extend([{'seq':3,'type':'tool-end','toolCall':final,'at':int(time.time()*1000)},{'seq':4,'type':'reply','text':reply,'at':int(time.time()*1000)}]);turn['done']=True
          result={'recognized':'测试输入','reply':reply,'toolCalls':[final],'audio':audio,'mime':'audio/wav'}
        elif action=='preview':
          await asyncio.sleep(.35)
          result={'audio':audio,'mime':'audio/wav'}
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
    async def home():await frame.get_by_role('tab',name='对话',exact=True).click()
    async def voice():
      await frame.get_by_role('tab',name='设置',exact=True).click()
      await frame.get_by_role('tab',name='声音',exact=True).click()
    try:await frame.get_by_role('heading',name='小鲸鱼娘在这里。',exact=True).wait_for(timeout=10000)
    except Exception as error:raise AssertionError('Plugin initial render failed: '+repr(errors)) from error
    await expect(frame.get_by_role('button',name='开始对话',exact=True)).to_be_enabled()
    assert await frame.get_by_role('application',name='音色三角配比').count()==0,'tuning must not occupy dialogue homepage'
    await frame.get_by_role('tab',name='设置',exact=True).click()
    await frame.get_by_label('补充提示词',exact=True).fill('先给结论，保持简短。')
    await frame.get_by_role('tab',name='工具',exact=True).click()
    await frame.get_by_role('checkbox',name='read',exact=True).check()
    await frame.get_by_role('tab',name='工作区',exact=True).click()
    await frame.get_by_label('工作区路径',exact=True).fill('/test/workspace')
    await frame.get_by_role('tab',name='说话习惯',exact=True).click()
    await frame.get_by_role('switch',name='等待时说一句',exact=True).check()
    await frame.get_by_label('等待多久后播放（毫秒）',exact=True).fill('0')
    await frame.get_by_label('中性短句（每行一句）',exact=True).fill('嗯，我想想。')
    await frame.get_by_role('button').filter(has_text='准备').last.click()
    await voice()
    triangle=frame.get_by_role('application',name='音色三角配比')
    box=await triangle.locator('svg').bounding_box()
    await page.mouse.click(box['x']+box['width']*160/320,box['y']+box['height']*28/294)
    await asyncio.wait_for(vertex_tuned.wait(),5)
    assert await frame.get_by_label('清亮少女',exact=True).input_value()=='100'
    await triangle.focus();await triangle.press('ArrowRight')
    values=[int(await frame.get_by_label(label,exact=True).input_value()) for label in ['清亮少女','甜美女声','知性御姐']]
    assert sum(values)==100 and values[0]<100,values
    await frame.get_by_role('combobox',name='调音语言',exact=True).click()
    await frame.get_by_role('option',name='日语音色',exact=True).click()
    ja_triangle=frame.get_by_role('application',name='日语音色三角配比')
    await ja_triangle.focus();await ja_triangle.press('1')
    await asyncio.wait_for(japanese_tuned.wait(),5)
    await frame.get_by_role('combobox',name='调音语言',exact=True).click()
    await frame.get_by_role('option',name='英语音色',exact=True).click()
    en_triangle=frame.get_by_role('application',name='英语音色三角配比')
    await en_triangle.focus();await en_triangle.press('3')
    await asyncio.wait_for(english_tuned.wait(),5)
    await frame.get_by_role('combobox',name='调音语言',exact=True).click()
    await frame.get_by_role('option',name='中文音色',exact=True).click()
    assert [int(await frame.get_by_label(label,exact=True).input_value()) for label in ['清亮少女','甜美女声','知性御姐']]==values
    await frame.get_by_role('combobox',name='对话语言',exact=True).click()
    await frame.get_by_role('option',name='中日混合',exact=True).click()
    await asyncio.wait_for(bilingual_tuned.wait(),5)
    await home()
    await frame.get_by_role('button',name='开始对话',exact=True).click()
    await frame.get_by_text('正在想',exact=True).wait_for(timeout=15000)
    await frame.get_by_role('button').filter(has_text='read').filter(has_text='调用中').wait_for()
    await voice()
    slider=frame.get_by_label('清亮少女',exact=True);await slider.fill('70')
    await home()
    await frame.get_by_text('在呢，主人。',exact=True).wait_for()
    await frame.get_by_role('button').filter(has_text='read').filter(has_text='已完成').click()
    await frame.get_by_text('只读工具检查通过',exact=True).wait_for()
    await home()
    await frame.get_by_text('听你说',exact=True).wait_for()
    await voice()
    assert await frame.get_by_label('试听示例文本',exact=True).input_value()=='主人好，有什么可以帮你？'
    await frame.get_by_role('combobox',name='测试句子',exact=True).click()
    await frame.get_by_role('option',name='中文 · 哈喽，这是我的声音',exact=True).click()
    async with page.expect_response(lambda response:response.url.endswith('/preview')):
      await frame.get_by_role('button',name='播放测试声',exact=True).click()
    await home()
    await frame.get_by_text('听你说',exact=True).wait_for()
    await voice()
    sample=[c[2] for c in calls if c[1]=='preview'][-1]
    assert sample['text']=='哈喽，这是我的声音～'
    assert sample['settings']['voice_mix'][0]['weight']==70
    assert not any(c[0]=='PUT' for c in calls),'preview unexpectedly saved configuration'
    async with page.expect_request(lambda request:request.url.endswith('/preview')):
      await frame.get_by_role('button',name='播放测试声',exact=True).click()
    await frame.get_by_role('combobox',name='测试句子',exact=True).click()
    await frame.get_by_role('option',name='日语 · 欢迎回来',exact=True).click()
    await expect(frame.get_by_role('button',name='播放测试声',exact=True)).to_be_enabled()
    async with page.expect_response(lambda response:response.url.endswith('/preview')):
      await frame.get_by_role('button',name='播放测试声',exact=True).click()
    await home()
    await frame.get_by_text('听你说',exact=True).wait_for()
    await voice()
    japanese_sample=[c[2] for c in calls if c[1]=='preview'][-1]
    assert japanese_sample['text']=='ご主人様、おかえりなさい。'
    assert japanese_sample['language']=='ja' and japanese_sample['settings']['japanese_voice_mix'][0]['weight']==100
    await frame.get_by_role('combobox',name='测试句子',exact=True).click()
    await frame.get_by_role('option').filter(has_text='英语').first.click()
    async with page.expect_response(lambda response:response.url.endswith('/preview')):
      await frame.get_by_role('button',name='播放测试声',exact=True).click()
    await home()
    await frame.get_by_text('听你说',exact=True).wait_for()
    await voice()
    english_sample=[c[2] for c in calls if c[1]=='preview'][-1]
    assert english_sample['language']=='en' and english_sample['settings']['english_voice_mix'][2]['weight']==100
    await frame.get_by_label('试听示例文本',exact=True).fill('This is a custom voice test.')
    await expect(frame.get_by_role('combobox',name='测试句子',exact=True)).to_have_text('自定义测试句')
    async with page.expect_response(lambda response:response.url.endswith('/config') and response.request.method=='PUT'):
      await frame.get_by_role('button',name='保存设置',exact=True).click()
    saved_mix=[c[2]['settings'] for c in calls if c[0]=='PUT'][-1]
    assert saved_mix['voice_mix'][0]['weight']==70 and saved_mix['japanese_voice_mix'][0]['weight']==100 and saved_mix['english_voice_mix'][2]['weight']==100
    async with page.expect_response(lambda response:response.url.endswith('/config') and response.request.method=='GET'):
      await frame.get_by_role('button',name='重新加载已保存配置',exact=True).click()
    for label,aria,expected in [('日语音色','日语音色三角配比',[100,0,0]),('英语音色','英语音色三角配比',[0,0,100])]:
      await frame.get_by_role('combobox',name='调音语言',exact=True).click()
      await frame.get_by_role('option',name=label,exact=True).click()
      names=['日语·优雅少女','日语·甜美少女','日语·沉静女声'] if label=='日语音色' else ['英语·动漫角色','英语·俏皮少女','英语·优雅女声']
      weights=[int(await frame.get_by_label(name,exact=True).input_value()) for name in names]
      assert weights==expected,weights
    assert saved_mix['enabled_tools']==['read'] and saved_mix['workspace']=='/test/workspace' and saved_mix['system_prompt']=='先给结论，保持简短。'
    assert any(c[1]=='events' for c in calls) and any(c[1]=='filler' for c in calls),'missing live events or cached filler playback'
    await home()
    await frame.get_by_role('button',name='结束对话',exact=True).click()
    await frame.get_by_text('已停止',exact=True).wait_for()
    child=page.frames[1]
    assert await child.evaluate('window.__testTracks.length>0 && window.__testTracks.every(track=>track.readyState==="ended")'),'microphone tracks not released'
    assert any(c[1]=='debug' and c[2].get('audio') for c in calls),'no VAD audio turn'
    assert any(c[1]=='tune' and c[2]['settings']['voice_mix'][0]['weight']==70 for c in calls),'no live tuning while thinking'
    await frame.get_by_label('想对小鲸鱼娘说的话',exact=True).fill('取消这句')
    await frame.get_by_role('button',name='发送',exact=True).click()
    await frame.get_by_text('正在想',exact=True).wait_for()
    async with page.expect_response(lambda response:response.url.endswith('/cancel')):
      await frame.get_by_role('button',name='打断',exact=True).click()
    await frame.get_by_text('已停止',exact=True).wait_for()
    async with page.expect_response(lambda response:response.url.endswith('/reset')):
      await frame.get_by_role('button',name='清空对话',exact=True).click()
    assert await frame.get_by_text('迟到回复',exact=True).count()==0
    for width in [110,390]:
      await page.set_viewport_size({'width':width,'height':844})
      bounds=await child.evaluate("""()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.body.querySelectorAll('*')].map(e=>({tag:e.tagName,cls:e.className?.baseVal||e.className,width:Math.round(e.getBoundingClientRect().width),right:Math.round(e.getBoundingClientRect().right)})).filter(e=>e.right>innerWidth+2&&e.width>0).slice(0,18)})""")
      assert bounds['scroll']<=bounds['width']+2,bounds
    assert not errors,errors
    assert any(c[1]=='cancel' for c in calls) and any(c[1]=='reset' for c in calls)
    print('PASS: separate shadcn dialogue/settings, prompt/tools/workspace/habits, live tool timeline, cached filler, independent CN/JA/EN banks, save/reload, previews, continuous synthetic mic, cancellation/autoplay/resume, 110/390px layout; zero live API calls')
    await browser.close()
asyncio.run(main())
