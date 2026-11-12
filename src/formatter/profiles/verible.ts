import { FormatterProfile } from './types';

export const verible: FormatterProfile = {
  id: 'verible', label: 'Verible', executable: 'verible-verilog-format',
  languages: ['verilog', 'systemverilog'],
  defaultArguments: [],
  // `-` reads the source from stdin.
  arguments: () => ['-'],
  rangeArguments: (startLine, endLine) => [`--lines=${startLine}-${endLine}`],
};
