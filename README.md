# HDL Support

Verilog/SystemVerilog, Tcl/SDC/XDC, and VHDL support for VS Code, powered by
the [Lapligence](https://github.com/klcheungaj/lapligence) and
[Softbrush](https://github.com/klcheungaj/softbrush) language servers.

## Verilog / SystemVerilog

- **Navigation** — go to definition, find references.
  <!-- ![Go to definition](media/screenshots/goto-definition.gif) -->
- **Semantic highlighting** — signals, ports, parameters, types, and macros.
  <!-- ![Semantic highlighting](media/screenshots/semantic-tokens.png) -->
- **Diagnostics** — syntax and elaboration errors plus 24 built-in lint rules.
  <!-- ![Diagnostics](media/screenshots/diagnostics.png) -->
- **HDL Modules view** — instance hierarchy with per-instance ports,
  parameters, and signals.
  <!-- ![HDL Modules view](media/screenshots/module-hierarchy.gif) -->
- **Hover, completion, symbols, folding, inactive `ifdef` dimming.**
- **Editing helpers** — templates, module instantiation, include links,
  Align Cursors (`Ctrl+Alt+A`), tab/space conversion.
- **Formatting** via `verible-verilog-format`; optional external linters
  (Verilator, xvlog, ModelSim, Slang).

## Tcl / SDC / XDC

Diagnostics, hover, completion, symbols, and semantic highlighting.

## VHDL

Syntax highlighting and snippets.

## Getting Started

Language servers are bundled for Linux x64. On other platforms, set
`hdlsupport.llg.path` and `hdlsupport.softbrush.path`.

Add an `llg.toml` to describe your project (run
**HDL Support: [Lapligence] Open Configuration (llg.toml)** to create one):

```toml
schema_version = 1

[sources]
directories = ["rtl"]

[compile]
top = "top"
include_dirs = ["include"]
defines = ["SYNTHESIS"]
```

Each file uses the closest `llg.toml` in its directory or a parent, up to the
workspace root. Full reference: [doc/llg.example.toml](doc/llg.example.toml).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `hdlsupport.llg.path` | `""` | `llg_ls` path; empty uses the bundled server |
| `hdlsupport.llg.configPath` | `""` | workspace-root config file; empty uses `<workspace>/llg.toml` |
| `hdlsupport.llg.logLevel` | `warn` | `off` … `trace` |
| `hdlsupport.softbrush.enabled` | `true` | enable Tcl/SDC/XDC features |
| `hdlsupport.softbrush.path` | `""` | `softbrush_ls` path; empty uses the bundled server |
| `hdlsupport.verilog.formatting.formatter` | `verible` | Verilog/SV formatter, or `none` |
| `hdlsupport.verilog.formatting.<tool>.{path,arguments}` | | per-formatter options |
| `hdlsupport.verilog.linting.linter` | `[]` | external linters to run; select several to run them all |
| `hdlsupport.verilog.linting.runAtFileLocation` | `false` | run linters in the document directory instead of the workspace folder |
| `hdlsupport.verilog.linting.<tool>.{path,arguments,useWSL}` | | per-linter options; `useWSL` runs the tool inside WSL on Windows |

External linters take include directories from the governing `llg.toml`.

## Troubleshooting

- Logs: **HDL Support: [Lapligence] Show Output**; raise `hdlsupport.llg.logLevel` for more.
- Config errors appear in the Problems panel on `llg.toml`.

## Contributing

See [doc/development.md](doc/development.md).
