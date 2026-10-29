import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createResponseBookkeeping} from '../src/realtime-response-bookkeeping.js'

const KEY='tok-abc-secret'

function fixture({live}={}){
 let settings={model:'m-test'},turn={id:'turn-1',generation:0},disposed=false
 const events=[]
 const book=createResponseBookkeeping({
  emit:e=>events.push(e),
  isDisposed:()=>disposed,
  isLive:live||(response=>!disposed&&!response.cancelled),
  currentTurn:()=>turn,
  getSettings:()=>settings,
  key:KEY,
 })
 return {events,book,setSettings:value=>{settings=value},setTurn:value=>{turn=value},dispose:()=>{disposed=true}}
}

test('context 形状固定，缺省 owner 按调用时求值（currentTurn 必须是函数引用）',()=>{
 const s=fixture()
 assert.deepEqual(s.book.context({id:'t1'},'user'),{messageId:'t1:user',turnId:'t1'})
 assert.deepEqual(s.book.context({id:'t1'},'assistant','r1','i1','c1'),
  {messageId:'t1:assistant',turnId:'t1',responseId:'r1',itemId:'i1',callId:'c1'})
 s.setTurn({id:'turn-2'})
 assert.equal(s.book.context().turnId,'turn-2')
 s.setTurn({id:'turn-3'})
 assert.equal(s.book.context().turnId,'turn-3','值快照会让整个 turn 塌成一个')
 assert.deepEqual(s.book.assistantContext({turn:{id:'t9'},id:'r9',itemId:'i9'},{item:{id:'i7'}}),
  {messageId:'t9:assistant',turnId:'t9',responseId:'r9',itemId:'i7'})
 assert.equal(s.book.transcriptContext({turnId:'t9'}).model,'m-test')
})

test('audit 的 model 跟随会话 settings，disposed 后静默',()=>{
 const s=fixture()
 s.book.audit('error',{turnId:'t1'},'failed',{text:'boom'})
 assert.equal(s.events.length,1)
 const record=s.events[0].record
 assert.equal(record.kind,'error');assert.equal(record.status,'failed');assert.equal(record.provider,'bailian')
 assert.equal(record.model,'m-test');assert.equal(record.text,'boom');assert.equal(record.turnId,'t1')
 assert.equal(typeof record.id,'string')
 s.setSettings({model:'m-swapped'})
 s.book.audit('transcription',{},'completed')
 assert.equal(s.events.at(-1).record.model,'m-swapped')
 s.dispose();s.book.audit('error',{},'failed')
 assert.equal(s.events.length,2)
})

test('response 审计字段集固定，音频时长由字节数推出，且只写一次',()=>{
 const s=fixture()
 const response={turn:{id:'t1'},id:'r1',audioBytes:48000,speechText:'你好'}
 s.book.finalizeResponseAudit(response,'completed')
 const record=s.events[0].record
 assert.deepEqual(Object.keys(record).sort(),
  ['at','audioDurationSeconds','audioOutput','id','kind','messageId','model','provider','responseId','status','text','turnId'])
 assert.equal(record.audioDurationSeconds,1);assert.equal(record.audioOutput,true);assert.equal(record.text,'你好')
 s.book.finalizeResponseAudit(response,'failed')
 assert.equal(s.events.length,1,'重复收尾不得追加第二条审计')
 const quiet={turn:{id:'t2'},id:null}
 s.book.finalizeResponseAudit(quiet,'cancelled')
 const second=s.events.at(-1).record
 assert.equal(second.audioOutput,false)
 for(const key of ['audioDurationSeconds','text','responseId']) assert.equal(key in second,false,`${key} 不应出现空值`)
})

test('迟到 usage 追加同 id 快照，不重复、不改 status',()=>{
 const s=fixture()
 const response={turn:{id:'t1'},id:'r1',audioBytes:24000,speechText:'嗯'}
 s.book.finalizeResponseAudit(response,'completed')
 const first=s.events[0].record
 s.book.captureResponseUsage(response,{total_tokens:12,input_tokens:3,output_tokens:9})
 assert.equal(s.events.length,2)
 const late=s.events[1].record
 assert.equal(late.id,first.id);assert.equal(late.status,first.status);assert.equal(late.at,first.at)
 assert.deepEqual(late.usage,{total_tokens:12,input_tokens:3,output_tokens:9})
 assert.equal('usage' in first,false)
 s.book.captureResponseUsage(response,{total_tokens:12,input_tokens:3,output_tokens:9})
 assert.equal(s.events.length,2,'同样的 usage 不得重复追加')
 s.book.captureResponseUsage(response,{total_tokens:14})
 assert.equal(s.events.at(-1).record.usage.total_tokens,14)
})

