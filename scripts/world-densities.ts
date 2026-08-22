/**
 * List the SPZ densities a finished world offers, and what each weighs.
 *
 * Reading a world is free; generating one is not. Choosing a density by
 * guessing "full_res is probably fine" risks a 300 MB download that makes the
 * plan screen unusable, which is exactly what happened with hobbiton.
 *
 *   npx tsx --env-file=.env scripts/world-densities.ts <world-id> [...]
 */

import { MarbleClient, listSpzUrls, readWorld, resolveApiKey } from '../lib/marble';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  process.stderr.write('usage: world-densities.ts <world-id> [...]\n');
  process.exit(2);
}

const client = new MarbleClient({ apiKey: resolveApiKey() });

for (const id of ids) {
  const world = readWorld(await client.getWorld(id));
  const urls = listSpzUrls(world?.assets);
  process.stdout.write(`\n${id}  ${world?.display_name ?? ''}\n`);
  for (const { key, url } of urls) {
    // HEAD rather than GET: the size is in the headers and the body is the
    // thing being decided about.
    let size = '?';
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const len = head.headers.get('content-length');
      if (len) size = `${(Number(len) / 1e6).toFixed(1)} MB`;
    } catch {
      size = 'unreachable';
    }
    process.stdout.write(`  ${key.padEnd(10)} ${size}\n`);
  }
}
