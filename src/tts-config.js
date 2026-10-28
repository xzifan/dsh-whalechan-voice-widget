import {BREEZE_PRESET_VOICES} from './breeze-voices.js'

export const TTS_DEFAULTS={tts_provider:'minimax',tts_profiles:{}}
export const TTS_PROTOCOLS=['openai-speech','mimo-chat','breeze-tts','custom-http']
export const TTS_PROFILE_DEFAULTS={name:'自定义 TTS',protocol:'custom-http',endpoint:'',model:'',voice:'',speed:1,format:'wav',instructions:'',key_file:'',auth_type:'none',auth_header:'api-key',extra:{},request_template:{input:'{{text}}',model:'{{model}}',voice:'{{voice}}'},response_type:'binary',response_path:'',mime:'audio/wav',sample_rate:24000}
export const TTS_BUILTINS={
 openai:{...TTS_PROFILE_DEFAULTS,name:'OpenAI 兼容语音',protocol:'openai-speech',endpoint:'https://api.openai.com/v1/audio/speech',model:'gpt-4o-mini-tts',voice:'alloy',format:'mp3',auth_type:'bearer',mime:'audio/mpeg'},
 mimo:{...TTS_PROFILE_DEFAULTS,name:'MiMo',protocol:'mimo-chat',endpoint:'https://api.xiaomimimo.com/v1/chat/completions',model:'mimo-v2.5-tts',voice:'mimo_default',auth_type:'header',response_type:'json-base64',response_path:'choices.0.message.audio.data'},
 breeze:{...TTS_PROFILE_DEFAULTS,name:'Breeze Blue',protocol:'breeze-tts',endpoint:'https://api.breeze.blue/v1/text-to-speech/{voice_id}',model:'breeze-tts-2-multilingual',voice:BREEZE_PRESET_VOICES.zh,format:'mp3',auth_type:'header',auth_header:'xi-api-key',mime:'audio/mpeg'},
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
export const validTtsProfileId=id=>typeof id==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(id)&&!['minimax','constructor','prototype','__proto__'].includes(id)
export function ttsProfiles(settings={}){
 const source=object(settings.tts_profiles)?settings.tts_profiles:{}
 return Object.fromEntries([...new Set([...Object.keys(TTS_BUILTINS),...Object.keys(source)])].filter(validTtsProfileId).map(id=>[id,{...TTS_PROFILE_DEFAULTS,...TTS_BUILTINS[id],...(object(source[id])?source[id]:{})}]))
}
export function getTtsProfile(settings={}){
 const id=settings.tts_provider||'minimax'
 if(id==='minimax')return {id,name:'MiniMax',protocol:'minimax',model:settings.tts_model,speed:settings.speed,key_file:settings.tts_key_file,auth_type:'bearer',capabilities:{mixing:true,emotion:true,nativeTags:/^speech-2\.8/.test(settings.tts_model||''),tagSyntax:'minimax'}}
 const profile=ttsProfiles(settings)[id]
 return profile?{...profile,id,capabilities:{mixing:false,emotion:false,nativeTags:['mimo-chat','breeze-tts'].includes(profile.protocol),tagSyntax:profile.protocol==='mimo-chat'?'mimo':profile.protocol==='breeze-tts'?'breeze':null}}:null
}
export function ttsEndpointProblem(value){
 if(typeof value!=='string'||value.length>2048)return '语音服务地址格式无效'
 if(!value.trim())return null
 let url;try{url=new URL(value.trim())}catch{return '请填写完整的语音服务 URL'}
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return '语音服务地址须为 HTTPS 或本机 HTTP'
 if(url.username||url.password||url.search||url.hash)return '语音服务地址不能包含认证信息、查询或片段'
 if(/[{}]|%7[bd]/i.test(url.hostname))return '地址占位符只能放在路径中'
 const path=url.pathname.replace(/\{voice_id\}|%7bvoice_id%7d/gi,'')
 if(/[{}]|%7[bd]/i.test(path))return '服务地址仅支持 {voice_id} 路径占位符'
 return null
}
function jsonProblem(value,requiredObject=false){
 if(requiredObject&&!object(value))return '须为 JSON 对象'
 const seen=new Set();let count=0
 function inspect(item,depth){
  if(depth>12||++count>2000)return 'JSON 内容过大或嵌套过深'
  if(item===null||typeof item==='string'||typeof item==='boolean')return null
  if(typeof item==='number')return Number.isFinite(item)?null:'JSON 数值必须有限'
  if(typeof item!=='object'||seen.has(item))return '须为可序列化的 JSON 值'
  seen.add(item)
  for(const [key,child] of Object.entries(item)){
   if(['__proto__','constructor','prototype'].includes(key))return 'JSON 包含不支持的字段'
   if(/^(?:headers|api[_-]?key|x[-_]api[-_]key|xi[-_]api[-_]key|authorization|proxy-authorization|password|secret|access[_-]?token|refresh[_-]?token|cookie)$/i.test(key))return '密钥须通过 DSH 凭据管理配置，不能直接写入 JSON'
   const issue=inspect(child,depth+1);if(issue)return issue
  }
  seen.delete(item);return null
 }
 const issue=inspect(value,0);if(issue)return issue
 try{if(JSON.stringify(value).length>32768)return 'JSON 内容不能超过 32768 字'}catch{return '须为可序列化的 JSON 值'}
 return null
}
export function ttsIssues(settings,context={},options={}){
 const errors={},fail=(key,message)=>{errors[key]??=message}
 if(typeof settings.tts_provider!=='string'||(settings.tts_provider!=='minimax'&&!validTtsProfileId(settings.tts_provider)))fail('tts_provider','请选择有效的语音提供方')
 if(!object(settings.tts_profiles)){fail('tts_profiles','语音提供方配置须为对象');return errors}
 if(Object.keys(settings.tts_profiles).length>12)fail('tts_profiles','最多保存12个语音提供方配置')
 for(const id of Object.keys(settings.tts_profiles))if(!validTtsProfileId(id))fail('tts_profiles','语音提供方标识格式无效')
 const profiles=ttsProfiles(settings),active=settings.tts_provider
 if(active!=='minimax'&&!Object.hasOwn(profiles,active))fail('tts_provider','所选语音提供方不存在，请重新选择')
 for(const [id,profile] of Object.entries(profiles)){
  if(!options.allProfiles&&id!==active)continue
  const prefix=`tts_profiles.${id}`,required=id===active
  if(Object.hasOwn(settings.tts_profiles,id)&&!object(settings.tts_profiles[id])){fail(prefix,'提供方配置须为对象');continue}
  if(Object.hasOwn(settings.tts_profiles,id)){const issue=jsonProblem(settings.tts_profiles[id],true);if(issue)fail(prefix,issue)}
  for(const [field,max] of [['name',80],['endpoint',2048],['model',200],['instructions',4000],['key_file',2048],['auth_header',80],['response_path',300],['mime',100]])if(typeof profile[field]!=='string'||profile[field].length>max)fail(`${prefix}.${field}`,`此项须为不超过${max}字的文本`)
  if(!TTS_PROTOCOLS.includes(profile.protocol))fail(`${prefix}.protocol`,'不支持的语音接口协议')
  const endpoint=ttsEndpointProblem(profile.endpoint);if(endpoint)fail(`${prefix}.endpoint`,endpoint)
  else if(required&&!profile.endpoint.trim())fail(`${prefix}.endpoint`,'请填写完整的语音服务 URL')
  let template='';try{template=JSON.stringify(profile.request_template)}catch{}
  const needsModel=profile.protocol!=='custom-http'||template.includes('{{model}}')
  if(required&&needsModel&&typeof profile.model==='string'&&!profile.model.trim())fail(`${prefix}.model`,'请填写语音模型 ID')
  if(required&&profile.protocol==='openai-speech'&&!((typeof profile.voice==='string'&&profile.voice.trim())||(object(profile.voice)&&typeof profile.voice.id==='string'&&profile.voice.id.trim())))fail(`${prefix}.voice`,'请填写音色名称或包含 id 的音色对象')
  if(required&&profile.protocol==='mimo-chat'&&(typeof profile.voice!=='string'||!profile.voice.trim()))fail(`${prefix}.voice`,'请填写 MiMo 音色名称')
  // Breeze uses built-in language presets; callers select the effective voice.
   if(profile.protocol==='breeze-tts'&&typeof profile.voice!=='string')fail(`${prefix}.voice`,'Breeze 音色 ID 须为文本')
  if(typeof profile.name==='string'&&!profile.name.trim())fail(`${prefix}.name`,'请填写提供方名称')
  if(!['bearer','header','none'].includes(profile.auth_type))fail(`${prefix}.auth_type`,'不支持的鉴权方式')
  if(profile.auth_type==='header'&&(!/^[A-Za-z0-9_-]{1,80}$/.test(profile.auth_header)||/^(?:host|content-length|content-type|connection|cookie|proxy-authorization|transfer-encoding)$/i.test(profile.auth_header)))fail(`${prefix}.auth_header`,'请填写有效的 API Key 请求头名称')
  const path=profile.key_file
  if(typeof path==='string'){
   const text=path.trim(),win=/^[A-Za-z]:[\\/]/.test(text)||/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(text)||/^[\\/](?![\\/])/.test(text),posix=text.startsWith('/')
   // eslint-disable-next-line no-control-regex -- 凭据路径校验需要拒绝控制字符
   if(/[\u0000-\u001f]/.test(path)||(text&&!text.startsWith('~/')&&!(context.platform==='win32'?win:context.platform?posix:win||posix)))fail(`${prefix}.key_file`,'凭据须为服务端绝对路径或以 ~/ 开头')
  }
  if(profile.protocol!=='mimo-chat'){
   const minimum=profile.protocol==='breeze-tts'?0.5:0.25,maximum=profile.protocol==='breeze-tts'?2:4
   if(!Number.isFinite(profile.speed)||profile.speed<minimum||profile.speed>maximum)fail(`${prefix}.speed`,`语速须为 ${minimum} 至 ${maximum}`)
  }
  if(!['mp3','wav','pcm16'].includes(profile.format))fail(`${prefix}.format`,'语音格式须为 MP3、WAV 或 PCM16')
  if(!Number.isInteger(profile.sample_rate)||profile.sample_rate<8000||profile.sample_rate>192000)fail(`${prefix}.sample_rate`,'采样率须为8000至192000的整数')
  if(profile.format==='pcm16'&&profile.protocol==='breeze-tts'&&![8000,11025,12000,16000,22050,24000,32000,44100,48000].includes(profile.sample_rate))fail(`${prefix}.sample_rate`,'Breeze PCM 采样率不受支持')
  if(profile.format==='pcm16'&&profile.protocol==='openai-speech'&&profile.sample_rate!==24000)fail(`${prefix}.sample_rate`,'OpenAI PCM 固定使用 24000 Hz')
  for(const [field,isObject] of [['voice',false],['extra',true],['request_template',true]]){const issue=jsonProblem(profile[field],isObject);if(issue)fail(`${prefix}.${field}`,issue)}
  if(!['binary','json-base64','json-hex'].includes(profile.response_type))fail(`${prefix}.response_type`,'不支持的音频响应类型')
  if(profile.protocol==='custom-http'&&profile.response_type!=='binary'&&(!profile.response_path||!profile.response_path.split('.').every(key=>/^[A-Za-z0-9_-]+$/.test(key)&&!['__proto__','constructor','prototype'].includes(key))))fail(`${prefix}.response_path`,'请填写音频字段路径，例如 data.audio')
  if(typeof profile.mime==='string'&&!/^audio\/[a-z0-9.+-]+$/i.test(profile.mime))fail(`${prefix}.mime`,'请填写有效的音频 MIME 类型')
 }
 return errors
}
