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

const SECTION_HEADER_RE = /^\[(.+)\]$/;

function isIniComment(trimmed: string): boolean {
  return trimmed.startsWith('#') || trimmed.startsWith(';');
}

/**
 * Section-aware variant of mergeProperties() for [Section]-structured files
 * like ARK's GameUserSettings.ini: managed keys replace the same key inside
 * the same section only, missing keys are appended to their section, and
 * whole missing sections are appended at the end. Everything else in the
 * existing file is preserved untouched.
 */
export function mergeIni(existing: string, managed: string): string {
  if (existing.trim() === '') return managed;

  // section '' holds keys before the first [header].
  const managedSections = new Map<string, Map<string, string>>();
  let parseSection = '';
  for (const line of managed.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || isIniComment(trimmed)) continue;
    const header = SECTION_HEADER_RE.exec(trimmed);
    if (header) {
      parseSection = header[1]!;
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let keys = managedSections.get(parseSection);
    if (!keys) {
      keys = new Map();
      managedSections.set(parseSection, keys);
    }
    keys.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
  }

  const out: string[] = [];
  let section = '';
  const flushSection = (name: string) => {
    const keys = managedSections.get(name);
    if (!keys) return;
    for (const [key, value] of keys) out.push(`${key}=${value}`);
    keys.clear();
  };

  for (const line of existing.split('\n')) {
    const trimmed = line.trim();
    const header = SECTION_HEADER_RE.exec(trimmed);
    if (header) {
      flushSection(section); // keys missing from the section that just ended
      section = header[1]!;
      out.push(line);
      continue;
    }
    if (trimmed && !isIniComment(trimmed)) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const keys = managedSections.get(section);
        const value = keys?.get(key);
        if (value !== undefined) {
          out.push(`${key}=${value}`);
          keys!.delete(key);
          continue;
        }
      }
    }
    out.push(line);
  }
  flushSection(section);

  let result = out.join('\n');
  const leftovers = [...managedSections.entries()].filter(([, keys]) => keys.size > 0);
  if (leftovers.length > 0) {
    if (result !== '' && !result.endsWith('\n')) result += '\n';
    for (const [name, keys] of leftovers) {
      if (name !== '') result += `[${name}]\n`;
      for (const [key, value] of keys) result += `${key}=${value}\n`;
    }
  }
  return result;
}
