// SPDX-License-Identifier: MIT
//
// Pure normalization for the recursive llg module-explorer response. The
// server owns hierarchy construction; this seam only validates the wire data
// and adapts it to the tree/content model used by the VS Code providers.

import type { LlgModuleExplorerSnapshot } from '../languageServer/llgClient';
import {
    MAX_EXPANDED_NODES,
    normalizeContentsDisplayText,
    UNREACHABLE_CYCLE_GROUP_NAME,
} from './moduleHierarchy';
import type {
    ClassifiedChild,
    HierarchyContents,
    HierarchyNode,
    HierarchyRoot,
    ModuleContentSource,
    ModuleRecord,
    SourceRange,
} from './moduleHierarchy';

export interface NormalizedModuleExplorerSnapshot {
    roots: NormalizedHierarchyRoot[];
    records: ModuleRecord[];
    /** True when the response-wide normalization limit omitted wire data. */
    isBudgetTruncated?: boolean;
}

interface NormalizedHierarchyRoot extends HierarchyRoot {
    /** Additive marker for truncation that happened outside a hierarchy node. */
    isBudgetTruncated?: boolean;
}

interface UnknownRecord {
    [key: string]: unknown;
}

export interface SnapshotNormalizationBudget {
    /** Remaining output slots, including one slot reserved for a marker. */
    remaining: number;
    /** Slots reserved for raw roots, or the first fallback root. */
    reservedSlots: number;
    /** One slot reserved for a synthetic unreachable-cycle group. */
    syntheticGroupSlots: number;
    /** One slot is kept available until truncation is known. */
    markerSlots: number;
    truncated: boolean;
    markerEmitted: boolean;
    markerAttached: boolean;
    truncationPending: boolean;
}

/** Response-wide cap for normalized records, contents, hierarchy, and markers. */
export const MAX_SNAPSHOT_NORMALIZATION_ITEMS = MAX_EXPANDED_NODES;
const SNAPSHOT_TRUNCATION_MARKER_SLOTS = 1;

export function availableSnapshotDataSlots(budget: SnapshotNormalizationBudget): number {
    return Math.max(
        0,
        budget.remaining - budget.markerSlots - budget.reservedSlots - budget.syntheticGroupSlots,
    );
}

export function noteSnapshotTruncation(budget: SnapshotNormalizationBudget): boolean {
    budget.truncated = true;
    if (budget.markerEmitted) {
        return false;
    }
    // The marker slot is reserved while there is still room for ordinary data.
    // Keep the guard for defensive callers that may observe a malformed budget.
    if (budget.remaining > 0) {
        budget.remaining -= 1;
    }
    budget.markerSlots = 0;
    budget.markerEmitted = true;
    budget.truncationPending = false;
    return true;
}

export function takeSnapshotDataSlot(budget: SnapshotNormalizationBudget): boolean {
    if (availableSnapshotDataSlots(budget) <= 0) {
        noteSnapshotTruncation(budget);
        return false;
    }
    budget.remaining -= 1;
    return true;
}

function takeSnapshotReservedSlot(budget: SnapshotNormalizationBudget): boolean {
    if (budget.reservedSlots <= 0 || budget.remaining <= budget.markerSlots) {
        noteSnapshotTruncation(budget);
        return false;
    }
    budget.remaining -= 1;
    budget.reservedSlots -= 1;
    return true;
}

export function takeSnapshotRootSlot(budget: SnapshotNormalizationBudget): boolean {
    return budget.reservedSlots > 0
        ? takeSnapshotReservedSlot(budget)
        : takeSnapshotDataSlot(budget);
}

function takeSnapshotSyntheticGroupSlot(budget: SnapshotNormalizationBudget): boolean {
    if (budget.syntheticGroupSlots > 0) {
        if (budget.remaining <= budget.markerSlots) {
            noteSnapshotTruncation(budget);
            return false;
        }
        budget.remaining -= 1;
        budget.syntheticGroupSlots -= 1;
        return true;
    }
    return takeSnapshotDataSlot(budget);
}

function releaseSnapshotSyntheticGroupSlots(budget: SnapshotNormalizationBudget): void {
    budget.syntheticGroupSlots = 0;
}

export function releaseSnapshotReservedSlots(budget: SnapshotNormalizationBudget): void {
    budget.reservedSlots = 0;
}

// Surelog/UHDM exposes the concrete net kind (`wire`, `tri`, `wand`, ...)
// rather than the legacy generic `net` category. Keep all of those qualifiers
// in the display detail so the Module contents view does not silently turn a
// net into an unqualified variable.
const NET_KINDS = new Set([
    'net', 'wire', 'wand', 'wor', 'tri', 'tri0', 'tri1', 'trireg', 'triand',
    'trior', 'uwire', 'supply0', 'supply1',
]);

const NET_QUALIFIER_PATTERN = /^(wire|tri|triand|trior|tri0|tri1|trireg|uwire|wand|wor|supply0|supply1)\b/i;
const PRESERVED_SOURCE_QUALIFIER_PATTERN =
    /\b(?:const|var|ref|buffer|linkage|typedef|wire|tri|triand|trior|tri0|tri1|trireg|uwire|wand|wor|supply0|supply1)\b/i;
const INTEGER_TYPE_KINDS = new Set([
    'int', 'integer', 'longint', 'shortint', 'byte', 'time', 'real', 'shortreal',
]);
const PACKED_TYPE_KINDS = new Set(['logic', 'bit', 'reg', ...NET_KINDS]);
const EXPLICIT_DISPLAY_KEYS = [
    'resolvedDisplayType',
    'resolvedTypeDisplay',
    'displayType',
    'typeDisplay',
    'display',
    'resolvedDisplay',
    'resolvedTypeText',
];
const TYPE_DISPLAY_KEYS = ['resolvedDisplayType', 'resolvedTypeDisplay', 'displayType', 'typeDisplay'];
const LOCATION_KEYS = [
    'location',
    'declarationLocation',
    'definitionLocation',
    'sourceLocation',
    'declaration',
    'definition',
    'source',
];

const UNREACHABLE_CYCLE_GROUP_ID = 'synthetic:unreachable-cycles';

