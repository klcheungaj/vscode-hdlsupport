/** Split legacy argument strings without evaluating a shell. Prefer string arrays for exact arguments. */
export function splitArguments(input: string | string[]): string[] {
  if (Array.isArray(input)) { return [...input]; }
  const result: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '\\' && quote !== "'" && next !== undefined && (next === quote || next === '"' || /\s/.test(next))) {
      word += next;
      index++;
      started = true;
    } else if (quote && character === quote) {
      quote = '';
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
      started = true;
    } else if (!quote && /\s/.test(character)) {
      if (started) { result.push(word); word = ''; started = false; }
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) { throw new Error('Unterminated quote in linter arguments'); }
  if (started) { result.push(word); }
  return result;
}
