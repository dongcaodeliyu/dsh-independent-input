import { readFile, readdir, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw new Error('RUNTIME_SNAPSHOT_INVALID') }
const forbidden = /^(?:\.git|work|node_modules|settings(?:\.json)?|profiles?|credentials?)(?:\/|$)/i
function safe(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..') || forbidden.test(path)) fail()
  return path
}
async function inventory(root, files) {
  const rows = []
  async function walk(path) {
    safe(path)
    const info = await lstat(join(root, path))
    if (info.isSymbolicLink()) fail()
    if (info.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) await walk(`${path}/${name}`)
    } else if (info.isFile()) {
      const bytes = await readFile(join(root, path))
      rows.push({ path, size: bytes.length, sha256: hash(bytes) })
    } else fail()
  }
  for (const path of [...new Set(files)].sort()) await walk(path)
  rows.sort((a,b) => a.path.localeCompare(b.path, 'en'))
  if (new Set(rows.map(r => r.path)).size !== rows.length) fail()
  return rows
}
async function verify(root, manifest) {
  for (const row of manifest) {
    const bytes = await readFile(join(root, row.path))
    if (bytes.length !== row.size || hash(bytes) !== row.sha256) fail()
  }
}

// Only npm's declared release files plus package.json are read. User data is never a source.
export async function ensureRuntimeSnapshot({ sourceRoot, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') }) {
  sourceRoot = resolve(sourceRoot)
  const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  if (!Array.isArray(pkg.files) || !pkg.files.length) fail()
  const files = ['package.json', ...pkg.files.map(safe)]
  const manifest = await inventory(sourceRoot, files)
  const serialized = JSON.stringify({ format: 1, files: manifest })
  const digest = hash(serialized)
  const parent = join(resolve(codexHome), 'independent-input', 'runtime')
  const root = join(parent, digest)
  await mkdir(parent, { recursive: true })
  try {
    const existing = await readFile(join(root, '.runtime-manifest.json'), 'utf8')
    if (existing !== serialized) fail()
    await verify(root, manifest)
    return { root, digest, manifest }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const staging = join(parent, `.staging-${randomUUID()}`)
  await mkdir(staging)
  try {
    for (const row of manifest) {
      const bytes = await readFile(join(sourceRoot, row.path))
      if (bytes.length !== row.size || hash(bytes) !== row.sha256) fail()
      await mkdir(resolve(staging, row.path, '..'), { recursive: true })
      await writeFile(join(staging, row.path), bytes, { flag: 'wx' })
    }
    // Detect additions, removals and edits during copying before publishing.
    if (JSON.stringify(await inventory(sourceRoot, files)) !== JSON.stringify(manifest)) fail()
    await verify(staging, manifest)
    await writeFile(join(staging, '.runtime-manifest.json'), serialized, { flag: 'wx' })
    try { await rename(staging, root) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      if (await readFile(join(root, '.runtime-manifest.json'), 'utf8') !== serialized) fail()
      await verify(root, manifest)
    }
    return { root, digest, manifest }
  } finally {
    const target = resolve(staging)
    if (dirname(target) !== resolve(parent) || !/^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(basename(target))) fail()
    await rm(target, { recursive: true, force: true })
  }
}
