import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MockLanguageModelV4} from 'ai/test';
import {createModelExecutor,createFixtureExecutor,validateOutput,conservativeReservationUsd} from '../src/models/executor.js';
const packet = {sources:[{id:'demo:room',text:'Sample room cap is ₹5,000; applicability unresolved.',page:3,version:'v1'}],upstream:[]};
const output = {findings:[{id:'f1',text:'Room applicability is unresolved.',sourceIds:['demo:room'],severity:'warning',kind:'unknown'}],summary:'Written clarification is needed.',verdict:'flag'};
const env = {LLM_PROVIDER:'google',LLM_MODEL:'explicit-test-model',GEMINI_API_KEY:'fake-not-a-key',LLM_INPUT_USD_PER_MILLION:'0.2',LLM_OUTPUT_USD_PER_MILLION:'0.8'};
test('fixture is explicit, zero cost and source bound',async () => { const result=await createFixtureExecutor().execute({role:'cover-worker',packet});assert.equal(result.provider,'fixture_non_llm');assert.equal(result.estimatedCostUsd,0);assert.deepEqual(result.output.findings[0].sourceIds,['demo:room']); });
test('missing configuration never falls back or creates an agent',async () => {let called=false;const executor=createModelExecutor({env:{},loadModel:()=>{called=true;}});await assert.rejects(executor.execute({role:'primary',packet}),{code:'not_configured'});assert.equal(called,false);});
test('injected model checks SDK settings, abort signal and usage without outbound calls',async () => {
  let settings,call;const executor=createModelExecutor({env,loadModel:async()=>({fake:true}),createAgent:s=>{settings=s;return {generate:async args=>{call=args;return {output,totalUsage:{inputTokens:100,outputTokens:50}};}};}});
  const result=await executor.execute({role:'rules-worker',packet});assert.equal(result.provider,'google');assert.equal(result.estimatedCostUsd,0.00006);assert.equal(settings.maxRetries,0);assert.equal(settings.maxOutputTokens,1800);assert.deepEqual(settings.tools,{});assert.ok(call.abortSignal);assert.match(settings.instructions,/UNTRUSTED DATA/);assert.ok(conservativeReservationUsd(env)>result.estimatedCostUsd);
});
test('invalid citations, enums, extra fields and guarantee assertions reject',() => {
  const ids=new Set(['demo:room']);assert.throws(()=>validateOutput({...output,extra:true},ids));assert.throws(()=>validateOutput({...output,findings:[{...output.findings[0],sourceIds:['invented']}]},ids));assert.throws(()=>validateOutput({...output,verdict:'approved'},ids));assert.throws(()=>validateOutput({...output,summary:'Claim approved'},ids),{code:'unsafe_output'});
});
test('reviewer cannot consume prior verdicts and oversized input rejects before model',async () => {
  const fixture=createFixtureExecutor();await assert.rejects(fixture.execute({role:'evidence-reviewer',packet:{...packet,upstream:[{role:'cover-worker',output}]}}),{code:'reviewer_isolation'});await assert.rejects(fixture.execute({role:'primary',packet:{...packet,input:'x'.repeat(25000)}}),{code:'input_limit'});
});
test('unknown usage fails closed and cancellation never loads provider',async () => {
  const executor=createModelExecutor({env,loadModel:async()=>({}),createAgent:()=>({generate:async()=>({output,totalUsage:{}})})});await assert.rejects(executor.execute({role:'primary',packet}),{code:'usage_unknown'});
  const controller=new AbortController();controller.abort();await assert.rejects(executor.execute({role:'primary',packet,signal:controller.signal}),{code:'aborted'});
});
test('unknown cost rates prevent paid model loading',async () => {const executor=createModelExecutor({env:{...env,LLM_INPUT_USD_PER_MILLION:undefined},loadModel:()=>{throw new Error('must not load');}});await assert.rejects(executor.execute({role:'primary',packet}),{code:'not_configured'});});
test('real ToolLoopAgent structured-output contract executes against SDK mock without network',async () => {
  const model=new MockLanguageModelV4({doGenerate:{content:[{type:'text',text:JSON.stringify(output)}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:50,text:50,reasoning:0}},warnings:[]}});
  const executor=createModelExecutor({env,loadModel:async()=>model});
  const result=await executor.execute({role:'primary',packet});
  assert.deepEqual(result.output,output);assert.equal(model.doGenerateCalls.length,1);assert.equal(result.usage.inputTokens,100);assert.equal(model.doGenerateCalls[0].maxOutputTokens,1800);assert.equal(model.doGenerateCalls[0].responseFormat.type,'json');
});
test('honest explicit negation remains visible but caveats cannot hide affirmative guarantees',() => {
  const ids=new Set(['demo:room']);
  assert.doesNotThrow(()=>validateOutput({...output,summary:'No guaranteed cashless access. Claim is not approved; applicability is unknown.'},ids));
  assert.doesNotThrow(()=>validateOutput({...output,summary:'No claim approved. No guaranteed payout.'},ids));
  assert.throws(()=>validateOutput({...output,summary:'Not guaranteed coverage, but guaranteed cashless access.'},ids),{code:'unsafe_output'});
  assert.throws(()=>validateOutput({...output,summary:'Claim approved. Details are unknown.'},ids),{code:'unsafe_output'});
});