function asRecord(value: unknown): UnknownRecord | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as UnknownRecord
        : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function displayString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value.trim() ? value : undefined;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
    }
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }
    for (const key of ['text', 'display', 'value']) {
        const candidate = record[key];
        if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'bigint') {
            return String(candidate);
        }
    }
    return undefined;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function hasOwn(record: UnknownRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeContentSource(value: unknown): ModuleContentSource | undefined {
    return value === 'elaborated' || value === 'declaration' ? value : undefined;
}

function normalizeRange(value: unknown): SourceRange | undefined {
    const range = asRecord(value);
    if (!range) {
        return undefined;
    }
    // Accept the compact shape emitted by llg as well as the LSP shape. The
    // latter makes this seam tolerant of proxy servers that reuse LSP ranges.
    const start = asRecord(range.start);
    const end = asRecord(range.end);
    if (start && end &&
        typeof start.line === 'number' && typeof start.character === 'number' &&
        typeof end.line === 'number' && typeof end.character === 'number') {
        return {
            startLine: start.line,
            startCharacter: start.character,
            endLine: end.line,
            endCharacter: end.character,
        };
    }
    if (typeof range.startLine === 'number' && typeof range.startCharacter === 'number' &&
        typeof range.endLine === 'number' && typeof range.endCharacter === 'number') {
        return {
            startLine: range.startLine,
            startCharacter: range.startCharacter,
            endLine: range.endLine,
            endCharacter: range.endCharacter,
        };
    }
    return undefined;
}

function numericValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    const record = asRecord(value);
    if (record) {
        return numericValue(record.value ?? record.width ?? record.resolvedWidth);
    }
    return undefined;
}

function rangePart(value: unknown): string | undefined {
    const text = displayString(value);
    return text ? normalizeContentsDisplayText(text) : undefined;
}

function rangeText(value: unknown): string | undefined {
    const text = rangePart(value);
    if (text) {
        return text.startsWith('[') ? text : `[${text}]`;
    }
    const range = asRecord(value);
    if (!range) {
        return undefined;
    }
    const left = rangePart(range.left ?? range.msb ?? range.high ?? range.upper ?? range.startIndex);
    const right = rangePart(range.right ?? range.lsb ?? range.low ?? range.lower ?? range.endIndex);
    return left !== undefined && right !== undefined
        ? `[${left}:${right}]`
        : undefined;
}

function packedRangeFromType(type: UnknownRecord): string | undefined {
    for (const key of ['resolvedRange', 'packedRange', 'packedDimension', 'range']) {
        const range = rangeText(type[key]);
        if (range) {
            return range;
        }
    }
    const dimensions = asArray(type.dimensions);
    if (dimensions.length > 0) {
        let ranges: string | undefined;
        for (const dimension of dimensions) {
            const range = rangeText(dimension);
            if (range !== undefined) {
                ranges = ranges === undefined ? range : `${ranges} ${range}`;
            }
        }
        if (ranges !== undefined) {
            return ranges;
        }
    }
    return undefined;
}

function typeText(value: unknown): string | undefined {
    const type = asRecord(value);
    if (!type) {
        const text = displayString(value);
        return text ? normalizeContentsDisplayText(text) : undefined;
    }
    for (const key of ['resolvedDisplayType', 'resolvedTypeDisplay', 'displayType', 'typeDisplay', 'display', 'text']) {
        const explicit = displayString(type[key]);
        if (explicit) {
            return normalizeContentsDisplayText(explicit);
        }
    }

    const kind = asString(type.kind);
    const normalizedKind = kind?.toLowerCase();
    const typeName = asString(type.typeName);
    const explicitRange = packedRangeFromType(type);
    const width = numericValue(type.width ?? type.resolvedWidth ?? type.packedWidth);
    const widthRange = explicitRange ?? (
        normalizedKind !== undefined && PACKED_TYPE_KINDS.has(normalizedKind) &&
        width !== undefined && width > 1
            ? `[${width - 1}:0]`
            : undefined
    );
    const signed = type.signed === true && normalizedKind !== undefined &&
        !INTEGER_TYPE_KINDS.has(normalizedKind)
        ? 'signed'
        : undefined;
    // `other` is the structured fallback for a user-defined/typedef type.
    // Showing the implementation sentinel (`other`) would hide the useful
    // name from old payloads that provide only typeName.
    let base = normalizedKind === 'other' && typeName
        ? typeName
        : [kind, typeName].filter(Boolean).join(' ');
    if (normalizedKind === 'array' || normalizedKind === 'real_array' || normalizedKind === 'shortreal_array') {
        base = 'array';
    }
    return normalizeContentsDisplayText([base, signed, widthRange].filter(Boolean).join(' ')) || undefined;
}

function hasExplicitTypeDisplay(value: unknown): boolean {
    const type = asRecord(value);
    return type !== undefined && TYPE_DISPLAY_KEYS.some((key) => displayString(type[key]) !== undefined);
}

function explicitDisplayType(child: UnknownRecord): string | undefined {
    for (const key of EXPLICIT_DISPLAY_KEYS) {
        const explicit = displayString(child[key]) ?? typeText(child[key]);
        if (explicit) {
            return normalizeContentsDisplayText(explicit);
        }
    }
    const resolvedType = child.resolvedType;
    if (resolvedType !== undefined && resolvedType !== null &&
        (typeof resolvedType === 'string' || hasExplicitTypeDisplay(resolvedType))) {
        const resolved = typeText(resolvedType);
        if (resolved) {
            return resolved;
        }
    }
    // `type.displayType` is the wire spelling emitted by llg. Do not treat a
    // plain structured `type` as authoritative here: a legacy payload may
    // also carry a type shape alongside detail that still includes the
    // declaration name.
    if (hasExplicitTypeDisplay(child.type)) {
        const display = typeText(child.type);
        if (display) {
            return display;
        }
    }
    return undefined;
}

function structuredType(child: UnknownRecord): { text?: string; value: unknown } {
    const value = child.resolvedType !== undefined && child.resolvedType !== null
        ? child.resolvedType
        : child.type;
    return { value, text: value === undefined || value === null ? undefined : typeText(value) };
}

function hasBracketDimension(text: string): boolean {
    return text.includes('[');
}

function structuredTypeIsTrustworthy(value: unknown, sourceDetail?: string): boolean {
    const type = asRecord(value);
    if (!type) {
        return false;
    }
    if (sourceDetail && PRESERVED_SOURCE_QUALIFIER_PATTERN.test(sourceDetail)) {
        // Structured types do not carry all source-level qualifiers. Keep the
        // source spelling when it contains one of those qualifiers rather than
        // silently reducing `linkage signed bus_t` to a bare implementation
        // kind such as `logic`.
        return false;
    }
    const kind = asString(type.kind)?.toLowerCase();
    if (hasExplicitTypeDisplay(type)) {
        return true;
    }
    if ((!kind || kind === 'other') && sourceDetail) {
        return false;
    }
    if (packedRangeFromType(type) === undefined && sourceDetail !== undefined && hasBracketDimension(sourceDetail)) {
        // A symbolic dimension in legacy detail is the only display evidence in
        // this shape. Do not replace it with a width guessed from a generic
        // structured type; an authoritative concrete display is handled by
        // explicitDisplayType before this fallback.
        return false;
    }
    return true;
}

interface NormalizedLocation {
    uri?: string;
    range?: SourceRange;
}

interface LocationCandidateSpec {
    uriKey: string;
    rangeKeys: readonly string[];
}

