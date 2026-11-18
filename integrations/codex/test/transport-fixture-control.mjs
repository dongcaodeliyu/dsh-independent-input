// Focused fake-transport tests isolate formatting/orchestration, never acquire
// the real desktop namespace. control-lease-test covers the real guard contract.
export function fixtureControl(){
 return {owner:null,executionId(context){return context?.executionId||context?.threadId||'fixture'},manualPreviewContext(){return {executionId:'manual-preview',actorKind:'manual-preview',caption:'manual fixture'}},
  async acquire(context){this.owner={executionId:this.executionId(context)}},assert(){},async bind(){},async pause(reason){if(this.owner)this.owner.pauseReason=reason},async resume(){if(this.owner)this.owner.pauseReason=null},async release(){this.owner=null},
  async status(){return {busy:!!this.owner,scope:'fake-transport-fixture',externalOfficialState:'unknown'}}}
}
