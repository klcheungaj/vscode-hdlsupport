# Source Guide

Source map and architecture for `src/`. Repo-wide rules are in the root
[`AGENTS.md`](../AGENTS.md).

## Source Map

- `extension.ts`: activation wiring; `deactivate()` awaits the llg `stop()`.
- `languageServer/`: language-server clients and their pure seams.
  - `llgClient.ts`: llg client manager (serialized lifecycle queue, custom
    requests, nested `llg.toml` roots).
  - `softbrushClient.ts`: lazy Softbrush client.
  - `commands.ts`, `configCommand.ts`: restart/output/dump/open-config commands.
  - Pure (no `vscode`): `resolve.ts` (executable resolution), `initOptions.ts`
    (init payload, effective config path), `restartPolicy.ts`,
    `llgConfigDiscovery.ts` (closest `llg.toml`, nested roots).
- `hierarchy/`: HDL Modules tree and Module Contents. `moduleExplorer.ts`
  (views), `moduleExplorerSnapshot.ts` (wire normalization),
  `moduleHierarchy.ts` (pure model), `refreshScheduler.ts` (debounce).
- `linter/`: optional external linters. `LintManager.ts` (scheduling,
  waivers), `ProfileLinter.ts` (shared process/diagnostic handling),
  `profiles/*` (pure per-tool flags and output parsing),
  `includeDirectories.ts` (include dirs from `llg.toml`).
- `clientFeatures/`: templates (`templateGenerator.ts`,
  `verilogStructure.ts`), `llg.toml` help, include links, folding,
  inactive-region dimming, external-lint quick actions. `*Pure.ts` files hold
  the vscode-free logic.
- `commands/`: module instantiation, whitespace conversion, align cursors.
- `formatter/`: external formatters. `ProfileFormatter.ts` (stdin/stdout
  process handling), `profiles/*` (pure per-tool flags).
- `test/`: Vitest unit/contract tests mirror the tree above; `test/e2e/` holds
  real-server contracts, the Mocha VS Code host (`e2e/clientHost`) and
  Playwright (`e2e/playwright`) suites.
- `../scripts/`: `stage-*.ts` download pinned server releases into
  `server/linux-x64/`; `sync-tool-profiles.ts` generates linter and formatter settings.

## Architecture Invariants

- Never register Verilog/SV language providers manually;
  `vscode-languageclient` registers them from server capabilities. Only the
  profile formatter and the folding-range provider are registered locally.
- llg init payload: `{ llg: { protocolVersion: 1, configFiles: [{ workspaceUri, path }] } }`.
  Client id is `'hdlsupport.llg'`. Settings restart the server only when
  `path`, `configPath`, or `logLevel` changes (`shouldRestartOnConfigChange`).
- Each file is governed by the closest `llg.toml` at or above it, up to the
  workspace root (`closestConfigPath`). The server reads one config per
  workspace folder, so nested config directories are sent as extra workspace
  folders; creating or deleting an `llg.toml` restarts the server.
- Pure seams (`resolve.ts`, `initOptions.ts`, `restartPolicy.ts`,
  `llgConfigDiscovery.ts`, `hierarchy/moduleHierarchy.ts`, `*Pure.ts`,
  `linter/profiles/*`, `formatter/profiles/*`) must not import `vscode`. Lazy `require('vscode')` only
  in `ModuleInstantiation.ts` and `configCommand.ts`.
- All llg client start/stop/restart/dispose goes through the serialized queue
  in `llgClient.ts`; at most one server process is alive.
- Softbrush starts lazily on the first Tcl/SDC/XDC document. Launch it with
  function-form `ServerOptions` and no arguments (older releases reject
  `--stdio`).
- Unknown SDC/XDC commands are never errors.
- External linters and formatters are profile-driven: add a profile under
  `linter/profiles/` or `formatter/profiles/` and run `npm run build:profiles`;
  no controller subclasses or tool switches.
- The servers never write project, config, or external files.
- Refresh work is debounced latest-wins: the HDL Modules sweep uses a 500 ms
  trailing timer (`refreshScheduler.ts`) and never overlaps a running sweep.
- HDL Modules prefers the server's `llg/moduleExplorer` snapshot and falls
  back to symbols. Roots are uninstantiated definitions; cycles stay visible in
  a synthetic group.
- Module Contents come from the selected elaborated instance (else its
  declaration) and navigate to declaration locations. No request-time
  project-file reads.
