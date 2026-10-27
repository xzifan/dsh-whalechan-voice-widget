import test from 'node:test'
import assert from 'node:assert/strict'
import {initializeToolSelection,toolRisk,sortTools} from './tool-selection.js'
test('common tools lead, risk overrides frequency, and equal ranks remain stable',()=>{
 const tools=Object.freeze([{name:'bash'},{name:'custom_b'},{name:'functions.read'},{name:'send_email'},{name:'web_search'},{name:'custom_a'},{name:'edit'},{name:'mcp/repo/delete_branch'}])
 assert.deepEqual(sortTools(tools).map(tool=>tool.name),['web_search','functions.read','custom_b','custom_a','edit','bash','send_email','mcp/repo/delete_branch'])
 assert.equal(tools[0].name,'bash')
 assert.deepEqual(sortTools(undefined),[])
 assert.deepEqual(sortTools([]),[])
})
const catalog={toolExecutionAvailable:true,tools:[{name:'read'},{name:'write'},{name:'bash'}]}
test('first configuration selects all available tools and marks initialized',()=>{
 const next=initializeToolSelection({enabled_tools:[],tools_configured:false},catalog)
 assert.deepEqual(next.enabled_tools,['read','write','bash']);assert.equal(next.tools_configured,true)
})
test('explicit clear-all and saved subset survive reload and catalog refresh',()=>{
 const empty={enabled_tools:[],tools_configured:true};assert.equal(initializeToolSelection(empty,catalog),empty)
 const subset={enabled_tools:['read'],tools_configured:true};assert.equal(initializeToolSelection(subset,catalog),subset)
 const legacy=initializeToolSelection({enabled_tools:['read'],tools_configured:false},catalog)
 assert.deepEqual(legacy.enabled_tools,['read']);assert.equal(legacy.tools_configured,true)
})
test('unavailable catalog does not initialize or overwrite settings',()=>{
 const config={enabled_tools:[],tools_configured:false};assert.equal(initializeToolSelection(config,{toolExecutionAvailable:false,tools:[]}),config)
})
test('risk labels distinguish readonly tools from mutation and execution',()=>{
 for(const name of ['bash','functions.write','functions.edit','job_kill','mcp/repo/delete_branch','send_email'])assert.ok(toolRisk({name}),name)
 for(const name of ['read','glob','grep','web_search','web_fetch','read_image','job_output','working_directory'])assert.equal(toolRisk({name}),'',name)
})
