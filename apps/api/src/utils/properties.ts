/**
 * Merges managed KEY=value lines into .properties-style content: lines for
 * the managed keys are replaced in place, missing ones are appended, and
 * everything else (comments, other keys, ordering) is preserved. Lets a
 * template assert single settings like Minecraft's server-port without
 * clobbering a file the game or a modpack legitimately owns.
 */
export function mergeProperties(existing: string, managed: string): string {
  const parseLine = (line: string): [string, string] | null => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return null;
    return [trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1)];
  };

  const remaining = new Map<string, string>();
  for (const line of managed.split('\n')) {
    const entry = parseLine(line);
    if (entry) remaining.set(entry[0], entry[1]);
  }

  const out = existing.split('\n').map((line) => {
    const entry = parseLine(line);
    if (!entry || !remaining.has(entry[0])) return line;
    const value = remaining.get(entry[0])!;
    remaining.delete(entry[0]);
    return `${entry[0]}=${value}`;
  });

  let result = out.join('\n');
  if (remaining.size > 0) {
    if (result !== '' && !result.endsWith('\n')) result += '\n';
    for (const [key, value] of remaining) {
      result += `${key}=${value}\n`;
    }
  }
  return result;
}
