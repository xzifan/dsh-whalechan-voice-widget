import Schema from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, sep, extname } from 'node:path'
import { createService, RequestError } from './service.js'
import { createNativeServices } from './native-services.js'

export const name='voice-workbench'
export const inject=['connection','webServer','llm','agentDefaultModel']
export const Config=Schema.object({
  minimaxKeyFile:Schema.string().default('').description('MiniMax 密钥文件路径，可使用 ~/；兼容 MINIMAX_API_KEY=… 格式'),
  minimaxRegion:Schema.union(['cn','io']).default('cn').description('MiniMax 区域'),
  asrBaseUrl:Schema.string().default('').description('OpenAI 兼容 ASR 根地址，例如 https://服务商/v1'),
  chatBaseUrl:Schema.string().default('').description('OpenAI 兼容对话根地址，例如 https://服务商/v1'),
  stateDir:Schema.string().default('').description('可选：工作台非敏感配置存储目录'),
  nativeAsrDataRoot:Schema.string().default('').description('可选：鲸鱼娘本地识别模型独立缓存目录'),
  runtimeRoot:Schema.string().default('').description('可选：DSH 发行版目录，通常自动检测'),
})
// Speech credentials use the host credentials service. Only references/status
// belong in plugin configuration; secret values are never returned to clients.
export function apply(ctx,config) {
  const native=createNativeServices(ctx,config)
  const service=createService(config,native)
  ctx.effect(()=>()=>Promise.all([service.dispose(),native.dispose?.()]))
  for(const [suffix,methods] of [['health',['GET']],['credentials/status',['POST']],['credentials/save',['POST']],['voice-presets/save',['POST']],['voice-presets/generate',['POST']],['voice-presets/apply',['POST']],['voice-presets/greeting',['POST']],['history/sessions',['POST']],['history/messages',['POST']],['statistics',['POST']],['audit',['POST']],['config',['GET','PUT']],['catalog',['POST']],['models/check',['POST']],['config/check',['POST']],['realtime/start',['POST']],['realtime/audio',['POST']],['realtime/commit',['POST']],['realtime/response',['POST']],['realtime/cancel',['POST']],['realtime/end',['POST']],['realtime/events',['POST']],['realtime/playback',['POST']]]) {
    ctx.effect(()=>ctx.connection.fetch.register({
      path:'/api/voice-workbench/'+suffix,methods,requestBody:suffix==='config'?'buffered':'streaming',
      async fetch(request) {
        try {
          let body={}
          if(request.method!=='GET') {
            const reader=request.body?.getReader();let bytes=0;const chunks=[]
            if(reader) while(true) {
              const {done,value}=await reader.read();if(done)break
              bytes+=value.length
              if(bytes>3*1024*1024+65536){await reader.cancel();throw new RequestError('请求体过大',413)}
              chunks.push(Buffer.from(value))
            }
            try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new RequestError('JSON 格式无效')}
          }
          const result=await service.handle(request.method,'/api/'+suffix,body,request.signal)
          return Response.json(result.body,{status:result.status||200,headers:{'cache-control':'no-store'}})
        }catch(error) {
          const safe=error instanceof RequestError||error?.name==='VoiceNativeError'
          return Response.json({error:safe?error.message:'语音请求失败，请检查插件配置',...(safe&&error.fields?{fieldErrors:error.fields}:{})},
            {status:safe?error.status:500,headers:{'cache-control':'no-store'}})
        }
      },
    }))
  }
  const root=fileURLToPath(new URL('../dist/web/',import.meta.url))
  ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/voice-workbench',async handler(req,res) {
    const admission=ctx.connection.admit(req)
    if('rejection' in admission){res.writeHead(admission.rejection);res.end();return}
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
    try {
      const url=new URL(req.url,'http://localhost')
      if(url.pathname==='/voice-workbench'){res.writeHead(302,{location:'/voice-workbench/'});res.end();return}
      const relative=decodeURIComponent(url.pathname.slice('/voice-workbench/'.length))||'index.html'
      const target=resolve(root,relative)
      if(!target.startsWith(resolve(root)+sep)){res.writeHead(403);res.end();return}
      const content=await readFile(target)
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[extname(target)]||'application/octet-stream'
      res.writeHead(200,{'content-type':mime,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'"})
      res.end(req.method==='HEAD'?undefined:content)
    }catch{res.writeHead(404);res.end()}
  }}))
}
