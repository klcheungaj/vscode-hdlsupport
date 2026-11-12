// SPDX-License-Identifier: MIT
//
// Pure unit tests for the module-hierarchy model. The fixtures mirror the
// REAL document-symbol output of the llg language server (see
// src/test/moduleInstantiation.test.ts for the feature.rs references):
// children arrive with LSP wire kinds - Module (2), Property/port (7),
// Variable/net (13), Constant/param (14) and Object/instance (19).

import { describe, expect, it } from 'vitest';
import {
    ambiguousModuleNames,
    applyInstanceNameFallback,
    buildHierarchy,
    buildModuleQuickPickItems,
    classifyDocumentSymbolChildren,
    cleanDisplayPath,
    contentsEntryDescription,
    normalizeContentsDisplayText,
    extractInstantiatedType,
    HierarchyNode,
    isModuleSymbolKind,
    MAX_EXPANDED_NODES,
    ModuleRecord,
    UNREACHABLE_CYCLE_GROUP_NAME,
} from '../../hierarchy/moduleHierarchy';

function mod(name: string, instances: Array<{ instanceName: string; moduleType?: string }>, uri?: string): ModuleRecord {
    return { name, uri: uri ?? `file:///${name}.sv`, instances };
}

describe('classifyDocumentSymbolChildren', () => {
    it('groups a real llg module body into params, ports, signals and instances', () => {
        // module counter #(parameter int WIDTH = 8)(input logic clk,
        // output logic [WIDTH-1:0] q); logic [7:0] bus; counter u_pipe (...);
        const children = [
            { name: 'WIDTH', kind: 14, detail: 'parameter int WIDTH = 8' },
            { name: 'clk', kind: 7, detail: 'input logic clk' },
            { name: 'q', kind: 7, detail: 'output logic [WIDTH-1:0] q' },
            { name: 'bus', kind: 13, detail: 'logic [7:0] bus' },
            { name: 'u_pipe', kind: 19, detail: 'counter #(.WIDTH(4))' },
        ];

        expect(classifyDocumentSymbolChildren(children)).toEqual({
            params: [{ name: 'WIDTH', detail: 'parameter int WIDTH = 8' }],
            ports: [
                { name: 'clk', detail: 'input logic clk' },
                { name: 'q', detail: 'output logic [WIDTH-1:0] q' },
            ],
            signals: [{ name: 'bus', detail: 'logic [7:0] bus' }],
            instances: [{ instanceName: 'u_pipe', moduleType: 'counter' }],
        });
    });

    it('classifies the new server shape: type-only details and bare-type instance details', () => {
        // llg now renders port/net/var children as `[direction] type`
        // (no trailing name), parameters as `parameter|localparam [type]`,
        // and instances as Object leaves whose detail IS the instantiated
        // module type.
        const classified = classifyDocumentSymbolChildren([
            { name: 'WIDTH', kind: 14, detail: 'parameter int' },
            { name: 'DEPTH', kind: 14, detail: 'localparam int' },
            { name: 'sel', kind: 7, detail: 'input [1:0]' },
            { name: 'q', kind: 7, detail: 'output logic [7:0]' },
            { name: 'enable', kind: 7, detail: 'inout' },
            { name: 'val', kind: 13, detail: 'logic [3:0]' },
            { name: 'line', kind: 13, detail: 'wire' },
            { name: 'u_dut', kind: 19, detail: 'child_mod' },
        ]);
        expect(classified.params).toEqual([
            { name: 'WIDTH', detail: 'parameter int' },
            { name: 'DEPTH', detail: 'localparam int' },
        ]);
        expect(classified.ports).toEqual([
            { name: 'sel', detail: 'input [1:0]' },
            { name: 'q', detail: 'output logic [7:0]' },
            { name: 'enable', detail: 'inout' },
        ]);
        expect(classified.signals).toEqual([
            { name: 'val', detail: 'logic [3:0]' },
            { name: 'line', detail: 'wire' },
        ]);
        expect(classified.instances).toEqual([{ instanceName: 'u_dut', moduleType: 'child_mod' }]);
    });

    it('recognizes parameters by their detail text regardless of kind', () => {
        const classified = classifyDocumentSymbolChildren([
            { name: 'X', kind: 13, detail: 'parameter int X = 1' },
            { name: 'clk', kind: 7, detail: 'localparam int clk = 0' },
            { name: 'Y', kind: 14 },
        ]);
        expect(classified.params.map((p) => p.name)).toEqual(['X', 'clk', 'Y']);
        expect(classified.ports).toEqual([]);
        expect(classified.signals).toEqual([]);
    });

    it('extracts the instantiated type from a "<instance> : <type>" name when detail is missing', () => {
        const classified = classifyDocumentSymbolChildren([{ name: 'u_foo : bar', kind: 19 }]);
        expect(classified.instances).toEqual([{ instanceName: 'u_foo : bar', moduleType: 'bar' }]);
    });

    it('keeps an instance without a determinable type as unresolved', () => {
        const classified = classifyDocumentSymbolChildren([{ name: 'u_alone', kind: 19 }]);
        expect(classified.instances).toEqual([{ instanceName: 'u_alone', moduleType: undefined }]);
    });

    it('retains an instance source location for the legacy hierarchy path', () => {
        const range = { startLine: 12, startCharacter: 4, endLine: 12, endCharacter: 10 };
        const classified = classifyDocumentSymbolChildren([{
            name: 'u_child',
            kind: 19,
            detail: 'child',
            uri: 'file:///workspace/top.sv',
            range,
        }]);

        expect(classified.instances).toEqual([{
            instanceName: 'u_child',
            moduleType: 'child',
            uri: 'file:///workspace/top.sv',
            range,
        }]);
    });

    it('ignores nested definitions, typedefs and unknown kinds', () => {
        const classified = classifyDocumentSymbolChildren([
            { name: 'nested_def', kind: 2 },
            { name: 'my_type', kind: 26, detail: 'typedef enum {A, B} my_type' },
            { name: 'mystery', kind: 999 },
        ]);
        expect(classified).toEqual({ ports: [], params: [], signals: [], instances: [] });
    });

    it('returns empty groups for empty or missing children', () => {
        expect(classifyDocumentSymbolChildren([])).toEqual({ ports: [], params: [], signals: [], instances: [] });
        expect(classifyDocumentSymbolChildren(undefined as never)).toEqual({
            ports: [],
            params: [],
            signals: [],
            instances: [],
        });
    });
});

