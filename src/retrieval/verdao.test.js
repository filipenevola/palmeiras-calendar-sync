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

describe('parseDateTime', () => {
  test('parses verdao date cells with accidental double slashes', async () => {
    const { parseDateTime } = await import('./verdao.js');
    const date = parseDateTime('16//9 – 19h00', 'Brasileirão 2026');
    expect(date).toBeInstanceOf(Date);
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(8);
    expect(date.getUTCDate()).toBe(16);
  });
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

  test('can read cache without attempting the network', async () => {
    const { fetchHTMLWithCache } = await import('./verdao.js');
    const url = 'https://ptd.verdao.net/cache-only/';
    globalThis.fetch = mock(async () => new Response('<html>cached</html>', { status: 200 }));
    await fetchHTMLWithCache(url, 1);

    globalThis.fetch = mock(async () => {
      throw new Error('network should not be called');
    });
    const result = await fetchHTMLWithCache(url, 1, { allowNetwork: false });

    expect(result.source).toBe('cache');
    expect(result.html).toContain('cached');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('parseCampeonatoBase', () => {
  const nextYear = new Date().getFullYear() + 1;
  const competition = `Brasileirão ${nextYear}`;
  const url = 'https://www.verdao.net/campeonato_base.php?c=2';

  test('keeps the returno (away) leg when the Rodada cell is also rowspan=2', async () => {
    const { parseCampeonatoBase } = await import('./verdao.js');
    const html = `<table>
      <tr><td rowspan="2">1</td><td>10/05 - 16h00</td><td rowspan="2">Santos</td><td></td><td>Allianz Parque</td><td>1</td></tr>
      <tr><td>20/09 - 18h30</td><td></td><td>Vila Belmiro</td><td>3</td></tr>
    </table>`;
    const matches = parseCampeonatoBase(html, competition, url);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => [m.opponent, m.isHome])).toEqual([
      ['Santos', true],
      ['Santos', false],
    ]);
  });

  test('still parses the standard 5-cell returno leg', async () => {
    const { parseCampeonatoBase } = await import('./verdao.js');
    const html = `<table>
      <tr><td>1</td><td>10/05 - 16h00</td><td rowspan="2">Santos</td><td></td><td>Allianz Parque</td><td>1</td></tr>
      <tr><td>20</td><td>20/09 - 18h30</td><td></td><td>Vila Belmiro</td><td>3</td></tr>
    </table>`;
    const matches = parseCampeonatoBase(html, competition, url);
    expect(matches.map((m) => [m.opponent, m.isHome])).toEqual([
      ['Santos', true],
      ['Santos', false],
    ]);
  });

  test('does not carry an opponent from an earlier round', async () => {
    const { parseCampeonatoBase } = await import('./verdao.js');
    const html = `<table>
      <tr><td>1</td><td>10/05 - 16h00</td><td>Santos</td><td></td><td>Allianz Parque</td><td>1</td></tr>
      <tr><td>2</td><td>17/05 - 16h00</td><td>x</td><td></td><td>Maracanã</td><td>1</td></tr>
      <tr><td>21</td><td>27/09 - 16h00</td><td></td><td>Allianz Parque</td><td>1</td></tr>
    </table>`;
    const matches = parseCampeonatoBase(html, competition, url);
    expect(matches.map((m) => m.opponent)).toEqual(['Santos']);
  });
});
