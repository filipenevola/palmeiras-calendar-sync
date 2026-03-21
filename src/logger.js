import { createLogger } from '@quave/logger';

// Initialize logger with Slack error webhook
const slackWebhookUrl = process.env.SLACK_ERROR_WEBHOOK;

// Validate Slack webhook URL format
function isValidSlackWebhook(url) {
  if (!url) return false;
  // Slack webhooks typically start with https://hooks.slack.com/services/
  return typeof url === 'string' && 
         url.startsWith('https://hooks.slack.com/services/') &&
         url.length > 40; // Basic length check
}

const isSlackEnabled = isValidSlackWebhook(slackWebhookUrl);

if (process.env.SLACK_ERROR_WEBHOOK && !isSlackEnabled) {
  console.warn('[LOGGER] SLACK_ERROR_WEBHOOK appears to be invalid - Slack notifications disabled');
  console.warn('[LOGGER] Webhook URL should start with: https://hooks.slack.com/services/');
} else if (!isSlackEnabled) {
  console.warn('[LOGGER] SLACK_ERROR_WEBHOOK not set - Slack notifications disabled');
}

const CURSOR_TAG = `@Cursor repo=filipenevola/palmeiras-calendar-sync, branch=main

Use the Quave ONE MCP to investigate logs and deployment status. Quave ONE IDs: accountId=KPADFfTBDQnk8J2Yv, appId=z5NAMzhWJikLpSZrf, appEnvId=zNp7QCSEWZQX4jzWB.

Investigate and fix this error.`;

const _logger = createLogger({
  appName: 'palmeiras-calendar-sync',
  environment: process.env.NODE_ENV || 'production',
  debug: {
    enabled: true,
    filter: ['SYNC'],
  },
  slack: {
    enabled: isSlackEnabled,
    webhookUrl: isSlackEnabled ? slackWebhookUrl : undefined,
    webhookUrls: isSlackEnabled ? {
      error: slackWebhookUrl,
    } : undefined,
    skipInDevelopment: false,
  },
});

const originalError = _logger.error.bind(_logger);
_logger.error = (message, ...args) => {
  const messageWithCursor = `${message}\n\n${CURSOR_TAG}`;
  originalError(messageWithCursor, ...args);
};

export const logger = _logger;

// Helper to ensure errors are always Error objects for proper Slack formatting
export function ensureError(error) {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  if (error && typeof error === 'object') {
    const err = new Error(error.message || error.error || 'Unknown error');
    if (error.code) err.code = error.code;
    if (error.stack) err.stack = error.stack;
    return err;
  }
  return new Error(String(error));
}

