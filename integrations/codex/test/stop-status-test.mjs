import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {InputEngine} from '../lib/engine.js'
import {apply} from '../index.js'
import {fixtureControl} from './transport-fixture-control.mjs'
const directory=await mkdtemp(join(tmpdir(),'stop-status-')),original=InputEngine.prototype.request
const event={reason:'escape',source:'keyboard-hook',kind:'pause',utcTimestamp:'2026-11-16T00:00:00.000Z',ownerName:'可读主名',ownerExecutionId:'execution-uuid-secret',ownerRootId:'root-uuid-secret',sessionId:'event-session',sequence:1,keyboard:{vkCode:27,scanCode:1,flags:0,injected:false,eventType:256}}
let paused=true,tool,dispose
const control=fixtureControl()
control.status=async()=>({busy:false,scope:'fixture',ownerName:null,ownerExecutionId:'execution-uuid-secret',ownerRootId:'root-uuid-secret',pauseReason:paused?'escape':null,stopInfo:paused?event:null,lastStop:event,externalOfficialState:'unknown'})
InputEngine.prototype.request=async()=>({ok:true,paused,sessionState:'idle',stopInfo:paused?event:null,lastStop:event})
try{
 const settingsFile=join(directory,'settings.json');await writeFile(settingsFile,'{"enabled":true}')
 dispose=await apply({tools:{register(value){tool=value;return()=>{}}}},{},{defineTool:v=>v,settingsFile,controlLease:control})
 const compact=await tool.execute({action:'status'})
 assert.match(compact.text,/键盘钩子检测到Esc（来源未能确认）/);assert.match(compact.text,/2026-11-16T00:00:00.000Z/)
 assert.doesNotMatch(compact.text,/execution-uuid|root-uuid|误按|真人按/)
 assert.equal(compact.meta.control.ownerExecutionId,'execution-uuid-secret')
 assert.equal(compact.meta.stopInfo.keyboard,undefined);assert.equal(compact.meta.control.stopInfo.ownerExecutionId,undefined)
 const details=await tool.execute({action:'status',details:true});assert.equal(details.meta.stopInfo.keyboard.vkCode,27)
 paused=false;const resumed=await tool.execute({action:'status'});assert.equal(resumed.meta.paused,false);assert.equal(resumed.meta.stopInfo,null);assert.match(resumed.text,/最近停止（当前未暂停）/)
 console.log('PASS actual status formatting: short source/time; unknown keyboard origin; no identity in human text; machine IDs retained; details-only key fields; resumed history is not current pause')
}finally{dispose?.();InputEngine.prototype.request=original;await rm(directory,{recursive:true,force:true})}

const {stopText}=await import('../lib/stop-info.js');assert.match(stopText({reason:'control-escape',source:'keyboard-hook'}),/Ctrl\+Esc/);assert.ok(!stopText({reason:'escape',source:'keyboard-hook'}).includes('Ctrl+Esc'));console.log('PASS new Ctrl+Esc versus legacy Esc source labels remain distinct')
