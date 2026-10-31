import {useState} from 'react'
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from './components/ui/sidebar'
import {Button} from './components/ui/button'
import {Badge} from './components/ui/badge'
import {SettingsView} from './settings-view.jsx'
import {RealtimeView} from './realtime-view.jsx'
import {AuditView} from './audit-view.jsx'
import {HistoryView} from './history-view.jsx'
import {StatisticsView} from './statistics-view.jsx'
import {ChangelogCorner} from './changelog-corner.jsx'
import {Settings2,X,LoaderCircle,Mic,ScrollText,BarChart3} from 'lucide-react'

const NAV = [
 {value:'realtime',label:'实时对话',icon:Mic},
 {value:'history',label:'会话记录',icon:ScrollText},
 {value:'statistics',label:'使用统计',icon:BarChart3},
 {value:'audit',label:'日志审计',icon:ScrollText},
 {value:'settings',label:'设置',icon:Settings2},
]

export function CompanionView(p){
 const [page,setPage]=useState('realtime')
 const [auditMessageId,setAuditMessageId]=useState('')
 const inspectMessage=id=>{setAuditMessageId(id);setPage('audit')}
 return <SidebarProvider>
  <Sidebar collapsible="icon">
   <SidebarHeader className="px-3 pt-4 pb-3 group-data-[collapsible=icon]:px-2">
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg group-data-[collapsible=icon]:justify-center">
     <img src="./avatar.webp" alt="鲸鱼娘" className="size-9 shrink-0 rounded-full object-cover ring-1 ring-border group-data-[collapsible=icon]:size-8" draggable={false}/>
     <div className="min-w-0 group-data-[collapsible=icon]:hidden">
      <p className="truncate text-sm font-semibold tracking-tight">语音小鲸鱼娘</p>
      <p className="truncate text-xs text-muted-foreground">你的声音，我有在听。</p>
     </div>
    </div>
   </SidebarHeader>
   <SidebarContent className="px-3 group-data-[collapsible=icon]:px-2">
    <SidebarMenu aria-label="主导航">
     {NAV.map(({value,label,icon:Icon})=>
      <SidebarMenuItem key={value}>
       <SidebarMenuButton isActive={page===value} tooltip={label} onClick={()=>setPage(value)} className="gap-2.5 px-2 py-2">
        <Icon/>
        <span>{label}</span>
       </SidebarMenuButton>
      </SidebarMenuItem>
     )}
    </SidebarMenu>
   </SidebarContent>
   {p.configBusy&&<SidebarFooter className="px-2 pb-1">
    <Badge variant="outline" className="w-fit gap-1 group-data-[collapsible=icon]:hidden"><LoaderCircle className="size-3 animate-spin"/>{p.configBusy}</Badge>
   </SidebarFooter>}
  </Sidebar>
  <SidebarInset className={`min-w-0 ${page==='history'?'h-svh min-h-0 overflow-hidden':''}`}>
   <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
    <SidebarTrigger aria-label="折叠/展开菜单" className="-ml-1"/>
    <span className="text-sm font-medium">{NAV.find(item=>item.value===page)?.label}</span>
   </header>
   <div className={`flex min-w-0 flex-1 flex-col ${page==='history'?'min-h-0 gap-2 px-3 pt-3 pb-2 sm:px-4 sm:pt-3':'gap-4 p-3 sm:p-5'}`}>
    {p.notice&&<div className={`flex min-w-0 items-start justify-between gap-3 rounded-lg border p-3 text-sm ${p.notice.kind==='error'?'border-destructive/40 text-destructive':'text-muted-foreground'}`} role={p.notice.kind==='error'?'alert':'status'}><span className="min-w-0 break-words">{p.notice.message}</span><Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="关闭提示" onClick={()=>p.setNotice(null)}><X/></Button></div>}
    {page==='realtime'&&<RealtimeView {...p} onInspectMessage={inspectMessage}/>}
    {page==='audit'&&<AuditView initialMessageId={auditMessageId} onClearMessageFilter={()=>setAuditMessageId('')}/>}
    {page==='history'&&<HistoryView onInspectMessage={inspectMessage}/>}
     {page==='statistics'&&<StatisticsView/>}
     {page==='settings'&&<SettingsView {...p}/>}
   </div>
  </SidebarInset>
  <ChangelogCorner/>
 </SidebarProvider>
}