// Keep each URI/range authority together. A payload can contain more than one
// of these shapes at once, so the order here is part of the compatibility
// contract rather than an implementation detail.
const LOCATION_CANDIDATE_SPECS: readonly LocationCandidateSpec[] = [
    { uriKey: 'declarationUri', rangeKeys: ['declarationRange'] },
    { uriKey: 'definitionUri', rangeKeys: ['definitionRange'] },
    { uriKey: 'sourceUri', rangeKeys: ['sourceRange'] },
    { uriKey: 'targetUri', rangeKeys: ['targetRange', 'targetSelectionRange'] },
    { uriKey: 'uri', rangeKeys: ['range'] },
];

function normalizeInstanceLocation(
    raw: UnknownRecord,
    definition?: Pick<ModuleRecord, 'uri' | 'range'>,
): NormalizedLocation {
    const uri = asString(raw.uri);
    const range = normalizeRange(raw.range);
    if (uri !== undefined || range !== undefined) {
        // A raw instance location is a complete navigation authority. Do not
        // fill a missing half from the module definition: that would pair an
        // instantiation URI with a definition range from another file.
        return {
            ...(uri !== undefined ? { uri } : {}),
            ...(range !== undefined ? { range } : {}),
        };
    }
    return {
        ...(definition?.uri ? { uri: definition.uri } : {}),
        ...(definition?.range ? { range: definition.range } : {}),
    };
}

function normalizeTruncationFlags(
    raw: UnknownRecord,
): Pick<HierarchyNode, 'isCycleTruncated' | 'isBudgetTruncated'> {
    // These are independent server facts. In particular, an old payload that
    // only has the budget marker must not be silently reclassified as a cycle.
    return {
        ...(raw.isCycleTruncated === true ? { isCycleTruncated: true } : {}),
        ...(raw.isBudgetTruncated === true ? { isBudgetTruncated: true } : {}),
    };
}

function makeLocationCandidate(uriValue: unknown, rangeValue: unknown): NormalizedLocation | undefined {
    const uri = asString(uriValue);
    const range = normalizeRange(rangeValue);
    if (uri === undefined && range === undefined) {
        return undefined;
    }
    return {
        ...(uri !== undefined ? { uri } : {}),
        ...(range !== undefined ? { range } : {}),
    };
}

function appendDirectLocationCandidates(
    record: UnknownRecord,
    candidates: NormalizedLocation[],
): void {
    for (const spec of LOCATION_CANDIDATE_SPECS) {
        let range: SourceRange | undefined;
        for (const key of spec.rangeKeys) {
            range = normalizeRange(record[key]);
            if (range !== undefined) {
                break;
            }
        }
        // A compact nested location may put startLine/endLine directly beside
        // its URI instead of under `range`; those fields are still one atomic
        // candidate. Do not use this fallback for another URI authority.
        if (range === undefined && spec.uriKey === 'uri') {
            range = normalizeRange(record);
        }
        const candidate = makeLocationCandidate(record[spec.uriKey], range);
        if (candidate !== undefined) {
            candidates.push(candidate);
        }
    }
}

function collectLocationCandidates(
    record: UnknownRecord,
    candidates: NormalizedLocation[],
    seen: Set<UnknownRecord>,
): void {
    if (seen.has(record)) {
        return;
    }
    const stack: Array<{ record: UnknownRecord; nextKeyIndex: number }> = [{ record, nextKeyIndex: 0 }];
    seen.add(record);
    appendDirectLocationCandidates(record, candidates);

    // This is the same depth-first traversal as the former recursive helper,
    // but a malformed location chain cannot exhaust the JavaScript call stack.
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.nextKeyIndex >= LOCATION_KEYS.length) {
            seen.delete(frame.record);
            stack.pop();
            continue;
        }
        const key = LOCATION_KEYS[frame.nextKeyIndex];
        frame.nextKeyIndex += 1;
        const nestedValue = frame.record[key];
        if (typeof nestedValue === 'string') {
            // `declaration`/`source` can also be source text. Only accept a
            // string candidate when it looks like a URI/path.
            if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/.test(nestedValue.trim())) {
                const candidate = makeLocationCandidate(nestedValue, undefined);
                if (candidate !== undefined) {
                    candidates.push(candidate);
                }
            }
            continue;
        }
        const nested = asRecord(nestedValue);
        if (!nested || seen.has(nested)) {
            continue;
        }
        seen.add(nested);
        appendDirectLocationCandidates(nested, candidates);
        stack.push({ record: nested, nextKeyIndex: 0 });
    }
}

function normalizeChildLocation(child: UnknownRecord): NormalizedLocation {
    const candidates: NormalizedLocation[] = [];
    collectLocationCandidates(child, candidates, new Set<UnknownRecord>());

    // A complete location is more useful and safer than a partial candidate,
    // even when the partial candidate has a higher named-field priority. If no
    // complete pair exists, preserve a URI-only candidate so the file can
    // still be opened; a range-only candidate is the last safe fallback.
    return candidates.find((candidate) => candidate.uri !== undefined && candidate.range !== undefined) ??
        candidates.find((candidate) => candidate.uri !== undefined) ??
        candidates.find((candidate) => candidate.range !== undefined) ??
        {};
}

function normalizeContentChild(
    value: unknown,
    budget: SnapshotNormalizationBudget,
    detailPrefix?: string,
    preferResolved = false,
): ClassifiedChild | undefined {
    const child = asRecord(value);
    const name = asString(child?.name);
    if (!name || !child) {
        return undefined;
    }
    if (!takeSnapshotDataSlot(budget)) {
        return undefined;
    }
    const sourceDetail = asString(child.detail);
    const explicit = explicitDisplayType(child);
    const structured = structuredType(child);
    const useStructured = structured.text !== undefined &&
        (preferResolved ? structuredTypeIsTrustworthy(structured.value, sourceDetail) : sourceDetail === undefined);
    const selected = explicit ?? (useStructured ? structured.text : sourceDetail ?? structured.text);
    const detail = selected ? normalizeContentsDisplayText(selected) : undefined;
    const resolvedDisplayType = explicit ?? (useStructured ? structured.text : undefined);
    return {
        name,
        ...(detailPrefix || detail ? { detail: [detailPrefix, detail].filter(Boolean).join(' ') } : {}),
        ...(resolvedDisplayType ? { resolvedDisplayType } : {}),
        ...normalizeChildLocation(child),
    };
}

function validPortDirection(value: unknown): string | undefined {
    const direction = asString(value)?.toLowerCase();
    return direction === 'input' || direction === 'in'
        ? 'input'
        : direction === 'output' || direction === 'out'
            ? 'output'
            : direction === 'inout' || direction === 'bidirectional'
                ? 'inout'
                : undefined;
}

