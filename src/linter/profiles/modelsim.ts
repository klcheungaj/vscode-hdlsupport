import { LinterProfile } from './types';
export const modelsim: LinterProfile = {
  id: 'modelsim', label: 'ModelSim / Questa', executable: 'vlog', output: 'stdout',
  configuration: { work: { type: 'string', default: 'work', description: 'ModelSim work library.' } },
  defaultArguments: ['-nologo'],
  arguments: context => ['-work', context.get('work', 'work'),
    ...(context.languageId === 'systemverilog' ? ['-sv'] : []),
    ...context.includeDirectories.map(directory => `+incdir+${directory}`)],
  diagnostics: [{ regex: /^\*\*\s+(?<severity>Error|Warning|Note)(?:\s+\(suppressible\))?:\s+\((?<code>[\w-]+)\)\s+(?<file>.+)\((?<line>\d+)\):\s*(?<message>.*)$/ }, { regex: /^\*\*\s+(?<severity>Error|Warning|Note)(?:\s+\(suppressible\))?:\s+(?:\([\w-]+\)\s+)?(?<file>.+)\((?<line>\d+)\):\s*(?:\((?<code>[\w-]+)\)\s*)?(?<message>.*)$/ }],
  severities: { error: 'error', warning: 'warning', note: 'information' },
};
