import { mkdir, copyFile } from 'node:fs/promises';
const target = new URL('../dist/marketplace-browser/', import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ['marketplace.mjs', 'remote-browser.mjs']) {
  await copyFile(new URL(`../src/marketplace-browser/${name}`, import.meta.url), new URL(name, target));
}
