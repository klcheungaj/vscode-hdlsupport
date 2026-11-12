# Client-host end-to-end tests (`@vscode/test-electron`)

These host tests drive the real extension inside a real VS Code window, with
the `llg` server replaced by a controllable fake (`suite/fakeLspServer.ts`).
They are **not** Vitest tests — the host suite has no `*.test.ts` suffix — and
are launched by `runTest.ts` through the Mocha-based `@vscode/test-electron`
harness. The separate `runTest.test.ts` Vitest unit test covers the display
policy without launching Electron.

## What is covered

1. The extension activates when a `.sv` file in the fixture workspace opens.
2. The client sends initialization options shaped
   `{ llg: { protocolVersion: 1, configFiles: [{ workspaceUri, path }] } }`
   pointing at the fixture workspace's `llg.toml` (captured by the fake
   server into `LLG_FAKE_RECORD`).
3. A fake `llg-lint` publication reaches VS Code's diagnostic API with its
   source, code, severity, and message intact.
4. Server-owned hover, definition, prepare-rename, and rename capabilities are
   registered by `vscode-languageclient` and callable through VS Code's provider
   execution commands.
5. Server-owned references, hierarchical document symbols, and workspace
   symbols are registered and converted through the corresponding VS Code
   provider commands.
6. Server-owned completion and semantic-token results, including the negotiated
   legend, reach VS Code without local provider registration.
7. `hdlsupport.llg.restart` completes without throwing.
8. Changing `logLevel` restarts the process while changing `trace.server`
   does not.
9. With the fake server in `crash:N` mode (more crashes than the client's
   bounded restart policy), restarts are attempted repeatedly and eventually
   stop; the restart command itself must not throw.
10. Restarting stops the previously recorded server process (the same stop
   path used by deactivation); no leftover pid from `server.pid` survives.
   Full deactivation happens at window close, which this harness cannot
   trigger mid-suite, so the shared stop path is asserted instead.
11. With `HDLSUPPORT_E2E_EXPLORER=1`, the fake server returns a deterministic
   recursive `llg/moduleExplorer` snapshot. The suite waits for the real
   refresh path, checks multiple roots and a top/child/leaf chain, selects an
   exact stable node through the normal hierarchy selection listener, and
   checks expanded Module Contents groups, typed descriptions, per-instance
   parameter values, and declaration-only/ambiguous rendering.
12. `llg.toml` key completion and section hover work through VS Code's provider
   execution commands.
13. The activated literal-include provider resolves a neighboring header, and
    external-linter diagnostics receive line, workspace, and documentation
    actions through VS Code's code-action command.
14. An empty `publishDiagnostics` notification clears only that document in the
    named Lapligence collection; another open document's diagnostics survive.

## Prerequisites

- A graphical display or Xvfb. On headless Linux, use `xvfb-run`, which creates
  a display owned by that invocation. An invoked GUI suite always fails when
  `DISPLAY` is unset, malformed, unreachable, or associated only with remote
  display forwarding; it never becomes a false-green skip. A local Xvfb socket
  remains eligible when `xvfb-run` has replaced `DISPLAY` with a different
  local endpoint.
- Run `npm ci` (or `npm install`) first; the pinned `mocha` dev dependency is
  part of the repository lockfile and is loaded only by this host runner.
- First run downloads VS Code via `@vscode/test-electron`.

## Running

```sh
npm run test:e2e:client-host  # compiles the extension/tests, then launches the host runner
```

On a headless Linux machine, wrap the repeatable script with Xvfb:

```sh
HDLSUPPORT_E2E_DISABLE_GPU=1 \
  xvfb-run -a npm run test:e2e:client-host
```

For inherited remote/container forwarding, the preflight rejects the run by
default: the VS Code remote server can own the forwarded socket, so a
connect-only probe is not evidence that Electron has a usable X server. If you
have independently verified the forwarded display, opt in with the exact value
`1`:

```sh
HDLSUPPORT_E2E_ALLOW_FORWARDED_DISPLAY=1 npm run test:e2e:client-host
```

