import React,{useState} from 'react'
import {Button} from './components/ui/button'
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from './components/ui/card'
import {Badge} from './components/ui/badge'
import {ValidationInput as Input,ValidationTextarea as Textarea,ValidationProvider,ValidationMessage,useFieldValidation} from './components/config-validation'
import {fieldDestination} from './lib/configuration.js'
import {Label} from './components/ui/label'
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from './components/ui/select'
import {Checkbox} from './components/ui/checkbox'
import {Tabs,TabsList,TabsTrigger,TabsContent} from './components/ui/tabs'
import {VoiceLayerView} from './voice-layer-view.jsx'
import {toolRisk,sortTools} from './lib/tool-selection.js'
import {Save,RefreshCw,MessageCircle,Volume2,FolderOpen,Wrench,LoaderCircle,ShieldAlert} from 'lucide-react'

export function SettingSelect({id,label,value,onChange,items,disabled=false}){const {attributes}=useFieldValidation(id);return <div className="min-w-0 space-y-2">
<Label htmlFor={id}>{label}</Label>
<Select value={value} onValueChange={onChange} disabled={disabled}>
<SelectTrigger id={id} {...attributes} aria-label={label} className="w-full min-w-0">
<SelectValue/>
</SelectTrigger>
<SelectContent className="max-w-[calc(100vw-16px)]">{items.map(item=>
<SelectItem key={item.value} value={item.value} disabled={item.disabled} className="whitespace-normal break-words">{item.label}</SelectItem>)}</SelectContent>
</Select>
<ValidationMessage id={id}/>
</div>}

