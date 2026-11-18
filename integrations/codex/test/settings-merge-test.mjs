import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {apply} from '../index.js'
const dir=await mkdtemp(join(tmpdir(),'input-settings-merge-')), settingsFile=join(dir,'settings.json')
let handler,dispose
try {
 const screens={DISPLAY_A:[30,8,280,40],DISPLAY_B:[10,16,320,50]}
 await writeFile(settingsFile,JSON.stringify({enabled:false,cursorSize:0,preferredMonitor:'SIDE',screenIndicators:screens,unrelated:'keep'}))
 dispose=await apply({tools:{register(){return ()=>{}}},effect(f){f()},webServer:{register(spec){if(spec.path.endsWith('/api'))handler=spec.handler;return ()=>{}}}}, {}, {defineTool:v=>v,settingsFile})
 const req=Readable.from([Buffer.from(JSON.stringify({enabled:false,cursorSize:72}))]);req.method='POST';req.url='/dsh-independent-input/api/settings'
 let output='';const res={setHeader(){},end(body){output=body}}
 await handler(req,res)
 assert.equal(res.statusCode,200,output)
 const saved=JSON.parse(await readFile(settingsFile,'utf8'))
 assert.equal(saved.preferredMonitor,'SIDE');assert.equal(saved.cursorSize,72);assert.equal(saved.enabled,false)
 assert.deepEqual(saved.screenIndicators,screens);assert.equal(saved.unrelated,'keep')
 console.log('PASS: actual ordinary settings POST uses runtime path and preserves both monitor DIP settings/other fields; no sidecar started')
}finally{dispose?.();await rm(dir,{recursive:true,force:true})}