CI also sets `HDLSUPPORT_E2E_VSCODE_VERSION` to `1.82.3` or `stable` and runs
this suite on Linux, Windows, and macOS. `HDLSUPPORT_E2E_DISABLE_GPU=1`
disables GPU acceleration for repeatable headless Electron runs.
The launcher supervises the host process with a 180-second timeout; a timeout
terminates the worker tree, preserves configured diagnostics, and fails the
invocation.

For a non-forwarded local display, the Linux preflight only screens whether the
parsed X11 UNIX socket or TCP endpoint accepts a connection. It is not proof of
X11 usability. It sends no X11 setup handshake and does not inspect or consume
`XAUTHORITY`; Electron/VS Code performs the real authenticated connection, so
`xvfb-run` cookies remain usable. The opt-in only permits the same endpoint
screening for a forwarded display; it does not claim that display is valid.
After an endpoint is accepted, the host suite is always attempted and any
Electron/test failure remains a failure rather than a skip.

or, after `npm run compile-tests`, directly from TypeScript:

```sh
npx ts-node src/test/e2e/clientHost/runTest.ts
```

## How the fake server is wired

`runTest.ts` builds a throwaway fixture under `os.tmpdir()`:

```
hdlsupport-e2e-host-<pid>-<n>-<rand>/
├── proj/                       # opened as the VS Code workspace
│   ├── .vscode/settings.json   # hdlsupport.llg.path → the test Node executable
│   ├── llg.toml               # schema v1, sources = ["."]
│   ├── top.sv                  # module top + two child instances + unused_sig
│   └── child.sv                # multiline parameter/port declarations + signal
├── control/
│   ├── mode                    # '' | normal | hang | crash[:N]
│   ├── launches.log            # one line per server launch
│   └── server.pid              # pid of the most recent launch
└── recorded-initialize.json    # raw initialize params (LLG_FAKE_RECORD)
```

The mode file lets specs flip behavior between launches; env vars
(`LLG_FAKE_RECORD`, `LLG_FAKE_CONTROL_DIR`, and
`HDLSUPPORT_E2E_EXPLORER=1`) are injected into the extension host via
`extensionTestsEnv`, so the spawned fake server inherits them. The fake
snapshot uses stable IDs, exact typed/display content, declaration URI/range
metadata, and derives its file URIs from the initialized workspace. The
latest response is also recorded as `control/module-explorer.json` for
read-only navigation assertions.

The harness enables the client’s test-only launch seam with
`HDLSUPPORT_TEST_MODE=1`, points `HDLSUPPORT_TEST_SERVER_MODULE` at the compiled
fake server module, and supplies `HDLSUPPORT_TEST_NODE_EXECUTABLE`. Production
launch behavior is unchanged; no shell wrapper is needed, which keeps the
fixture portable across Windows, macOS, and Linux.

The opt-in activation export is `{ moduleExplorer, includeLinks }` (plus
compatibility aliases for the explorer methods). Its provider-facing explorer
adapter is:

```ts
moduleExplorer.wait(): Promise<void>
moduleExplorer.inspect(): {
  hierarchy: TreeItem[];
  contents: TreeItem[];
  selectedId?: string;
}
moduleExplorer.select(id: string): Promise<void>
```

`includeLinks.provider` is the exact document-link provider registered during
activation, allowing the host suite to test link resolution without relying on
a non-public VS Code execution command.

Each serializable `TreeItem` contains `id`, `label`, optional `description`,
`tooltip`, and provider-owned `command`, `collapsibleState`, and recursively
materialized `children`.
`select` resolves the provider item by stable ID and invokes the same selection
path used by the hierarchy view; the test does not mutate explorer state.

The host suite selects a leaf using the returned `TreeItem.id` and executes the
provider-owned `hdlsupport.modules.gotoDefinition` command preserved by the
test adapter. It verifies the declaration URI and exact active-editor selection
range; the command payload is not rebuilt by the test.

## Fake server modes

| Mode         | Behavior                                                            |
| ------------ | ------------------------------------------------------------------- |
| `normal`     | All advertised providers, diagnostics, and clean shutdown.           |
| `hang`       | Records initialize params but never answers; exercises timeouts.    |
| `crash`      | Crashes right after every successful initialize handshake.          |
| `crash:N`    | Crashes after init N times, then behaves like `normal`.             |
