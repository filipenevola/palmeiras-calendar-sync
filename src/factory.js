import { createHash, randomUUID } from 'node:crypto';

// Filipe Nevola Factory: the Warren work controller investigates real failures
// and opens a fix PR or asks on GitHub.
const REPOSITORY = 'filipenevola/palmeiras-calendar-sync';
const SOURCE = 'palmeiras-calendar-sync';
const APP_ENV_ID = process.env.QUAVE_APP_ENV_ID || 'zNp7QCSEWZQX4jzWB';
const DEFAULT_URL = 'https://work-controller-production-filipenevola.svc-us5.zcloud.ws';
const ENV_LINK = `https://app.quave.cloud/account/KPADFfTBDQnk8J2Yv/app/z5NAMzhWJikLpSZrf/env/${APP_ENV_ID}`;

// Same failure class -> same fingerprint, so repeats join the active work item
// instead of starting new investigations. Volatile IDs, numbers and URLs are ignored.
export function fingerprint(message) {
  const normalized = String(message).replace(/https?:\/\/\S+/g, '<url>').replace(/\d+/g, '#');
  return `${SOURCE}:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

export function workRequest(error) {
  return {
    type: 'bug',
    repository: REPOSITORY,
    source: SOURCE,
    externalId: `${process.env.HOSTNAME || 'local'}-${randomUUID()}`,
    fingerprint: fingerprint(error.message),
    title: `Palmeiras calendar sync failed: ${error.message}`.slice(0, 250),
    description: [
      'The scheduled verdao.net -> Google Calendar sync failed in production.',
      `Investigate with Quave ONE MCP: get-logs and get-app-env-status appEnvId=${APP_ENV_ID}.`,
      'The app runs continuously and retries on the next cron tick (CRON_SCHEDULE, default every 30 minutes).',
    ].join('\n'),
    context: {
      message: error.message.slice(0, 16000),
      ...(error.stack ? { stack: error.stack.slice(0, 16000) } : {}),
      environment: 'production',
    },
    links: [ENV_LINK],
  };
}

// Never throws: a reporting failure must not hide the original error.
export async function reportToFactory(error, { fetchImpl = fetch, env = process.env } = {}) {
  const bearer = env.FACTORY_WORK_BEARER;
  if (!bearer) return { reported: false, reason: 'FACTORY_WORK_BEARER not set' };
  try {
    const response = await fetchImpl(`${env.FACTORY_WORK_URL || DEFAULT_URL}/work`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(workRequest(error)),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { reported: false, reason: `work controller HTTP ${response.status}` };
    const { work, duplicate } = await response.json();
    return { reported: true, workId: work?.id, duplicate: Boolean(duplicate) };
  } catch (reportError) {
    return { reported: false, reason: reportError.message };
  }
}

export function handoffText(result) {
  return result.reported
    ? `Sent to Filipe Nevola Factory (${result.workId}${result.duplicate ? ', already open' : ''}).`
    : `Not sent to Filipe Nevola Factory: ${result.reason}.`;
}
