// The module ' contains the VS Code extensibility API
// Import the module and reference it with the alias in your code below
import {
    commands,
    Disposable,
    ExtensionContext,
    FoldingRange,
    FoldingRangeKind,
    FoldingRangeProvider,
    IndentAction,
    languages,
    TextDocument,
    workspace,
    LanguageConfiguration,
    DocumentSelector
} from 'vscode';

import { createSoftbrushClientManager, SOFTBRUSH_LANGUAGES } from './languageServer/softbrushClient';

import LintManager from './linter/LintManager';
import ProfileFormatter, { FORMATTER_LANGUAGES } from './formatter/ProfileFormatter';
import * as ModuleInstantiation from './commands/ModuleInstantiation';
import { registerWhitespaceCommands } from './commands/whitespace';
import { registerAlignCursors } from './commands/alignCursors';
import { createLogger, Logger } from './logger';
import { createLlgClientManager, readLaunchParams, LlgClientManager } from './languageServer/llgClient';
import { launchParamsDiffer, shouldRestartOnConfigChange } from './languageServer/restartPolicy';
import { registerLlgCommands } from './languageServer/commands';
import { registerModuleExplorer, type ModuleExplorerTestAdapter } from './hierarchy/moduleExplorer';
import { computeVerilogFoldingRanges, PureFoldingRange } from './clientFeatures/foldingRanges';
import { InactiveRegionController } from './clientFeatures/inactiveRegions';
import { registerTemplateGenerator } from './clientFeatures/templateGenerator';
import { registerLlgConfigEditing } from './clientFeatures/llgConfigProvider';
import { registerLiteralIncludeLinks, type LiteralIncludeLinksTestAdapter } from './clientFeatures/includeLinks';
import { registerExternalLintActions } from './clientFeatures/externalLintActions';

export var logger: Logger;
let languageConfigurations: Disposable[] = [];
let lintManager: LintManager;
const selector: DocumentSelector = [
    { scheme: 'file', language: 'systemverilog' },
    { scheme: 'file', language: 'verilog' }
];

let softbrushManager: ReturnType<typeof createSoftbrushClientManager> | undefined;
let llgManager: LlgClientManager | undefined;

/** Opt-in host-test surface; normal extension activation still returns void. */
export interface HdlSupportTestApi extends ModuleExplorerTestAdapter {
    moduleExplorer: ModuleExplorerTestAdapter;
    includeLinks: LiteralIncludeLinksTestAdapter;
}

