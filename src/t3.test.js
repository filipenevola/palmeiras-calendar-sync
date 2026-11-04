import { expect, test } from 'bun:test';
import { t3Request } from './t3.js';

test('t3Request mentions t3fn on this repository only when configured', () => {
  expect(t3Request('boom', {})).toBe('boom');
  const text = t3Request('boom', { T3_SLACK_BOT_USER_ID: 'U123' });
  expect(text.startsWith('<@U123> [palmeiras-calendar-sync] boom')).toBe(true);
});
