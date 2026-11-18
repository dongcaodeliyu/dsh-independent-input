import assert from 'node:assert/strict'
import {presentObservation,presentWindows,presentStatus,textLimit} from '../lib/presentation.js'
const long='中文😀'.repeat(1000)
const observed={observationId:'fresh',window:{title:long},elements:[{elementId:'e1',parentId:'e0',name:long,type:'ControlType.Edit',value:long,rect:{x:1,y:2,width:30,height:20},enabled:true,offscreen:false,password:false,state:{readonly:false},nativeWindowHandle:42,nativeClass:'Edit',nativeRoot:1,nativePid:10,nativeReadOnly:false,nativePassword:false}]}
const original=JSON.stringify(observed),compact=presentObservation(observed)
assert.deepEqual(compact.evidence,{uiaVisibility:'provider-reported',imageEvidence:'none',screenshotContentFreshness:'unavailable'})
assert.equal(compact.elements[0].nativePid,undefined);assert.deepEqual(compact.elements[0].backgroundActions,['type'])
assert.equal([...compact.elements[0].name].length,256);assert.equal(compact.elements[0].nameLength,3000);assert.equal(compact.elements[0].valueTruncated,true)
assert.equal(compact.windowObservationId,'fresh');assert.equal(JSON.stringify(observed),original,'projection cannot alter internal full signature data')
const details=presentObservation(observed,{details:true,maxTextChars:1000});assert.equal(details.elements[0].nativePid,10);assert.equal([...details.elements[0].value].length,1000)
const short=presentObservation({...observed,elements:[{...observed.elements[0],name:'short',value:'ok'}]});assert.equal('nameLength' in short.elements[0],false);assert.equal('valueTruncated' in short.elements[0],false)
const inventory={windows:Array.from({length:100},(_,i)=>({title:'Target '+i,className:'EDIT',pid:10,hwnd:i+1}))}
const page=presentWindows(inventory,{title:'target',className:'edit',pid:10,offset:24,limit:24});assert.equal(page.windows.length,24);assert.equal(page.windows[0].hwnd,25);assert.equal(page.totalMatched,100);assert.equal(page.hasMore,true);assert.equal(inventory.windows.length,100)
assert.equal([...presentStatus({foreground:{title:long}}).foreground.title].length,256)
assert.equal(textLimit('x'.repeat(20000),1000000).text.length,16384)
console.log('PASS: bounded public Name/Value/status; truncation flags only on truncation; details opt-in; complete internal data unchanged; windows filtered paging does not truncate internal open inventory')

const virtual={elementId:'provider-e',type:'ControlType.Button',name:'Provider workflow',rect:{x:9,y:8,width:90,height:30},enabled:true,offscreen:false,nativeWindowHandle:0}
const button={...virtual,elementId:'native-button',nativeWindowHandle:99,nativeClass:'Button'}
const elements=[virtual,button,observed.elements[0]],signature=JSON.stringify(elements)
for(const [shot,imageEvidence] of [[null,'none'],[{images:[],meta:{path:'saved.png'}},'saved-only'],[{images:[{type:'image'}],meta:{path:'saved.png',mappingVerified:true,occlusionSafe:true}},'attached']]){
 const out=presentObservation({...observed,elements},{},shot)
 assert.equal(out.elements.length,3,'virtual provider nodes must not be filtered')
 assert.equal(out.elements[0].offscreen,false);assert.deepEqual(out.elements[0].rect,virtual.rect);assert.deepEqual(out.elements[0].backgroundActions,[])
 assert.deepEqual(out.elements[1].backgroundActions,['click']);assert.deepEqual(out.elements[2].backgroundActions,['type'])
 assert.equal(out.elements[1].elementId,'native-button');assert.equal(out.elements[2].elementId,'e1')
 assert.equal(out.evidence.imageEvidence,imageEvidence)
 assert.equal(out.evidence.screenshotContentFreshness,shot?'unverified':'unavailable')
 assert.equal(out.evidence.consistency,undefined,'no visual classifier or automatic mismatch claim')
 assert.equal(out.elements[0].evidence,undefined,'evidence is global, not copied onto every element')
}
assert.equal(JSON.stringify(elements),signature)
console.log('PASS projection contract: provider/offscreen visibility labelled, virtual data retained, actual image attachment separate from saved-only, fresh content unverified, native Button/Edit IDs and background actions intact')
const valueCandidate=presentObservation({...observed,elements:[{...virtual,type:'ControlType.Edit',patterns:['Value']}]})
assert.equal(valueCandidate.elements[0].valueWrite,'foreground-root-under-preserve')
assert.deepEqual(valueCandidate.elements[0].backgroundActions,[],'Value must not advertise unconditional background preserve capability')
console.log('PASS conditional Value discoverability: foreground-under-preserve, native background actions unchanged')