function normalizePorts(
    value: unknown,
    budget: SnapshotNormalizationBudget,
    preferResolved = false,
): ClassifiedChild[] {
    const ports: ClassifiedChild[] = [];
    const rawPorts = asArray(value);
    for (let index = 0; index < rawPorts.length; index += 1) {
        if (availableSnapshotDataSlots(budget) <= 0) {
            noteSnapshotTruncation(budget);
            break;
        }
        const port = rawPorts[index];
        const raw = asRecord(port);
        const direction = validPortDirection(raw?.direction);
        const child = normalizeContentChild(port, budget, undefined, preferResolved);
        if (!child || !direction) {
            if (child) {
                ports.push(child);
            }
            continue;
        }
        const detail = child.detail?.trim() ?? '';
        ports.push({
            ...child,
            detail: /^(input|output|inout)\b/i.test(detail)
                ? child.detail
                : [direction, child.detail].filter(Boolean).join(' '),
        });
    }
    return ports;
}

function normalizeSignals(
    value: unknown,
    budget: SnapshotNormalizationBudget,
    portNames: ReadonlySet<string> = new Set(),
    preferResolved = false,
): ClassifiedChild[] {
    const names = new Set<string>();
    const signals: ClassifiedChild[] = [];
    const rawSignals = asArray(value);
    for (let index = 0; index < rawSignals.length; index += 1) {
        if (availableSnapshotDataSlots(budget) <= 0) {
            noteSnapshotTruncation(budget);
            break;
        }
        const signal = rawSignals[index];
        const raw = asRecord(signal);
        const kind = asString(raw?.kind)?.toLowerCase();
        const name = asString(raw?.name);
        // `net` and `var` are internal model categories, not source-level
        // types. Preserve a useful net qualifier, but let the actual type
        // (`logic`, `bit`, `int`, ...) stand on its own for variables. Apply
        // the qualifier even when a proxy server supplied textual detail.
        if (!name || portNames.has(name) || names.has(name)) {
            continue;
        }
        const child = normalizeContentChild(signal, budget, undefined, preferResolved);
        if (!child) {
            continue;
        }
        names.add(child.name);
        const detail = child.detail?.trim();
        const isNet = kind !== undefined && NET_KINDS.has(kind);
        const netQualifier = kind === undefined || kind === 'net' ? 'wire' : kind;
        const netDetail = isNet && detail &&
            !NET_QUALIFIER_PATTERN.test(detail)
            ? `${netQualifier} ${detail}`
            : detail ?? (isNet ? netQualifier : undefined);
        const resolvedDetail = child.resolvedDisplayType?.trim();
        const resolvedNetDetail = isNet && resolvedDetail && !NET_QUALIFIER_PATTERN.test(resolvedDetail)
            ? `${netQualifier} ${resolvedDetail}`
            : resolvedDetail ?? (isNet ? netQualifier : undefined);
        signals.push({
            ...child,
            ...(netDetail ? { detail: netDetail } : {}),
            ...(resolvedNetDetail ? { resolvedDisplayType: resolvedNetDetail } : {}),
        });
    }
    return signals;
}

function normalizeParameters(
    value: unknown,
    budget: SnapshotNormalizationBudget,
    preferResolved = false,
): ClassifiedChild[] {
    const params: ClassifiedChild[] = [];
    const rawParams = asArray(value);
    for (let index = 0; index < rawParams.length; index += 1) {
        if (availableSnapshotDataSlots(budget) <= 0) {
            noteSnapshotTruncation(budget);
            break;
        }
        const parameter = rawParams[index];
        const raw = asRecord(parameter);
        if (!raw) {
            continue;
        }
        const existingDetail = asString(raw?.detail);
        const prefix = raw?.local === true ? 'localparam' : 'parameter';
        const valueText = displayString(raw.value ?? raw.resolvedValue);
        const child = normalizeContentChild(parameter, budget, undefined, preferResolved);
        if (!child) {
            continue;
        }
        const structured = structuredType(raw);
        const explicit = explicitDisplayType(raw);
        const resolvedType = explicit ?? (preferResolved ? child.resolvedDisplayType : undefined);
        const normalizedExisting = existingDetail
            ? normalizeContentsDisplayText(existingDetail)
            : undefined;
        const baseDetail = normalizedExisting
            ? resolvedType
                ? /^(parameter|localparam)\b/i.test(resolvedType)
                    ? resolvedType
                    : `${prefix} ${resolvedType}`
                : /^(parameter|localparam)\b/i.test(normalizedExisting)
                    ? normalizedExisting
                    : `${prefix} ${normalizedExisting}`
            : [prefix, resolvedType ?? structured.text].filter(Boolean).join(' ');
        const resolvedBase = baseDetail || prefix;
        const resolvedDisplayType = valueText && !resolvedBase.includes('=')
            ? `${resolvedBase} = ${normalizeContentsDisplayText(valueText)}`
            : resolvedBase;
        const detail = !existingDetail && valueText
            ? resolvedDisplayType
            : resolvedBase;
        if (existingDetail) {
            params.push({
                ...child,
                detail,
                ...(valueText ? { value: valueText } : {}),
                ...(resolvedType ? { resolvedDisplayType } : {}),
            });
            continue;
        }
        params.push({
            ...child,
            ...(detail ? { detail } : {}),
            ...(valueText ? { value: valueText } : {}),
        });
    }
    return params;
}

/**
 * Preserve the distinction between a new server's authoritative empty group
 * and an older server that omitted the group entirely.  The contents provider
 * uses that distinction to fall back to `modules` only when necessary.
 */
function normalizeContents(
    raw: UnknownRecord,
    budget: SnapshotNormalizationBudget,
): HierarchyContents {
    const contentSource = normalizeContentSource(raw.contentSource);
    const preferResolved = contentSource === 'elaborated';
    const rawPorts = hasOwn(raw, 'ports') && Array.isArray(raw.ports)
        ? normalizePorts(raw.ports, budget, preferResolved)
        : undefined;
    const rawParams = hasOwn(raw, 'params') && Array.isArray(raw.params)
        ? normalizeParameters(raw.params, budget, preferResolved)
        : undefined;
    let rawSignalPorts: Set<string> | undefined;
    if (rawPorts !== undefined) {
        rawSignalPorts = new Set<string>();
        for (const port of rawPorts) {
            rawSignalPorts.add(port.name);
        }
    }
    const rawSignals = hasOwn(raw, 'signals') && Array.isArray(raw.signals)
        ? normalizeSignals(raw.signals, budget, rawSignalPorts, preferResolved)
        : undefined;
    const isAmbiguousDefinition = raw.isAmbiguousDefinition === true ||
        raw.isAmbiguous === true ||
        raw.ambiguousDefinition === true;
    return {
        ...(rawPorts !== undefined ? { ports: rawPorts } : {}),
        ...(rawParams !== undefined ? { params: rawParams } : {}),
        ...(rawSignals !== undefined ? { signals: rawSignals } : {}),
        ...(contentSource ? { contentSource } : {}),
        ...(isAmbiguousDefinition ? { isAmbiguousDefinition: true } : {}),
    };
}

