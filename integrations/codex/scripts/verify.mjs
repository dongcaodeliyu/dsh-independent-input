import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
if (process.platform !== 'win32') throw new Error('Run the isolated tests on Windows')

const root = fileURLToPath(new URL('../', import.meta.url))
const data = mkdtempSync(join(tmpdir(), 'codex-verify-'))
const env = {
  ...process.env,
  CODEX_HOME: join(data, 'home'),
  CODEX_INPUT_DATA_DIR: join(data, 'data'),
}
const tests = [
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/tooltip-render-test.ps1"],
  ["node", "test/asset-paths-test.mjs"],
  ["node", "test/presentation-test.mjs"],
  ["node", "test/focus-policy-test.mjs"],
  ["node", "test/thread-caption-test.mjs"],
  ["node", "test/project-identity-test.mjs"],
  ["node", "test/engine-interrupt-test.mjs"],
  ["node", "test/stop-source-test.mjs"],
  ["node", "test/stop-status-test.mjs"],
  ["node", "test/settings-merge-test.mjs"],
  ["node", "test/window-actions-test.mjs"],
  ["node", "test/window-placement-test.mjs"],
  ["node", "test/control-final-contract-test.mjs"],
  ["node", "test/control-owner-cancel-test.mjs"],
  ["node", "test/control-queue-protocol-test.mjs"],
  ["node", "test/control-queue-boundary-test.mjs"],
  ["node", "test/control-queue-mcp-concurrency-test.mjs"],
  ["node", "test/control-queue-wakeup-test.mjs"],
  ["node", "test/control-lease-test.mjs"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/powershell-encoding-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/cursor-metadata-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/keyboard-routing-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/value-setter-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/stop-key-test.ps1"],
  ["node", "test/dual-lane-state-test.mjs"],
  ["node", "test/dual-guardian-test.mjs"],
  ["node", "test/dual-coordinator-test.mjs"],
  ["node", "test/dual-controller-fault-test.mjs"],
  ["node", "test/dual-recovery-test.mjs"],
  ["node", "test/dual-shared-pause-test.mjs"],
  ["node", "test/dual-stop-storage-test.mjs"],
  ["node", "test/coordinator-runtime-test.mjs"],
  ["node", "test/coordinator-client-version-test.mjs"],
  ["node", "test/shared-header-lifecycle-test.mjs"],
  ["node", "test/shared-header-members-test.mjs"],
  ["node", "test/input-session-resume-feedback-test.mjs"],
  ["node", "test/input-session-race-test.mjs"],
  ["node", "test/input-session-yield-test.mjs"],
  ["node", "test/auth-boundary-test.mjs"],
  ["node", "test/auth-privacy-test.mjs"],
  ["node", "test/runtime-snapshot-test.mjs"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/auth-privacy-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/auth-observation-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/element-route-scope-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/raw-keyboard-guard-test.ps1"],
  ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "test/shared-header-topology-test.ps1"],
]
try {
  for (const [command, ...args] of tests) {
    console.log('RUN', command, ...args)
    const result = spawnSync(command === 'node' ? process.execPath : command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
      timeout: 120000,
    })
    if (result.status !== 0) throw new Error('Check failed: ' + args.join(' '), { cause: result.error })
  }
} finally {
  rmSync(data, { recursive: true, force: true })
}