describe('extractInstantiatedType', () => {
    it('takes the leading identifier of the detail, before parameter overrides', () => {
        expect(extractInstantiatedType('u_counter', 'counter #(.WIDTH(8))')).toBe('counter');
        expect(extractInstantiatedType('u_counter', 'counter')).toBe('counter');
    });

    it('strips a pkg:: scope prefix from the detail', () => {
        expect(extractInstantiatedType('u_add', 'adder_pkg::adder')).toBe('adder');
    });

    it('falls back to the name suffix after the last colon', () => {
        expect(extractInstantiatedType('u_fifo : fifo')).toBe('fifo');
        expect(extractInstantiatedType('wrapper.u_fifo : fifo')).toBe('fifo');
    });

    it('gives up instead of guessing when only a bare identifier name exists', () => {
        expect(extractInstantiatedType('u_counter')).toBeUndefined();
        expect(extractInstantiatedType('u_counter', '')).toBeUndefined();
        expect(extractInstantiatedType('u_counter', '#(.WIDTH(8))')).toBeUndefined();
    });
});

describe('buildHierarchy', () => {
    it('returns multiple tops sorted by name; instantiated modules are not roots', () => {
        const roots = buildHierarchy([
            mod('zeta_top', []),
            mod('helper', []),
            mod('alpha_top', [{ instanceName: 'u_helper', moduleType: 'helper' }]),
        ]);
        expect(roots.map((root) => root.name)).toEqual(['alpha_top', 'zeta_top']);
    });

    it('retains declaration contents on roots and recursively expanded instances', () => {
        const roots = buildHierarchy([
            {
                id: 'module:top',
                name: 'top',
                uri: 'file:///top.sv',
                ports: [{ name: 'clk', detail: 'input logic' }],
                params: [{ name: 'WIDTH', detail: 'parameter int = 8', value: '8' }],
                signals: [{ name: 'state', detail: 'logic [7:0]' }],
                contentSource: 'elaborated',
                instances: [{ instanceName: 'u_child', moduleType: 'child' }],
            },
            {
                id: 'module:child',
                name: 'child',
                uri: 'file:///child.sv',
                ports: [{ name: 'data', detail: 'output logic [7:0]' }],
                params: [{ name: 'DEPTH', detail: 'parameter int = 4', value: '4' }],
                signals: [{ name: 'child_state', detail: 'wire logic [7:0]' }],
                contentSource: 'declaration',
                instances: [],
            },
        ]);

        expect(roots[0]).toMatchObject({
            id: 'module:top',
            ports: [{ name: 'clk', detail: 'input logic' }],
            params: [{ name: 'WIDTH', value: '8' }],
            signals: [{ name: 'state', detail: 'logic [7:0]' }],
            contentSource: 'elaborated',
        });
        expect(roots[0].children[0]).toMatchObject({
            definitionId: 'module:child',
            ports: [{ name: 'data', detail: 'output logic [7:0]' }],
            params: [{ name: 'DEPTH', value: '4' }],
            signals: [{ name: 'child_state', detail: 'wire logic [7:0]' }],
            contentSource: 'declaration',
        });
    });

    it('expands instances recursively with instance name plus instantiated type', () => {
        const roots = buildHierarchy([
            mod('top', [
                { instanceName: 'u_mid_a', moduleType: 'mid_a' },
                { instanceName: 'u_mid_b', moduleType: 'mid_b' },
            ]),
            mod('mid_a', [{ instanceName: 'u_leaf', moduleType: 'leaf' }]),
            mod('mid_b', []),
            mod('leaf', []),
        ]);
        expect(roots).toHaveLength(1);
        expect(roots[0].children).toEqual([
            {
                instanceName: 'u_mid_a',
                moduleType: 'mid_a',
                uri: 'file:///mid_a.sv',
                range: undefined,
                isCycleTruncated: undefined,
                children: [
                    {
                        instanceName: 'u_leaf',
                        moduleType: 'leaf',
                        uri: 'file:///leaf.sv',
                        range: undefined,
                        isCycleTruncated: undefined,
                        children: [],
                    },
                ],
            },
            {
                instanceName: 'u_mid_b',
                moduleType: 'mid_b',
                uri: 'file:///mid_b.sv',
                range: undefined,
                isCycleTruncated: undefined,
                children: [],
            },
        ]);
    });

    it('uses an instance location before the target definition location', () => {
        const definitionRange = { startLine: 1, startCharacter: 0, endLine: 5, endCharacter: 1 };
        const instantiationRange = { startLine: 20, startCharacter: 2, endLine: 20, endCharacter: 8 };
        const roots = buildHierarchy([
            {
                name: 'top',
                uri: 'file:///workspace/top.sv',
                instances: [{
                    instanceName: 'u_child',
                    moduleType: 'child',
                    uri: 'file:///workspace/top.sv',
                    range: instantiationRange,
                }],
            },
            {
                name: 'child',
                uri: 'file:///workspace/child.sv',
                range: definitionRange,
                instances: [],
            },
        ]);

        expect(roots[0].children[0]).toMatchObject({
            uri: 'file:///workspace/top.sv',
            range: instantiationRange,
        });
    });

    it('breaks instantiation cycles deterministically without hanging', () => {
        const roots = buildHierarchy([
            mod('b', [{ instanceName: 'u_a', moduleType: 'a' }]),
            mod('a', [{ instanceName: 'u_b', moduleType: 'b' }]),
        ]);
        // Both modules are instantiated by discovered definitions, so neither
        // is promoted to an ordinary root. The deterministic synthetic group
        // still exposes the cycle and its repeated edge is terminal.
        expect(roots.map((root) => root.name)).toEqual([UNREACHABLE_CYCLE_GROUP_NAME]);
        expect(roots[0]).toMatchObject({
            id: 'synthetic:unreachable-cycles',
            isSyntheticGroup: true,
        });
        expect(roots[0].children.map((node) => node.moduleType)).toEqual(['a']);
        expect(roots[0].children[0].children[0]).toMatchObject({
            instanceName: 'u_b',
            moduleType: 'b',
        });
        expect(roots[0].children[0].children[0].children[0]).toMatchObject({
            instanceName: 'u_a',
            moduleType: 'a',
            isCycleTruncated: true,
            children: [],
        });
        // SCC ordering is independent of the provider's definition order.
        expect(buildHierarchy([
            mod('a', [{ instanceName: 'u_b', moduleType: 'b' }]),
            mod('b', [{ instanceName: 'u_a', moduleType: 'a' }]),
        ])).toEqual(roots);
    });

    it('keeps a self-instantiating module visible in the synthetic cycle group', () => {
        const roots = buildHierarchy([mod('gen_loop', [{ instanceName: 'u_self', moduleType: 'gen_loop' }])]);
        expect(roots.map((root) => root.name)).toEqual([UNREACHABLE_CYCLE_GROUP_NAME]);
        expect(roots[0]).toMatchObject({ isSyntheticGroup: true });
        expect(roots[0].children[0]).toMatchObject({
            instanceName: 'gen_loop',
            moduleType: 'gen_loop',
        });
        expect(roots[0].children[0].children).toEqual([
            expect.objectContaining({
                instanceName: 'u_self',
                moduleType: 'gen_loop',
                isCycleTruncated: true,
                children: [],
            }),
        ]);
    });

    it('keeps a real root separate from an unreachable cycle group', () => {
        const roots = buildHierarchy([
            mod('top', []),
            mod('b', [{ instanceName: 'u_a', moduleType: 'a' }]),
            mod('a', [{ instanceName: 'u_b', moduleType: 'b' }]),
        ]);

        expect(roots.map((root) => root.name)).toEqual(['top', UNREACHABLE_CYCLE_GROUP_NAME]);
        expect(roots.filter((root) => root.name === 'a' || root.name === 'b')).toEqual([]);
        expect(roots[1]).toMatchObject({
            id: 'synthetic:unreachable-cycles',
            isSyntheticGroup: true,
        });
        expect(roots[1].children[0].children[0].children[0]).toMatchObject({
            moduleType: 'a',
            isCycleTruncated: true,
        });
    });

    it('keeps a reachable cycle flagged while retaining a real uninstantiated root', () => {
        const roots = buildHierarchy([
            mod('top', [{ instanceName: 'u_a', moduleType: 'a' }]),
            mod('a', [{ instanceName: 'u_b', moduleType: 'b' }]),
            mod('b', [{ instanceName: 'u_a_again', moduleType: 'a' }]),
        ]);

        expect(roots.map((root) => root.name)).toEqual(['top']);
        expect(roots[0].children[0].children[0].children[0]).toMatchObject({
            instanceName: 'u_a_again',
            moduleType: 'a',
            isCycleTruncated: true,
            children: [],
        });
    });

    it('re-expands shared submodules in diamond instantiations', () => {
        const roots = buildHierarchy([
            mod('top', [
                { instanceName: 'u_left', moduleType: 'left' },
                { instanceName: 'u_right', moduleType: 'right' },
            ]),
            mod('left', [{ instanceName: 'u_shared_l', moduleType: 'shared' }]),
            mod('right', [{ instanceName: 'u_shared_r', moduleType: 'shared' }]),
            mod('shared', []),
        ]);
        expect(roots).toHaveLength(1);
        expect(roots[0].children[0].children[0].moduleType).toBe('shared');
        expect(roots[0].children[1].children[0].moduleType).toBe('shared');
    });

    it('nests hierarchy edges straight from a server-shaped document-symbol payload', () => {
        // top.sv: `child_mod u_dut();` and `sub u_sub();`; child_mod.sv:
        // `cell u_cell();`.  The records are built exactly like the explorer
        // builds them: Object-kind (19) children with the instantiated type
        // as detail.
        const recordOf = (name: string, children: Array<{ name: string; kind: number; detail?: string }>, uri?: string): ModuleRecord => ({
            name,
            uri: uri ?? `file:///${name}.sv`,
            instances: classifyDocumentSymbolChildren(children).instances,
        });
        const roots = buildHierarchy([
            recordOf('top', [
                { name: 'u_dut', kind: 19, detail: 'child_mod' },
                { name: 'u_sub', kind: 19, detail: 'sub' },
            ]),
            recordOf('child_mod', [{ name: 'u_cell', kind: 19, detail: 'cell' }]),
            recordOf('sub', []),
            recordOf('cell', []),
        ]);
        expect(roots.map((root) => root.name)).toEqual(['top']);
        expect(roots[0].children.map((node) => node.moduleType)).toEqual(['child_mod', 'sub']);
        // Expansion resolves recursively down to the leaves.
        expect(roots[0].children[0].children[0]).toMatchObject({
            instanceName: 'u_cell',
            moduleType: 'cell',
            children: [],
        });
    });

    it('buckets unresolved instances under "(unresolved)" without inventing edges', () => {
        const roots = buildHierarchy([
            mod('top', [
                { instanceName: 'u_known', moduleType: 'child' },
                { instanceName: 'u_ghost_type', moduleType: 'ghost_cell' },
                { instanceName: 'u_no_type' },
            ]),
            mod('child', []),
        ]);
        // 'top' instantiates 'child', so only 'top' is a root.
        expect(roots.map((root) => root.name)).toEqual(['top']);
        const topRoot = roots[0];
        expect(topRoot.children).toHaveLength(3);
        // Resolved edge first (declaration order).
        expect(topRoot.children[0]).toMatchObject({ instanceName: 'u_known', moduleType: 'child' });
        // Known type text but no discovered definition: plain leaf, no guessed expansion.
        expect(topRoot.children[1]).toEqual({
            instanceName: 'u_ghost_type',
            moduleType: 'ghost_cell',
            children: [],
        });
        // Type-less instance lands in the synthetic group.
        const group = topRoot.children[2];
        expect(group.isUnresolvedGroup).toBe(true);
        expect(group.instanceName).toBeUndefined();
        expect(group.children).toEqual([{ instanceName: 'u_no_type', children: [] }]);
    });

    it('does not let unresolved instances hide real tops', () => {
        const roots = buildHierarchy([mod('loner', [{ instanceName: 'u_mystery' }])]);
        expect(roots.map((root) => root.name)).toEqual(['loner']);
    });

    it('deduplicates repeated module definitions by keeping the first record', () => {
        const roots = buildHierarchy([
            mod('dup', [{ instanceName: 'u_one' }], 'file:///first.sv'),
            mod('dup', [{ instanceName: 'u_two' }], 'file:///second.sv'),
            mod('user', [{ instanceName: 'u_dup', moduleType: 'dup' }]),
        ]);
        // 'dup' is instantiated by 'user', so only 'user' is a root.
        expect(roots.map((root) => root.name)).toEqual(['user']);
        const dupNode = roots[0].children[0];
        expect(dupNode.moduleType).toBe('dup');
        // The FIRST definition won: its uri and instances, not the second's.
        expect(dupNode.uri).toBe('file:///first.sv');
        expect(dupNode.children).toEqual([
            { isUnresolvedGroup: true, children: [{ instanceName: 'u_one', children: [] }] },
        ]);
    });

    it('tolerates null-ish input', () => {
        expect(buildHierarchy(undefined as never)).toEqual([]);
        expect(buildHierarchy([])).toEqual([]);
    });
});

