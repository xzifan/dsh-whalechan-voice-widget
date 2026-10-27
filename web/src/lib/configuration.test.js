import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeSettings} from './core.js'
import {configIssues,configurationContext,fieldDestination,fieldForControl,mergeConfigurationErrors,errorsForField} from './configuration.js'

test('a normalized realtime settings object passes validation',()=>{
  assert.deepEqual(configIssues(normalizeSettings(),configurationContext({},{})),{})
})

test('invalid workspace, prompt and tool lists are flagged and clear on correction',()=>{
  let settings=normalizeSettings()
  settings.workspace='x'.repeat(3000)
  settings.system_prompt='y'.repeat(9000)
  settings.enabled_tools=[123]
  assert.ok(configIssues(settings).workspace)
  assert.ok(configIssues(settings).system_prompt)
  assert.ok(configIssues(settings).enabled_tools)
  assert.deepEqual(configIssues(normalizeSettings()),{})
})

test('non-object realtime settings are flagged',()=>{
  const settings=normalizeSettings();settings.realtime='bad'
  assert.ok(configIssues(settings).realtime)
})

test('issue links route fields to dialogue, tools and voice sections',()=>{
  assert.deepEqual(fieldDestination('system_prompt'),{section:'prompt',id:'system-prompt'})
  assert.deepEqual(fieldDestination('workspace'),{section:'tools',id:'workspace'})
  assert.deepEqual(fieldDestination('enabled_tools'),{section:'tools',id:'tools-heading'})
  assert.deepEqual(fieldDestination('realtime.use_tts_voice'),{section:'voice',id:'realtime'})
  assert.equal(fieldForControl('system-prompt'),'system_prompt')
  assert.equal(fieldForControl('workspace'),'workspace')
  assert.equal(fieldForControl('tools-heading'),'enabled_tools')
})

test('errorsForField scopes to exact and dotted fields',()=>{
  const errors={workspace:'bad',realtime:'bad object','realtime.use_tts_voice':'bad flag'}
  assert.deepEqual(errorsForField(errors,'workspace'),['bad'])
  assert.deepEqual(errorsForField(errors,'realtime'),['bad object','bad flag'])
})

test('late server errors from old drafts cannot invalidate a newer draft',()=>{
  const server={snapshot:'old',errors:{workspace:'目录不存在'}}
  assert.deepEqual(mergeConfigurationErrors({},server,'new'),{})
  assert.deepEqual(mergeConfigurationErrors({},server,'old'),{workspace:'目录不存在'})
})