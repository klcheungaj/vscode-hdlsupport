/** Regenerate contributed linter and formatter settings from the profiles their providers use. */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { linterProfiles } from '../src/linter/profiles';
import { formatterProfiles } from '../src/formatter/profiles';

const manifestPath = resolve(__dirname, '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const properties = manifest.contributes.configuration.find((entry: { properties: Record<string, unknown> }) => entry.properties['hdlsupport.verilog.linting.linter']).properties;

interface ToolSettings {
  id: string;
  settings: Record<string, Record<string, unknown>>;
}

/** The setting that picks the tool: one ID or `none`, or a list of IDs when several tools may run together. */
function selectorSchema(tools: ToolSettings[], defaultTool: string, description: string, multiple: boolean): Record<string, unknown> {
  const ids = tools.map(tool => tool.id);
  return multiple
    ? { scope: 'resource', type: 'array', items: { type: 'string', enum: ids }, uniqueItems: true, default: [], description }
    : { scope: 'resource', type: 'string', enum: [...ids, 'none'], default: defaultTool, description };
}

/** Writes the tool selector and every `<section>.<tool>.<key>` setting, dropping ones no profile generates any more. */
function syncSection(section: string, selector: string, schema: Record<string, unknown>, tools: ToolSettings[]): void {
  properties[`${section}.${selector}`] = schema;
  const generated = new Set<string>();
  for (const tool of tools) {
    for (const [key, schema] of Object.entries(tool.settings)) {
      properties[`${section}.${tool.id}.${key}`] = { scope: 'resource', ...schema };
      generated.add(`${section}.${tool.id}.${key}`);
    }
  }
  for (const key of Object.keys(properties)) {
    if (key.startsWith(`${section}.`) && key.split('.').length > 4 && !generated.has(key)) { delete properties[key]; }
  }
}

const pathSetting = (label: string, executable: string): Record<string, unknown> => ({
  type: 'string', default: '', description: `Path to the ${label} executable, or to its directory. Empty uses ${executable} from PATH.`,
});

const linterTools: ToolSettings[] = linterProfiles.map(profile => ({
  id: profile.id,
  settings: {
    path: pathSetting(profile.label, profile.executable),
    arguments: { type: ['string', 'array'], items: { type: 'string' }, default: profile.defaultArguments, description: 'Extra arguments, as an array or a string. A value replaces the defaults shown. Include directories (from llg.toml) and the file are added automatically. No shell expansion.' },
    useWSL: { type: 'boolean', default: false, description: `Run ${profile.label} inside WSL (Windows only).` },
    ...profile.configuration,
  },
}));
syncSection('hdlsupport.verilog.linting', 'linter',
  selectorSchema(linterTools, 'none', 'Linters to run in addition to the language server diagnostics. All selected linters run. Empty runs none.', true), linterTools);
properties['hdlsupport.verilog.linting.runAtFileLocation'] = {
  scope: 'resource', type: 'boolean', default: false, description: "Run linters in the document's directory instead of the workspace folder.",
};

const formatterTools: ToolSettings[] = formatterProfiles.map(profile => ({
  id: profile.id,
  settings: {
    path: pathSetting(profile.label, profile.executable),
    arguments: { type: ['string', 'array'], items: { type: 'string' }, default: profile.defaultArguments, description: 'Extra arguments, as an array or a string. A value replaces the defaults shown. Line-range and stdin flags are added automatically. No shell expansion.' },
    ...profile.configuration,
  },
}));
syncSection('hdlsupport.verilog.formatting', 'formatter',
  selectorSchema(formatterTools, 'verible', 'Formatter for Verilog and SystemVerilog documents. none disables formatting.', false), formatterTools);

const output = JSON.stringify(manifest, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (output !== readFileSync(manifestPath, 'utf8')) { throw new Error('Linter or formatter settings are stale. Run npm run build:profiles.'); }
} else {
  writeFileSync(manifestPath, output);
}
