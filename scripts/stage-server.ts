#!/usr/bin/env node
// Stages the Lapligence (llg) language server for bundling in a VSIX by
// downloading the pinned GitHub release asset instead of building from
// source. Bump `tag` and every `asset`/`sha256` pair together to update.
//
// Flags:
//   --target <t>   VS Code target to stage (default: this host's target)
//   --print-plan   print the resolved URL/checksum/destination and exit

import { main, type ServerRelease } from './serverRelease';

export const LLG_RELEASE: ServerRelease = {
  label: 'stage-server',
  repo: 'klcheungaj/lapligence',
  tag: 'v0.4.0',
  assets: {
    'linux-x64': {
      asset: 'lapligence-0.4.0-linux-x86_64.tar.gz',
      sha256: 'ed43872ad58789a8115aeeac8481c22ab76b10d83590ef1f4bbcc11c95e5d4ee',
    },
    'linux-arm64': {
      asset: 'lapligence-0.4.0-linux-arm64.tar.gz',
      sha256: '289e4df111e18800c87db6bf4b373f5aa80b3bd62f60f00a9825c38b41d69fa6',
    },
    'darwin-arm64': {
      asset: 'lapligence-0.4.0-macos-arm64.tar.gz',
      sha256: 'a83886787570875cb3b7e808e08e074551962b9a89054d6403e9b3556333690f',
    },
    'win32-x64': {
      asset: 'lapligence-0.4.0-windows-x86_64.zip',
      sha256: 'd0f1dd5a9b49d56b92168b717abc10330e0580cc8369c6457fd6162293cadcd9',
    },
    'win32-arm64': {
      asset: 'lapligence-0.4.0-windows-arm64.zip',
      sha256: '733c3fa462564f84b01b9602a4a7b719bda6f48047477632e91fd746eea6444d',
    },
  },
  binary: 'llg_ls',
};

if (require.main === module) {
  main(LLG_RELEASE);
}
