import { LinterProfile } from './types';
export const slang: LinterProfile = {
  id: 'slang', label: 'Slang', executable: 'slang', output: 'stderr',
  defaultArguments: [],
  arguments: context => context.includeDirectories.flatMap(directory => ['-I', directory]),
  diagnostics: [{ regex: /^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s*(?<severity>note|warning|error):\s*(?<message>.*?)(?:\s*\[-W(?<code>[^\]]+)\])?$/ }],
  severities: { error: 'error', warning: 'warning', note: 'information' },
};
