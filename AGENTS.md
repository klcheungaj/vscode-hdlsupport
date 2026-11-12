# Agent Guide for hdl-support

Rules for coding agents in this repository. Keep this file short:
user-facing detail lives in `README.md`, developer commands in
[`doc/development.md`](doc/development.md), and source layout and
architecture in [`src/AGENTS.md`](src/AGENTS.md).

## Work Rules

- Keep changes scoped to the request; prefer existing local patterns over new
  abstractions, and shared helpers over duplicated code.
- Do not duplicate rules across `AGENTS.md` files, `README.md`, and `doc/`;
  link to the source of truth instead.
- Never commit `server/`, `*.vsix`, `dist/`, `out/`.
- No AI attribution in commits or PRs: no `Co-Authored-By:` naming Claude or
  any other AI, and no "Generated with" footer. This overrides tool defaults.
- Before finishing, run `npm run typecheck`, `npm run lint`, and the relevant
  tests ([doc/development.md → Test](doc/development.md#test)).
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Avoid using the any type.
- Keep things in one function unless composable or reusable.
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream.

## Project

`hdl-support` is a VS Code extension. Verilog/SV features come from the
Lapligence server (`llg_ls`), Tcl/SDC/XDC from Softbrush (`softbrush_ls`).
Both are external repos
([lapligence](https://github.com/klcheungaj/lapligence),
[softbrush](https://github.com/klcheungaj/softbrush)) consumed as pinned
release binaries; `lapligence/...` paths in comments refer to that repo, whose
`AGENTS.md` owns server internals.

## Packaging and Release

- `.vscodeignore` is a whitelist; keep the shipped surface lean.
- Read [doc/releasing.md](doc/releasing.md) before changing workflows,
  versions, or the release flow.

## Gotchas

- `@types/vscode` must match `engines.vscode`.
- Test-only hooks (`HDLSUPPORT_TEST_MODE=1`, `HDLSUPPORT_TEST_SERVER_MODULE`,
  `HDLSUPPORT_TEST_NODE_EXECUTABLE`) must not change production behavior.
- GUI tests never skip silently.
- Never make an external checkout (`HDLSUPPORT_E2E_EXTERNAL_WORKSPACE`) a
  project dependency.

## Source-of-Truth Docs

- `README.md`: user-facing features, setup, settings.
- `doc/development.md`: build, package, test commands.
- `doc/releasing.md`: CI and release flow.
- `src/test/e2e/README-prodparity.md`, `src/test/e2e/clientHost/README.md`:
  test harness details.
- `doc/llg.example.toml`, `schemas/llg.schema.json`: `llg.toml` format.