test('usage 早于审计到达时只记在 response 上，收尾时带进去',()=>{
 const s=fixture()
 const response={turn:{id:'t1'},id:'r1'}
 s.book.captureResponseUsage(response,{total_tokens:5})
 assert.equal(s.events.length,0)
 s.book.finalizeResponseAudit(response,'completed')
 assert.deepEqual(s.events[0].record.usage,{total_tokens:5})
})

test('remember 去重/空串/700 截断/上限 12/密钥脱敏，并返回同一数组实例',()=>{
 const s=fixture()
 const seen=s.book.history
 assert.ok(Array.isArray(seen))
 s.book.remember('user','  ')
 assert.equal(seen.length,0)
 s.book.remember('user','hello')
 s.book.remember('user','hello')
 assert.equal(seen.length,1,'连续同 role 同文不得重复')
 s.book.remember('assistant','hello')
 assert.equal(seen.length,2)
 s.book.remember('user','x'.repeat(900))
 assert.equal(seen.at(-1).text.length,700)
 s.book.remember('user',`token ${KEY} 泄露`)
 assert.equal(seen.at(-1).text.includes(KEY),false)
 assert.equal(seen.at(-1).text.includes('[已隐藏]'),true)
 for(let n=0;n<20;n++) s.book.remember('user',`m${n}`)
 assert.equal(seen.length,12)
 assert.equal(seen.at(-1).text,'m19')
 assert.equal(s.book.history,seen,'fillers 的 context() 依赖同一个实例')
})

test('finalizeText 走 spokenText，只在非 TTS 时发 transcript-done，且幂等',()=>{
 const s=fixture()
 const response={turn:{id:'t1'},id:'r1',tts:false}
 s.book.finalizeText(response,'我先调用 design_voice 工具试试')
 assert.equal(response.text,'我先设计声音试试')
 assert.equal(s.book.history.at(-1).text,'我先设计声音试试')
 assert.equal(s.events.length,1)
 assert.equal(s.events[0].type,'transcript-done')
 assert.equal(s.events[0].model,'m-test')
 assert.equal(s.events[0].messageId,'t1:assistant')
 assert.equal(response.speechContext.turnId,'t1')
 s.book.finalizeText(response,'再来一条')
 assert.equal(s.events.length,1,'finalized 后不得再发')
 const tts={turn:{id:'t2'},id:'r2',tts:true}
 s.book.finalizeText(tts,'你好')
 assert.equal(s.events.length,1,'TTS 会话的文本由合成层投递，不发 transcript-done')
 assert.equal(tts.text,'你好')
})

test('finalizeText 对已失效的 response 不落任何痕迹',()=>{
 const s=fixture({live:()=>false})
 const response={turn:{id:'t1'},id:'r1'}
 s.book.finalizeText(response,'hi')
 assert.equal(s.events.length,0);assert.equal(response.finalized,undefined)
 assert.equal(s.book.history.length,0)
})

test('itemText 优先 text，整段为空才回落 transcript',()=>{
 const {book}=fixture()
 assert.equal(book.itemText({content:[{text:'a'},{transcript:'b'}]}),'a')
 assert.equal(book.itemText({content:[{transcript:'b'},{transcript:'c'}]}),'bc')
 assert.equal(book.itemText({content:[]}),'')
 assert.equal(book.itemText(undefined),'')
})

test('redactError 隐藏会话密钥并交给 redactText 兜底',()=>{
 const {book}=fixture()
 assert.equal(book.redactError(`上游返回 ${KEY} 错误`),'上游返回 [已隐藏] 错误')
 assert.equal(book.redactError(`a ${KEY} b ${KEY} c`),'a [已隐藏] b [已隐藏] c')
 assert.equal(book.redactError(42),'42')
})

test('源码守卫：realtime-service 只通过工厂拿簿记函数',()=>{
 const source=readFileSync(new URL('../src/realtime-service.js',import.meta.url),'utf8')
 assert.match(source,/createResponseBookkeeping/)
 for(const name of ['remember','context','transcriptContext','redactError','audit','assistantContext','finalizeResponseAudit','captureResponseUsage','finalizeText','itemText'])
  assert.equal(new RegExp(`function ${name}\\(`).test(source),false,`${name} 应只在 bookkeeping 模块里定义`)
 assert.equal(/const history = \[\]/.test(source),false,'history 必须由工厂返回同一个实例')
 assert.equal(/currentTurn:\s*\(\s*\)\s*=>/.test(source),false,'currentTurn 必须传函数引用，不能包成快照工厂')
})