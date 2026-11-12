// SPDX-License-Identifier: MIT
//
// Thin VS Code wrapper for the tab <-> space conversion commands; the
// conversion rules live in whitespacePure.ts.
import { commands, ExtensionContext, Range, Selection, TextEditor, window } from 'vscode';
import { convertWhitespace, selectedLineSpans, WhitespaceMode } from './whitespacePure';

const COMMANDS: ReadonlyArray<readonly [string, WhitespaceMode]> = [
    ['hdlsupport.convertTabsToSpaces', 'tabsToSpaces'],
    ['hdlsupport.convertSpacesToTabs', 'spacesToTabs'],
];

/** Converts the whole document when nothing is selected, else every line
 *  touched by a selection; one edit, so one undo step. */
async function convert(editor: TextEditor | undefined, mode: WhitespaceMode): Promise<void> {
    if (!editor) {
        return;
    }
    const { document } = editor;
    const tabSize = Number(editor.options.tabSize);
    const wholeDocument = editor.selections.every((selection) => selection.isEmpty);
    const ranges = wholeDocument
        ? [new Range(document.lineAt(0).range.start, document.lineAt(document.lineCount - 1).range.end)]
        : selectedLineSpans(editor.selections).map(({ startLine, endLine }) =>
            new Range(document.lineAt(startLine).range.start, document.lineAt(endLine).range.end));
    const previous = editor.selections;
    const applied = await editor.edit((builder) => ranges.forEach((range) =>
        builder.replace(range, convertWhitespace(mode, document.getText(range), tabSize))));
    if (!applied) {
        return;
    }
    // Whole document: keep the cursors where they were. Selection mode:
    // highlight the converted lines.
    editor.selections = wholeDocument
        ? previous
        : ranges.map((range) => new Selection(range.start, document.lineAt(range.end.line).range.end));
}

export function registerWhitespaceCommands(context: ExtensionContext): void {
    context.subscriptions.push(...COMMANDS.map(([id, mode]) =>
        commands.registerCommand(id, () => convert(window.activeTextEditor, mode))));
}
