// SPDX-License-Identifier: MIT
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { closestConfigPath, nestedConfigRoots } from '../../languageServer/llgConfigDiscovery';

const ws = path.resolve('/ws');
const at = (...parts: string[]): string => path.join(ws, ...parts);
const existing = (...files: string[]) => (candidate: string): boolean => files.includes(candidate);

describe('closestConfigPath', () => {
    const rootConfig = at('llg.toml');

    it('prefers llg.toml in the file directory', () => {
        const isFile = existing(at('a', 'b', 'llg.toml'), at('a', 'llg.toml'), rootConfig);
        expect(closestConfigPath(at('a', 'b', 'top.sv'), ws, rootConfig, isFile)).toBe(at('a', 'b', 'llg.toml'));
    });

    it('walks up to the nearest ancestor', () => {
        const isFile = existing(at('a', 'llg.toml'), rootConfig);
        expect(closestConfigPath(at('a', 'b', 'c', 'top.sv'), ws, rootConfig, isFile)).toBe(at('a', 'llg.toml'));
    });

    it('falls back to the workspace root effective config (which may be an override)', () => {
        const override = at('cfg', 'custom.toml');
        expect(closestConfigPath(at('a', 'top.sv'), ws, override, existing())).toBe(override);
        expect(closestConfigPath(at('top.sv'), ws, override, existing())).toBe(override);
    });

    it('never consults subdirectories or directories above the workspace root', () => {
        const isFile = existing(at('a', 'sub', 'llg.toml'), path.join(path.dirname(ws), 'llg.toml'));
        expect(closestConfigPath(at('a', 'top.sv'), ws, rootConfig, isFile)).toBe(rootConfig);
    });

    it('walks to the filesystem root without a workspace', () => {
        const isFile = existing(at('llg.toml'));
        expect(closestConfigPath(at('a', 'top.sv'), undefined, undefined, isFile)).toBe(at('llg.toml'));
        expect(closestConfigPath(at('a', 'top.sv'), undefined, undefined, existing())).toBeUndefined();
    });
});

describe('nestedConfigRoots', () => {
    it('keeps only sorted, unique directories strictly inside a workspace root', () => {
        const other = path.resolve('/other');
        expect(nestedConfigRoots([ws], [
            at('z', 'llg.toml'),
            at('llg.toml'),
            at('a', 'llg.toml'),
            at('a', 'llg.toml'),
            at('a', 'custom.toml'),
            path.join(other, 'x', 'llg.toml'),
        ])).toEqual([at('a'), at('z')]);
    });

    it('does not treat another workspace root as nested', () => {
        expect(nestedConfigRoots([ws, at('sub')], [at('sub', 'llg.toml')])).toEqual([]);
    });
});
