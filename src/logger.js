import { createLogger } from '@quave/logger';

// Initialize logger with Slack error webhook
const slackWebhookUrl = process.env.SLACK_ERROR_WEBHOOK;
const isSlackEnabled = !!slackWebhookUrl;

if (!isSlackEnabled) {
  console.warn('[LOGGER] SLACK_ERROR_WEBHOOK not set - Slack notifications disabled');
}

export const logger = createLogger({
  appName: 'palmeiras-calendar-sync',
  environment: process.env.NODE_ENV || 'production',
  debug: {
    enabled: true,
    filter: ['SYNC'], // Enable debug logs for SYNC-related messages
  },
  slack: {
    enabled: isSlackEnabled,
    webhookUrl: slackWebhookUrl, // Required: default webhook URL
    webhookUrls: {
      error: slackWebhookUrl, // Override for errors specifically
    },
    skipInDevelopment: false, // Changed to false to test in any environment
  },
});

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