export function SettingsView(p){
 const {settings,change,fieldErrors={},validationWarnings=[],checkingConfig,checkAllConfig,dirty,saved,configBusy,catalog,catalogBusy,catalogError,loadCatalog,saveConfig,loadConfig}=p
 const [section,setSection]=useState('prompt')
 const [parameterError,setParameterError]=useState('')
 const goToIssue=field=>{const target=fieldDestination(field);setSection(target.section);requestAnimationFrame(()=>requestAnimationFrame(()=>{const node=document.getElementById(target.id);for(let parent=node?.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;node?.focus();node?.scrollIntoView({block:'center',behavior:'smooth'})}))}
 const issueEntries=Object.entries({...fieldErrors,...(parameterError?{'tts_parameters':parameterError}:{})})
 const tools=sortTools(catalog?.tools)
 const selectedTools=new Set(settings.enabled_tools),unknownTools=settings.enabled_tools.filter(name=>!tools.some(tool=>tool.name===name))
 return <ValidationProvider value={{errors:fieldErrors}}>
<div className="mx-auto w-full max-w-6xl min-w-0 space-y-4">
  <Card>
<CardHeader className="gap-3">
<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
<div className="space-y-1">
<CardTitle>设置</CardTitle>
<CardDescription>调整对话偏好、工具与声音。</CardDescription>
</div>
<Badge variant="secondary">{configBusy||(!saved?'加载中':issueEntries.length?`请修正${issueEntries.length}项配置`:dirty?'有未保存更改':'已保存')}</Badge>
</div>
</CardHeader>
<CardContent className="flex min-w-0 flex-wrap items-center gap-2">
<p className="w-full text-xs leading-relaxed text-muted-foreground">更改用于下一次对话；保存后会保留。</p>
<Button onClick={saveConfig} disabled={!!configBusy||checkingConfig||issueEntries.length>0||!saved||!dirty} className="min-w-0 whitespace-normal transition-colors">
<Save/>保存设置</Button>
<Button variant="outline" onClick={checkAllConfig} disabled={!!configBusy||checkingConfig||!!parameterError} className="min-w-0 whitespace-normal">{checkingConfig?<LoaderCircle className="animate-spin"/>:<RefreshCw/>}{checkingConfig?'检查中…':'检查全部配置'}</Button>
<Button variant="ghost" onClick={loadConfig} disabled={!!configBusy} aria-label="重新加载已保存配置" className="min-w-0 whitespace-normal transition-colors">
<RefreshCw/>重新加载</Button>
</CardContent>
</Card>
  {issueEntries.length>0&&<Card role="alert" aria-label="配置问题">
<CardHeader>
<CardTitle>请修正{issueEntries.length}项配置</CardTitle>
<CardDescription>点击问题可跳到对应字段；修改后会重新检查。</CardDescription>
</CardHeader>
<CardContent className="flex min-w-0 flex-col items-start gap-2">{issueEntries.map(([field,message])=>
<Button key={field} variant="link" className="h-auto min-w-0 whitespace-normal text-left text-destructive" onClick={()=>goToIssue(field)}>{message}</Button>)}</CardContent>
</Card>}
   {validationWarnings.length>0&&<Card aria-label="配置提醒"><CardContent className="space-y-2 pt-6">{validationWarnings.map(message=><p key={message} className="text-xs text-muted-foreground">{message}</p>)}</CardContent></Card>}
   <Tabs value={section} onValueChange={setSection} orientation="vertical" className="min-w-0 flex-col gap-4 sm:flex-row">
<TabsList aria-label="设置分类" className="grid h-auto w-full min-w-0 grid-cols-3 gap-1 sm:sticky sm:top-4 sm:flex sm:w-40 sm:shrink-0 sm:flex-col">{[['prompt','对话',MessageCircle],['tools','工具',Wrench],['voice','声音',Volume2]].map(([value,label,Icon])=>
<TabsTrigger key={value} value={value} className="h-auto min-h-9 min-w-0 justify-start whitespace-normal transition-colors">
<Icon/>{label}</TabsTrigger>)}</TabsList>
   <TabsContent value="prompt" className="m-0 min-w-0 flex-1 space-y-4">
<Card>
<CardHeader>
<CardTitle>对话提示词</CardTitle>
<CardDescription>告诉小鲸鱼娘如何陪你聊天。修改会用于下一次 Realtime 对话。</CardDescription>
</CardHeader>
<CardContent className="space-y-3">
<Label htmlFor="system-prompt">补充提示词</Label>
<Textarea id="system-prompt" rows={12} maxLength={8000} value={settings.system_prompt} onChange={event=>change('system_prompt',event.target.value)} placeholder="例如：回答简短一点，先说结论，再问一个自然的追问。"/>
<ValidationMessage id="system-prompt"/>
<p className="text-xs text-muted-foreground">鲸鱼娘的身份与称呼仍会保留，这里用于补充聊天偏好。</p>
</CardContent>
</Card>
</TabsContent>
<TabsContent value="tools" className="m-0 min-w-0 flex-1 space-y-4">
<Card>
<CardHeader>
<CardTitle className="flex items-center gap-2"><FolderOpen className="size-4"/>工作区</CardTitle>
<CardDescription>启用工具时，在这里选择它们工作的目录。</CardDescription>
</CardHeader>
<CardContent className="space-y-4">
<div className="space-y-2">
<Label htmlFor="workspace">工作区路径</Label>
<Input id="workspace" value={settings.workspace} onChange={event=>change('workspace',event.target.value)} placeholder="留空使用 DSH 当前工作区"/>
<ValidationMessage id="workspace"/>
</div>
<div className="min-w-0 space-y-2 rounded-lg border bg-muted/30 p-3">
<p className="text-xs text-muted-foreground">DSH 当前工作区</p>
<p className="break-all text-sm">{catalog?.currentWorkspace||'尚未读取'}</p>
<Button variant="outline" size="sm" disabled={!catalog?.currentWorkspace} onClick={()=>change('workspace',catalog.currentWorkspace)}>使用当前工作区</Button>
</div>
<p className="text-xs text-muted-foreground">工具和工作区修改用于下一次请求，不会改动其他会话的工作目录。</p>
</CardContent>
</Card>
<Card>
<CardHeader>
<div className="flex flex-wrap items-center justify-between gap-2">
<CardTitle id="tools-heading" tabIndex={-1} className="flex items-center gap-2"><Wrench className="size-4"/>Realtime 工具</CardTitle>
<Button size="sm" variant="outline" onClick={loadCatalog} disabled={catalogBusy}>
<RefreshCw/>刷新工具</Button>
</div>
<CardDescription>可用工具默认全部勾选，也可以按需取消。按预计常用程度排序，高危工具统一靠后并用红框标识；实际执行仍遵循 DSH 审批与文件策略。</CardDescription>
</CardHeader>
<CardContent className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">已选 {tools.filter(tool=>selectedTools.has(tool.name)).length} / {tools.length} 个工具</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!catalog?.toolExecutionAvailable||catalogBusy||!tools.length} onClick={()=>change('enabled_tools',tools.map(tool=>tool.name))}>全选</Button><Button size="sm" variant="ghost" disabled={!settings.enabled_tools.length} onClick={()=>change('enabled_tools',[])}>全部取消</Button></div></div>{catalogBusy&&<p className="flex items-center gap-2 text-sm text-muted-foreground">
<LoaderCircle className="size-4 animate-spin"/>正在读取可用工具…</p>}{catalogError&&<p className="text-sm text-destructive">{catalogError}</p>}{!catalog?.toolExecutionAvailable&&<p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">当前没有可用的工具执行服务。对话仍可正常进行。</p>}{!catalogBusy&&!tools.length&&<p className="text-sm text-muted-foreground">没有可选工具。</p>}{tools.map(tool=>
<div key={tool.name} data-tool-risk={toolRisk(tool)?'high':'normal'} className={`flex min-w-0 items-start gap-3 rounded-lg p-3 ${toolRisk(tool)?'border-2 border-destructive/60 bg-destructive/5':'border'}`}>
<Checkbox id={`tool-${tool.name}`} checked={selectedTools.has(tool.name)} disabled={!catalog?.toolExecutionAvailable} onCheckedChange={checked=>change('enabled_tools',checked===true?[...new Set([...settings.enabled_tools,tool.name])]:settings.enabled_tools.filter(name=>name!==tool.name))}/>
<div className="min-w-0 space-y-1">
<div className="flex flex-wrap items-center gap-2"><Label htmlFor={`tool-${tool.name}`} className="break-all">{tool.name}</Label>{toolRisk(tool)&&<Badge variant="outline" className="gap-1 border-destructive/50 text-destructive"><ShieldAlert className="size-3"/>高危工具</Badge>}</div>
{toolRisk(tool)&&<p className="text-xs text-destructive">{toolRisk(tool)}</p>}
<p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{tool.description||'无额外描述'}</p>
</div>
</div>)}{unknownTools.length>0&&<div className="space-y-2 rounded-md border p-3">
<p className="text-xs text-muted-foreground">以下已选工具当前未出现在目录中：</p>{unknownTools.map(name=>
<div key={name} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
<span className="break-all text-xs">{name}</span>
<Button size="sm" variant="ghost" onClick={()=>change('enabled_tools',settings.enabled_tools.filter(value=>value!==name))}>移除</Button>
</div>)}</div>}</CardContent>
</Card>
</TabsContent>
   <TabsContent value="voice" className="m-0 min-w-0 flex-1">
<VoiceLayerView {...p} onParameterError={setParameterError}/>
</TabsContent>
  </Tabs>
 </div>
</ValidationProvider>
}