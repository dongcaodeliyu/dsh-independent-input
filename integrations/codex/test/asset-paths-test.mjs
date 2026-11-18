import assert from 'node:assert/strict'
import {resolveAssets} from '../lib/asset-paths.js'
import {mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const original=resolveAssets(),temporary=await mkdtemp(join(tmpdir(),'asset-stage-'))
try{await mkdir(join(temporary,'assets','cursors'),{recursive:true});await copyFile(join(original,'cursors','pointer.png'),join(temporary,'assets','cursors','pointer.png'));assert.equal(resolveAssets(temporary),join(temporary,'assets'));assert.throws(()=>resolveAssets(join(temporary,'missing','nested','plugin')));console.log('PASS actual asset resolver: repository fallback and standalone stage, no personal metadata')}
finally{await rm(temporary,{recursive:true,force:true})}
