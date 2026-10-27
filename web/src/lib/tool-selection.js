// Risk labels describe capability; DSH remains responsible for approval/guards.
const leafName=name=>String(name||'').split(/[./:]/).at(-1).toLowerCase()
export function toolRisk(tool){
 const name=leafName(tool?.name)
 if (/^subagent(?:_|$)/.test(name)) return '可委派代理执行任务，可能调用写入或命令工具'
 if (/^(bash|exec|exec_command|shell|run_code|execute|terminal)$/.test(name)) return '可执行命令，可能修改文件或系统状态'
 if (/^(write|edit|apply_patch|delete|remove|move|rename)(_|$)/.test(name)) return '可写入、修改或删除文件与数据'
 if (/^(job_kill|kill|stop_process|terminate)(_|$)/.test(name)) return '可终止正在运行的任务或进程'
 if (/(^|_)(send|publish|deploy|purchase|payment|transfer|install|uninstall|merge|push|create|update|delete|remove|execute|exec)(_|$)/.test(name)) return '可能改变外部服务、资源或运行状态'
 return ''
}
// Expected usefulness in voice conversations, not measured usage statistics.
const commonTools=['web_search','web_fetch','read','glob','grep','read_image','schedule_list','session_search','session_event_search','session_event_read','working_directory','job_output','job_list','list_agents','get_goal','skill','ask_user_question','present','write','edit','bash']
const commonToolRanks=new Map(commonTools.map((name,index)=>[name,index]))
export function sortTools(tools){
 if(!Array.isArray(tools))return []
 return tools.map((tool,index)=>({tool,index,risk:Number(Boolean(toolRisk(tool))),rank:commonToolRanks.get(leafName(tool?.name))??commonTools.length}))
  .sort((a,b)=>a.risk-b.risk||a.rank-b.rank||a.index-b.index)
  .map(({tool})=>tool)
}
export function initializeToolSelection(settings,catalog){
 if(settings.tools_configured||!catalog?.toolExecutionAvailable||!Array.isArray(catalog.tools))return settings
 const existing=Array.isArray(settings.enabled_tools)?settings.enabled_tools:[]
 return {...settings,tools_configured:true,enabled_tools:existing.length?existing:[...new Set(catalog.tools.map(t=>t.name))]}
}
