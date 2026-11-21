#!/usr/bin/env node
// Stages the Softbrush (Tcl/SDC/XDC) language server for bundling in a VSIX
// by downloading the pinned GitHub release asset rather than building from
// source. Bump `tag` and every `asset`/`sha256` pair together to update.
//
// Flags:
//   --target <t>   VS Code target to stage (default: this host's target)
//   --print-plan   print the resolved URL/checksum/destination and exit

import { main, type ServerRelease } from './serverRelease';

export const SOFTBRUSH_RELEASE: ServerRelease = {
  label: 'stage-softbrush',
  repo: 'klcheungaj/softbrush',
  tag: 'v0.2.2',
  assets: {
    'linux-x64': {
      asset: 'softbrush_ls-0.2.2-linux-x86_64.tar.gz',
      sha256: 'f3785a03ba83bd5876d1d5b2f267cd530102ecb228bfaf01909c4dc29d1ff5df',
    },
    'linux-arm64': {
      asset: 'softbrush_ls-0.2.2-linux-arm64.tar.gz',
      sha256: '6ccb04e1219bbc0acae12f0bad035c16b6677171808647377a0f7aadd8da2edd',
    },
    'darwin-arm64': {
      asset: 'softbrush_ls-0.2.2-macos-arm64.tar.gz',
      sha256: 'bd047701bafde869395d639a9642d024145de03a906f1c099d78bf475a15beb9',
    },
    'win32-x64': {
      asset: 'softbrush_ls-0.2.2-windows-x86_64.zip',
      sha256: 'b0fa0825347029083ebe9d8bb20a3b03f8719f7fe457996279207fe19c41dfe7',
    },
    'win32-arm64': {
      asset: 'softbrush_ls-0.2.2-windows-arm64.zip',
      sha256: '17ddce6db67f3856b8e0bfadb88236636094bc5effa3ec4cfd5d05b4fc73fb4e',
    },
  },
  binary: 'softbrush_ls',
};

if (require.main === module) {
  main(SOFTBRUSH_RELEASE);
}
