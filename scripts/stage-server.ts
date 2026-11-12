#!/usr/bin/env node
// Stages the Lapligence (llg) language server for bundling in the linux-x64
// VSIX by downloading the pinned GitHub release asset instead of building
// from source. Bump `tag`, `asset` and `sha256` together to update.
//
// Flags:
//   --print-plan   print the resolved URL/checksum/destination and exit

import { main } from './serverRelease';

main({
  label: 'stage-server',
  repo: 'klcheungaj/lapligence',
  tag: 'v0.4.0',
  asset: 'lapligence-0.4.0-linux-x86_64.tar.gz',
  sha256: 'ed43872ad58789a8115aeeac8481c22ab76b10d83590ef1f4bbcc11c95e5d4ee',
  binary: 'llg_ls',
});