type SnapshotTaskKind = 'node' | 'scope';

interface SnapshotNormalizationTask {
    kind: SnapshotTaskKind;
    value: unknown;
    parent?: HierarchyNode;
    useReservedSlot?: boolean;
}

function normalizeNodeSelf(
    raw: UnknownRecord,
    modulesById: Map<string, ModuleRecord>,
    budget: SnapshotNormalizationBudget,
): HierarchyNode | undefined {
    const instanceName = asString(raw.instanceName) ?? asString(raw.name) ??
        (raw.isCycleRoot === true ? asString(raw.moduleType) : undefined);
    // A server may include an unresolved synthetic group just as the legacy
    // client model does. It deliberately has no instance name.
    const isUnresolvedGroup = raw.isUnresolvedGroup === true;
    if (!instanceName && !isUnresolvedGroup) {
        return undefined;
    }
    const moduleType = asString(raw.moduleType) ?? asString(raw.type);
    const definitionId = asString(raw.definitionId);
    const definition = definitionId ? modulesById.get(definitionId) : undefined;
    return {
        ...(asString(raw.id) ? { id: asString(raw.id) } : {}),
        ...(instanceName ? { instanceName } : {}),
        ...(moduleType ? { moduleType } : {}),
        ...(definitionId ? { definitionId } : {}),
        ...normalizeInstanceLocation(raw, definition),
        ...(isUnresolvedGroup ? { isUnresolvedGroup: true } : {}),
        ...normalizeContents(raw, budget),
        ...normalizeTruncationFlags(raw),
        children: [],
    };
}

function normalizeScopeSelf(
    raw: UnknownRecord,
    budget: SnapshotNormalizationBudget,
): HierarchyNode | undefined {
    const name = asString(raw.name);
    if (!name) {
        return undefined;
    }
    return {
        instanceName: name,
        isGenerateScope: true,
        ...(asString(raw.id) ? { id: asString(raw.id) } : {}),
        ...normalizeContents(raw, budget),
        children: [],
    };
}

function hasRawDescendants(raw: UnknownRecord, kind: SnapshotTaskKind): boolean {
    return kind === 'node'
        ? asArray(raw.children).length > 0 || asArray(raw.generatedScopes).length > 0
        : asArray(raw.children).length > 0 || asArray(raw.nestedScopes).length > 0;
}

function hasNormalizableTreeIdentity(raw: UnknownRecord, kind: SnapshotTaskKind): boolean {
    if (kind === 'scope') {
        return asString(raw.name) !== undefined;
    }
    return asString(raw.instanceName) !== undefined ||
        asString(raw.name) !== undefined ||
        (raw.isCycleRoot === true && asString(raw.moduleType) !== undefined) ||
        raw.isUnresolvedGroup === true;
}

/**
 * Push children in reverse so the LIFO work stack visits them in wire order.
 * Direct instance children intentionally precede generated scopes, and direct
 * scope children precede nested scopes, matching the server/client contract.
 */
function enqueueSnapshotChildren(
    stack: SnapshotNormalizationTask[],
    raw: UnknownRecord,
    parent: HierarchyNode,
    kind: SnapshotTaskKind,
    budget: SnapshotNormalizationBudget,
): boolean {
    const nestedKey = kind === 'node' ? 'generatedScopes' : 'nestedScopes';
    const nestedKind: SnapshotTaskKind = 'scope';
    const nested = asArray(raw[nestedKey]);
    const children = asArray(raw.children);
    const total = children.length + nested.length;
    const limit = Math.min(total, availableSnapshotDataSlots(budget));
    for (let position = limit - 1; position >= 0; position -= 1) {
        if (position < children.length) {
            stack.push({ kind: 'node', value: children[position], parent });
        } else {
            stack.push({ kind: nestedKind, value: nested[position - children.length], parent });
        }
    }
    return limit < total;
}

function normalizeTree(
    value: unknown,
    modulesById: Map<string, ModuleRecord>,
    kind: SnapshotTaskKind,
    budget: SnapshotNormalizationBudget,
    useReservedRootSlot: boolean,
): HierarchyNode | undefined {
    let root: HierarchyNode | undefined;
    let lastNormalizedNode: HierarchyNode | undefined;
    const stack: SnapshotNormalizationTask[] = [{ kind, value, useReservedSlot: useReservedRootSlot }];

    // Parent nodes are attached before their descendants are processed. This
    // avoids a second recursive assembly pass while retaining exact child
    // order and makes a malformed/cyclic in-memory object graph bounded by the
    // same budget as a large wire response.
    while (stack.length > 0) {
        const task = stack.pop()!;
        if (budget.remaining <= 0) {
            continue;
        }
        const raw = asRecord(task.value);
        if (!raw || !hasNormalizableTreeIdentity(raw, task.kind)) {
            continue;
        }
        const tookSlot = task.useReservedSlot === true
            ? takeSnapshotRootSlot(budget)
            : takeSnapshotDataSlot(budget);
        if (!tookSlot) {
            continue;
        }
        const markerEmittedBeforeNode = budget.markerEmitted;
        const normalized = task.kind === 'node'
            ? normalizeNodeSelf(raw, modulesById, budget)
            : normalizeScopeSelf(raw, budget);
        if (!normalized) {
            continue;
        }

        let markerAttached = false;
        const omittedChildren = availableSnapshotDataSlots(budget) > 0
            ? enqueueSnapshotChildren(stack, raw, normalized, task.kind, budget)
            : hasRawDescendants(raw, task.kind);
        if (omittedChildren) {
            // Keep the marker on the last accepted descendant when possible,
            // rather than on the parent that merely noticed a large sibling
            // list. The output order remains the same as the wire order.
            budget.truncated = true;
            budget.truncationPending = true;
        }
        if (!omittedChildren &&
            (availableSnapshotDataSlots(budget) <= 0 &&
                (hasRawDescendants(raw, task.kind) || stack.length > 0 || budget.truncationPending))) {
            markerAttached = noteSnapshotTruncation(budget);
        }
        if (markerAttached) {
            // Keep the final accepted node visible and make the client-side
            // safety cut explicit. A server-provided truncation flag is left
            // intact and may coexist with this marker.
            normalized.isBudgetTruncated = true;
            budget.markerAttached = true;
        }
        if (!markerAttached && !markerEmittedBeforeNode && budget.markerEmitted &&
            !budget.markerAttached) {
            // Content normalization can exhaust the budget before the node's
            // children are considered. Attach that marker to this node.
            normalized.isBudgetTruncated = true;
            budget.markerAttached = true;
        }
        if (task.parent) {
            task.parent.children.push(normalized);
        } else {
            root = normalized;
        }
        lastNormalizedNode = normalized;
    }
    if (budget.truncationPending && !budget.markerEmitted) {
        const markerAttached = noteSnapshotTruncation(budget);
        if (markerAttached && lastNormalizedNode !== undefined) {
            lastNormalizedNode.isBudgetTruncated = true;
            budget.markerAttached = true;
        }
    }
    return root;
}