describe('buildHierarchy expansion budget', () => {
    /** Depth-first collection of every node below the given roots. */
    const flattenNodes = (nodes: HierarchyNode[]): HierarchyNode[] => {
        const result: HierarchyNode[] = [];
        const stack = [...nodes].reverse();
        while (stack.length > 0) {
            const node = stack.pop()!;
            result.push(node);
            for (let index = node.children.length - 1; index >= 0; index -= 1) {
                stack.push(node.children[index]);
            }
        }
        return result;
    };

    function sharedBudget(limit: number) {
        const state = { remaining: limit, truncated: false, markerAttached: false };
        return {
            state,
            takeRootSlot: () => {
                if (state.remaining <= 0) {
                    return false;
                }
                state.remaining -= 1;
                return true;
            },
            takeNodeSlot: () => {
                if (state.remaining <= 0) {
                    return false;
                }
                state.remaining -= 1;
                return true;
            },
            takeContentSlot: () => {
                if (state.remaining <= 0) {
                    return false;
                }
                state.remaining -= 1;
                return true;
            },
            noteTruncation: () => {
                state.truncated = true;
            },
            markTruncationAttached: () => {
                state.markerAttached = true;
            },
        };
    }

    it('applies one shared budget to root contents and deep expansion', () => {
        const wideBudget = sharedBudget(MAX_EXPANDED_NODES);
        const wideRoots = buildHierarchy([{
            name: 'wide',
            uri: 'file:///wide.sv',
            params: Array.from({ length: MAX_EXPANDED_NODES + 100 }, (_, index) => ({
                name: `p${index}`,
            })),
            instances: [],
        }], wideBudget);

        expect(wideRoots).toHaveLength(1);
        expect(wideRoots[0].params).toHaveLength(MAX_EXPANDED_NODES - 1);
        expect(wideRoots[0].isBudgetTruncated).toBe(true);
        expect(wideBudget.state.truncated).toBe(true);
        expect(wideBudget.state.markerAttached).toBe(true);
        expect(1 + (wideRoots[0].params?.length ?? 0))
            .toBeLessThanOrEqual(MAX_EXPANDED_NODES);

        const deepBudget = sharedBudget(MAX_EXPANDED_NODES);
        const modules: ModuleRecord[] = [];
        for (let index = 0; index <= MAX_EXPANDED_NODES + 100; index += 1) {
            modules.push(mod(
                `shared_chain_${index}`,
                index < MAX_EXPANDED_NODES + 100
                    ? [{ instanceName: `u_${index + 1}`, moduleType: `shared_chain_${index + 1}` }]
                    : [],
            ));
        }
        const deepRoots = buildHierarchy(modules, deepBudget);
        const deepNodes = flattenNodes(deepRoots[0].children);
        expect(1 + deepNodes.length).toBeLessThanOrEqual(MAX_EXPANDED_NODES);
        expect(deepRoots[0].isBudgetTruncated).toBe(true);
        expect(deepBudget.state.truncated).toBe(true);
        expect(deepBudget.state.markerAttached).toBe(true);
    });

    it('caps exponential double-instantiation chains with flagged truncated leaves', () => {
        // 14 doubling levels would expand 2^13 internal modules (16382 nodes)
        // without a cap; the budget stops the descent far earlier. Expansion
        // follows declaration order, so the budget is spent deterministically
        // along the depth-first pre-order.
        const LEVELS = 14;
        const modules: ModuleRecord[] = [];
        for (let i = 0; i < LEVELS; i++) {
            modules.push(
                mod(
                    `m${i}`,
                    i < LEVELS - 1
                        ? [
                              { instanceName: `u_a${i}`, moduleType: `m${i + 1}` },
                              { instanceName: `u_b${i}`, moduleType: `m${i + 1}` },
                          ]
                        : [],
                ),
            );
        }

        const roots = buildHierarchy(modules);
        expect(roots).toHaveLength(1);
        const all = flattenNodes(roots[0].children);
        const truncated = all.filter((node) => node.isBudgetTruncated);

        // The blowup is bounded instead of reaching the uncapped 16382 nodes.
        expect(all.length).toBeLessThan(2 * MAX_EXPANDED_NODES);
        expect(truncated.length).toBeGreaterThan(0);
        // Truncated nodes stay visible but never expand further, exactly like
        // cycle truncation.
        for (const node of truncated) {
            expect(node.children).toEqual([]);
            expect(node.moduleType).toBeDefined();
        }
        // Depth-first pre-order: the leftmost spine is expanded first and is
        // therefore intact all the way down to the instance-free leaf module.
        let spine = roots[0].children[0];
        for (let depth = 0; depth < LEVELS - 2; depth++) {
            expect(spine.isBudgetTruncated).toBeUndefined();
            spine = spine.children[0];
        }
        expect(spine.isBudgetTruncated).toBeUndefined();
        expect(spine.moduleType).toBe(`m${LEVELS - 1}`);
        expect(spine.children).toEqual([]);
        // Same input, same tree.
        expect(buildHierarchy(modules)).toEqual(roots);
    });

    it('leaves ordinary hierarchies unflagged by the budget', () => {
        const roots = buildHierarchy([
            mod('top', [
                { instanceName: 'u_left', moduleType: 'left' },
                { instanceName: 'u_right', moduleType: 'right' },
            ]),
            mod('left', [{ instanceName: 'u_shared_l', moduleType: 'shared' }]),
            mod('right', [{ instanceName: 'u_shared_r', moduleType: 'shared' }]),
            mod('shared', []),
        ]);
        const flagged = flattenNodes(roots[0].children).filter((node) => node.isBudgetTruncated);
        expect(flagged).toEqual([]);
    });

    it('walks a 5,100-deep legacy chain without using the JS call stack', () => {
        const DEPTH = 5_100;
        const modules: ModuleRecord[] = [];
        for (let index = 0; index <= DEPTH; index += 1) {
            modules.push(mod(
                `chain_${index}`,
                index < DEPTH
                    ? [{ instanceName: `u_${index + 1}`, moduleType: `chain_${index + 1}` }]
                    : [],
            ));
        }

        let roots: ReturnType<typeof buildHierarchy> = [];
        expect(() => {
            roots = buildHierarchy(modules);
        }).not.toThrow();

        const all = flattenNodes(roots[0].children);
        expect(roots.map((root) => root.name)).toEqual(['chain_0']);
        expect(all.length).toBeLessThanOrEqual(MAX_EXPANDED_NODES);
        expect(all.filter((node) => node.isBudgetTruncated)).toHaveLength(1);
        expect(all.every((node) => node.children.length <= 1)).toBe(true);
    });

    it('shares the response-wide expansion cap across multiple legacy roots', () => {
        const DEPTH = 5_100;
        const modules: ModuleRecord[] = [];
        for (let index = 0; index <= DEPTH; index += 1) {
            modules.push(mod(
                `a_chain_${index}`,
                index < DEPTH
                    ? [{ instanceName: `u_${index + 1}`, moduleType: `a_chain_${index + 1}` }]
                    : [],
            ));
        }
        modules.push(mod('z_top', [{ instanceName: 'u_leaf', moduleType: 'z_leaf' }]));
        modules.push(mod('z_leaf', []));

        const roots = buildHierarchy(modules);
        const all = flattenNodes(roots.flatMap((root) => root.children));

        expect(roots.map((root) => root.name)).toEqual(['a_chain_0', 'z_top']);
        expect(all.length).toBeLessThanOrEqual(MAX_EXPANDED_NODES);
        expect(all.filter((node) => node.isBudgetTruncated)).toHaveLength(1);
    });

    it('keeps unresolved groups and their children within the expansion cap', () => {
        const instances = Array.from(
            { length: MAX_EXPANDED_NODES + 100 },
            (_, index) => ({ instanceName: `u_unresolved_${index}` }),
        );
        const roots = buildHierarchy([mod('top', instances)]);
        const all = flattenNodes(roots[0].children);
        const group = roots[0].children.find((node) => node.isUnresolvedGroup);

        expect(all.length).toBeLessThanOrEqual(MAX_EXPANDED_NODES);
        expect(group).toBeDefined();
        expect(group!.children.length).toBeLessThanOrEqual(MAX_EXPANDED_NODES);
        expect(all.filter((node) => node.isBudgetTruncated)).toHaveLength(1);
        expect(group!.isBudgetTruncated).toBe(true);
    });

    it('keeps diamond duplication correct while the budget caps deep chains', () => {
        // Every level doubles the next, so the same child type legitimately
        // appears under MANY parents; the budget must bound the blowup
        // without breaking the duplication semantics below the cut.
        const LEVELS = 14;
        const modules: ModuleRecord[] = [];
        for (let i = 0; i < LEVELS; i++) {
            modules.push(
                mod(
                    `d${i}`,
                    i < LEVELS - 1
                        ? [
                              { instanceName: `u_l${i}`, moduleType: `d${i + 1}` },
                              { instanceName: `u_r${i}`, moduleType: `d${i + 1}` },
                          ]
                        : [],
                ),
            );
        }
        const roots = buildHierarchy(modules);
        expect(roots).toHaveLength(1);
        const all = flattenNodes(roots[0].children);

        // Bounded instead of the uncapped 2^11 expansions.
        expect(all.length).toBeLessThan(2 * MAX_EXPANDED_NODES);
        const truncated = all.filter((node) => node.isBudgetTruncated);
        expect(truncated.length).toBeGreaterThan(0);
        for (const node of truncated) {
            expect(node.children).toEqual([]);
            expect(node.moduleType).toBeDefined();
        }
        // Diamond duplication semantics hold wherever expansion reached:
        // every visited parent carries BOTH instances with the SAME child
        // type.  Depth-first pre-order spends the budget inside the leftmost
        // subtree first, so the top-level right sibling is already a flagged
        // leaf while the spine below stays fully duplicated.
        let level = roots[0].children;
        expect(level).toHaveLength(2);
        expect(level[0].moduleType).toBe(level[1].moduleType);
        expect(level[1].isBudgetTruncated).toBe(true);
        for (let depth = 1; depth < 5; depth++) {
            level = level[0].children;
            expect(level).toHaveLength(2);
            expect(level[0].moduleType).toBe(level[1].moduleType);
            expect(level.every((node) => !node.isBudgetTruncated)).toBe(true);
        }
    });
});

