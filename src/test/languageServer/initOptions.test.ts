import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { buildInitializationOptions, WorkspaceFolderInfo } from '../../languageServer/initOptions';

const noOverride = () => '';

describe('buildInitializationOptions', () => {
    it('defaults to <root>/llg.toml when the override is unset', () => {
        const folder = path.resolve('/ws/project-a');
        const options = buildInitializationOptions([{ uri: folder, name: 'project-a' }], noOverride);
        expect(options).toEqual({
            llg: {
                protocolVersion: 1,
                configFiles: [
                    {
                        workspaceUri: pathToFileURL(folder).href,
                        path: path.join(folder, 'llg.toml'),
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
        const beta = path.resolve('/ws/beta');
        const alpha = path.resolve('/ws/alpha');
        const folders: WorkspaceFolderInfo[] = [
            { uri: beta, name: 'beta' },
            { uri: alpha, name: 'alpha' },
        ];
        const overrides: Record<string, string> = {
            [beta]: 'other.toml',
            [alpha]: '',
        };
        const options = buildInitializationOptions(folders, (folderUri) => overrides[folderUri] ?? '');
        expect(options.llg.protocolVersion).toBe(1);
        expect(options.llg.configFiles.map((entry) => entry.workspaceUri)).toEqual([
            pathToFileURL(beta).href,
            pathToFileURL(alpha).href,
        ]);
        expect(options.llg.configFiles.map((entry) => entry.path)).toEqual([
            path.resolve(beta, 'other.toml'),
            path.resolve(alpha, 'llg.toml'),
        ]);
    });

    it('handles an empty folder list', () => {
        expect(buildInitializationOptions([], noOverride)).toEqual({
            llg: { protocolVersion: 1, configFiles: [] },
        });
    });
});
