import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let dataDir;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'palmeiras-verdao-test-'));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  mock.restore();
  delete process.env.DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe('fetchHTMLWithCache', () => {
  test('stores a successful response and reuses it when the source times out', async () => {
    const { fetchHTMLWithCache } = await import('./verdao.js');
    const url = 'https://ptd.verdao.net/test-page/';

    globalThis.fetch = mock(async () => new Response('<html>fresh fixtures</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    }));

    const live = await fetchHTMLWithCache(url, 1);
    expect(live.source).toBe('live');
    expect(live.html).toContain('fresh fixtures');

    globalThis.fetch = mock(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    const cached = await fetchHTMLWithCache(url, 1);
    expect(cached.source).toBe('cache');
    expect(cached.html).toBe(live.html);

    const files = await Array.fromAsync(new Bun.Glob('*.json').scan(join(dataDir, 'verdao-html-cache')));
    expect(files).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(dataDir, 'verdao-html-cache', files[0]), 'utf-8'));
    expect(persisted.url).toBe(url);
  });

  test('reports unavailable when neither the network nor cache can provide HTML', async () => {
    const { fetchHTMLWithCache } = await import('./verdao.js');
    globalThis.fetch = mock(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    const result = await fetchHTMLWithCache('https://ptd.verdao.net/never-cached/', 1);
    expect(result).toEqual({ html: null, source: 'unavailable', savedAt: null });
  });
});