describe('isModuleSymbolKind', () => {
    it('accepts the vscode SymbolKind.Module numbering (1)', () => {
        expect(isModuleSymbolKind(1)).toBe(true);
    });

    it('accepts the raw LSP wire value for Module (2) defensively', () => {
        expect(isModuleSymbolKind(2)).toBe(true);
    });

    it('rejects non-module kinds from either numbering space', () => {
        expect(isModuleSymbolKind(0)).toBe(false);
        expect(isModuleSymbolKind(3)).toBe(false);
        expect(isModuleSymbolKind(4)).toBe(false);
        expect(isModuleSymbolKind(13)).toBe(false);
        expect(isModuleSymbolKind(14)).toBe(false);
        expect(isModuleSymbolKind(19)).toBe(false);
    });
});

describe('cleanDisplayPath', () => {
    it('strips a leading "./"', () => {
        expect(cleanDisplayPath('./rtl/counter.sv')).toBe('rtl/counter.sv');
    });

    it('leaves ordinary relative paths untouched', () => {
        expect(cleanDisplayPath('rtl/counter.sv')).toBe('rtl/counter.sv');
        // Only a leading dot-slash is noise; ".." escapes are meaningful.
        expect(cleanDisplayPath('../shared/top.v')).toBe('../shared/top.v');
    });
});

