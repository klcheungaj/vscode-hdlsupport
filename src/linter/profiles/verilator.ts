import { LANGUAGE_STANDARD, LinterProfile } from './types';
export const verilator: LinterProfile = {
  id: 'verilator', label: 'Verilator', executable: 'verilator', windowsExecutable: 'verilator_bin.exe',
  output: 'stderr',
  defaultArguments: ['--lint-only', `+${LANGUAGE_STANDARD}ext+v`, `+${LANGUAGE_STANDARD}ext+sv`],
  arguments: context => context.includeDirectories.map(directory => `-I${directory}`),
  diagnostics: [{ regex: /^%(?<severity>Error|Warning|Info)(?:-(?<code>[\w-]+))?:\s+(?<file>.+?):(?<line>\d+):(?:(?<column>\d+):)?\s*(?<message>.*)$/ }],
  severities: { error: 'error', warning: 'warning', info: 'information' },
};
