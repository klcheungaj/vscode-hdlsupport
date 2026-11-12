# Development

Building, testing, and packaging `hdl-support`. User documentation is in the [README](../README.md).

## Build

Requires Node.js 22.12+ (20.19+ for build and unit tests only), VS Code ^1.82.0, and `tar`.

```sh
npm install
npm run build             # linter settings, syntaxes, snippets
npm run stage:server      # download llg_ls → server/linux-x64/
npm run stage:softbrush   # download softbrush_ls → server/linux-x64/
npm run compile           # bundle → dist/  (npm run watch for watch mode)
npm run typecheck
npm run lint
```

Run the extension with `code --extensionDevelopmentPath="$PWD"` after `npm run compile`.

Server versions are pinned in `scripts/stage-server.ts` and `scripts/stage-softbrush.ts`. To upgrade, update `tag`, `asset`, and `sha256` there.

## Package

```sh
npm run package:linux-x64                          # → hdl-support-linux-x64.vsix
code --install-extension hdl-support-linux-x64.vsix
```

Releases: see [doc/releasing.md](releasing.md).

## Test

| Command | Runs |
| --- | --- |
| `npm test` | unit + server contract tests |
| `npm run test:unit` | unit tests |
| `REQUIRE_LLG=1 REQUIRE_SOFTBRUSH=1 npm run test:contract` | real-server stdio contracts (stage servers first) |
| `npm run test:package` | VSIX contents (package first) |
| `npm run test:binaries` | server binary linkage |
| `npm run test:e2e:client-host` | VS Code host with a fake server |
| `npm run test:e2e:playwright` | VS Code UI via Playwright |
| `npm run test:e2e:real-server-host` | VS Code with real `llg_ls` |
| `npm run test:e2e:softbrush-host` | VS Code with real `softbrush_ls` |
| `npm run test:all` | build + unit + GUI tests |
| `npm run test:all:linux` | everything, including package and real servers |

GUI tests need a display. On headless Linux, prefix with `HDLSUPPORT_E2E_DISABLE_GPU=1 xvfb-run -a`.

| Variable | Effect |
| --- | --- |
| `HDLSUPPORT_E2E_VSCODE_VERSION` | VS Code version for GUI tests (`1.82.3`, `stable`) |
| `HDLSUPPORT_E2E_ARTIFACT_DIR` | keep GUI test logs |
| `HDLSUPPORT_E2E_EXTERNAL_WORKSPACE` | run contracts against an external HDL project |
| `HDLSUPPORT_LLG_BINARY`, `HDLSUPPORT_SOFTBRUSH_BINARY` | binaries for `test:binaries` |

More: [src/test/e2e/README-prodparity.md](../src/test/e2e/README-prodparity.md), [src/test/e2e/clientHost/README.md](../src/test/e2e/clientHost/README.md).
