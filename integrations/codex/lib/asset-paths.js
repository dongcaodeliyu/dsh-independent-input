import {existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
export function resolveAssets(pluginRoot=fileURLToPath(new URL('../',import.meta.url))){
 const local=join(pluginRoot,'assets'),upstream=resolve(pluginRoot,'../..','assets')
 for(const root of [local,upstream])if(existsSync(join(root,'cursors','pointer.png')))return root
 throw new Error('Cursor assets missing: use the repository checkout or the packaged plugin')
}
