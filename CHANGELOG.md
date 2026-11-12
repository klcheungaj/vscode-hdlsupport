# Change Log

All notable changes to the "hdl-support" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.0] - Unreleased

### Added

- Executable linkage contracts for Linux, Windows and macOS; Linux mimalloc protocol-allocation checks also validate the actual packaged servers.
- Real VS Code/Softbrush startup and diagnostic regression coverage.

- Tcl, SDC, and XDC TextMate grammars and editor configurations, with Softbrush diagnostics, hover, completion, symbols, and semantic tokens. The SDC and XDC grammars extend the Tcl grammar, and all three color tokens the same way as Softbrush semantic tokens, so highlighting does not change when the server starts. Unknown constraint commands remain non-blocking hints.
- Bundled Linux x64 Softbrush server, executable override, enable setting, restart/output commands, and `npm run stage:softbrush`.

- Lapligence (`llg`) language server integration (Surelog/UHDM-based) with diagnostics including built-in lint rules, hover, go-to-definition, find-references, symbol rename, document and workspace symbols, completion, semantic tokens, multi-root workspace support, and unsaved-buffer awareness.
- Editor-independent `llg.toml` v1 configuration (`schema_version = 1`) for source discovery, compile options (`top`, `include_dirs`, `defines`), and lint rules (`enabled`, `severity`).
- Commands: `hdlsupport.llg.restart`, `hdlsupport.llg.openConfig`, `hdlsupport.llg.showOutput`.
- Settings: `hdlsupport.llg.path`, `hdlsupport.llg.configPath`, `hdlsupport.llg.logLevel`, `hdlsupport.llg.trace.server`.
- Bundled Lapligence (`llg`) server for Linux x64 with an executable-path override for other platforms.
- `npm run stage:server` and `npm run stage:softbrush` packaging scripts, which download pinned, SHA-256-verified static Lapligence v0.4.0 and Softbrush v0.2.2 release assets instead of building the submodules, and `npm run package:linux-x64`.
- Client-side HDL template generation for SystemVerilog testbenches, cocotb starters, modules, interfaces, clock/reset blocks, assertions, and covergroups.
- `llg.toml` completion, hover help, directory-path completion, and a packaged JSON schema.
- Navigable links for literal Verilog/SystemVerilog include directives.
- External-linter quick actions for line/workspace waivers and Verilator warning documentation.
- Multiple `llg.toml` files per workspace: each file uses the closest `llg.toml` in its directory or an ancestor up to the workspace root; nested config directories are announced to the server as extra roots, and creating/deleting one restarts the server.
- `HDL Support: Align Cursors` (`hdlsupport.alignCursors`) pads multi-cursors with spaces to the rightmost visual column.
- Configuration completion/schema support for all 24 Lapligence lint rules, including `empty-implicit-sensitivity`, `assignment-in-condition`, `casex-statement`, `undriven-signal`, `incomplete-sensitivity-list`, `out-of-range-select`, `xz-logical-equality`, and `duplicate-case-item`.
- Cross-platform GitHub Actions CI for static checks, unit tests, VS Code/Electron and Playwright tests, real-server contracts, and Linux x64 VSIX validation.
- A dependency audit workflow (push, pull request, weekly) that verifies npm registry signatures, rejects advisories in runtime dependencies or critical ones anywhere, and reviews dependencies added by pull requests; releases run the same runtime audit before packaging.
- A guarded GitHub Release workflow that builds the static Linux x64 package, verifies it, publishes a versioned VSIX and SHA-256 checksum, and supports tag or manual dispatch releases.

### Changed

- All commands use the `HDL Support` category; language-server commands carry a `[Lapligence]` or `[Softbrush]` label. HDL Modules Go to Definition is no longer listed in the Command Palette (tree items still navigate).
- Tab/space conversion commands are rewritten and renamed to `hdlsupport.convertTabsToSpaces` / `hdlsupport.convertSpacesToTabs`; Align Cursors and the converters share one visual-column rule (wide CJK characters take two columns).
- Launch Softbrush without injected arguments, preserving compatibility with releases that reject `--stdio`.