/** Maps a pure folding range onto the vscode API shape, translating the hint. */
function toFoldingRange(range: PureFoldingRange): FoldingRange {
    const foldingRange = new FoldingRange(range.start, range.end);
    if (range.kind === 'comment') {
        foldingRange.kind = FoldingRangeKind.Comment;
    } else if (range.kind === 'region') {
        foldingRange.kind = FoldingRangeKind.Region;
    }
    return foldingRange;
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext): HdlSupportTestApi | undefined {
    updateLanguageConfigurations();
    logger = createLogger('Verilog');
    softbrushManager = createSoftbrushClientManager(context);

    // Configure lint manager
    lintManager = new LintManager(logger.getChild('LintManager'));
    context.subscriptions.push(lintManager);
    // Register command for manual linting
    context.subscriptions.push(commands.registerCommand(
        'verilog.lint',
        lintManager.runLintTool,
        lintManager
    ));

    registerWhitespaceCommands(context);
    registerAlignCursors(context);

    // External formatter, selected by `hdlsupport.verilog.formatting.formatter`.
    const formatter = new ProfileFormatter(logger.getChild('Formatter'));
    const formatterSelector = FORMATTER_LANGUAGES.map(language => ({ scheme: 'file', language }));
    context.subscriptions.push(languages.registerDocumentRangeFormattingEditProvider(formatterSelector, formatter));
    context.subscriptions.push(languages.registerDocumentFormattingEditProvider(formatterSelector, formatter));

    // Client-side structural folding for Verilog/SV. The Lapligence server advertises
    // no foldingRangeProvider (its ServerCapabilities never set one), and
    // FoldingRangeProvider is not among the server-owned features in AGENTS.md,
    // so ranges are computed locally over the document text.
    const hdlFoldingProvider: FoldingRangeProvider = {
        provideFoldingRanges(document: TextDocument): FoldingRange[] {
            return computeVerilogFoldingRanges(document.getText()).map(toFoldingRange);
        },
    };
    context.subscriptions.push(languages.registerFoldingRangeProvider(selector, hdlFoldingProvider));

    registerTemplateGenerator(context);
    registerLlgConfigEditing(context);
    const includeLinksTestAdapter = registerLiteralIncludeLinks(context);
    registerExternalLintActions(context);

    // Create and start the Lapligence language client without blocking activation.
    llgManager = createLlgClientManager(context);
    context.subscriptions.push({ dispose: () => void llgManager?.dispose() });
    let llgRequested = false;
    const startLlg = () => {
        if (llgRequested) { return; }
        llgRequested = true;
        void llgManager?.start().catch((err) => {
            logger.error(`starting the Lapligence language server failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    };
    // Opening a constraint-only project must not require an unrelated HDL server.
    const constraintActivation = workspace.textDocuments.some(document => SOFTBRUSH_LANGUAGES.includes(document.languageId));
    if (!constraintActivation || workspace.textDocuments.some(document => ['verilog', 'systemverilog'].includes(document.languageId))) {
        startLlg();
    } else {
        void workspace.findFiles('**/{llg.toml,*.v,*.sv,*.vh,*.svh}', '**/node_modules/**', 1)
            .then(files => { if (files.length > 0) { startLlg(); } }, error => logger.warn(String(error)));
    }
    context.subscriptions.push(workspace.onDidOpenTextDocument(document => {
        if (['verilog', 'systemverilog'].includes(document.languageId)) { startLlg(); }
    }));

    registerLlgCommands(context, llgManager);

    // Dim conditional-compilation branches the server skips under the
    // effective llg.toml defines. Decoration only - ranges come from the
    // llg/inactiveRanges custom request, nothing is recomputed client-side.
    context.subscriptions.push(new InactiveRegionController(llgManager));

    // Configure command to instantiate a module
    context.subscriptions.push(commands.registerCommand(
        'verilog.instantiateModule',
        ModuleInstantiation.instantiateModuleInteract
    ));

    // Restart the server when its executable, config override or log level changes.
    // TOML content changes are handled by the running server; workspace folder changes are
    // supported natively by the server, so no client-side restart is needed for them.
    context.subscriptions.push(workspace.onDidChangeConfiguration((e) => {
        const affected = ['path', 'configPath', 'logLevel']
            .map((key) => `hdlsupport.llg.${key}`)
            .filter((key) => e.affectsConfiguration(key));
        if (!shouldRestartOnConfigChange(affected)) {
            return;
        }
        // VS Code can report a key as affected even when its effective value is
        // unchanged, so restart only when the settings actually differ from what
        // the running server was launched with.
        const manager = llgManager;
        if (!manager) {
            return;
        }
        // A failed launch keeps the last successful settings snapshot. Even
        // restoring those settings must retry when no server is running.
        if (manager.isRunning() && manager.appliedLaunchParams !== null
            && !launchParamsDiffer(manager.appliedLaunchParams, readLaunchParams(context))) {
            return;
        }
        void manager.restart().catch((err) => {
            logger.error(`restarting the Lapligence language server failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }));

    // HDL Modules explorer: use the server's recursive snapshot when
    // available, with the standard-symbol implementation kept for older
    // external/bundled servers.
    const moduleExplorerTestAdapter = registerModuleExplorer(
        context,
        logger.getChild('ModuleExplorer'),
        llgManager,
    );

    return process.env.HDLSUPPORT_E2E_EXPLORER === '1' && moduleExplorerTestAdapter
        ? {
            ...moduleExplorerTestAdapter,
            moduleExplorer: moduleExplorerTestAdapter,
            includeLinks: includeLinksTestAdapter,
        }
        : undefined;
}

// this method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
    languageConfigurations.forEach(d => d.dispose());
    lintManager?.dispose();
    await Promise.all([llgManager?.stop(), softbrushManager?.stop()]);
}

export function updateLanguageConfigurations(): void {
    languageConfigurations.forEach(d => d.dispose());
    languageConfigurations.push(languages.setLanguageConfiguration('systemverilog', commentRules()));
    languageConfigurations.push(languages.setLanguageConfiguration('verilog', commentRules()));
}

/**
 * Sets up additional language configuration that's impossible to do via a
 * separate language-configuration.json file. See [1] for more information.
 *
 * [1]: https://github.com/Microsoft/issues/11514#issuecomment-244707076
 */
function commentRules(): LanguageConfiguration {
    return {
        onEnterRules: [
        {
            // Begins an auto-closed multi-line comment (standard or parent doc)
            // e.g. /** | */ or /*! | */
            beforeText: /^\s*\/\*(\*|\!)(?!\/)([^\*]|\*(?!\/))*$/,
            afterText: /^\s*\*\/$/,
            action: { indentAction: IndentAction.IndentOutdent, appendText: ' * ' },
        },
        {
            // Begins a multi-line comment (standard or parent doc)
            // e.g. /** ...| or /*! ...|
            beforeText: /^\s*\/\*(\*|\!)(?!\/)([^\*]|\*(?!\/))*$/,
            action: { indentAction: IndentAction.None, appendText: ' * ' },
        },
        {
            // Continues a multi-line comment
            // e.g.  * ...|
            beforeText: /^(\ \ )*\ \*(\ ([^\*]|\*(?!\/))*)?$/,
            action: { indentAction: IndentAction.None, appendText: '* ' },
        },
        {
            // Dedents after closing a multi-line comment
            // e.g.  */|
            beforeText: /^(\ \ )*\ \*\/\s*$/,
            action: { indentAction: IndentAction.None, removeText: 1 },
        },
        ],
    };
}
