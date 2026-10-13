import { describe, expect, test } from 'bun:test';
import { fingerprint, workRequest, reportToFactory, handoffText } from './factory.js';

describe('Filipe Nevola Factory reporting', () => {
  test('fingerprint groups the same failure class and ignores volatile numbers and URLs', () => {
    expect(fingerprint('Fetch failed for https://ptd.verdao.net/jogos/2026 after 3 attempts'))
      .toBe(fingerprint('Fetch failed for https://www.verdao.net/x after 4 attempts'));
    expect(fingerprint('Missing environment variables: GOOGLE_CREDENTIALS'))
      .not.toBe(fingerprint('Verdão retrieval unavailable: no live pages or cached copies could be loaded'));
  });

  test('work request matches the work controller intake contract', () => {
    const body = workRequest(new Error('boom'));
    expect(body).toMatchObject({ type: 'bug', repository: 'filipenevola/palmeiras-calendar-sync', source: 'palmeiras-calendar-sync' });
    expect(body.source).toMatch(/^[\w.-]{1,80}$/);
    expect(body.fingerprint.length).toBeLessThanOrEqual(200);
    expect(body.links.every(l => l.startsWith('https://'))).toBe(true);
    expect(workRequest(new Error('a')).externalId).not.toBe(workRequest(new Error('a')).externalId);
  });

  test('posts with the bearer, reports the work ID and never throws', async () => {
    const calls = [];
    const env = { FACTORY_WORK_BEARER: 'token', FACTORY_WORK_URL: 'https://factory.test' };
    const ok = async (url, init) => { calls.push({ url, init }); return Response.json({ work: { id: 'work_1' }, duplicate: false }, { status: 202 }); };
    const result = await reportToFactory(new Error('boom'), { fetchImpl: ok, env });
    expect(result).toEqual({ reported: true, workId: 'work_1', duplicate: false });
    expect(calls[0].url).toBe('https://factory.test/work');
    expect(calls[0].init.headers.authorization).toBe('Bearer token');
    expect(handoffText(result)).toBe('Sent to Filipe Nevola Factory (work_1).');

    expect(await reportToFactory(new Error('boom'), { fetchImpl: ok, env: {} })).toMatchObject({ reported: false });
    const down = await reportToFactory(new Error('boom'), { env, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    expect(handoffText(down)).toBe('Not sent to Filipe Nevola Factory: ECONNRESET.');
  });
});
