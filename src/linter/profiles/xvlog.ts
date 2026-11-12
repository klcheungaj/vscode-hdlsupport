import { LinterProfile } from './types';
export const xvlog: LinterProfile = {
  id: 'xvlog', label: 'Vivado Logical Simulator', executable: 'xvlog', output: 'stdout',
  windowsExecutable: 'xvlog',
  legacySection: 'verilog.linting.xvlog',
  defaultArguments: ['-nolog'],
  arguments: context => [...(context.languageId === 'systemverilog' ? ['-sv'] : []),
    ...context.includeDirectories.flatMap(directory => ['-i', directory])],
  diagnostics: [{ regex: /^(?<severity>ERROR|WARNING|INFO):\s+\[(?<code>VRFC\b[^\]]*)\]\s+(?<message>.*\S)\s+\[(?<file>.*):(?<line>\d+)\]\s*$/ }],
  severities: { error: 'error', warning: 'warning', info: 'information' },
};
