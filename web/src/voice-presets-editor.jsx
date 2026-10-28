import {Button} from './components/ui/button'
import {Badge} from './components/ui/badge'
import {Label} from './components/ui/label'
import {Textarea} from './components/ui/textarea'
import {Wand2,LoaderCircle,Volume2} from 'lucide-react'
import {presetPromptIssue} from './lib/voice-presets.js'
import {VOICE_PRESETS} from './lib/voice-layer.js'

export function VoicePresetsEditor({controls,disabled=false}) {
  const {presets,editorPresetId,drafts,busy,messages,playback,greeting}=controls
  const preset=presets?.find(item=>item.id===editorPresetId)
  const prompt=preset?(drafts[preset.id]??preset.prompt):''
  const dirty=!!preset&&prompt.trim()!==preset.prompt
  const pending=!!busy&&busy.id===preset?.id
  const generating=pending&&['generate','generating'].includes(busy.action)
  const canApply=!!preset?.candidate&&!dirty
  const issue=presetPromptIssue(prompt)
  const message=messages[preset?.id]
  const ownPlayback=playback.presetId===preset?.id?playback:null
  return <section aria-label="音色预设" className="min-w-0 space-y-4">
    <div className="flex items-center gap-2 text-sm font-medium"><Wand2 className="size-4"/>音色预设</div>
    <p className="text-xs leading-relaxed text-muted-foreground">点击模板填入提示词，再按喜好修改。生成后即可试听一段自然的中文、日语和英语，喜欢后再应用。已生成的音色可直接再听，无需重新生成。</p>
    {!preset?<p role="status" className="text-xs text-muted-foreground">音色提示词尚未加载，请重新加载设置。</p>:<div data-preset-id={preset.id} className="min-w-0 space-y-3 rounded-lg border p-4">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <Label htmlFor="voice-prompt" className="shrink-0 text-sm font-medium">音色提示词</Label>
        <div role="group" aria-label="音色提示词模板" tabIndex={0} className="ml-auto flex min-w-0 max-w-[65%] items-center gap-2 overflow-x-auto overscroll-x-contain pb-1" style={{scrollbarWidth:'thin'}}>
          {VOICE_PRESETS.map(template=><Button key={template.id} type="button" size="sm" variant="outline" className="h-7 shrink-0 whitespace-nowrap px-2 text-xs" disabled={disabled||!!busy} aria-label={`填入${template.name}模板`} onClick={()=>{controls.edit(preset.id,template.designPrompt);document.getElementById('voice-prompt')?.focus()}}>{template.name}</Button>)}
        </div>
      </div>
      <Button type="button" size="sm" variant="secondary" className="h-auto min-h-8 whitespace-normal" disabled={disabled||!!busy} onClick={()=>{controls.edit(preset.id,VOICE_PRESETS.find(template=>template.id==='preset-warm').designPrompt);document.getElementById('voice-prompt')?.focus()}}>使用内置默认提示词</Button>
      <Textarea id="voice-prompt" aria-describedby="voice-prompt-help" rows={5} maxLength={500} value={prompt} disabled={disabled||!!busy} onChange={event=>controls.edit(preset.id,event.target.value)} className="resize-y text-sm leading-relaxed"/>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="voice-prompt-help" className="text-xs text-muted-foreground">{prompt.trim().length}/500 字 · 至少 4 字{dirty?' · 修改后需重新保存并生成。':''}</p>
        <Badge variant={preset.applied&&!dirty?'default':'outline'}>{dirty?'未保存':preset.applied?'已应用':preset.candidate?'已生成':'待生成'}</Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled||!!busy||!!issue||(!dirty&&!!preset.candidate)} onClick={()=>controls.generate(preset.id)}>
          {generating&&<LoaderCircle className="size-4 animate-spin"/>}{generating?(busy.action==='generate'?'保存中…':'生成中…'):!dirty&&preset.candidate?'已生成':'保存并生成音色'}
        </Button>
        <Button size="sm" disabled={disabled||!!busy||!canApply||preset.applied} onClick={()=>controls.apply(preset.id)}>
          {pending&&busy.action==='apply'&&<LoaderCircle className="size-4 animate-spin"/>}{pending&&busy.action==='apply'?'应用中…':preset.applied?'已应用':'应用音色'}
        </Button>
        {canApply&&<Button size="sm" variant="ghost" disabled={disabled||!!busy} onClick={()=>controls.replay(preset.id)}><Volume2 className="size-4"/>{greeting?.presetId===preset.id?'再听一次':'试听音色'}</Button>}
      </div>
      {message?.text&&<p role={['error','greetingError'].includes(message.kind)?'alert':'status'} className={`text-xs leading-relaxed ${['error','greetingError'].includes(message.kind)?'text-destructive':'text-muted-foreground'}`}>{message.text}</p>}
      {message?.kind==='greetingError'&&<Button size="sm" variant="outline" disabled={disabled||!!busy||!canApply} onClick={()=>controls.retryGreeting(preset.id)}>重试试听</Button>}
      {ownPlayback?.playbackError&&<div role="alert" className="space-y-2"><p className="text-xs text-destructive">{ownPlayback.playbackError}</p><Button size="sm" variant="outline" disabled={!!busy} onClick={controls.retryPlayback}>重试播放</Button></div>}
      {ownPlayback?.speaking&&<p role="status" className="text-xs text-muted-foreground">正在播放新音色…</p>}
    </div>}
  </section>
}
