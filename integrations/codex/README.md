# Codex integration

Windows Codex MCP plugin version 0.7.6, control protocol v3. The Codex integration lives under this directory and uses the repository's existing cursor artwork.

- Up to three independent execution backends share a Windows desktop. The fourth request waits in FIFO order. Executions in the same root are mutually exclusive. Status reports separate execution and coordinator versions.
- The shared screen header distinguishes finish, temporary resource yield, and a user stop. Finish releases the input session. Begin starts a new observation epoch. Only an explicit user-approved resume clears a paused execution, and its receipt reflects authoritative readback.
- UIA observations and optional WGC screenshots provide scoped evidence. Native messages handle supported background inputs. Value and Invoke routes under the default preserve policy require the target's current foreground root. Password fields are excluded and authentication material in observations is redacted. The plugin does not automatically fall back to native Codex Computer Use.
- Window opening requires authorization and can return a pending ticket. Poll its status before deciding what to do. A launch receipt confirms submission to Windows and window observation remains a separate check.

## Build and install

Use Windows 10/11, Windows PowerShell 5.1, Node.js 24, and a Codex version with local plugin support. A source checkout needs Visual Studio C++ tools and the Windows SDK to build the WGC capture helper. From this directory:

```powershell
.\native\window-capture\build.cmd
powershell.exe -NoProfile -File scripts/package-codex.ps1 -OutputDirectory <absolute-output-directory>
```

Extract the resulting ZIP and use the extracted `dsh-independent-input` directory. The packager builds the launch helper, stages both native helpers with their source, and adds the upstream assets and their NOTICE. The packaged MCP entry takes a content-checked snapshot of its runtime files, including these assets, before starting. Install from the extracted package:

```powershell
codex plugin marketplace add <absolute-path-to-extracted-dsh-independent-input>
codex plugin add dsh-independent-input@dsh-independent-input-local
codex plugin list --json
```

Follow the Codex hook trust and refresh prompts. When upgrading from protocol v2, let existing owners and waiters finish before starting the new runtime. Check runtime and coordinator versions after refresh. The input hook supplies routing guidance. Desktop actions still require user authorization.

## Verification

Run `npm test` here on Windows. [Verification and limits](docs/verification.md) describes the isolated tests and historical desktop evidence. Development and packaging use the existing upstream artwork and preserve its separate terms in the repository NOTICE. The package includes that notice at `assets/NOTICE`.
