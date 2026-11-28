import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../lib/testing.mjs'

test('usage isolates latest starts, snapshots names and bounds switches/sessions', () => {
  assert.equal(typeof mod.RequestUsage, 'function')
  const usage = new mod.RequestUsage(2)
  usage.start('s', 'old', 'model')
  usage.select('s', 'old', 'A', 'Original')
  usage.start('s', 'new', 'model')
  usage.select('s', 'new', 'B', 'Backup')
  usage.finish('s', 'old', 'failed')
  assert.equal(usage.get('s').phase, 'running')
  assert.equal(usage.latest().requestId, 'new')
  for (let i = 0; i < 12; i++) usage.select('s', 'new', `C${i}`, `Seat ${i}`, 'RATE_LIMIT')
  assert.equal(usage.get('s').switches.length, 10)
  usage.start('other', 'third', 'model')
  usage.finish('s', 'new', 'completed')
  assert.equal(usage.latest().requestId, 'third')
  usage.start('last', 'fourth', 'model')
  assert.equal(usage.get('s'), null)
})
const identity={appId:'app',ideFunction:'chat',ideVersion:'1',ideVersionCode:'1',clientVersion:'1',originator:'test',userAgent:'test'}
const options=(sessionId,extra={})=>({model:'GLM-5.3',sessionId,tools:[{name:'bash',parameters:{}}],messages:[{role:'user',content:[{type:'text',text:'hi'}]}],...extra})
test('adapter tracks actual HTTP failover, leaves background calls alone, and closes abort/failure before delta',async()=>{
  const usage=new mod.RequestUsage();const original=globalThis.fetch
  let seat='A'
  const pool={active:()=>true,attempts:1,seats:()=>[{pat:'A',name:'Alpha'},{pat:'B',name:'Beta'}],prepare:async()=>({memberId:seat,session:{token:seat}}),stepAside:async()=>{seat='B';return{memberId:'B',session:{token:'B'}}},reportFailure:async()=>{}}
  const adapter=new mod.TraeAdapter({host:'https://fake',displayName:'test',identity,auth:{get:async()=>({token:'A'})},pool,usage,readTimeoutMs:100,emptyRetries:0,loopGuardChars:0,logger:{info(){},warn(){}}})
  globalThis.fetch=async(url,init)=>init.headers.authorization.includes('A')?new Response('insufficient quota for this seat',{status:402}):new Response('event: output\ndata: {"response":"ok"}\n\nevent: done\ndata: {}\n\n')
  try {
    for await(const c of adapter.stream(options('s'))){}
    assert.equal(usage.get('s')?.phase,'completed')
    assert.equal(usage.get('s').seatId,'B');assert.equal(usage.get('s').seatName,'Beta')
    assert.equal(usage.get('s').switches[0].reasonCode,'QUOTA')
    const before=usage.latest();for await(const c of adapter.stream(options('s',{purpose:'title'}))){}
    assert.deepEqual(usage.latest(),before)
    const controller=new AbortController();controller.abort()
    globalThis.fetch=async(url,init)=>{init.signal.throwIfAborted();throw new Error('transport')}
    await assert.rejects(async()=>{for await(const c of adapter.stream(options('cancel',{signal:controller.signal}))) {}})
    assert.equal(usage.get('cancel').phase,'cancelled')
    await assert.rejects(async()=>{for await(const c of adapter.stream(options('failed'))) {}})
    assert.equal(usage.get('failed').phase,'failed')
  } finally {globalThis.fetch=original}
})
test('interleaved streams report partial refusal against actual seat and record failure',async()=>{
  const original=globalThis.fetch; const usage=new mod.RequestUsage();let cursor=0;let serving;const reports=[];let release
  const pool={active:()=>true,attempts:1,seats:()=>[{pat:'A',name:'Alpha'},{pat:'B',name:'Beta'}],prepare:async()=>{serving=cursor++===0?'A':'B';return{memberId:serving,session:{token:serving}}},reportFailure:async(code,message,id)=>reports.push(id??serving)}
  const adapter=new mod.TraeAdapter({host:'https://fake',displayName:'test',identity,auth:{get:async()=>({token:'A'})},pool,usage,readTimeoutMs:0,emptyRetries:0,loopGuardChars:0,logger:{info(){},warn(){}}})
  globalThis.fetch=async(url,init)=> {
    if(init.headers.authorization.endsWith('A'))return new Response(new ReadableStream({start(controller){release=()=>{controller.enqueue(new TextEncoder().encode('event: output\ndata: {"response":"partial"}\n\nevent: error\ndata: {"error":"rate limit exceeded"}\n\n'));controller.close()}}}))
    return new Response('event: output\ndata: {"response":"ok"}\n\n')
  }
  try {
    const first=(async()=>{for await(const c of adapter.stream(options('a'))) {}})()
    while(!release)await new Promise(r=>setImmediate(r))
    for await(const c of adapter.stream(options('b'))){}
    release();await first
    assert.deepEqual(reports,['A'])
    assert.equal(usage.get('a').phase,'failed')
    assert.equal(usage.get('b').phase,'completed')
  } finally {globalThis.fetch=original}
})
