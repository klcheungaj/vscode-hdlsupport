#!/usr/bin/env node
// Stages the Softbrush (Tcl/SDC/XDC) language server for bundling in the
// linux-x64 VSIX by downloading the pinned GitHub release asset rather
// than building from source. Bump `tag`, `asset` and `sha256` together to update.
//
// Flags:
//   --print-plan   print the resolved URL/checksum/destination and exit

import { main } from './serverRelease';

main({
  label: 'stage-softbrush',
  repo: 'klcheungaj/softbrush',
  tag: 'v0.2.2',
  asset: 'softbrush_ls-0.2.2-linux-x86_64.tar.gz',
  sha256: 'f3785a03ba83bd5876d1d5b2f267cd530102ecb228bfaf01909c4dc29d1ff5df',
  binary: 'softbrush_ls',
});