- Standalone Verilog/SystemVerilog files now establish an llg analysis root instead of relying on the extension host working directory. Correcting a failed server path restarts linting.

- External linters share a controller and tool profiles for arguments, diagnostic parsing, severity, and generated settings. Diagnostic ownership preserves errors across files; Windows batch launchers use PATHEXT resolution.
- The Verilog/SystemVerilog formatter is profile-driven like the external linters: `hdlsupport.verilog.formatting.formatter` selects the tool (`verible`, or `none` to disable) and `hdlsupport.verilog.formatting.verible.{path,arguments}` configure it. Arguments are passed without shell expansion, and range formatting passes `--lines`.

- `Verilog: Instantiate Module` (`verilog.instantiateModule`) is now built on standard LSP document symbols, so it works with the Lapligence language server; Universal Ctags is no longer involved.
- Verilog/SystemVerilog language features are served by the Lapligence language server instead of in-extension providers.
- External linters (verilator, xvlog, modelsim, slang) are disabled by default (`hdlsupport.verilog.linting.linter` defaults to an empty list) and are independent from Lapligence diagnostics. The setting now takes a list of linters, which all run on each lint and whose diagnostics are merged; the earlier single-string value is still read.
- `runAtFileLocation` is one shared setting, `hdlsupport.verilog.linting.runAtFileLocation`, replacing the per-linter copies, and every linter now has a `useWSL` option (previously only Verilator and Slang).
- The generated `llg.toml` no longer disables `unused-signal`; Lapligence diagnostic publications are named, explicitly forwarded, and logged with lint/total counts.
- Production and desktop contracts now cover cross-file prepare-rename/rename edits, all server-owned VS Code providers, the five expanded lint diagnostics, per-document and Problems-panel diagnostic clearing, semantic tokens that survive syntax errors in open buffers, shutdown shadow cleanup, and opt-in read-only smoke testing of an external HDL checkout.
- VS Code engine requirement bumped to `^1.82.0`.
- Locked dependency versions refreshed to resolve npm audit advisories, including the bundled `glob`, `minimatch`, and `brace-expansion`.
- External-linter include directories now come from the `llg.toml` governing the linted file (`[sources] directories`, `[compile] include_dirs`, else the workspace root) instead of glob-expanded settings.
- Each external linter's `arguments` setting now shows its built-in default flags; a configured value replaces them. Verilator is always run with IEEE 1800-2009 extensions, matching the language server.
- CI actions are pinned to full commit SHAs, generated syntax/snippet files are checked for drift, GUI failures retain diagnostic artifacts, and release publishing is isolated behind the `github-release` environment.

### Removed

- Icarus Verilog (`iverilog`) external-linter support.
- Settings `hdlsupport.verilog.includePath`, `hdlsupport.verilog.excludePath`, `hdlsupport.verilog.maxSearchDepth`, `hdlsupport.verilog.linting.<tool>.includePath`, `hdlsupport.verilog.version`, and `hdlsupport.systemverilog.version`; the `glob` dependency.
- **BREAKING:** Bluespec (BSV) support: the `bsv` language, its grammar, and its outline, hover, completion, and definition providers.
- The `lapligence` and `softbrush` git submodules and the Docker/cargo server build paths (`LLG_BUILD_MODE`, `LLG_SKIP_BUILD`, `SOFTBRUSH_BUILD_MODE`, ...); the bundled servers come from pinned release assets.

- **BREAKING:** internal ANTLR4-based Verilog indexer and worker-based indexing pipeline.
- **BREAKING:** Universal Ctags integration.
- **BREAKING:** `hdlsupport.verilog.indexer`, `hdlsupport.verilog.workerNumber`, and `hdlsupport.verilog.ctags.path` settings.
- **BREAKING:** included-files listing command.
- **BREAKING:** `hdlsupport.verilog.formatCommand` — replaced by `hdlsupport.verilog.formatting.verible.{path,arguments}`; `${workspaceFolder}`-style placeholders are not expanded.
- **BREAKING:** `llg-lint.toml` support — replaced by `llg.toml` with no migration compatibility.

## [Unreleased]

- Initial release
