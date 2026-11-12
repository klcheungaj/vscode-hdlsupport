// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
    MAX_SNAPSHOT_NORMALIZATION_ITEMS,
    normalizeModuleExplorerSnapshot,
} from '../../hierarchy/moduleExplorerSnapshot';

describe('normalizeModuleExplorerSnapshot', () => {
    it('renders a recursive server snapshot with multiple tops and typed contents', () => {
        const result = normalizeModuleExplorerSnapshot({
            modules: [
                {
                    id: 'module:root:top',
                    name: 'top',
                    uri: 'file:///workspace/top.sv',
                    range: { startLine: 0, startCharacter: 7, endLine: 4, endCharacter: 1 },
                    ports: [{
                        name: 'clk',
                        direction: 'input',
                        type: { kind: 'logic', width: 1, signed: false, typeName: null },
                    }],
                    params: [{
                        name: 'WIDTH',
                        type: { kind: 'int', width: 32, signed: true, typeName: null },
                        value: '8',
                        local: false,
                    }],
                    signals: [{
                        name: 'data',
                        kind: 'var',
                        type: { kind: 'logic', width: 8, signed: false, typeName: null },
                    }, {
                        name: 'bus',
                        kind: 'net',
                        type: { kind: 'logic', width: 32, signed: false, typeName: null },
                    }, {
                        name: 'legacy_bus',
                        kind: 'net',
                        detail: 'logic [7:0] legacy_bus',
                    }, {
                        name: 'concrete_wire',
                        kind: 'wire',
                        type: { kind: 'logic', width: 4, signed: false, typeName: null },
                    }],
                },
                {
                    id: 'module:root:second',
                    name: 'second',
                    uri: 'file:///workspace/second.sv',
                    ports: [],
                    params: [],
                    signals: [],
                },
            ],
            roots: [
                {
                    id: 'instance:root:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    definitionId: 'module:root:top',
                    uri: 'file:///workspace/top.sv',
                    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 3 },
                    contentSource: 'elaborated',
                    ports: [],
                    params: [],
                    signals: [],
                    generatedScopes: [{
                        id: 'generate:root:top.g[0]',
                        name: 'g[0]',
                        params: [],
                        children: [{
                            id: 'instance:root:top.g[0].u_leaf',
                            instanceName: 'u_leaf',
                            moduleType: 'leaf',
                            definitionId: 'module:root:leaf',
                            uri: 'file:///workspace/leaf.sv',
                            contentSource: 'elaborated',
                            ports: [{
                                name: 'data',
                                direction: 'input',
                                type: { kind: 'logic', width: 8 },
                            }],
                            params: [{
                                name: 'WIDTH',
                                type: { kind: 'int', width: 32 },
                                value: '4',
                            }],
                            signals: [{
                                name: 'data',
                                kind: 'net',
                                type: { kind: 'logic', width: 8 },
                            }, {
                                name: 'leaf_state',
                                kind: 'var',
                                type: { kind: 'logic', width: 8 },
                            }],
                            children: [],
                        }],
                        nestedScopes: [{
                            id: 'generate:root:top.g[0].inner',
                            name: 'inner',
                            children: [{
                                id: 'instance:root:top.g[0].inner.u_nested',
                                instanceName: 'u_nested',
                                moduleType: 'nested_leaf',
                                children: [],
                            }],
                        }],
                    }],
                    children: [{
                        id: 'instance:root:top.u_child',
                        instanceName: 'u_child',
                        moduleType: 'child',
                        definitionId: 'module:root:child',
                        uri: 'file:///workspace/child.sv',
                        children: [],
                    }],
                },
                {
                    id: 'instance:root:second',
                    instanceName: 'second',
                    moduleType: 'second',
                    definitionId: 'module:root:second',
                    uri: 'file:///workspace/second.sv',
                    children: [],
                },
            ],
        });

        expect(result?.roots.map((root) => root.name)).toEqual(['top', 'second']);
        expect(result?.roots[0].definitionId).toBe('module:root:top');
        expect(result?.roots[0].children.map((child) => child.instanceName)).toEqual(['u_child', 'g[0]']);
        expect(result?.roots[0].children[1]).toMatchObject({
            isGenerateScope: true,
            id: 'generate:root:top.g[0]',
        });
        expect(result?.roots[0].children[1].children[0]).toMatchObject({
            moduleType: 'leaf',
            definitionId: 'module:root:leaf',
        });
        expect(result?.roots[0].children[1].children[1]).toMatchObject({
            isGenerateScope: true,
            id: 'generate:root:top.g[0].inner',
            children: [{ moduleType: 'nested_leaf' }],
        });
        expect(result?.roots[0].contentSource).toBe('elaborated');
        expect(result?.roots[0].children[1].children[0]).toMatchObject({
            contentSource: 'elaborated',
            ports: [{ name: 'data', detail: 'input logic [7:0]' }],
            params: [{ name: 'WIDTH', detail: 'parameter int = 4', value: '4' }],
            // `data` is also a port; it must not be repeated as a signal.
            signals: [{ name: 'leaf_state', detail: 'logic [7:0]' }],
        });
        expect(result?.records[0]).toMatchObject({
            id: 'module:root:top',
            name: 'top',
            ports: [{ name: 'clk', detail: 'input logic' }],
            params: [{ name: 'WIDTH', detail: 'parameter int = 8', value: '8' }],
            signals: [
                { name: 'data', detail: 'logic [7:0]' },
                { name: 'bus', detail: 'wire logic [31:0]' },
                { name: 'legacy_bus', detail: 'wire logic [7:0] legacy_bus' },
                { name: 'concrete_wire', detail: 'wire logic [3:0]' },
            ],
        });
    });

    it('groups raw cycle roots once without promoting them to ordinary roots', () => {
        const result = normalizeModuleExplorerSnapshot({
            modules: [
                { id: 'module:ordinary', name: 'ordinary', uri: 'file:///workspace/ordinary.sv' },
                { id: 'module:a', name: 'a', uri: 'file:///workspace/a.sv' },
                { id: 'module:b', name: 'b', uri: 'file:///workspace/b.sv' },
            ],
            roots: [
                {
                    id: 'instance:ordinary',
                    instanceName: 'ordinary',
                    moduleType: 'ordinary',
                    definitionId: 'module:ordinary',
                    children: [],
                },
                {
                    id: 'instance:cycle:b',
                    isCycleRoot: true,
                    instanceName: 'b',
                    moduleType: 'b',
                    definitionId: 'module:b',
                    uri: 'file:///workspace/b.sv',
                    children: [{
                        id: 'instance:cycle:b.u_a',
                        instanceName: 'u_a',
                        moduleType: 'a',
                        isCycleTruncated: true,
                        children: [],
                    }],
                },
                {
                    id: 'instance:cycle:a',
                    isCycleRoot: true,
                    // The compact cycle-root shape has no instanceName.
                    moduleType: 'a',
                    definitionId: 'module:a',
                    uri: 'file:///workspace/a.sv',
                    isBudgetTruncated: true,
                    children: [{
                        id: 'instance:cycle:a.u_b',
                        instanceName: 'u_b',
                        moduleType: 'b',
                        isBudgetTruncated: true,
                        children: [],
                    }],
                },
            ],
        });

        expect(result).toBeDefined();
        expect(result!.roots.map((root) => root.name)).toEqual([
            'ordinary',
            '(unreachable cycles)',
        ]);
        expect(result!.roots.filter((root) => root.isSyntheticGroup)).toHaveLength(1);
        expect(result!.roots.some((root) => root.name === 'a')).toBe(false);

        const group = result!.roots[1];
        expect(group).toMatchObject({
            id: 'synthetic:unreachable-cycles',
            name: '(unreachable cycles)',
            isSyntheticGroup: true,
        });
        expect(group).not.toHaveProperty('definitionId');
        expect(group).not.toHaveProperty('uri');
        expect(group).not.toHaveProperty('range');
        expect(group).not.toHaveProperty('ports');
        expect(group).not.toHaveProperty('params');
        expect(group).not.toHaveProperty('signals');
        expect(group).not.toHaveProperty('contentSource');
        expect(group.children.map((child) => child.id)).toEqual([
            'instance:cycle:a',
            'instance:cycle:b',
        ]);
        expect(group.children[0]).toMatchObject({
            instanceName: 'a',
            moduleType: 'a',
            isBudgetTruncated: true,
            children: [{
                instanceName: 'u_b',
                isBudgetTruncated: true,
            }],
        });
        expect(group.children[1]).toMatchObject({
            instanceName: 'b',
            children: [{
                instanceName: 'u_a',
                isCycleTruncated: true,
            }],
        });
    });

    it('does not double-group an existing synthetic cycle root', () => {
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                id: 'synthetic:unreachable-cycles',
                name: '(unreachable cycles)',
                isSyntheticGroup: true,
                children: [{
                    id: 'instance:cycle:a',
                    instanceName: 'a',
                    moduleType: 'a',
                    children: [],
                }],
            }],
        });

        expect(result!.roots).toHaveLength(1);
        expect(result!.roots[0]).toMatchObject({
            id: 'synthetic:unreachable-cycles',
            name: '(unreachable cycles)',
            isSyntheticGroup: true,
            children: [{ id: 'instance:cycle:a', instanceName: 'a' }],
        });
        expect(result!.roots[0].children).toHaveLength(1);
    });

    it('prefers raw instance locations over definition locations and keeps content locations separate', () => {
        const parentUri = 'file:///workspace/top.sv';
        const definitionUri = 'file:///workspace/child.sv';
        const definitionRange = { startLine: 2, startCharacter: 0, endLine: 6, endCharacter: 1 };
        const instantiationRange = { startLine: 18, startCharacter: 4, endLine: 18, endCharacter: 12 };
        const declarationRange = { startLine: 4, startCharacter: 17, endLine: 4, endCharacter: 24 };
        const result = normalizeModuleExplorerSnapshot({
            modules: [{
                id: 'module:child',
                name: 'child',
                uri: definitionUri,
                range: definitionRange,
            }],
            roots: [{
                id: 'instance:top',
                instanceName: 'top',
                moduleType: 'top',
                children: [{
                    id: 'instance:top.u_child',
                    instanceName: 'u_child',
                    moduleType: 'child',
                    definitionId: 'module:child',
                    uri: parentUri,
                    range: instantiationRange,
                    contentSource: 'elaborated',
                    ports: [{
                        name: 'payload',
                        direction: 'output',
                        type: { kind: 'logic', width: 8 },
                        location: { uri: definitionUri, range: declarationRange },
                    }],
                    children: [],
                }, {
                    id: 'instance:top.u_fallback',
                    instanceName: 'u_fallback',
                    moduleType: 'child',
                    definitionId: 'module:child',
                    children: [],
                }],
            }],
        });

        const [rawInstance, fallbackInstance] = result!.roots[0].children;
        expect(rawInstance).toMatchObject({
            uri: parentUri,
            range: instantiationRange,
        });
        expect(fallbackInstance).toMatchObject({
            uri: definitionUri,
            range: definitionRange,
        });
        expect(rawInstance.ports).toEqual([expect.objectContaining({
            name: 'payload',
            uri: definitionUri,
            range: declarationRange,
        })]);
        expect(result!.records[0]).toMatchObject({
            uri: definitionUri,
            range: definitionRange,
        });
    });

    it('normalizes cycle and budget truncation flags independently, including old budget-only payloads', () => {
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                instanceName: 'top',
                moduleType: 'top',
                children: [{
                    instanceName: 'u_cycle',
                    moduleType: 'loop',
                    isCycleTruncated: true,
                    children: [],
                }, {
                    instanceName: 'u_budget',
                    moduleType: 'wide',
                    isBudgetTruncated: true,
                    children: [],
                }, {
                    instanceName: 'u_old',
                    moduleType: 'legacy',
                    isBudgetTruncated: true,
                    children: [],
                }],
            }],
        });

        expect(result!.roots[0].children).toEqual([
            expect.objectContaining({ isCycleTruncated: true }),
            expect.objectContaining({ isBudgetTruncated: true }),
            expect.objectContaining({ isBudgetTruncated: true }),
        ]);
        expect(result!.roots[0].children[0]).not.toHaveProperty('isBudgetTruncated');
        expect(result!.roots[0].children[1]).not.toHaveProperty('isCycleTruncated');
        expect(result!.roots[0].children[2]).not.toHaveProperty('isCycleTruncated');
    });

    it('accepts an empty server snapshot without falling back to symbols', () => {
        expect(normalizeModuleExplorerSnapshot({ modules: [], roots: [] })).toEqual({ roots: [], records: [] });
    });

    it('keeps syntax-fallback module definitions visible when no top instances exist', () => {
        const result = normalizeModuleExplorerSnapshot({
            modules: [{ id: 'module:broken', name: 'broken', uri: 'file:///broken.sv' }],
            roots: [],
        });

        expect(result?.roots).toEqual([{
            name: 'broken',
            definitionId: 'module:broken',
            uri: 'file:///broken.sv',
            contentSource: 'declaration',
            children: [],
        }]);
    });

    it('rejects a response with no roots field so the caller can use symbols', () => {
        expect(normalizeModuleExplorerSnapshot({ modules: [] })).toBeUndefined();
        expect(normalizeModuleExplorerSnapshot(undefined)).toBeUndefined();
    });

    it('keeps declaration-only and ambiguous markers while validating malformed content entries', () => {
        const result = normalizeModuleExplorerSnapshot({
            modules: [{
                id: 'module:decl',
                name: 'decl',
                uri: 'file:///workspace/decl.sv',
                ports: [{ name: 'clk', direction: 'input', detail: 'logic clk' }],
                params: [{ name: 'DEPTH', detail: 'int', value: '4' }],
                signals: [],
            }],
            roots: [{
                id: 'instance:decl',
                instanceName: 'decl',
                moduleType: 'decl',
                definitionId: 'module:decl',
                contentSource: 'declaration',
                // Newer server snapshots use the shorter additive wire name;
                // the normalizer exposes the stable client-side marker.
                isAmbiguous: true,
                ports: [{ name: 'clk', direction: 'input', type: { kind: 'logic', width: 1 } }],
                params: [],
                signals: [{ name: 'clk', kind: 'net', type: { kind: 'logic', width: 1 } },
                    { name: 'state', kind: 'var', type: { kind: 'logic', width: 4 } },
                    null,
                ],
                children: [{
                    id: 'instance:decl:child',
                    instanceName: 'u_child',
                    moduleType: 'child',
                    // An ambiguous child is a leaf to the renderer even if a
                    // proxy server accidentally includes child data.
                    isAmbiguousDefinition: true,
                    children: [{ instanceName: 'u_grandchild', moduleType: 'grandchild', children: [] }],
                }],
            }],
        });

        expect(result?.roots[0]).toMatchObject({
            id: 'instance:decl',
            contentSource: 'declaration',
            isAmbiguousDefinition: true,
            ports: [{ name: 'clk', detail: 'input logic' }],
            signals: [{ name: 'state', detail: 'logic [3:0]' }],
        });
        expect(result?.roots[0].children[0]).toMatchObject({
            id: 'instance:decl:child',
            isAmbiguousDefinition: true,
        });
        expect(result?.records[0].params).toEqual([{
            name: 'DEPTH',
            detail: 'parameter int',
            value: '4',
        }]);
    });

    it('prefers resolved display text, derives elaborated widths, and keeps leaf locations', () => {
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                id: 'instance:resolved:top',
                instanceName: 'top',
                moduleType: 'top',
                contentSource: 'elaborated',
                ports: [{
                    name: 'data',
                    direction: 'output',
                    detail: 'output logic [ WIDTH - 1 : 0 ] data',
                    type: { kind: 'logic', width: 8 },
                    resolvedDisplayType: 'output   logic [ 7 : 0 ]',
                    location: {
                        uri: 'file:///workspace/top.sv',
                        range: { start: { line: 4, character: 8 }, end: { line: 4, character: 12 } },
                    },
                }],
                params: [{
                    name: 'WIDTH',
                    type: { kind: 'int', width: 32 },
                    value: 8,
                    location: {
                        uri: 'file:///workspace/top.sv',
                        range: { startLine: 1, startCharacter: 17, endLine: 1, endCharacter: 22 },
                    },
                }],
                signals: [{
                    name: 'tri_state',
                    kind: 'tri',
                    type: { kind: 'logic', width: 4 },
                }],
                children: [],
            }],
        });

        expect(result?.roots[0].ports).toEqual([expect.objectContaining({
            name: 'data',
            detail: 'output logic [7:0]',
            resolvedDisplayType: 'output logic [7:0]',
            uri: 'file:///workspace/top.sv',
            range: { startLine: 4, startCharacter: 8, endLine: 4, endCharacter: 12 },
        })]);
        expect(result?.roots[0].params).toEqual([expect.objectContaining({
            name: 'WIDTH',
            detail: 'parameter int = 8',
            value: '8',
        })]);
        expect(result?.roots[0].signals).toEqual([expect.objectContaining({
            name: 'tri_state',
            detail: 'tri logic [3:0]',
            resolvedDisplayType: 'tri logic [3:0]',
        })]);
    });

    it('keeps declaration locations atomic when direct authorities are incomplete', () => {
        const declarationUri = 'file:///workspace/declaration.sv';
        const unrelatedSourceRange = { startLine: 21, startCharacter: 2, endLine: 21, endCharacter: 8 };
        const completeUri = 'file:///workspace/complete.sv';
        const completeRange = { startLine: 6, startCharacter: 10, endLine: 6, endCharacter: 14 };
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                instanceName: 'top',
                moduleType: 'top',
                ports: [{
                    name: 'mixed_authority',
                    direction: 'output',
                    declarationUri,
                    sourceRange: unrelatedSourceRange,
                }, {
                    name: 'complete_declaration',
                    direction: 'output',
                    declarationUri: completeUri,
                    declarationRange: completeRange,
                }],
                children: [],
            }],
        });

        const ports = result!.roots[0].ports!;
        expect(ports[0]).toMatchObject({ name: 'mixed_authority', uri: declarationUri });
        expect(ports[0]).not.toHaveProperty('range');
        expect(ports[1]).toMatchObject({
            name: 'complete_declaration',
            uri: completeUri,
            range: completeRange,
        });
    });

    it('keeps named type displays, concrete widths, symbolic fallbacks, and unpacked suffixes', () => {
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                id: 'instance:format:top',
                instanceName: 'top',
                moduleType: 'top',
                contentSource: 'elaborated',
                ports: [{
                    name: 'state',
                    direction: 'input',
                    // Legacy detail includes the declaration name; the
                    // nested displayType is already type-only.
                    detail: 'input enum state_t state',
                    type: { kind: 'enum', typeName: 'state_t', displayType: 'enum   state_t' },
                    location: {
                        uri: 'file:///workspace/types.sv',
                        range: { start: { line: 3, character: 11 }, end: { line: 3, character: 16 } },
                    },
                }, {
                    name: 'data',
                    direction: 'output',
                    detail: 'output logic [ WIDTH - 1 : 0 ] data',
                    type: { kind: 'logic', width: 8, displayType: 'logic [ 7 : 0 ]' },
                }, {
                    name: 'symbolic',
                    direction: 'inout',
                    detail: 'inout logic [WIDTH-1:0] symbolic',
                    type: { kind: 'logic', width: 8 },
                }, {
                    name: 'array_port',
                    direction: 'input',
                    type: { kind: 'logic', displayType: 'logic [7:0] [ 0 : 3 ]' },
                }],
                params: [{
                    name: 'WIDTH',
                    type: { kind: 'int', displayType: 'int' },
                    value: 8,
                }],
                signals: [{
                    name: 'word_signal',
                    kind: 'wire',
                    type: { kind: 'other', typeName: 'word_t', displayType: 'word_t' },
                }],
                children: [],
            }],
        });

        expect(result?.roots[0].ports).toEqual([
            expect.objectContaining({
                name: 'state',
                detail: 'input enum state_t',
                resolvedDisplayType: 'enum state_t',
                uri: 'file:///workspace/types.sv',
                range: { startLine: 3, startCharacter: 11, endLine: 3, endCharacter: 16 },
            }),
            expect.objectContaining({
                name: 'data',
                detail: 'output logic [7:0]',
                resolvedDisplayType: 'logic [7:0]',
            }),
            expect.objectContaining({
                name: 'symbolic',
                detail: 'inout logic [WIDTH-1:0] symbolic',
            }),
            expect.objectContaining({
                name: 'array_port',
                detail: 'input logic [7:0] [0:3]',
                resolvedDisplayType: 'logic [7:0] [0:3]',
            }),
        ]);
        expect(result?.roots[0].signals).toEqual([expect.objectContaining({
            name: 'word_signal',
            detail: 'wire word_t',
            resolvedDisplayType: 'wire word_t',
        })]);
        expect(result?.roots[0].ports?.[2]).not.toHaveProperty('resolvedDisplayType');
        expect(result?.roots[0].params).toEqual([expect.objectContaining({
            name: 'WIDTH',
            detail: 'parameter int = 8',
        })]);
    });

    it('renders old detail-only payloads without requiring type or location fields', () => {
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                instanceName: 'legacy',
                moduleType: 'legacy',
                ports: [{ name: 'clk', direction: 'input', detail: ' input   logic [ 1 : 0 ] clk ' }],
                params: [{ name: 'P', detail: 'parameter int', value: '1' }],
                signals: [{ name: 'state', kind: 'var', detail: ' logic [ 3 : 0 ] state ' }],
                children: [],
            }],
        });

        expect(result?.roots[0]).toMatchObject({
            name: 'legacy',
            ports: [{ name: 'clk', detail: 'input logic [1:0] clk' }],
            params: [{ name: 'P', detail: 'parameter int', value: '1' }],
            signals: [{ name: 'state', detail: 'logic [3:0] state' }],
        });
    });

    it('normalizes a 5,100-deep snapshot iteratively and emits one budget marker', () => {
        const DEPTH = 5_100;
        const root: { instanceName: string; moduleType: string; children: unknown[] } = {
            instanceName: 'root',
            moduleType: 'm0',
            children: [],
        };
        let cursor = root;
        for (let index = 1; index <= DEPTH; index += 1) {
            const child = {
                instanceName: `u_${index}`,
                moduleType: `m${index}`,
                children: [] as unknown[],
            };
            cursor.children.push(child);
            cursor = child;
        }

        let result: ReturnType<typeof normalizeModuleExplorerSnapshot>;
        expect(() => {
            result = normalizeModuleExplorerSnapshot({ roots: [root] });
        }).not.toThrow();

        const nodes = [] as Array<{ children: Array<{ children: unknown[] }>; isBudgetTruncated?: boolean }>;
        const stack = [...(result!.roots[0].children as typeof nodes)];
        while (stack.length > 0) {
            const node = stack.pop()!;
            nodes.push(node);
            for (let index = node.children.length - 1; index >= 0; index -= 1) {
                stack.push(node.children[index] as typeof nodes[number]);
            }
        }

        expect(nodes.length).toBeLessThanOrEqual(5_000);
        expect(nodes.filter((node) => node.isBudgetTruncated)).toHaveLength(1);
        expect(nodes.every((node) => node.children.length <= 1)).toBe(true);
    });

    it('shares the snapshot normalization cap across roots while retaining wire order', () => {
        const firstRoot = {
            instanceName: 'first',
            moduleType: 'first',
            children: Array.from({ length: 5_100 }, (_, index) => ({
                instanceName: `u_${index}`,
                moduleType: 'leaf',
                children: [],
            })),
        };
        const secondRoot = {
            instanceName: 'second',
            moduleType: 'second',
            children: [],
        };

        const result = normalizeModuleExplorerSnapshot({ roots: [firstRoot, secondRoot] });
        expect(result?.roots.map((root) => root.name)).toEqual(['first']);
        const children = result!.roots[0].children;
        expect(children[0].instanceName).toBe('u_0');
        expect(children.at(-1)?.isBudgetTruncated).toBe(true);
        expect(children.filter((child) => child.isBudgetTruncated)).toHaveLength(1);
    });

    it('bounds a large declaration-only catalog and its empty-root fallback globally', () => {
        const moduleCount = 10_000;
        const result = normalizeModuleExplorerSnapshot({
            modules: Array.from({ length: moduleCount }, (_, index) => ({
                id: `module:${index}`,
                name: `module_${index}`,
                uri: `file:///workspace/module_${index}.sv`,
            })),
            roots: [],
        });

        expect(result).toBeDefined();
        expect(result!.records.length).toBeGreaterThan(0);
        expect(result!.roots.length).toBeGreaterThan(0);
        expect(result!.records[0]).toMatchObject({
            id: 'module:0',
            name: 'module_0',
        });
        expect(result!.roots[0]).toMatchObject({
            definitionId: 'module:0',
            name: 'module_0',
        });
        expect(result!.isBudgetTruncated).toBe(true);
        expect(result!.roots.at(-1)).toHaveProperty('isBudgetTruncated', true);
        expect(result!.records.length + result!.roots.length + 1)
            .toBeLessThanOrEqual(MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    });

    it('charges every module content child against the response-wide budget', () => {
        const contentCount = 10_000;
        const result = normalizeModuleExplorerSnapshot({
            modules: [{
                id: 'module:wide',
                name: 'wide',
                uri: 'file:///workspace/wide.sv',
                ports: Array.from({ length: contentCount }, (_, index) => ({
                    name: `port_${index}`,
                    direction: 'input',
                    type: { kind: 'logic', width: 1 },
                })),
                params: Array.from({ length: contentCount }, (_, index) => ({
                    name: `param_${index}`,
                    type: { kind: 'int' },
                })),
                signals: Array.from({ length: contentCount }, (_, index) => ({
                    name: `signal_${index}`,
                    kind: 'var',
                    type: { kind: 'logic', width: 1 },
                })),
            }],
            roots: [],
        });

        const record = result!.records[0];
        const normalizedContentCount = (record.ports?.length ?? 0) +
            (record.params?.length ?? 0) +
            (record.signals?.length ?? 0);
        const fallbackRootContentCount = (result!.roots[0].ports?.length ?? 0) +
            (result!.roots[0].params?.length ?? 0) +
            (result!.roots[0].signals?.length ?? 0);
        expect(normalizedContentCount).toBeGreaterThan(0);
        expect(result!.roots).toHaveLength(1);
        expect(result!.isBudgetTruncated).toBe(true);
        expect(result!.roots[0]).toHaveProperty('isBudgetTruncated', true);
        expect(result!.records.length + normalizedContentCount + result!.roots.length +
            fallbackRootContentCount + 1)
            .toBeLessThanOrEqual(MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    });

    it('bounds a multi-root catalog while retaining the source-order prefix', () => {
        const result = normalizeModuleExplorerSnapshot({
            modules: Array.from({ length: 5 }, (_, index) => ({
                id: `module:top_${index}`,
                name: `top_${index}`,
                uri: `file:///workspace/top_${index}.sv`,
            })),
            roots: Array.from({ length: 10_000 }, (_, index) => ({
                instanceName: `top_${index}`,
                moduleType: `top_${index}`,
                definitionId: `module:top_${index}`,
                uri: `file:///workspace/top_${index}.sv`,
                children: [],
            })),
        });

        expect(result!.roots.length).toBeGreaterThan(1);
        expect(result!.roots.map((root) => root.name).slice(0, 3)).toEqual([
            'top_0', 'top_1', 'top_2',
        ]);
        expect(result!.roots.length).toBeLessThan(10_000);
        expect(result!.isBudgetTruncated).toBe(true);
        expect(result!.roots.at(-1)).toHaveProperty('isBudgetTruncated', true);
        expect(result!.records.length + result!.roots.length + 1)
            .toBeLessThanOrEqual(MAX_SNAPSHOT_NORMALIZATION_ITEMS);
        expect(result!.records.slice(0, 3).map((record) => record.name)).toEqual([
            'top_0', 'top_1', 'top_2',
        ]);
    });

    it('preserves source qualifiers in typed snapshot contents', () => {
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                instanceName: 'top',
                moduleType: 'top',
                contentSource: 'elaborated',
                ports: [
                    { name: 'p_const', direction: 'input', type: { kind: 'logic', displayType: 'const logic' } },
                    { name: 'p_ref', direction: 'input', type: { kind: 'logic', displayType: 'ref logic' } },
                    { name: 'p_buffer', direction: 'input', type: { kind: 'logic', displayType: 'buffer logic' } },
                ],
                signals: [
                    { name: 's_var', kind: 'var', type: { kind: 'logic', displayType: 'var logic' } },
                    { name: 's_linkage', kind: 'var', type: { kind: 'logic', displayType: 'linkage signed bus_t' } },
                    { name: 's_typedef', kind: 'var', type: { kind: 'logic', displayType: 'typedef state_t' } },
                ],
                children: [],
            }],
        });

        expect(result?.roots[0].ports).toEqual([
            expect.objectContaining({ name: 'p_const', detail: 'input const logic', resolvedDisplayType: 'const logic' }),
            expect.objectContaining({ name: 'p_ref', detail: 'input ref logic', resolvedDisplayType: 'ref logic' }),
            expect.objectContaining({ name: 'p_buffer', detail: 'input buffer logic', resolvedDisplayType: 'buffer logic' }),
        ]);
        expect(result?.roots[0].signals).toEqual([
            expect.objectContaining({ name: 's_var', detail: 'var logic', resolvedDisplayType: 'var logic' }),
            expect.objectContaining({ name: 's_linkage', detail: 'linkage signed bus_t', resolvedDisplayType: 'linkage signed bus_t' }),
            expect.objectContaining({ name: 's_typedef', detail: 'typedef state_t', resolvedDisplayType: 'typedef state_t' }),
        ]);
    });

    it('does not let an incomplete structured type erase source qualifiers', () => {
        const result = normalizeModuleExplorerSnapshot({
            roots: [{
                instanceName: 'top',
                moduleType: 'top',
                contentSource: 'elaborated',
                ports: [{
                    name: 'p_linkage',
                    direction: 'input',
                    detail: 'input linkage signed bus_t',
                    resolvedType: { kind: 'logic', width: 1 },
                }],
                signals: [{
                    name: 's_var',
                    kind: 'var',
                    detail: 'var logic',
                    resolvedType: { kind: 'logic', width: 1 },
                }],
                children: [],
            }],
        });

        expect(result?.roots[0].ports).toEqual([expect.objectContaining({
            name: 'p_linkage',
            detail: 'input linkage signed bus_t',
        })]);
        expect(result?.roots[0].signals).toEqual([expect.objectContaining({
            name: 's_var',
            detail: 'var logic',
        })]);
        expect(result?.roots[0].ports?.[0]).not.toHaveProperty('resolvedDisplayType');
        expect(result?.roots[0].signals?.[0]).not.toHaveProperty('resolvedDisplayType');
    });
});
