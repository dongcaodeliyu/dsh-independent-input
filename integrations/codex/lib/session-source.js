// Only transport-supplied metadata enters this resolver; never tool arguments.
export function sourceContext(meta = {}) {
 meta=meta && typeof meta==='object' && !Array.isArray(meta)?meta:{}
 const id=typeof meta.threadId==='string' ? meta.threadId : null
 return Object.freeze({threadId:id, caption:id ? '会话名称暂不可用' : '会话名称暂不可用'})
}
export async function resolveSessionSource(context, readThread) {
 if(!context?.threadId) return sourceContext()
 const executionId=context.threadId; let id=executionId; const seen=new Set();let title=null;const chain=[]
 for(let depth=0;depth<8 && id && !seen.has(id);depth++) {
  seen.add(id); let result;try{result=await readThread({threadId:id,includeTurns:false})}catch{break}
  const thread=result?.thread;if(!thread || thread.id!==id)break
  chain.push(id);if(typeof thread.name==='string'&&thread.name.trim())title=thread.name.slice(0,160)
  id=thread.source?.subAgent?.thread_spawn?.parent_thread_id||null
 }
 return Object.freeze({threadId:executionId,chain,caption:title ? `来源会话: ${title}` : '会话名称暂不可用'})
}
