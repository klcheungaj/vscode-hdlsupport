// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import * as path from 'path';

import { linterIncludeDirectories, llgConfigDirectories } from '../../linter/includeDirectories';

const ROOT = path.resolve(path.sep, 'ws');
const at = (...parts: string[]): string => path.join(ROOT, ...parts);

describe('llgConfigDirectories', () => {
    it('resolves source directories and include_dirs against the config directory', () => {
        const text = [
            '[sources]',
            'directories = ["rtl", "../shared"]',
            '[compile]',
            'include_dirs = ["include"]',
        ].join('\n');
        expect(llgConfigDirectories(text, at('proj'))).toEqual([at('proj', 'rtl'), at('shared'), at('proj', 'include')]);
    });

    it('uses the config directory as the default source directory', () => {
        expect(llgConfigDirectories('[compile]\ninclude_dirs = ["inc"]\n', at('proj')))
            .toEqual([at('proj'), at('proj', 'inc')]);
        expect(llgConfigDirectories('schema_version = 1\n', at('proj'))).toEqual([at('proj')]);
    });
});

describe('linterIncludeDirectories', () => {
    const documentDirectory = at('proj', 'rtl', 'core');

    it('lists the document directory first and de-duplicates', () => {
        expect(linterIncludeDirectories({
            documentDirectory,
            fallbackDirectory: ROOT,
            configPath: at('proj', 'llg.toml'),
            configText: '[sources]\ndirectories = ["rtl/core", "rtl"]\n',
        })).toEqual([documentDirectory, at('proj', 'rtl')]);
    });

    it('falls back to the workspace root when no config is readable', () => {
        expect(linterIncludeDirectories({
            documentDirectory, fallbackDirectory: ROOT, configPath: at('llg.toml'), configText: undefined,
        })).toEqual([documentDirectory, ROOT]);
        expect(linterIncludeDirectories({
            documentDirectory, fallbackDirectory: documentDirectory, configPath: undefined, configText: undefined,
        })).toEqual([documentDirectory]);
    });
});