describe('buildModuleQuickPickItems', () => {
    const identityPath = (uri: string): string => uri;

    it('labels items with the module name and details them with the display path', () => {
        const items = buildModuleQuickPickItems(
            [
                { name: 'counter', uri: 'file:///w/rtl/counter.sv' },
                { name: 'top', uri: 'file:///w/rtl/top.sv' },
            ],
            identityPath,
        );
        expect(items).toEqual([
            { name: 'counter', uri: 'file:///w/rtl/counter.sv', label: 'counter', detail: 'file:///w/rtl/counter.sv' },
            { name: 'top', uri: 'file:///w/rtl/top.sv', label: 'top', detail: 'file:///w/rtl/top.sv' },
        ]);
    });

    it('sorts by module name, then by path', () => {
        const items = buildModuleQuickPickItems(
            [
                { name: 'top', uri: 'file:///b/top.sv' },
                { name: 'alpha', uri: 'file:///z/alpha.sv' },
                { name: 'alpha', uri: 'file:///a/alpha.sv' },
            ],
            identityPath,
        );
        expect(items.map((item) => `${item.name}@${item.uri}`)).toEqual([
            'alpha@file:///a/alpha.sv',
            'alpha@file:///z/alpha.sv',
            'top@file:///b/top.sv',
        ]);
    });

    it('dedupes exact (name, uri) repeats while keeping distinct files', () => {
        const items = buildModuleQuickPickItems(
            [
                { name: 'dup', uri: 'file:///one.sv' },
                { name: 'dup', uri: 'file:///one.sv' },
                { name: 'dup', uri: 'file:///two.sv' },
            ],
            identityPath,
        );
        expect(items).toHaveLength(2);
        // Same-named definitions in different files repeat the path in
        // description so the duplicates stand out.
        expect(items.every((item) => item.description === item.detail)).toBe(true);
    });

    it('omits description when every module name is unique', () => {
        const items = buildModuleQuickPickItems(
            [
                { name: 'counter', uri: 'file:///counter.sv' },
                { name: 'top', uri: 'file:///top.sv' },
            ],
            identityPath,
        );
        expect(items.map((item) => item.description)).toEqual([undefined, undefined]);
    });

    it('formats paths through the injected formatter (asRelativePath seam)', () => {
        const items = buildModuleQuickPickItems([{ name: 'm', uri: 'file:///root/sub/m.sv' }], (uri) =>
            cleanDisplayPath(uri.replace('file:///root/', './')),
        );
        expect(items[0].detail).toBe('sub/m.sv');
    });

    it('skips malformed entries and tolerates empty input', () => {
        expect(buildModuleQuickPickItems([], identityPath)).toEqual([]);
        expect(
            buildModuleQuickPickItems(
                [undefined as never, { name: '', uri: 'file:///x.sv' }, { name: 'ok', uri: '' }, { name: 'kept', uri: 'file:///k.sv' }],
                identityPath,
            ),
        ).toEqual([
            { name: 'kept', uri: 'file:///k.sv', label: 'kept', detail: 'file:///k.sv' },
        ]);
    });
});

