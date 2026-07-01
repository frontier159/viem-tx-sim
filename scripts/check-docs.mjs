import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const docPath = resolve('docs/motivation.md');
const doc = readFileSync(docPath, 'utf8');
const missing = [];

for (const match of doc.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
  const target = resolve(dirname(docPath), match[1]);
  if (!existsSync(target)) missing.push(match[1]);
}

if (missing.length > 0) {
  throw new Error(`Missing markdown image assets:\n${missing.join('\n')}`);
}

const postCount = (doc.match(/^## Post /gm) ?? []).length;
if (postCount !== 11) {
  throw new Error(`Expected 11 posts in docs/motivation.md, found ${postCount}`);
}
