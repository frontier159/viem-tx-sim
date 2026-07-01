import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('motivation docs', () => {
  it('contains every post and links to extracted image assets', () => {
    const docPath = resolve('docs/motivation.md');
    const doc = readFileSync(docPath, 'utf8');
    expect(doc.match(/^## Post /gm)).toHaveLength(11);

    for (const match of doc.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
      const target = match[1];
      expect(target).toBeDefined();
      expect(existsSync(resolve(dirname(docPath), target!))).toBe(true);
    }
  });
});
