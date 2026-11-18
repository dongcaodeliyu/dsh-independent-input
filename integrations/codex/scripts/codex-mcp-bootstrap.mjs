#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureRuntimeSnapshot } from '../lib/runtime-snapshot.mjs'

try {
  const { root } = await ensureRuntimeSnapshot({ sourceRoot: dirname(dirname(fileURLToPath(import.meta.url))) })
  process.chdir(root)
  await import(pathToFileURL(join(root, 'scripts', 'codex-mcp.mjs')).href)
} catch {
  // Never expose source paths, environment, or arguments on the protocol channel.
  console.error('[independent-input] RUNTIME_START_FAILED')
  process.exit(1)
}
