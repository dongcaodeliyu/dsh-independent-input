import { resolveAssets } from '../lib/asset-paths.js'
import assert from 'node:assert/strict'
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { ensureRuntimeSnapshot } from '../lib/runtime-snapshot.mjs'

const candidate = fileURLToPath(new URL('..', import.meta.url))
const source = process.argv[2] ? resolve(process.argv[2]) : candidate
const temp = await mkdtemp(join(tmpdir(), 'runtime-snapshot-test-'))
let child
try {
  const cache = join(temp, 'mock-cache'), home = join(temp, 'private-home')
  await mkdir(cache)
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  for (const path of ['package.json', ...pkg.files]) await cp(path === 'assets' ? resolveAssets(source) : join(source,path), join(cache,path), { recursive:true })
  await cp(join(candidate,'lib/runtime-snapshot.mjs'), join(cache,'lib/runtime-snapshot.mjs'))
  await cp(join(candidate,'scripts/codex-mcp-bootstrap.mjs'), join(cache,'scripts/codex-mcp-bootstrap.mjs'))
  await writeFile(join(cache,'settings.json'), 'SECRET_SETTINGS_NOT_A_RELEASE_ASSET')
  const snapshot = await ensureRuntimeSnapshot({sourceRoot:cache,codexHome:home})
  assert(!snapshot.manifest.some(row=>row.path==='settings.json'))
  const before = await readFile(join(snapshot.root,'sidecar.ps1'))
  child = spawn(process.execPath, [join(cache,'scripts/codex-mcp-bootstrap.mjs')], { cwd:cache, env:{...process.env,CODEX_HOME:home,CODEX_INPUT_DATA_DIR:join(temp,'data')}, stdio:['pipe','pipe','pipe'] })
  let stderr=''; child.stderr.on('data', d=>stderr+=d)
  const responses = new Map(), pending = new Map()
  createInterface({input:child.stdout}).on('line', line=> {
    const message=JSON.parse(line); responses.set(message.id,message); pending.get(message.id)?.(message)
  })
  async function request(id,method,params={}) {
    const result = new Promise((accept,reject)=> {
      const timer=setTimeout(()=>reject(new Error('protocol timeout: '+stderr)),15000)
      pending.set(id,value=>{clearTimeout(timer);accept(value)})
    })
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')
    return result
  }
  assert((await request(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'snapshot-protocol-test',version:'1'}})).result.serverInfo)
  assert((await request(2,'tools/list')).result.tools.length>0)
  await rm(cache,{recursive:true,force:true})
  assert.deepEqual(await readFile(join(snapshot.root,'sidecar.ps1')), before)
  for (const path of ['lib/dual-guardian.ps1','lib/dual-coordinator-host.mjs','lib/shared-header-host.js','assets']) {
    assert(snapshot.manifest.some(row=>row.path===path || row.path.startsWith(path+'/')))
  }
  assert.deepEqual((await request(3,'ping')).result,{})
  for(const row of snapshot.manifest) assert.equal((await readFile(join(snapshot.root,row.path))).length,row.size)
  assert(!stderr.includes(temp))
  const fixture=join(temp,'fixture')
  await mkdir(fixture)
  await writeFile(join(fixture,'package.json'),JSON.stringify({type:'module',files:['entry.mjs']}))
  await writeFile(join(fixture,'entry.mjs'),'export const value=1')
  const small=await ensureRuntimeSnapshot({sourceRoot:fixture,codexHome:home})
  assert.equal((await ensureRuntimeSnapshot({sourceRoot:fixture,codexHome:home})).digest,small.digest)
  await writeFile(join(small.root,'entry.mjs'),'tampered')
  await assert.rejects(ensureRuntimeSnapshot({sourceRoot:fixture,codexHome:home}),/RUNTIME_SNAPSHOT_INVALID/)
  const failed=join(temp,'failed-cache')
  await mkdir(join(failed,'scripts'),{recursive:true})
  await mkdir(join(failed,'lib'))
  await writeFile(join(failed,'package.json'),JSON.stringify({type:'module',files:['lib','scripts']}))
  await cp(join(candidate,'lib/runtime-snapshot.mjs'),join(failed,'lib/runtime-snapshot.mjs'))
  await cp(join(candidate,'scripts/codex-mcp-bootstrap.mjs'),join(failed,'scripts/codex-mcp-bootstrap.mjs'))
  await writeFile(join(failed,'scripts/codex-mcp.mjs'),"process.stdin.resume(); setInterval(()=>{},1000); throw new Error('PRIVATE_PATH_OR_ARGUMENT')")
  const failure=spawn(process.execPath,[join(failed,'scripts/codex-mcp-bootstrap.mjs')],{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe']})
  let failOut='',failErr=''
  failure.stdout.on('data',d=>failOut+=d);failure.stderr.on('data',d=>failErr+=d)
  const failCode=await new Promise((accept,reject)=>{
    const timer=setTimeout(()=>{failure.kill();reject(new Error('failed bootstrap retained live handle'))},5000)
    failure.once('exit',code=>{clearTimeout(timer);accept(code)})
  })
  assert.equal(failCode,1);assert.equal(failOut,'');assert.equal(failErr,'[independent-input] RUNTIME_START_FAILED\n')
  await writeFile(join(fixture,'package.json'),JSON.stringify({files:['../settings.json']}))
  await assert.rejects(ensureRuntimeSnapshot({sourceRoot:fixture,codexHome:home}),/RUNTIME_SNAPSHOT_INVALID/)
  console.log(JSON.stringify({ok:true,digest:snapshot.digest,releaseFiles:snapshot.manifest.length,protocolMethods:['initialize','tools/list','ping-after-cache-delete'],settingsCopied:false,resourceContentUnchanged:true,guiActions:0}))
} finally {
  if(child && child.exitCode===null){child.stdin.end();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(()=>{child.kill();resolve()},3000)})}
  assert.equal(dirname(resolve(temp)),resolve(tmpdir()))
  assert(basename(temp).startsWith('runtime-snapshot-test-'))
  await rm(temp,{recursive:true,force:true})
}
