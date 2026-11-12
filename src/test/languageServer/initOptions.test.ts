import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildInitializationOptions, WorkspaceFolderInfo } from '../../languageServer/initOptions';

const noOverride = () => '';

describe('buildInitializationOptions', () => {
    it('defaults to <root>/llg.toml when the override is unset', () => {
        const options = buildInitializationOptions([{ uri: '/ws/project-a', name: 'project-a' }], noOverride);
        expect(options).toEqual({
            llg: {
                protocolVersion: 1,
                configFiles: [
                    {
                        workspaceUri: 'file:///ws/project-a',
                        path: path.resolve('/ws/project-a', 'llg.toml'),
                    },
                ],
            },
        });
    });

    it('resolves relative overrides from the folder root', () => {
        const options = buildInitializationOptions(
            [{ uri: '/ws/project-a', name: 'project-a' }],
            () => 'config/custom-llg.toml',
        );
        expect(options.llg.configFiles[0].path).toBe(
            path.resolve('/ws/project-a', 'config/custom-llg.toml'),
        );
    });

    it('passes absolute overrides through unchanged', () => {
        const absolute = '/etc/llg/shared.toml';
        const options = buildInitializationOptions([{ uri: '/ws/project-a', name: 'project-a' }], () => absolute);
        expect(options.llg.configFiles[0].path).toBe(absolute);
    });

    it('emits one entry per folder in input order', () => {
        const folders: WorkspaceFolderInfo[] = [
            { uri: '/ws/beta', name: 'beta' },
            { uri: '/ws/alpha', name: 'alpha' },
        ];
        const overrides: Record<string, string> = {
            '/ws/beta': 'other.toml',
            '/ws/alpha': '',
        };
        const options = buildInitializationOptions(folders, (folderUri) => overrides[folderUri] ?? '');
        expect(options.llg.protocolVersion).toBe(1);
        expect(options.llg.configFiles.map((entry) => entry.workspaceUri)).toEqual([
            'file:///ws/beta',
            'file:///ws/alpha',
        ]);
        expect(options.llg.configFiles.map((entry) => entry.path)).toEqual([
            path.resolve('/ws/beta', 'other.toml'),
            path.resolve('/ws/alpha', 'llg.toml'),
        ]);
    });

    it('handles an empty folder list', () => {
        expect(buildInitializationOptions([], noOverride)).toEqual({
            llg: { protocolVersion: 1, configFiles: [] },
        });
    });
});
