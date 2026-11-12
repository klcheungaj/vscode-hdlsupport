import { modelsim } from './modelsim';
import { slang } from './slang';
import { verilator } from './verilator';
import { xvlog } from './xvlog';
import { LinterProfile } from './types';

export const linterProfiles: readonly LinterProfile[] = [xvlog, modelsim, verilator, slang];
export function findLinterProfile(id: string): LinterProfile | undefined {
  return linterProfiles.find(profile => profile.id === id);
}