export function createSnapshotNormalizationBudget(
    reservedSlots = 0,
    syntheticGroupSlots = 0,
): SnapshotNormalizationBudget {
    const markerSlots = Math.min(SNAPSHOT_TRUNCATION_MARKER_SLOTS, MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    const maxReservedSlots = Math.max(0, MAX_SNAPSHOT_NORMALIZATION_ITEMS - markerSlots);
    const availableReservedSlots = Math.max(0, maxReservedSlots - reservedSlots);
    return {
        remaining: MAX_SNAPSHOT_NORMALIZATION_ITEMS,
        reservedSlots: Math.min(Math.max(0, reservedSlots), maxReservedSlots),
        syntheticGroupSlots: Math.min(Math.max(0, syntheticGroupSlots), availableReservedSlots),
        markerSlots,
        truncated: false,
        markerEmitted: false,
        markerAttached: false,
        truncationPending: false,
    };
}

function normalizeNode(
    value: unknown,
    modulesById: Map<string, ModuleRecord>,
    budget: SnapshotNormalizationBudget,
): HierarchyNode | undefined {
    return normalizeTree(value, modulesById, 'node', budget, true);
}

function normalizeRoot(
    value: unknown,
    modulesById: Map<string, ModuleRecord>,
    budget: SnapshotNormalizationBudget,
): NormalizedHierarchyRoot | undefined {
    const raw = asRecord(value);
    if (!raw) {
        return undefined;
    }
    const node = normalizeNode(raw, modulesById, budget);
    if (!node) {
        return undefined;
    }
    const definitionId = asString(raw.definitionId);
    const definition = definitionId ? modulesById.get(definitionId) : undefined;
    return {
        ...(asString(raw.id) ? { id: asString(raw.id) } : {}),
        name: definition?.name ?? node.instanceName ?? node.moduleType ?? 'top',
        ...(definitionId ? { definitionId } : {}),
        ...normalizeInstanceLocation(raw, definition),
        ...(node.ports !== undefined ? { ports: node.ports } : {}),
        ...(node.params !== undefined ? { params: node.params } : {}),
        ...(node.signals !== undefined ? { signals: node.signals } : {}),
        ...(node.contentSource ? { contentSource: node.contentSource } : {}),
        ...(node.isAmbiguousDefinition ? { isAmbiguousDefinition: true } : {}),
        ...(node.isBudgetTruncated ? { isBudgetTruncated: true } : {}),
        children: node.children,
    };
}

interface OrderedCycleRepresentative {
    node: HierarchyNode;
    rootIndex: number;
    childIndex: number;
}

function isSyntheticCycleGroupRoot(raw: UnknownRecord): boolean {
    if (raw.isSyntheticGroup === true || asString(raw.id) === UNREACHABLE_CYCLE_GROUP_ID) {
        return true;
    }
    // Accept the legacy symbol-path shape even if a proxy dropped the marker,
    // without treating a real module with the same display name as synthetic.
    return asString(raw.name) === UNREACHABLE_CYCLE_GROUP_NAME &&
        asString(raw.instanceName) === undefined &&
        asString(raw.moduleType) === undefined;
}

function normalizeCycleRoot(
    value: unknown,
    modulesById: Map<string, ModuleRecord>,
    budget: SnapshotNormalizationBudget,
): HierarchyNode | undefined {
    const raw = asRecord(value);
    if (!raw) {
        return undefined;
    }
    // Rust normally sends instanceName for these representatives. The
    // module type is still a safe display/identity fallback for the compact
    // shape used by older proxies and regression fixtures.
    return normalizeNode(raw, modulesById, budget);
}

function normalizeSyntheticCycleGroup(
    value: unknown,
    modulesById: Map<string, ModuleRecord>,
    budget: SnapshotNormalizationBudget,
): NormalizedHierarchyRoot | undefined {
    const node = normalizeNode(value, modulesById, budget);
    if (!node) {
        return undefined;
    }
    return {
        id: UNREACHABLE_CYCLE_GROUP_ID,
        name: UNREACHABLE_CYCLE_GROUP_NAME,
        isSyntheticGroup: true,
        ...(node.isBudgetTruncated ? { isBudgetTruncated: true } : {}),
        children: node.children,
    };
}

function compareCycleRepresentatives(
    left: OrderedCycleRepresentative,
    right: OrderedCycleRepresentative,
): number {
    if (left.node.id !== undefined && right.node.id !== undefined) {
        if (left.node.id < right.node.id) {
            return -1;
        }
        if (left.node.id > right.node.id) {
            return 1;
        }
    } else if (left.node.id !== undefined) {
        return -1;
    } else if (right.node.id !== undefined) {
        return 1;
    }

    if (left.node.moduleType !== undefined && right.node.moduleType !== undefined) {
        if (left.node.moduleType < right.node.moduleType) {
            return -1;
        }
        if (left.node.moduleType > right.node.moduleType) {
            return 1;
        }
    }
    if (left.node.instanceName !== undefined && right.node.instanceName !== undefined) {
        if (left.node.instanceName < right.node.instanceName) {
            return -1;
        }
        if (left.node.instanceName > right.node.instanceName) {
            return 1;
        }
    }
    return left.rootIndex - right.rootIndex || left.childIndex - right.childIndex;
}

function normalizeModule(
    value: unknown,
    budget: SnapshotNormalizationBudget,
): ModuleRecord | undefined {
    const raw = asRecord(value);
    if (!raw) {
        return undefined;
    }
    const name = asString(raw.name);
    if (!name) {
        return undefined;
    }
    if (!takeSnapshotDataSlot(budget)) {
        return undefined;
    }
    const range = normalizeRange(raw.range);
    // Module URIs are optional in the protocol (e.g. a parse fallback can
    // lack a source identity), but the existing contents model uses a string.
    // Keep the record selectable by its stable id while leaving its location
    // empty for the tree provider to display safely.
    return {
        ...(asString(raw.id) ? { id: asString(raw.id) } : {}),
        name,
        uri: asString(raw.uri) ?? '',
        ...(range ? { range } : {}),
        ...normalizeContents(raw, budget),
        instances: [],
    };
}

function recordsFromRoots(
    roots: readonly HierarchyRoot[],
    budget: SnapshotNormalizationBudget,
): ModuleRecord[] {
    const records: ModuleRecord[] = [];
    const seen = new Set<string>();
    const stack: Array<{ node: HierarchyRoot | HierarchyNode; isRoot: boolean }> = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) {
        stack.push({ node: roots[index], isRoot: true });
    }
    while (stack.length > 0) {
        const entry = stack.pop()!;
        const { node, isRoot } = entry;
        const name = isRoot ? (node as HierarchyRoot).name : (node as HierarchyNode).moduleType;
        const uri = node.uri;
        if (name && uri && !seen.has(`${name}|${uri}`)) {
            seen.add(`${name}|${uri}`);
            if (!takeSnapshotDataSlot(budget)) {
                break;
            }
            records.push({
                name,
                uri,
                ...(node.definitionId ? { id: node.definitionId } : {}),
                ...(node.range ? { range: node.range } : {}),
                ...(node.ports !== undefined ? { ports: node.ports } : {}),
                ...(node.params !== undefined ? { params: node.params } : {}),
                ...(node.signals !== undefined ? { signals: node.signals } : {}),
                ...(node.contentSource ? { contentSource: node.contentSource } : {}),
                ...(node.isAmbiguousDefinition ? { isAmbiguousDefinition: true } : {}),
                instances: [],
            });
        }
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push({ node: node.children[index], isRoot: false });
        }
    }
    return records;
}

