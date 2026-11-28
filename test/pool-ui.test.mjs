import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mod from '../lib/testing.mjs'
const jwt = (name='a') => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp:4102444800,data:{email:`${name}@example.com`} })).toString('base64url')}.sig`
function setup() {
  const secrets = { A:'pat-secret-a', B:jwt('b') }
  let roster = ['A','B','M'].map(pat => ({pat,name:pat,email:'',password:''}))
  const pool = new mod.TraePatPool({host:'https://upstream.test',clientId:'app',userAgent:'test',seats:()=>roster,mode:()=> 'rotate',readSecret:async ref=> secrets[ref],singleRef:()=> 'A',maxAttempts:()=>3,logger:{info(){},warn(){}},storeFile:join(mkdtempSync(join(tmpdir(),'pool-ui-')),'probe.json')})
  const view = new mod.TraePoolView({pool,host:'https://upstream.test',consoleHost:'https://console.test',clientId:'app',userAgent:'test',readSecret:async ref=>secrets[ref],writable:()=>true,mode:()=> 'rotate'})
  return {pool,view,secrets,setRoster:v=>{roster=v}}
}
test('pool view reads metadata without auth/rotation; validates current credential and retains cooldown', async () => {
  assert.equal(typeof mod.TraePoolView,'function')
  const {pool,view,secrets}=setup()
  const original=globalThis.fetch; const calls=[]
  globalThis.fetch=async (url)=>{calls.push(String(url));return Response.json({Result:{Token:jwt(),TokenExpireAt:4102444800}})}
  try {
    const status=await view.snapshot()
    assert.deepEqual(status.summary,{total:3,configured:2,usable:0,attention:0,pending:3})
    assert.equal(calls.length,0)
    assert.equal((await pool.prepare()).memberId,'A')
    await pool.reportFailure('RATE_LIMIT','safe','A')
    assert.equal((await view.validate('A')).validation,'valid')
    const after=await view.snapshot()
    assert.equal(after.summary.usable,0)
    assert.equal(after.summary.attention,1)
    assert.equal(after.seats[0].reasonCode,'rate-limited')
    assert.equal(after.seats[2].validation,'missing')
    assert.equal(JSON.stringify(after).includes(secrets.A),false)
    assert.equal((await pool.prepare()).memberId,'B')
    await pool.reportFailure('AUTH','safe','A')
    assert.equal((await view.snapshot()).seats[0].validation,'invalid')
  } finally {globalThis.fetch=original}
})
test('direct JWT requires server identity, failures are sanitized and validations coalesce', async () => {
  assert.equal(typeof mod.TraePoolView,'function')
  const {view,secrets}=setup(); const original=globalThis.fetch; let calls=0
  globalThis.fetch=async ()=>{calls++;return new Response(secrets.B,{status:401})}
  try {
    const [a,b]=await Promise.all([view.validate('B'),view.validate('B')])
    assert.equal(calls,1); assert.equal(a.validation,'invalid'); assert.deepEqual(a,b)
    assert.equal(JSON.stringify(a).includes(secrets.B),false)
    assert.equal((await view.snapshot()).summary.attention,1)
  } finally {globalThis.fetch=original}
})
test('credential generation and removed roster discard late validation evidence', async () => {
  assert.equal(typeof mod.TraePoolView,'function')
  const {view,secrets,setRoster}=setup(); const original=globalThis.fetch; let resolve
  globalThis.fetch=()=>new Promise(r=>{resolve=r})
  try {
    const pending=view.validate('A'); while(!resolve) await new Promise(r=>setImmediate(r))
    secrets.A='new-secret'; view.invalidate('A');
    resolve(Response.json({Result:{Token:jwt(),TokenExpireAt:4102444800}}));await pending
    assert.equal((await view.snapshot()).seats[0].validation,'unknown')
    let release; globalThis.fetch=()=>new Promise(r=>{release=r})
    const removed=view.validate('A');while(!release)await new Promise(r=>setImmediate(r))
    setRoster([]);await view.snapshot();release(Response.json({Result:{Token:jwt(),TokenExpireAt:4102444800}}));await removed
    assert.equal((await view.snapshot()).seats.length,0)
  } finally {globalThis.fetch=original}
})
test('exchange without genuine expiry stays pending instead of inventing validation lifetime',async()=>{
  const {view}=setup();const original=globalThis.fetch
  globalThis.fetch=async()=>Response.json({Result:{Token:'opaque-server-token-with-no-expiry'}})
  try {
    const row=await view.validate('A')
    assert.equal(row.validation,'unavailable')
    assert.equal(row.reasonCode,'verification-protocol')
    assert.equal((await view.snapshot()).summary.usable,0)
  } finally {globalThis.fetch=original}
})
test('rename and reorder preserve current credential evidence, remove/readd discards pending evidence',async()=>{
  const {view,setRoster}=setup();const original=globalThis.fetch
  globalThis.fetch=async()=>Response.json({Result:{Token:jwt(),TokenExpireAt:4102444800}})
  try {
    await view.validate('A')
    setRoster(['B','A','M'].map(pat=>({pat,name:`renamed ${pat}`,email:'',password:''})))
    const snapshot=await view.snapshot()
    assert.equal(snapshot.seats[1].validation,'valid')
    assert.equal(snapshot.seats[1].name,'renamed A')
  } finally {globalThis.fetch=original}
})
test('server identity echoing an opaque secret is never exposed',async()=>{
  const {view,secrets}=setup();const original=globalThis.fetch
  globalThis.fetch=async()=>Response.json({Result:{Token:jwt(secrets.A),TokenExpireAt:4102444800}})
  try {
    const row=await view.validate('A')
    assert.equal(row.validation,'valid')
    assert.equal(row.identity,null)
    assert.equal(JSON.stringify(row).includes(secrets.A),false)
  } finally {globalThis.fetch=original}
})
test('delayed old exchange rejection cannot poison a new credential',async()=>{
  const {pool,secrets}=setup();const original=globalThis.fetch;let release
  globalThis.fetch=()=>new Promise(resolve=>{release=()=>resolve(new Response('invalid token',{status:401}))})
  try {
    const old=pool.prepare();while(!release)await new Promise(r=>setImmediate(r))
    secrets.A=jwt('replacement');await pool.resetByRef('A')
    release();await old
    assert.equal((await pool.status()).find(s=>s.ref==='A').reason,undefined)
  } finally {globalThis.fetch=original}
})
test('pool rechecks captured credential guard after awaiting probe state',async()=>{
  for(const path of ['reportFailure','stepAside']) {
    const {pool,view,secrets}=setup();secrets.A=jwt('original')
    const picked=await pool.prepare();const ticket=await view.observeRequest('A',picked.session)
    const original=pool.probeState.bind(pool);const prior=await original();let release
    pool.probeState=()=>new Promise(resolve=>{release=()=>resolve(prior)})
    const pending=path==='reportFailure'
      ?pool.reportFailure('RATE_LIMIT','safe','A',()=>ticket.failed('RATE_LIMIT'))
      :pool.stepAside('A','RATE_LIMIT','safe',[],()=>ticket.failed('RATE_LIMIT'))
    while(!release)await new Promise(r=>setImmediate(r))
    pool.probeState=original
    secrets.A=jwt('replacement');view.invalidate('A');const reset=pool.resetByRef('A')
    const next=await pool.sessionFor('A');const nextTicket=await view.observeRequest('A',next);await nextTicket.succeeded()
    release();await Promise.all([pending,reset])
    const snapshot=await view.snapshot()
    assert.equal(snapshot.seats[0].reasonCode,null,path)
    assert.equal(snapshot.seats[0].validation,'valid',path)
  }
})
test('request retains verified GetUserInfo identity when JWT has no name claims',async()=>{
  const {routes,adapters,secrets}=pluginSetup({seats:[{pat:'A',name:'',email:'',password:''}]});const original=globalThis.fetch
  secrets.A=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({exp:4102444800})).toString('base64url')}.sig`
  try {
    globalThis.fetch=async()=>Response.json({Data:{UserInfo:{UserID:'42',Username:'Server Alpha'}}})
    await routes.get(mod.POOL_VALIDATE_ROUTE).fetch(new Request('http://local/validate',{method:'POST',body:JSON.stringify({seatId:'A'})}))
    globalThis.fetch=async()=>new Response('event: output\ndata: {"response":"ok"}\n\n')
    for await(const c of adapters.trae.stream({model:'GLM-5.3',sessionId:'server-name',tools:[{name:'bash',parameters:{}}],messages:[{role:'user',content:[{type:'text',text:'hi'}]}]})){}
    const usage=(await(await routes.get(mod.SESSION_ROUTE).fetch(new Request(`http://local${mod.SESSION_ROUTE}?session=server-name&view=usage`))).json()).value
    const snapshot=(await(await routes.get(mod.POOL_ROUTE).fetch(new Request('http://local/pool'))).json()).value
    assert.equal(usage.request.seatName,'Server Alpha')
    assert.equal(snapshot.seats[0].identity,'Server Alpha')
  } finally {globalThis.fetch=original}
})
test('quota pending reads isolate legacy and targeted credential versions and retain newest cache',async()=>{
  const releases=[];let calls=0
  const token=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({exp:4102444800,data:{tob_tenant_id:'42'}})).toString('base64url')}.sig`
  const seat=version=>({id:'A',name:'A',token,credentialVersion:version,console:{reset(){},read:()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve({fetchedAt:Date.now(),packs:[],remaining:5})))}}})
  let version='current-v1'
  const quota=new mod.TraeQuota({host:'https://fake',userAgent:'test',headers:()=>({}),seats:async()=>[seat(undefined)],seat:async()=>seat(version)})
  const legacy=quota.all();await new Promise(r=>setImmediate(r))
  const targeted=quota.forSeat('A');await new Promise(r=>setImmediate(r))
  releases.at(-1)()
  const current=await targeted
  releases[0]()
  const all=await legacy
  assert.equal(all[0].credentialVersion,null)
  assert.equal(current.credentialVersion,'current-v1')
  assert.equal((await quota.forSeat('A')).credentialVersion,'current-v1')
  assert.equal(calls,2)
  version='current-v2'
  const next=quota.forSeat('A');await new Promise(r=>setImmediate(r));releases[2]();assert.equal((await next).credentialVersion,'current-v2')
  assert.equal((await quota.forSeat('A')).credentialVersion,'current-v2')
  assert.equal(calls,3)
})
test('opaque PAT forced-refresh rejection invalidates prior evidence while network failure stays unavailable',async()=>{
  const {routes,adapters,secrets,events}=pluginSetup({seats:[{pat:'A',name:'A',email:'',password:''}]});const original=globalThis.fetch
  secrets.A='opaque-pat-original';let mode='success'
  const options={model:'GLM-5.3',sessionId:'opaque',tools:[{name:'bash',parameters:{}}],messages:[{role:'user',content:[{type:'text',text:'hi'}]}]}
  const run=async()=>{for await(const chunk of adapters.trae.stream(options)) {}}
  const row=async()=> (await(await routes.get(mod.POOL_ROUTE).fetch(new Request('http://local/pool'))).json()).value.seats[0]
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/ExchangeToken')) {
      if(mode==='network')throw new TypeError('network unavailable')
      if(mode==='reject')return new Response('invalid token',{status:401})
      return Response.json({Result:{Token:jwt('opaque'),TokenExpireAt:4102444800}})
    }
    return mode==='success'?new Response('event: output\ndata: {"response":"ok"}\n\n'):new Response('expired JWT',{status:401})
  }
  try {
    await run();assert.equal((await row()).validation,'valid')
    mode='reject';await assert.rejects(run,error=>error.code==='AUTH')
    assert.equal((await row()).validation,'invalid')
    secrets.A='opaque-pat-replacement';events['credentials/reference-updated']('A')
    mode='success';await run();assert.equal((await row()).validation,'valid')
    mode='network';await assert.rejects(run,error=>error.code==='TRANSPORT')
    assert.equal((await row()).validation,'unavailable')
  } finally {globalThis.fetch=original}
})
function pluginSetup(config={}) {
  const routes=new Map(), adapters={}, events={}; const reads=[]
  const secrets={A:jwt('a'),B:jwt('b')}
  mod.apply({logger:{info(){},warn(){}},effect(){},on:(key,fn)=>{events[key]=fn},get:name=> name==='credentials'?{resolve:async ref=>{reads.push(ref);return {value:secrets[ref]}},describe:async()=>({writable:true})}:undefined,inject:(deps,cb)=>{if(deps.includes('connection'))cb({connection:{fetch:{register:route=>routes.set(route.path,route)}}})},fiber:{entry:{options:{id:'trae-pat-pool'}}},llm:{registerAdapter:(keys,a)=>{for(const k of keys)adapters[k]=a},registerConfigurableProviders(){}}},mod.Config({catalogSource:'builtin',suggestions:false,seats:['A','B'].map(pat=>({pat,name:pat,email:'',password:''})),...config}))
  return {routes,adapters,events,reads,secrets}
}
test('only genuine successful chat validates actual credential; late replaced credential does not publish',async()=>{
  const {routes,adapters,secrets,events}=pluginSetup();const original=globalThis.fetch;let release
  const options={model:'GLM-5.3',sessionId:'chat',tools:[{name:'bash',parameters:{}}],messages:[{role:'user',content:[{type:'text',text:'hi'}]}]}
  const snapshot=async()=> (await (await routes.get(mod.POOL_ROUTE).fetch(new Request('http://local/pool'))).json()).value
  try {
    globalThis.fetch=async()=>new Response('event: output\ndata: {"response":"ok"}\n\nevent: done\ndata: {}\n\n')
    for await(const c of adapters.trae.stream(options)){}
    assert.equal((await snapshot()).summary.usable,1)
    assert.equal((await snapshot()).seats[1].validation,'unknown')
    events['credentials/reference-updated']('A');
    globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){release=()=>{controller.enqueue(new TextEncoder().encode('event: output\ndata: {"response":"late"}\n\n'));controller.close()}}}))
    const late=(async()=>{for await(const c of adapters.trae.stream(options)) {}})();while(!release)await new Promise(r=>setImmediate(r))
    secrets.A=jwt('changed');events['credentials/reference-updated']('A');release();await late
    assert.equal((await snapshot()).summary.usable,0)
    globalThis.fetch=async()=>new Response('event: output\ndata: {"response":"partial"}\n\nevent: error\ndata: {"error":"rate limit exceeded"}\n\n')
    for await(const c of adapters.trae.stream(options)){}
    assert.equal((await snapshot()).summary.usable,0)
  } finally {globalThis.fetch=original}
})
test('single-seat prior successful chat becomes invalid after server auth rejection',async()=>{
  const {routes,adapters}=pluginSetup({seats:[{pat:'A',name:'A',email:'',password:''}]});const original=globalThis.fetch
  const options={model:'GLM-5.3',sessionId:'single',tools:[{name:'bash',parameters:{}}],messages:[{role:'user',content:[{type:'text',text:'hi'}]}]}
  try {
    globalThis.fetch=async()=>new Response('event: output\ndata: {"response":"ok"}\n\n')
    for await(const c of adapters.trae.stream(options)){}
    globalThis.fetch=async()=>new Response('credential rejected',{status:401})
    await assert.rejects(async()=>{for await(const c of adapters.trae.stream(options)) {}})
    const snapshot=(await(await routes.get(mod.POOL_ROUTE).fetch(new Request('http://local/pool'))).json()).value
    assert.equal(snapshot.seats[0].validation,'invalid')
    assert.equal(snapshot.summary.usable,0)
  } finally {globalThis.fetch=original}
})
test('delayed old SSE and HTTP failures cannot reject replacement credential',async()=>{
  const original=globalThis.fetch
  const options={model:'GLM-5.3',sessionId:'race',tools:[{name:'bash',parameters:{}}],messages:[{role:'user',content:[{type:'text',text:'hi'}]}]}
  try { for(const mode of ['sse','http']) {
    const {routes,adapters,secrets,events}=pluginSetup();let release
    globalThis.fetch=async()=> mode==='sse'
      ? new Response(new ReadableStream({start(controller){release=()=>{controller.enqueue(new TextEncoder().encode('event: output\ndata: {"response":"old"}\n\nevent: error\ndata: {"error":"rate limit exceeded"}\n\n'));controller.close()}}}))
      : new Promise(resolve=>{release=()=>resolve(new Response('insufficient quota',{status:402}))})
    const old=(async()=>{try{for await(const c of adapters.trae.stream(options)) {}}catch{}})();while(!release)await new Promise(r=>setImmediate(r))
    secrets.A=jwt('replacement');events['credentials/reference-updated']('A')
    globalThis.fetch=async()=>new Response('event: output\ndata: {"response":"new"}\n\n')
    for await(const c of adapters.trae.stream({...options,sessionId:'new'})){}
    release();await old
    const snapshot=(await(await routes.get(mod.POOL_ROUTE).fetch(new Request('http://local/pool'))).json()).value
    assert.equal(snapshot.seats[0].validation,'valid',mode)
    assert.equal(snapshot.seats[0].reasonCode,null,mode)
    assert.equal(snapshot.summary.usable,1,mode)
  }} finally {globalThis.fetch=original}
})
test('unnamed request keeps actual identity and version after same-reference replacement',async()=>{
  const {routes,adapters,secrets,events}=pluginSetup({seats:[{pat:'A',name:'',email:'',password:''}]});const original=globalThis.fetch
  globalThis.fetch=async()=>new Response('event: output\ndata: {"response":"ok"}\n\n')
  const ask=async(path)=> (await(await routes.get(path.split('?')[0]).fetch(new Request(`http://local${path}`))).json()).value
  try {
    for await(const c of adapters.trae.stream({model:'GLM-5.3',sessionId:'identity',tools:[{name:'bash',parameters:{}}],messages:[{role:'user',content:[{type:'text',text:'hi'}]}]})){}
    const before=(await ask(`${mod.SESSION_ROUTE}?session=identity&view=usage`)).request
    assert.equal(before.seatName,'a@example.com')
    assert.equal(typeof before.credentialVersion,'string')
    secrets.A=jwt('replacement');events['credentials/reference-updated']('A')
    const row=(await ask(mod.POOL_ROUTE)).seats[0]
    const after=(await ask(`${mod.SESSION_ROUTE}?session=identity&view=usage`)).request
    assert.equal(after.seatName,'a@example.com')
    assert.equal(after.credentialVersion,before.credentialVersion)
    assert.notEqual(after.credentialVersion,row.credentialVersion)
  } finally {globalThis.fetch=original}
})
test('host routes reject malformed/unknown seats; usage branch and pool are read-only; quota resolves chosen seat only', async()=>{
  assert.equal(typeof mod.POOL_ROUTE,'string')
  const {routes,reads}=pluginSetup();const original=globalThis.fetch;const seen=[]
  globalThis.fetch=async(url)=>{seen.push(String(url));return Response.json({data:{user_entitlement_pack_list:[]}})}
  const request=async(path,query='',body)=> routes.get(path).fetch(new Request(`http://local${path}${query}`,body===undefined?{}:{method:'POST',body}))
  try {
    assert.equal((await request(mod.POOL_VALIDATE_ROUTE,'','{')).status,400)
    assert.equal((await request(mod.POOL_VALIDATE_ROUTE,'',JSON.stringify({seatId:7}))).status,400)
    assert.equal((await request(mod.POOL_VALIDATE_ROUTE,'',JSON.stringify({seatId:'unknown'}))).status,404)
    assert.equal((await request(mod.QUOTA_ROUTE,'?seat=unknown')).status,404)
    const usage=await(await request(mod.SESSION_ROUTE,'?session=s&view=usage')).json()
    assert.deepEqual(usage.value,{session:'s',request:null})
    assert.equal(reads.length,0)
    const poolValue=(await(await request(mod.POOL_ROUTE)).json()).value
    assert.equal(poolValue.summary.total,2)
    assert.equal(typeof poolValue.seats[0].credentialVersion,'string')
    assert.equal(seen.length,0)
    reads.length=0
    const targeted=await(await request(mod.QUOTA_ROUTE,'?seat=B')).json()
    assert.equal(targeted.value.credentialVersion,poolValue.seats[1].credentialVersion)
    assert.ok(reads.length >= 1);assert.ok(reads.every(ref=>ref==='B'))
    const legacyQuota=await(await request(mod.QUOTA_ROUTE)).json()
    assert.equal(legacyQuota.value.seats.find(row=>row.seatId==='B').credentialVersion,poolValue.seats[1].credentialVersion)
  } finally {globalThis.fetch=original}
})
