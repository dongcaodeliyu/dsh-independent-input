import assert from 'node:assert/strict'
import {resolvePreferredMonitor,preferredWindowBounds} from '../lib/window-placement.js'
const main={device:'MAIN',primary:true,workArea:{x:0,y:0,width:2560,height:1528}}
const side={device:'SIDE',primary:false,workArea:{x:-1920,y:-200,width:1920,height:1040}}
assert.equal(resolvePreferredMonitor([main,side]).monitor,side)
assert.equal(resolvePreferredMonitor([main]).monitor,main)
assert.equal(resolvePreferredMonitor([main,side],'primary').monitor,main)
assert.equal(resolvePreferredMonitor([main,side],'side').monitor,side)
assert.equal(resolvePreferredMonitor([main,side],'unplugged').monitor,side)
assert.equal(resolvePreferredMonitor([]).available,false)
assert.deepEqual(preferredWindowBounds({width:800,height:600},side),{x:-1360,y:20,width:800,height:600})
assert.deepEqual(preferredWindowBounds({width:3000,height:2000},side),{x:-1920,y:-200,width:1920,height:1040})
assert.throws(()=>preferredWindowBounds({width:-1,height:600},side))
assert.equal(side.workArea.x,-1920)
console.log('PASS: secondary-first/device/primary/disconnected/single/no-monitor policies; negative physical workarea placement and clamp; no window calls')
