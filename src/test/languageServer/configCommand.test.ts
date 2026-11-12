import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { canOfferTemplateCreation, CONFIG_TEMPLATE, effectiveConfigPath } from '../../languageServer/configCommand';

describe('effectiveConfigPath', () => {
    it('defaults to the root-local llg.toml when the override is empty', () => {
        expect(effectiveConfigPath('/ws/project-a', '')).toBe(path.join('/ws/project-a', 'llg.toml'));
    });

    it('resolves a relative override from the folder root', () => {
        expect(effectiveConfigPath('/ws/project-a', 'config/custom-llg.toml')).toBe(
            path.resolve('/ws/project-a', 'config/custom-llg.toml'),
        );
    });

    it('passes an absolute override through unchanged', () => {
        expect(effectiveConfigPath('/ws/project-a', '/etc/llg/shared.toml')).toBe('/etc/llg/shared.toml');
    });
});

describe('canOfferTemplateCreation', () => {
    it('offers creation for the root-local default path', () => {
        const folder = '/ws/project-a';
        expect(canOfferTemplateCreation(path.join(folder, 'llg.toml'), folder)).toBe(true);
    });

    it('offers creation for a relative override that resolves onto the root-local default', () => {
        const folder = '/ws/project-a';
        expect(canOfferTemplateCreation(effectiveConfigPath(folder, './llg.toml'), folder)).toBe(true);
    });

    it('never offers creation for overrides resolving elsewhere', () => {
        const folder = '/ws/project-a';
        expect(canOfferTemplateCreation(path.join(folder, 'other.toml'), folder)).toBe(false);
        expect(canOfferTemplateCreation('/etc/llg/shared.toml', folder)).toBe(false);
        expect(canOfferTemplateCreation(path.resolve(folder, '../shared/llg.toml'), folder)).toBe(false);
    });
});

describe('default llg.toml template', () => {
    it('leaves built-in lint rules enabled', () => {
        expect(CONFIG_TEMPLATE).toContain('[lint]\nenabled = true');
        expect(CONFIG_TEMPLATE).not.toMatch(/^\s*enabled\s*=\s*false\s*$/m);
    });
});
