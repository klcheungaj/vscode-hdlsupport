// SPDX-License-Identifier: MIT
//
// Thin VS Code wrapper for "HDL Support: Align Cursors"; the alignment rule
// lives in alignCursorsPure.ts.

import { commands, ExtensionContext, Position, Selection, TextEditor, window } from 'vscode';
import { computeAlignCursors } from './alignCursorsPure';

export async function alignCursors(editor: TextEditor | undefined = window.activeTextEditor): Promise<void> {
    if (!editor) { return; }
    const { document } = editor;
    const result = computeAlignCursors(
        line => document.lineAt(line).text,
        editor.selections.map(s => ({
            anchor: { line: s.anchor.line, character: s.anchor.character },
            active: { line: s.active.line, character: s.active.character },
        })),
        Number(editor.options.tabSize),
    );
    if (result.edits.length === 0) { return; }

    // One edit call == one undo step.
    const applied = await editor.edit(builder => {
        for (const e of result.edits) {
            builder.insert(new Position(e.line, e.character), e.insertText);
        }
    });
    if (!applied) { return; }
    // Set selections explicitly instead of relying on VS Code's tracking of
    // cursors that sit exactly on an insertion point.
    editor.selections = result.selections.map(s =>
        new Selection(
            new Position(s.anchor.line, s.anchor.character),
            new Position(s.active.line, s.active.character),
        ));
}

export function registerAlignCursors(context: ExtensionContext): void {
    context.subscriptions.push(commands.registerCommand('hdlsupport.alignCursors', () => alignCursors()));
}
