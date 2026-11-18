import { join, basename, win32 } from 'node:path'
import { homedir } from 'node:os'
const cache=new Map()
// Only this execution's ancestors are queried. Never read conversation turns.
export async function threadCaption(context,{dbPath=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'state_5.sqlite'),now=Date.now(),ttl=15000}={}){
  const executionId=context?.threadId
  if(!executionId)return Object.freeze({...context,projectId:null,projectName:null,projectPath:null,projectSource:'unavailable'})
  const key=dbPath+'|'+executionId,cached=cache.get(key)
  if(cached&&now-cached.at<ttl)return cached.value
  let db,rootId=null,name=null,rootResolved=false,captionSource='execution-id',projectId=null,projectName=null,projectPath=null,projectSource='unavailable'
  try {
    const {DatabaseSync}=await import('node:sqlite')
    db=new DatabaseSync(dbPath,{readOnly:true})
    const query=db.prepare('SELECT id,name,title,source FROM threads WHERE id = ?')
    let id=executionId;const seen=new Set()
    for(let depth=0;depth<8&&id&&!seen.has(id);depth++){
      seen.add(id);const row=query.get(id);if(!row||row.id!==id)break
      rootId=id
      // name is the sidebar chat name; title may contain the original prompt.
      name=typeof row.name==='string'&&row.name.trim()?row.name.trim().slice(0,160):null
      let source;try{source=typeof row.source==='string'?JSON.parse(row.source):row.source}catch{}
      id=source?.subagent?.thread_spawn?.parent_thread_id||null
      if(!id)rootResolved=true
    }
    if(!rootResolved){rootId=null;name=null}
    if(name)captionSource='sidebar-name'
    if(rootResolved){
      // Optional schema fields are independent of chat-name resolution.
      try{const row=db.prepare('SELECT project_id FROM threads WHERE id = ?').get(rootId);projectId=typeof row?.project_id==='string'&&row.project_id.trim()?row.project_id:null}catch{}
      try{const row=db.prepare('SELECT cwd FROM threads WHERE id = ?').get(rootId);projectPath=typeof row?.cwd==='string'&&row.cwd.trim()?row.cwd:null}catch{}
      if(projectId){
        try{
          const row=db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId)
          if(typeof row?.name==='string'&&row.name.trim()){projectName=row.name.trim();projectSource='projects.name'}
        }catch{}
      }
      if(!projectName&&projectPath){
        projectName=(projectPath.includes('\\')?win32.basename(projectPath):basename(projectPath))||null
        if(projectName)projectSource='root-cwd-basename'
      }
    }
  }catch{}finally{try{db?.close()}catch{}}
  const caption=name?`主聊天: ${name}`:`会话名称暂不可用`
  const value=Object.freeze({...context,rootId,name,caption,captionSource,projectId,projectName,projectPath,projectSource})
  if(cache.size>128)cache.clear()
  cache.set(key,{at:now,value});return value
}