function fallbackRootFromModule(
    module: ModuleRecord,
    budget: SnapshotNormalizationBudget,
): NormalizedHierarchyRoot | undefined {
    const tookSlot = takeSnapshotRootSlot(budget);
    if (!tookSlot) {
        return undefined;
    }
    const copiedContents = copyLegacyContents(module, budget);
    return {
        name: module.name,
        ...(module.id ? { definitionId: module.id } : {}),
        ...(module.uri ? { uri: module.uri } : {}),
        ...(module.range ? { range: module.range } : {}),
        ...copiedContents.contents,
        contentSource: module.contentSource ?? 'declaration',
        ...(module.isAmbiguousDefinition ? { isAmbiguousDefinition: true } : {}),
        ...(copiedContents.truncated ? { isBudgetTruncated: true } : {}),
        children: [],
    };
}

type BudgetMarkedHierarchyEntry = { isBudgetTruncated?: boolean };
type LegacyHierarchyEntry = HierarchyRoot | HierarchyNode;

interface BoundedLegacyChildren {
    children: ClassifiedChild[];
    truncated: boolean;
}

function copyBoundedLegacyChildren(
    children: readonly ClassifiedChild[],
    budget: SnapshotNormalizationBudget,
): BoundedLegacyChildren {
    const bounded: ClassifiedChild[] = [];
    for (let index = 0; index < children.length; index += 1) {
        if (!takeSnapshotDataSlot(budget)) {
            return { children: bounded, truncated: true };
        }
        bounded.push(children[index]);
    }
    return { children: bounded, truncated: false };
}

function copyLegacyContents(
    source: HierarchyContents,
    budget: SnapshotNormalizationBudget,
): { contents: HierarchyContents; truncated: boolean } {
    const contents: HierarchyContents = {};
    let truncated = false;
    if (source.ports !== undefined) {
        const bounded = copyBoundedLegacyChildren(source.ports, budget);
        if (!bounded.truncated || bounded.children.length > 0) {
            contents.ports = bounded.children;
        }
        truncated = truncated || bounded.truncated;
    }
    if (source.params !== undefined) {
        const bounded = copyBoundedLegacyChildren(source.params, budget);
        if (!bounded.truncated || bounded.children.length > 0) {
            contents.params = bounded.children;
        }
        truncated = truncated || bounded.truncated;
    }
    if (source.signals !== undefined) {
        const bounded = copyBoundedLegacyChildren(source.signals, budget);
        if (!bounded.truncated || bounded.children.length > 0) {
            contents.signals = bounded.children;
        }
        truncated = truncated || bounded.truncated;
    }
    return { contents, truncated };
}

function copyLegacyHierarchyEntry(
    source: LegacyHierarchyEntry,
    budget: SnapshotNormalizationBudget,
): { entry: LegacyHierarchyEntry; truncated: boolean } {
    const copiedContents = copyLegacyContents(source, budget);
    const target = { ...source, children: [] } as LegacyHierarchyEntry;
    if (source.ports !== undefined) {
        if (copiedContents.contents.ports !== undefined) {
            target.ports = copiedContents.contents.ports;
        } else {
            delete target.ports;
        }
    }
    if (source.params !== undefined) {
        if (copiedContents.contents.params !== undefined) {
            target.params = copiedContents.contents.params;
        } else {
            delete target.params;
        }
    }
    if (source.signals !== undefined) {
        if (copiedContents.contents.signals !== undefined) {
            target.signals = copiedContents.contents.signals;
        } else {
            delete target.signals;
        }
    }
    return {
        entry: target,
        truncated: copiedContents.truncated,
    };
}

function hasBudgetMarker(value: LegacyHierarchyEntry): boolean {
    return (value as BudgetMarkedHierarchyEntry).isBudgetTruncated === true;
}

function attachLegacyBudgetMarker(
    budget: SnapshotNormalizationBudget,
    target: LegacyHierarchyEntry,
): void {
    if (!budget.markerEmitted) {
        noteSnapshotTruncation(budget);
    }
    (target as BudgetMarkedHierarchyEntry).isBudgetTruncated = true;
    budget.markerAttached = true;
}

interface LegacyHierarchyFrame {
    source: LegacyHierarchyEntry;
    parent?: LegacyHierarchyEntry;
    target?: LegacyHierarchyEntry;
    isRoot: boolean;
    entered: boolean;
    nextChildIndex: number;
}

/**
 * Applies the snapshot response budget to hierarchy data already produced by
 * the legacy moduleHierarchy builder. The builder has its own expansion cap,
 * but that cap is intentionally independent; this second, iterative pass is
 * what makes records, fallback contents, roots, and expanded nodes share one
 * response-wide client limit without changing the builder's hierarchy rules.
 */
