import { numericUsage } from './audit-log.js'

const LIMIT=24*1024*1024
const ERROR_BODY_LIMIT=4096
const forbidden=new Set(['__proto__','prototype','constructor'])
const safeCode=value=>String(value||'').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80)
// 非百炼提供方各自的错误体形状不同，只有状态码和一小段错误体被用来判断失败类别；
// 错误体本身绝不回显（可能带账号与请求细节）。
const modelSemantics=text=>/model/i.test(text)&&/(not.?(?:exist|found)|invalid|unsupported|unknown|deprecat|retire|no.?such|unavailable)/i.test(text)
function categoryFor(status,text=''){
  if(status===401||status===403)return 'authorization'
  if(status===402||status===429)return 'quota-or-balance'
  if((status===400||status===404)&&modelSemantics(text))return 'model-unavailable'
  return 'upstream'
}
// `safe` 是审计与建议的唯一来源：`status` 保留上游真实码（对外状态码仍按旧口径映射），
// 分类供 failureAdvice 用，否则 401/429 会被一律显示成「请重试」。
function failure(message,status=502,detail){
  const d=detail||{}
  const code=safeCode(d.code)
  return Object.assign(new Error(message),{name:'VoiceNativeError',status,safe:{status:Number.isInteger(d.status)?d.status:status,code:code||'unknown',category:d.category||'upstream'}})
}
/** Bounded read of an error body so the status can be classified; never surfaced. */
async function errorPayload(response){
  const payload={text:'',code:'',message:''}
  try{
    const reader=response?.body?.getReader?.()
    if(reader){
      let length=0
      try{
        while(length<ERROR_BODY_LIMIT){
          const {done,value}=await reader.read()
          if(done)break
          length+=value.length
          payload.text+=Buffer.from(value).toString('utf8')
        }
      }finally{try{await reader.cancel()}catch{/* 清不掉上游响应不能盖住真正的失败。 */}}
    }else if(typeof response?.text==='function')payload.text=await response.text()
  }catch{return payload}
  payload.text=payload.text.slice(0,ERROR_BODY_LIMIT)
  try{
    const json=JSON.parse(payload.text)
    payload.code=String(json?.code||json?.error?.code||'')
    payload.message=String(json?.message||json?.error?.message||'')
  }catch{/* 非 JSON 错误体仍然可用：401/402/429 只靠状态码就能分类。 */}
  return payload
}
function requireValue(ok,message,status=400){if(!ok)throw failure(message,status)}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
function cancelled(signal){if(signal?.aborted)throw failure('语音请求已取消',499)}
function safePath(value,path){
  requireValue(typeof path==='string'&&path.length<=500,'音频响应路径格式无效')
  const keys=path.split('.')
  requireValue(keys.length&&keys.every(key=>/^[A-Za-z0-9_-]+$/.test(key)&&!forbidden.has(key)),'音频响应路径格式无效')
  let current=value
  for(const key of keys){if(current===null||typeof current!=='object'||!Object.hasOwn(current,key))return undefined;current=current[key]}
  return current
}
function expand(value,variables,depth=0){
  requireValue(depth<=16,'请求模板嵌套过深')
  if(typeof value==='string'){
    const token=value.match(/^\{\{([a-z_]+)\}\}$/)
    if(token){requireValue(Object.hasOwn(variables,token[1]),'请求模板含有不支持的占位符');return structuredClone(variables[token[1]])}
    return value.replace(/\{\{([a-z_]+)\}\}/g,(_,name)=>{requireValue(Object.hasOwn(variables,name),'请求模板含有不支持的占位符');const replacement=variables[name];requireValue(replacement===null||typeof replacement!=='object','JSON 音色只能作为完整占位符使用');return String(replacement??'')})
  }
  if(Array.isArray(value))return value.map(item=>expand(item,variables,depth+1))
  if(plain(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,expand(item,variables,depth+1)]))
  requireValue(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value),'请求模板须为有效 JSON')
  return value
}
function endpoint(profile){
  let url;try{url=new URL(profile.endpoint)}catch{throw failure('语音服务地址格式无效',400)}
  requireValue(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname),'语音服务地址须为 HTTPS 或本机 HTTP')
  requireValue(!url.username&&!url['pass'+'word']&&!url.search&&!url.hash,'语音服务地址不能包含认证信息、查询或片段')
  requireValue(!/[{}]|%7[bd]/i.test(url.hostname),'地址占位符只能出现在路径中')
  if(/\{voice_id\}|%7bvoice_id%7d/i.test(url.pathname)){
    requireValue(typeof profile.voice==='string'&&profile.voice.trim(),'此服务路径需要文本音色 ID')
    url.pathname=url.pathname.replace(/\{voice_id\}|%7bvoice_id%7d/gi,encodeURIComponent(profile.voice.trim()))
  }
  requireValue(!/\{\{|%7b%7b/i.test(url.pathname),'服务地址含有不支持的占位符')
  if(profile.protocol==='breeze-tts'){
    let format=profile.format==='pcm16'?'pcm':profile.format||'mp3'
    if(format==='pcm'&&profile.sample_rate!==undefined&&profile.sample_rate!==24000){
      requireValue([8000,11025,12000,16000,22050,32000,44100,48000].includes(profile.sample_rate),'Breeze Blue 不支持该 PCM 采样率')
      format+='_'+profile.sample_rate
    }
    url.searchParams.set('output_format',format)
  }
  return url.toString()
}
function requestBody(profile,text,language){
  const extra=plain(profile.extra)?profile.extra:{}
  const speed=profile.speed??1,format=profile.format||'mp3',instructions=profile.instructions||''
  if(profile.protocol==='openai-speech')requireValue(Number.isFinite(speed)&&speed>=0.25&&speed<=4,'OpenAI 语速须为 0.25 至 4')
  else if(profile.protocol==='breeze-tts')requireValue(Number.isFinite(speed)&&speed>=0.5&&speed<=2,'Breeze Blue 语速须为 0.5 至 2')
  else if(profile.protocol==='custom-http')requireValue(Number.isFinite(speed),'自定义语速须为有效数字')
  if(format==='pcm16'&&['openai-speech','mimo-chat'].includes(profile.protocol))requireValue(profile.sample_rate===undefined||profile.sample_rate===24000,'此语音协议的 PCM 输出固定为 24000 Hz')
  requireValue(typeof instructions==='string','发音指导须为文本')
  const clean=Object.fromEntries(Object.entries(extra).filter(([key])=>!['stream','stream_format','headers','authorization','api-key','xi-api-key'].includes(key.toLowerCase())))
  if(profile.protocol==='openai-speech'){
    const body={...clean,model:profile.model,input:text,voice:profile.voice,speed,response_format:format==='pcm16'?'pcm':format}
    delete body.instructions
    if(instructions.trim())body.instructions=instructions
    return body
  }
  if(profile.protocol==='mimo-chat'){
    requireValue(!/-(?:voiceclone|voicedesign)$/i.test(profile.model||''),'MiMo 音色设计与克隆使用不同协议，请选择预置音色模型或自定义 HTTP 模板')
    requireValue(typeof profile.voice==='string'&&profile.voice.trim(),'MiMo 预置音色须填写文本 ID')
    const messages=[];if(instructions.trim())messages.push({role:'user',content:instructions});messages.push({role:'assistant',content:text})
    const body={...clean,model:profile.model,messages,audio:{voice:profile.voice,format},stream:false};delete body.speed
    return body
  }
  if(profile.protocol==='breeze-tts'){
    requireValue(typeof profile.voice==='string'&&profile.voice.trim(),'Breeze Blue 须填写音色 ID')
    const body={...clean,text,model_id:profile.model,voice_settings:{...(plain(extra.voice_settings)?extra.voice_settings:{}),speed}}
    delete body.instructions;delete body.language_code
    if(instructions.trim())body.instructions=instructions
    if(['zh','ja','en'].includes(language))body.language_code=language
    return body
  }
  if(profile.protocol==='custom-http'){
    requireValue(plain(profile.request_template),'请填写 JSON 请求模板')
    const body={...clean,...expand(profile.request_template,{text,model:profile.model??'',voice:profile.voice??'',speed,language:language??'',instructions})}
    if(Object.hasOwn(body,'stream'))body.stream=false
    return body
  }
  throw failure('不支持的语音服务协议',400)
}
function requestHeaders(profile,key){
  const headers={'Content-Type':'application/json'}
  const kind=profile.auth_type||'bearer'
  requireValue(['bearer','header','none'].includes(kind),'不支持的认证方式')
  if(kind==='none')return headers
  requireValue(typeof key==='string'&&key.trim()&&!/[\r\n]/.test(key),'请配置此语音服务的有效凭据',503)
  if(kind==='bearer')headers.Authorization='Bearer '+key
  else{
    const name=profile.auth_header||'api-key'
    requireValue(typeof name==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(name)&&!['host','content-type','content-length','connection','cookie','proxy-authorization','transfer-encoding'].includes(name.toLowerCase()),'认证请求头名称无效')
    headers[name]=key
  }
  return headers
}
async function readBounded(response,signal){
  const known=Number(response.headers?.get?.('content-length'))
  requireValue(!Number.isFinite(known)||known<=LIMIT,'语音服务响应过大',502)
  if(!response.body?.getReader){const data=Buffer.from(await response.arrayBuffer());requireValue(data.length<=LIMIT,'语音服务响应过大',502);return data}
  const reader=response.body.getReader(),chunks=[];let length=0
  try{
    while(true){cancelled(signal);const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>LIMIT){await reader.cancel();throw failure('语音服务响应过大')};chunks.push(Buffer.from(value))}
  }catch(error){if(signal?.aborted)throw failure('语音请求已取消',499);if(error?.name==='VoiceNativeError')throw error;throw failure('读取语音服务响应失败')}
  finally{reader.releaseLock?.()}
  return Buffer.concat(chunks)
}
function decoded(value,type){
  requireValue(typeof value==='string'&&value.length>0,'语音服务未返回音频',502)
  let data
  if(type==='json-hex'){
    requireValue(value.length%2===0&&/^[a-f0-9]+$/i.test(value),'语音服务返回的音频编码无效',502)
    requireValue(value.length<=LIMIT*2,'语音服务响应过大',502);data=Buffer.from(value,'hex')
  }else{
    const encoded=value.replace(/\s/g,'')
    requireValue(encoded.length<=Math.ceil(LIMIT/3)*4&&/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)&&encoded.length%4!==1&&(!encoded.includes('=')||encoded.length%4===0),'语音服务返回的音频编码无效',502)
    data=Buffer.from(encoded,'base64')
    requireValue(data.toString('base64').replace(/=+$/,'')===encoded.replace(/=+$/,''),'语音服务返回的音频编码无效',502)
  }
  requireValue(data.length>0&&data.length<=LIMIT,'语音服务未返回有效音频',502)
  return data
}
function wave(pcm,rate){
  requireValue(Number.isInteger(rate)&&rate>=8000&&rate<=192000,'PCM 采样率无效')
  requireValue(pcm.length%2===0,'语音服务返回的 PCM 数据无效',502)
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40)
  return Buffer.concat([header,pcm])
}
function audioResult(data,profile,contentType=''){
  requireValue(data.length>0,'语音服务未返回音频',502)
  if(data.length>=12&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WAVE')return {audio:data.toString('base64'),mime:'audio/wav'}
  if(profile.format==='pcm16'||/^audio\/(?:pcm|l16)/i.test(contentType))return {audio:wave(data,['openai-speech','mimo-chat'].includes(profile.protocol)?24000:profile.sample_rate??24000).toString('base64'),mime:'audio/wav'}
  let mime
  if(data.toString('ascii',0,3)==='ID3'||data.length>=2&&data[0]===255&&(data[1]&224)===224&&(data[1]&6)===2)mime='audio/mpeg'
  else if(data.toString('ascii',0,4)==='fLaC')mime='audio/flac'
  else if(data.toString('ascii',0,4)==='OggS')mime='audio/ogg'
  else if(data.length>=2&&data[0]===255&&(data[1]&246)===240)mime='audio/aac'
  requireValue(mime,'语音服务返回的内容不是可播放音频',502)
  return {audio:data.toString('base64'),mime}
}
/** Provider-specific JSON requests and bounded binary/base64/hex audio decoding. */
export async function synthesizeHttpTts({profile,text,key,signal,fetcher=globalThis.fetch,language}){
  cancelled(signal)
  requireValue(plain(profile)&&typeof text==='string'&&text.trim()&&text.length<=2000,'请输入有效的语音合成文本')
  const url=endpoint(profile),body=requestBody(profile,text,language),headers=requestHeaders(profile,key)
  let response
  try{response=await fetcher(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal})}catch{cancelled(signal);throw failure('语音服务连接失败，请检查当前服务配置')}
  cancelled(signal)
  if(!response?.ok){
    const status=Number.isInteger(response?.status)?response.status:502
    const upstream=await errorPayload(response)
    throw failure(`语音服务返回 HTTP ${status}`,status===402?402:502,{status,code:upstream.code,category:categoryFor(status,`${upstream.code} ${upstream.message}`)})
  }
  const data=await readBounded(response,signal),contentType=response.headers?.get?.('content-type')||''
  const type=profile.protocol==='mimo-chat'?'json-base64':profile.protocol==='custom-http'?(profile.response_type||'binary'):'binary'
  if(type==='binary'){
    requireValue(!/\bjson\b/i.test(contentType),'语音服务返回了 JSON，未返回音频',502)
    return { ...audioResult(data,profile,contentType), usage:null, usageAvailable:false }
  }
  requireValue(['json-base64','json-hex'].includes(type),'不支持的音频响应类型')
  let json;try{json=JSON.parse(data.toString('utf8'))}catch{throw failure('语音服务返回的 JSON 无效')}
  const path=profile.protocol==='mimo-chat'?'choices.0.message.audio.data':profile.response_path
  const audio=decoded(safePath(json,path),type)
  const usage=numericUsage(json.usage ?? json.output?.usage)
  const rawId=json.request_id ?? json.id
  const requestId=typeof rawId==='string'?rawId.replace(/[^A-Za-z0-9_.-]/g,'').slice(0,100):''
  return {...audioResult(audio,profile,profile.mime||''),usage,usageAvailable:usage!==null,...(requestId?{requestId}:{})}
}
