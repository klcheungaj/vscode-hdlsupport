// SPDX-License-Identifier: MIT
//
// Small, conservative source helpers for explicit client-side commands. This
// is not a project index or a language provider: it only inspects the text the
// user explicitly asks a command to transform.

export type PortDirection = 'input' | 'output' | 'inout' | 'ref';

export interface ParsedPort {
    name: string;
    direction: PortDirection;
    typeText: string;
}

export interface ParsedParameter {
    name: string;
    declaration: string;
}

export interface ParsedModule {
    name: string;
    ports: ParsedPort[];
    parameters: ParsedParameter[];
    start: number;
    end: number;
}

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_$]*';

/** Replaces comments with spaces while preserving offsets and line breaks. */
export function maskComments(source: string): string {
    let result = '';
    let inBlockComment = false;
    let inLineComment = false;
    let inString = false;
    for (let i = 0; i < source.length; i++) {
        const character = source[i];
        const next = source[i + 1];
        if (inLineComment) {
            if (character === '\n' || character === '\r') {
                inLineComment = false;
                result += character;
            } else {
                result += ' ';
            }
            continue;
        }
        if (inBlockComment) {
            if (character === '*' && next === '/') {
                result += '  ';
                i += 1;
                inBlockComment = false;
            } else {
                result += character === '\n' || character === '\r' ? character : ' ';
            }
            continue;
        }
        if (inString) {
            result += character;
            if (character === '\\' && next !== undefined) {
                result += next;
                i += 1;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '/' && next === '/') {
            result += '  ';
            i += 1;
            inLineComment = true;
        } else if (character === '/' && next === '*') {
            result += '  ';
            i += 1;
            inBlockComment = true;
        } else {
            result += character;
            inString = character === '"';
        }
    }
    return result;
}

export function findMatchingDelimiter(source: string, openIndex: number): number | undefined {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const open = source[openIndex];
    const close = pairs[open];
    if (close === undefined) {
        return undefined;
    }
    let depth = 0;
    let inString = false;
    for (let i = openIndex; i < source.length; i++) {
        const character = source[i];
        if (inString) {
            if (character === '\\') {
                i += 1;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        } else if (character === open) {
            depth += 1;
        } else if (character === close && --depth === 0) {
            return i;
        }
    }
    return undefined;
}

export function splitTopLevel(source: string): string[] {
    const parts: string[] = [];
    let start = 0;
    const stack: string[] = [];
    let inString = false;
    for (let i = 0; i < source.length; i++) {
        const character = source[i];
        if (inString) {
            if (character === '\\') {
                i += 1;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        } else if ('([{'.includes(character)) {
            stack.push(character);
        } else if (')]}'.includes(character)) {
            stack.pop();
        } else if (character === ',' && stack.length === 0) {
            parts.push(source.slice(start, i).trim());
            start = i + 1;
        }
    }
    const tail = source.slice(start).trim();
    if (tail.length > 0) {
        parts.push(tail);
    }
    return parts;
}

function skipWhitespace(source: string, index: number): number {
    while (index < source.length && /\s/.test(source[index])) {
        index += 1;
    }
    return index;
}

function parsePorts(source: string): ParsedPort[] {
    const ports: ParsedPort[] = [];
    let inheritedDirection: PortDirection | undefined;
    let inheritedType = 'logic';
    for (const rawPart of splitTopLevel(maskComments(source))) {
        const part = rawPart.replace(/^\(\*[^]*?\*\)\s*/, '').trim();
        const directionMatch = /^(input|output|inout|ref)\b\s*([^]*)$/i.exec(part);
        let remainder = part;
        if (directionMatch) {
            inheritedDirection = directionMatch[1].toLowerCase() as PortDirection;
            inheritedType = 'logic';
            remainder = directionMatch[2].trim();
        }
        if (inheritedDirection === undefined) {
            continue;
        }
        remainder = remainder.replace(/\s*=\s*[^]*$/, '').trim();
        const nameMatch = new RegExp(`(${IDENTIFIER})\\s*(?:\\[[^\\]]*\\]\\s*)*$`).exec(remainder);
        if (!nameMatch) {
            continue;
        }
        const name = nameMatch[1];
        const explicitType = remainder.slice(0, nameMatch.index).trim();
        if (explicitType.length > 0) {
            inheritedType = explicitType;
        }
        ports.push({ name, direction: inheritedDirection, typeText: inheritedType });
    }
    return ports;
}

function parseNonAnsiPorts(header: string, body: string): ParsedPort[] | undefined {
    const names = splitTopLevel(maskComments(header)).map((part) => part.trim());
    const identifierPattern = new RegExp(`^${IDENTIFIER}$`);
    if (names.some((name) => !identifierPattern.test(name))) {
        return undefined;
    }
    const declarations = new Map<string, ParsedPort>();
    const maskedBody = maskComments(body);
    const declarationPattern = /\b(input|output|inout|ref)\b([^;]*);/gi;
    let match: RegExpExecArray | null;
    while ((match = declarationPattern.exec(maskedBody)) !== null) {
        const ports = parsePorts(`${match[1]} ${body.slice(match.index + match[1].length, declarationPattern.lastIndex - 1)}`);
        for (const port of ports) {
            declarations.set(port.name, port);
        }
    }
    const ports = names.map((name) => declarations.get(name));
    return ports.every((port): port is ParsedPort => port !== undefined) ? ports : undefined;
}

function parseParameters(source: string): ParsedParameter[] {
    const parameters: ParsedParameter[] = [];
    for (const rawPart of splitTopLevel(maskComments(source))) {
        const part = rawPart.replace(/^(?:parameter|localparam)\b\s*/i, '').trim();
        const beforeValue = part.split('=')[0].trim();
        const nameMatch = new RegExp(`(${IDENTIFIER})\\s*$`).exec(beforeValue);
        if (nameMatch) {
            parameters.push({ name: nameMatch[1], declaration: rawPart.trim() });
        }
    }
    return parameters;
}

export function parseModuleDefinitions(source: string): ParsedModule[] {
    const masked = maskComments(source);
    const modules: ParsedModule[] = [];
    const modulePattern = new RegExp(`\\bmodule\\s+(?:(?:automatic|static)\\s+)?(${IDENTIFIER})`, 'g');
    let match: RegExpExecArray | null;
    while ((match = modulePattern.exec(masked)) !== null) {
        let cursor = skipWhitespace(masked, match.index + match[0].length);
        let parameters: ParsedParameter[] = [];
        if (masked[cursor] === '#') {
            cursor = skipWhitespace(masked, cursor + 1);
            if (masked[cursor] === '(') {
                const end = findMatchingDelimiter(masked, cursor);
                if (end === undefined) {
                    continue;
                }
                parameters = parseParameters(source.slice(cursor + 1, end));
                cursor = skipWhitespace(masked, end + 1);
            }
        }
        let portStart: number | undefined;
        let portEnd = cursor;
        if (masked[cursor] === '(') {
            portStart = cursor;
            const matchingPortEnd = findMatchingDelimiter(masked, cursor);
            if (matchingPortEnd === undefined) {
                continue;
            }
            portEnd = matchingPortEnd;
        } else if (masked[cursor] !== ';') {
            continue;
        }
        const endMatch = /\bendmodule\b/g;
        endMatch.lastIndex = portEnd;
        const moduleEnd = endMatch.exec(masked);
        if (!moduleEnd) {
            continue;
        }
        let ports: ParsedPort[] = [];
        if (portStart !== undefined) {
            const header = source.slice(portStart + 1, portEnd);
            const headerParts = splitTopLevel(maskComments(header));
            ports = parsePorts(header);
            if (ports.length !== headerParts.length) {
                const nonAnsiPorts = parseNonAnsiPorts(header, source.slice(portEnd + 1, moduleEnd.index));
                if (!nonAnsiPorts) {
                    continue;
                }
                ports = nonAnsiPorts;
            }
        }
        modules.push({
            name: match[1],
            ports,
            parameters,
            start: match.index,
            end: moduleEnd.index + moduleEnd[0].length,
        });
        modulePattern.lastIndex = portEnd + 1;
    }
    return modules;
}

export function signalDeclaration(port: ParsedPort, signalName = port.name): string {
    const kind = port.direction === 'output' || port.direction === 'inout' ? 'wire' : 'logic';
    const type = port.typeText
        .replace(/\b(?:var|wire|wand|wor|tri|tri0|tri1|uwire|reg|logic)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return `${kind}${type ? ` ${type}` : ''} ${signalName};`;
}