export function boundLegacyHierarchy(
    roots: readonly HierarchyRoot[],
    budget: SnapshotNormalizationBudget,
): HierarchyRoot[] {
    const boundedRoots: HierarchyRoot[] = [];
    const stack: LegacyHierarchyFrame[] = [];
    let nextRootIndex = 0;
    let lastTarget: LegacyHierarchyEntry | undefined;

    while (nextRootIndex < roots.length || stack.length > 0) {
        if (stack.length === 0) {
            stack.push({
                source: roots[nextRootIndex],
                isRoot: true,
                entered: false,
                nextChildIndex: 0,
            });
            nextRootIndex += 1;
        }

        const frame = stack[stack.length - 1];
        if (!frame.entered) {
            frame.entered = true;
            const tookSlot = frame.isRoot
                ? takeSnapshotRootSlot(budget)
                : takeSnapshotDataSlot(budget);
            if (!tookSlot) {
                break;
            }
            const copied = copyLegacyHierarchyEntry(frame.source, budget);
            const target = copied.entry;
            if (hasBudgetMarker(frame.source)) {
                budget.truncated = true;
                if (!budget.markerEmitted) {
                    noteSnapshotTruncation(budget);
                }
                (target as BudgetMarkedHierarchyEntry).isBudgetTruncated = true;
                budget.markerAttached = true;
            }
            if (copied.truncated) {
                attachLegacyBudgetMarker(budget, target);
            } else if (budget.markerEmitted && !budget.markerAttached) {
                // A bounded workspace-symbol index can discover truncation
                // before the first visible hierarchy entry is copied.
                attachLegacyBudgetMarker(budget, target);
            }
            if (frame.parent !== undefined) {
                frame.parent.children.push(target as HierarchyNode);
            } else {
                boundedRoots.push(target as HierarchyRoot);
            }
            frame.target = target;
            lastTarget = target;
            continue;
        }

        const target = frame.target;
        if (target === undefined || frame.nextChildIndex >= frame.source.children.length) {
            stack.pop();
            continue;
        }
        if (availableSnapshotDataSlots(budget) <= 0) {
            attachLegacyBudgetMarker(budget, target);
            stack.pop();
            continue;
        }
        const child = frame.source.children[frame.nextChildIndex];
        frame.nextChildIndex += 1;
        stack.push({
            source: child,
            parent: target,
            isRoot: false,
            entered: false,
            nextChildIndex: 0,
        });
    }

    if (budget.truncated && !budget.markerAttached && lastTarget !== undefined) {
        attachLegacyBudgetMarker(budget, lastTarget);
    }
    return boundedRoots;
}

/**
 * Converts the server response into safe tree data. `undefined` means the
 * response is not a recognized snapshot and lets the caller use symbols.
 */
export function normalizeModuleExplorerSnapshot(
    snapshot: LlgModuleExplorerSnapshot | unknown,
): NormalizedModuleExplorerSnapshot | undefined {
    const raw = asRecord(snapshot);
    if (!raw) {
        return undefined;
    }
    const rawRoots = raw.roots;
    if (!Array.isArray(rawRoots)) {
        return undefined;
    }
    const rawModules = asArray(raw.modules);
    const reservedSlots = rawRoots.length > 0
        ? 1
        : rawModules.length > 0
            ? 1
            : 0;
    const hasRawSyntheticGroup = rawRoots.some((value) => {
        const root = asRecord(value);
        return root !== undefined && isSyntheticCycleGroupRoot(root);
    });
    const hasRawCycleRoot = rawRoots.some((value) => {
        const root = asRecord(value);
        return root !== undefined && root.isCycleRoot === true && !isSyntheticCycleGroupRoot(root);
    });
    const budget = createSnapshotNormalizationBudget(
        reservedSlots,
        hasRawCycleRoot && !hasRawSyntheticGroup ? 1 : 0,
    );
    const modules: ModuleRecord[] = [];
    const modulesById = new Map<string, ModuleRecord>();
    for (let index = 0; index < rawModules.length; index += 1) {
        const rawModule = asRecord(rawModules[index]);
        if (!rawModule || !asString(rawModule.name)) {
            continue;
        }
        if (availableSnapshotDataSlots(budget) <= 0) {
            noteSnapshotTruncation(budget);
            break;
        }
        const normalized = normalizeModule(rawModule, budget);
        if (!normalized) {
            if (budget.truncated) {
                break;
            }
            continue;
        }
        modules.push(normalized);
        if (normalized.id !== undefined) {
            // Preserve the old last-definition-wins behavior for duplicate IDs.
            modulesById.set(normalized.id, normalized);
        }
        if (availableSnapshotDataSlots(budget) <= 0 && budget.truncated) {
            break;
        }
    }

    const roots: NormalizedHierarchyRoot[] = [];
    const cycleRepresentatives: OrderedCycleRepresentative[] = [];
    let hasNormalizedSyntheticGroup = false;
    let syntheticGroupBudgetTruncated = false;
    for (let index = 0; index < rawRoots.length; index += 1) {
        const rawRoot = asRecord(rawRoots[index]);
        if (!rawRoot) {
            continue;
        }

        if (isSyntheticCycleGroupRoot(rawRoot)) {
            const normalized = normalizeSyntheticCycleGroup(rawRoot, modulesById, budget);
            if (normalized) {
                hasNormalizedSyntheticGroup = true;
                syntheticGroupBudgetTruncated = syntheticGroupBudgetTruncated ||
                    normalized.isBudgetTruncated === true;
                normalized.children.forEach((node, childIndex) => {
                    cycleRepresentatives.push({ node, rootIndex: index, childIndex });
                });
            }
        } else if (rawRoot.isCycleRoot === true) {
            const normalized = normalizeCycleRoot(rawRoot, modulesById, budget);
            if (normalized) {
                cycleRepresentatives.push({ node: normalized, rootIndex: index, childIndex: 0 });
            }
        } else {
            const normalized = normalizeRoot(rawRoot, modulesById, budget);
            if (normalized) {
                roots.push(normalized);
            }
        }
        if (budget.remaining <= 0) {
            break;
        }
    }
    // Invalid or excess raw roots do not need to keep slots away from the
    // declaration-record fallback. The normalized output remains bounded.
    releaseSnapshotReservedSlots(budget);

    cycleRepresentatives.sort(compareCycleRepresentatives);
    if (hasNormalizedSyntheticGroup || cycleRepresentatives.length > 0) {
        const children = cycleRepresentatives.map(({ node }) => node);
        if (hasNormalizedSyntheticGroup || takeSnapshotSyntheticGroupSlot(budget)) {
            roots.push({
                id: UNREACHABLE_CYCLE_GROUP_ID,
                name: UNREACHABLE_CYCLE_GROUP_NAME,
                isSyntheticGroup: true,
                ...(syntheticGroupBudgetTruncated ? { isBudgetTruncated: true } : {}),
                children,
            });
        }
    } else {
        // A malformed or fully truncated cycle entry should not permanently
        // consume the slot reserved for a group that was never emitted.
        releaseSnapshotSyntheticGroupSlots(budget);
    }

    // Syntax-fallback analyses can have useful module definitions but no
    // elaborated top instances. Keep those definitions visible as leaf roots
    // instead of presenting an apparently empty explorer.
    const displayRoots: NormalizedHierarchyRoot[] = roots.length > 0 ? roots : [];
    if (displayRoots.length === 0) {
        for (const module of modules) {
            const fallbackRoot = fallbackRootFromModule(module, budget);
            if (!fallbackRoot) {
                break;
            }
            displayRoots.push(fallbackRoot);
        }
    }

    const records = modules.length > 0
        ? modules
        : recordsFromRoots(displayRoots, budget);
    if (budget.truncated && !budget.markerAttached && displayRoots.length > 0) {
        displayRoots[displayRoots.length - 1].isBudgetTruncated = true;
        budget.markerAttached = true;
    }
    return {
        roots: displayRoots,
        records,
        ...(budget.truncated ? { isBudgetTruncated: true } : {}),
    };
}