describe('contentsEntryDescription', () => {
    it('removes grouped port directions from type-only descriptions', () => {
        expect(contentsEntryDescription('input [31:0]')).toBe('[31:0]');
        expect(contentsEntryDescription('output logic [7:0]')).toBe('logic [7:0]');
        // Trailing type words are never mistaken for declared names.
        expect(contentsEntryDescription('inout wire')).toBe('wire');
        expect(contentsEntryDescription('input logic')).toBe('logic');
        expect(contentsEntryDescription('logic [7:0]')).toBe('logic [7:0]');
        expect(contentsEntryDescription('wire')).toBe('wire');
        expect(contentsEntryDescription('reg')).toBe('reg');
        expect(contentsEntryDescription('parameter')).toBe('parameter');
        expect(contentsEntryDescription('localparam int')).toBe('localparam int');
    });

    it('defensively strips a trailing declared NAME from legacy details', () => {
        expect(contentsEntryDescription('input logic clk')).toBe('logic');
        expect(contentsEntryDescription('output logic [WIDTH-1:0] q')).toBe('logic [WIDTH-1:0]');
        expect(contentsEntryDescription('logic [3:0] val')).toBe('logic [3:0]');
        expect(contentsEntryDescription('wire w1')).toBe('wire');
        expect(contentsEntryDescription('reg r_flags')).toBe('reg');
    });

    it('collapses whitespace and packed-range spacing while preserving type syntax', () => {
        expect(normalizeContentsDisplayText('  logic   signed  [ 1 : 0 ]   [ 3 : 0 ]  '))
            .toBe('logic signed [1:0] [3:0]');
        expect(contentsEntryDescription(' output   logic [ 1 : 0 ] q ')).toBe('logic [1:0]');
    });

    it('prefers a resolved display and appends a resolved parameter value', () => {
        expect(contentsEntryDescription('input logic [WIDTH - 1 : 0]', {
            resolvedDisplayType: 'input  logic [7 : 0]',
        })).toBe('logic [7:0]');
        expect(contentsEntryDescription('parameter int', { value: '8' })).toBe('parameter int = 8');
    });

    it('never strips the final identifier from an authoritative named type display', () => {
        expect(contentsEntryDescription('input word_t data', {
            resolvedDisplayType: 'input word_t',
        })).toBe('word_t');
        expect(contentsEntryDescription('wire word_t data', {
            resolvedDisplayType: 'wire word_t',
        })).toBe('wire word_t');
        expect(contentsEntryDescription('enum state_t state', {
            resolvedDisplayType: 'enum state_t',
        })).toBe('enum state_t');
    });

    it('uses the legacy child name when deciding whether raw detail has a trailing declaration name', () => {
        expect(contentsEntryDescription('input word_t', { name: 'data' })).toBe('word_t');
        expect(contentsEntryDescription('input word_t data', { name: 'data' })).toBe('word_t');
    });

    it('normalizes nested packed and unpacked dimensions without losing operators', () => {
        expect(normalizeContentsDisplayText(
            'logic [ BASE + IDX - 1 : 0 ] [ 0 : DEPTH - 1 ]',
        )).toBe('logic [BASE+IDX-1:0] [0:DEPTH-1]');
        expect(normalizeContentsDisplayText('logic [A ? B[ 3 : 0 ] : C]')).toBe('logic [A?B[3:0]:C]');
    });

    it('compacts ordinary ranges and operators while collapsing outside whitespace', () => {
        expect(normalizeContentsDisplayText('[ 1 : 0 ]')).toBe('[1:0]');
        expect(normalizeContentsDisplayText('[BASE + IDX - 1:0]')).toBe('[BASE+IDX-1:0]');
        expect(normalizeContentsDisplayText('  enum   state_t   [ A ? B [ 3 : 0 ] : C ]  '))
            .toBe('enum state_t [A?B[3:0]:C]');
    });

    it('preserves required separators for keyword expressions and nested identifiers', () => {
        expect(normalizeContentsDisplayText('[P inside {1, 2}:0]')).toBe('[P inside {1,2}:0]');
        expect(normalizeContentsDisplayText('[P inside {BASE, IDX}:0]')).toBe('[P inside {BASE,IDX}:0]');
        expect(normalizeContentsDisplayText('[ P + +1 : 0 ]')).toBe('[P+ +1:0]');
        expect(normalizeContentsDisplayText('[ P - -1 : 0 ]')).toBe('[P- -1:0]');
        expect(normalizeContentsDisplayText(String.raw`[ \WIDTH : 0 ]`)).toBe(String.raw`[\WIDTH :0]`);
    });

    it('preserves logical, reduction and comment/operator token boundaries', () => {
        expect(normalizeContentsDisplayText('[A & &B:0]')).toBe('[A& &B:0]');
        expect(normalizeContentsDisplayText('[A | |B:0]')).toBe('[A| |B:0]');
        expect(normalizeContentsDisplayText('[A ^ ^B:0]')).toBe('[A^ ^B:0]');
        expect(normalizeContentsDisplayText('[A / /B:0]')).toBe('[A/ /B:0]');
        expect(normalizeContentsDisplayText('[A / *B:0]')).toBe('[A/ *B:0]');
        expect(normalizeContentsDisplayText('[A | - >B:0]')).toBe('[A| - >B:0]');
        expect(normalizeContentsDisplayText('[A : :B:0]')).toBe('[A: :B:0]');
    });

    it('preserves line comments and resumes scanning after their newline', () => {
        const input = 'logic [A // keep B active\n + B : 0]';
        const result = normalizeContentsDisplayText(input);

        expect(result).toBe('logic [A // keep B active\n +B:0]');
        expect(result).toContain('// keep B active\n');
        expect(result).toMatch(/\n \+B:0\]$/);
    });

    it('preserves block comments and ignores brackets inside them', () => {
        const input = 'logic [A /* ] fake [ bracket */ + B : 0]';
        const result = normalizeContentsDisplayText(input);

        expect(result).toBe('logic [A /* ] fake [ bracket */ +B:0]');
        expect(result).toContain('/* ] fake [ bracket */');
        expect(result).toMatch(/\*\/ \+B:0\]$/);
    });

    it('keeps operators distinct when a block comment separates them', () => {
        const input = '[A + /* keep + */ + B : 0]';
        const result = normalizeContentsDisplayText(input);

        expect(result).toBe('[A+ /* keep + */ +B:0]');
        expect(result).toContain('+ /* keep + */ +B');
        expect(result).not.toContain('++');
    });

    it('preserves comments outside dimensions while normalizing the range', () => {
        expect(normalizeContentsDisplayText('logic /* keep */ signed [ 1 : 0 ]'))
            .toBe('logic /* keep */ signed [1:0]');
    });

    it('preserves quoted strings and nested bracket boundaries', () => {
        expect(normalizeContentsDisplayText('[A[ 3 : 0 ] == "text ]  with spaces" : 0]'))
            .toBe('[A[3:0]=="text ]  with spaces":0]');
    });

    it('keeps escaped identifiers terminated before punctuation', () => {
        const slash = String.fromCharCode(92);
        expect(normalizeContentsDisplayText(`[ ${slash}WIDTH : 0 ]`))
            .toBe(`[${slash}WIDTH :0]`);
    });

    it('preserves whitespace and delimiters inside string-like dimension tokens', () => {
        expect(normalizeContentsDisplayText('[MODE == "A  ] B" : 0]')).toBe('[MODE=="A  ] B":0]');
    });

    it('keeps direction stripping compatible with normalized keyword dimensions', () => {
        expect(contentsEntryDescription(' output   logic [ P inside { BASE, IDX } : 0 ] q '))
            .toBe('logic [P inside {BASE,IDX}:0]');
    });

    it('removes a legacy declaration name before an unpacked suffix', () => {
        expect(contentsEntryDescription('logic [7:0] data [ 0 : 3 ]', { name: 'data' }))
            .toBe('logic [7:0] [0:3]');
        expect(contentsEntryDescription('word_t [ 0 : 3 ]', { name: 'data' }))
            .toBe('word_t [0:3]');
    });

    it('removes only redundant directions and preserves source type qualifiers', () => {
        for (const qualifier of ['const', 'var', 'ref', 'buffer', 'linkage']) {
            expect(contentsEntryDescription(`input ${qualifier} logic signal`, { name: 'signal' }))
                .toBe(`${qualifier} logic`);
        }
        expect(contentsEntryDescription('input typedef state_t state', { name: 'state' }))
            .toBe('typedef state_t');
        expect(contentsEntryDescription('input linkage signed bus_t')).toBe('linkage signed bus_t');
    });

    it('keeps keyword-led parameter texts verbatim even when they end in a type word', () => {
        // Legacy value-rich shape: the name sits right after the keyword, not
        // at the tail, so nothing may be stripped.
        expect(contentsEntryDescription('parameter W: int = 8')).toBe('parameter W: int = 8');
        expect(contentsEntryDescription('localparam DEPTH: int')).toBe('localparam DEPTH: int');
    });

    it('degrades gracefully on empty and single-token details', () => {
        expect(contentsEntryDescription(undefined)).toBeUndefined();
        expect(contentsEntryDescription('   ')).toBeUndefined();
        expect(contentsEntryDescription('clk')).toBe('clk');
        expect(contentsEntryDescription('logic [7:0]')).toBe('logic [7:0]');
    });
});

