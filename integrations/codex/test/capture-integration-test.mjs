// Shipped sidecar -> packaged WGC executable, invalid HWND only. No user capture.
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputEngine } from '../lib/engine.js'
if (process.platform !== 'win32') process.exit(0)
const temp=await mkdtemp(join(tmpdir(),'input-wgc-invalid-'));const engine=new InputEngine()
try{
 const path=join(temp,'must-not-exist.png')
 const result=await engine.request('capture',{hwnd:1,path,screenCopy:false},20000)
 assert.equal(result.ok,false)
 assert.equal(result.method,'wgc-window')
 assert.equal(result.reason,'window_closed')
 await assert.rejects(access(path))
 console.log('PASS: real sidecar -> shipped WGC invalid-window rejection; no silent screen fallback or stale image')
}finally{engine.stop();await rm(temp,{recursive:true,force:true})}
