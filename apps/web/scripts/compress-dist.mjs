// Precompresses the built web UI so the API can serve .br/.gz variants
// directly (@fastify/static preCompressed) instead of shipping ~250 KB of
// uncompressed JS/CSS on every page load. Runs as part of `pnpm build`;
// pure node core, no dependencies.
/* global console */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt', '.map']);
const MIN_BYTES = 1024; // tiny files aren't worth the extra inodes

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let count = 0;
for (const file of walk(dist)) {
  if (!COMPRESSIBLE.has(extname(file))) continue;
  if (statSync(file).size < MIN_BYTES) continue;
  const content = readFileSync(file);
  writeFileSync(`${file}.gz`, gzipSync(content, { level: 9 }));
  writeFileSync(
    `${file}.br`,
    brotliCompressSync(content, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  );
  count += 1;
}
console.log(`precompressed ${count} dist file(s) (.gz + .br)`);