describe('ambiguousModuleNames', () => {
    it('flags names defined in more than one distinct file', () => {
        const modules = [
            mod('dup', [], 'file:///a/dup.sv'),
            mod('dup', [], 'file:///b/dup.sv'),
            mod('uniq', [], 'file:///c/uniq.sv'),
        ];
        expect(ambiguousModuleNames(modules)).toEqual(new Set(['dup']));
    });

    it('treats repeats in the SAME file as unambiguous and skips malformed records', () => {
        const modules = [
            mod('twice', [], 'file:///a/twice.sv'),
            mod('twice', [], 'file:///a/twice.sv'),
            mod('bad', [], ''),
            { name: '', uri: 'file:///x.sv', instances: [] } as unknown as ModuleRecord,
        ];
        expect(ambiguousModuleNames(modules)).toEqual(new Set());
    });

    it('tolerates null-ish input', () => {
        expect(ambiguousModuleNames(undefined as never)).toEqual(new Set());
        expect(ambiguousModuleNames([])).toEqual(new Set());
    });
});

describe('applyInstanceNameFallback', () => {
    it('surfaces container-scope instance names when the server emitted no typed instances', () => {
        expect(applyInstanceNameFallback([], ['u_b', 'u_a'])).toEqual([
            { instanceName: 'u_b' },
            { instanceName: 'u_a' },
        ]);
    });

    it('never overrides server-provided instances or invents types', () => {
        const typed = [{ instanceName: 'u_dut', moduleType: 'child' }];
        expect(applyInstanceNameFallback(typed, ['u_other'])).toEqual(typed);
        expect(applyInstanceNameFallback([], undefined)).toEqual([]);
        expect(applyInstanceNameFallback([], [])).toEqual([]);
    });
});
