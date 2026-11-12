import { FormatterProfile } from './types';
import { verible } from './verible';

export const formatterProfiles: readonly FormatterProfile[] = [verible];
export function findFormatterProfile(id: string): FormatterProfile | undefined {
  return formatterProfiles.find(profile => profile.id === id);
}
