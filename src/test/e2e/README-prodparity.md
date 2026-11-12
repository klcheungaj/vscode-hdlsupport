# Production-parity e2e suites (raw stdio)

## Why this directory exists

Vitest unit + fake-server suites pass, yet real projects hit a wall: diagnostics
publish fine, but hover / definition / completion / documentSymbols /
semanticTokens return EMPTY and `verilog.instantiateModule` says
"No modules found". The suites here reproduce production against the REAL
staged binary (`server/linux-x64/llg_ls`) over raw Content-Length-framed
JSON-RPC stdio — exactly what VS Code + vscode-languageclient send:
initializationOptions `{ llg: { protocolVersion: 1, configFiles: [...] } }`,
one `didOpen`, project-wide `publishDiagnostics`, then direct requests.

- `featuresParity.e2e.test.ts` — feature matrix on an error-containing repo
  (`[PROD-PARITY]`) + inline-replicated `verilog.instantiateModule`
  precondition (`[INSTANTIATE-MODULE-PRECONDITION]`).
- `semanticTokensConformance.e2e.test.ts` — strict wire-format conformance of
  `semanticTokens/full` on a clean repo (delta decoding, legend bounds,
  position truthfulness, CRLF handling).
- `moduleExplorer.e2e.test.ts` — staged-binary `llg/moduleExplorer` coverage
  for automatically inferred roots, `[compile].top`, recursive elaborated
  nodes, typed contents, and exclusion of port backing nets from Signals.
- `realServer.e2e.test.ts` — baseline capability/lifecycle coverage plus
  cross-file prepare-rename/rename edits, all five expanded careless-mistake
  lint rules, diagnostic recovery, config reload, read-only behavior, and
  deterministic temporary-shadow cleanup.
- `externalWorkspace.e2e.test.ts` — opt-in smoke coverage for a real HDL
  checkout supplied through `HDLSUPPORT_E2E_EXTERNAL_WORKSPACE`. It creates a
  temporary config, indexes the checkout in place, exercises the standard
  providers plus Module Explorer, and verifies that the external RTL tree is
  byte-for-byte unchanged. It is skipped unless explicitly enabled, so the
  repository and CI do not depend on a private or neighboring project.

Fixtures: `fixtures/realProject.ts` builds a production-shaped workspace —
nested `rtl/sub/`, `tb/`, `include/defs.vh`, TAB indentation, a >120-column
line, one CRLF file, and an opt-in deliberate Surelog-visible parse error
(`injectError`, default on) so whole-project analysis is NOT clean. All suites
skip when the staged binary is missing. The module-explorer suite also creates
an isolated temporary variant with `[compile].top = "top"`; its checksum is
verified before cleanup, so no tracked fixture is edited. **`[PROD-PARITY]`
and conformance failures are FINDINGS by design — do not weaken the
assertions.** Open-buffer semantic-token checks cover self-contained source
and include-macro-dependent source; both return non-empty token streams.

## What raw-stdio cannot cover

No editor means no coverage of VS Code-side provider registration,
snippet-insertion UX, quick picks/input boxes, Problems-panel rendering,
vscode-languageclient restart handling under a real host, or multi-root
wiring in a live window. Those need the electron layers below.

## Three-layer test model

The three primary layers are fast unit tests, the `@vscode/test-electron`
client-host suite, and the Playwright desktop UI suite. Unit tests run with:

```sh
npm run test:unit
```

The client-host suite is described below. Playwright runs with
`npm run test:e2e:playwright`. These GUI layers use the fake LSP server for
client/UI behavior; this raw-stdio directory is an additional production
contract layer against real `llg`, and Playwright does not replace the Linux
VSIX contract checked by `vsixContents.e2e.test.ts` after
`npm run package:linux-x64`.

## UI layer: `@vscode/test-electron` harness

`src/test/e2e/clientHost/` drives the real extension inside a real VS Code
window against a controllable fake server (see its README). It remains a
Mocha suite run through `@vscode/test-electron`, not a Vitest suite; it covers
activation, initialization wiring, lifecycle/restart behavior, and the opt-in
provider-backed Module Explorer adapter:

```sh
npm run test:e2e:client-host                     # needs a display, or:
xvfb-run -a npm run test:e2e:client-host
```

Environment prerequisites (Debian/Ubuntu names): `xvfb`, `libgtk-3-0`,
`libnss3`, `libgbm1`, `libasound2t64`, `libxss1`, `libxshmfence1`, `libdrm2`,
`libx11-xcb1`, and `libxcb-dri3-0`. The first run downloads a private VS Code
build via `@vscode/test-electron`; cache it in CI to keep runs fast.
The Linux package contract also requires the `unzip`/`zipinfo` utilities so it
can inspect the generated VSIX itself.

## Sample CI job running both layers

On Linux CI, install Xvfb and the VS Code runtime libraries, then invoke both
GUI commands through `xvfb-run -a`. Set `HDLSUPPORT_E2E_DISABLE_GPU=1` and
`HDLSUPPORT_E2E_VSCODE_VERSION` (either
`1.82.3` or `stable`). Windows and macOS run the same commands on native
runners. CI caches npm and `@vscode/test-electron` downloads by operating
system, architecture, VS Code version, and lockfile hash, and uploads Playwright
reports/traces/screenshots plus VS Code/fake-server logs on failure.

The complete Linux production-parity sequence is:

```sh
npm ci
npm run build
npm run package:linux-x64
npm run test:unit
REQUIRE_LLG=1 npm run test:contract
npm run test:package
HDLSUPPORT_E2E_DISABLE_GPU=1 \
  xvfb-run -a npm run test:e2e:playwright
HDLSUPPORT_E2E_DISABLE_GPU=1 \
  xvfb-run -a npm run test:e2e:client-host
```

The raw suites may report a missing staged binary as a local skip; CI stages
the server first, so a missing or unusable artifact is a job failure. GUI
display/process failures must likewise fail the invocation. The fake server is
deliberately not a substitute for real language-server behavior; use the raw
layer for that coverage.

To smoke-test any separate checkout without adding it as a fixture or project
dependency, point the optional contract at its absolute path. The current
fixture contract expects a representative `rtl/cfg_fsm.sv` and recursively
discovers `.v`/`.sv` files below `rtl`:

```sh
HDLSUPPORT_E2E_EXTERNAL_WORKSPACE=/absolute/path/to/hdl-project \
  REQUIRE_LLG=1 npm run test:contract
```

The Playwright desktop journey additionally opens VS Code's actual Problems
panel, observes an `llg-lint` diagnostic, edits the source, and verifies that
the server's empty publication removes the visible problem.
