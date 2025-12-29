import { createLogger } from '@quave/logger';

// Initialize logger with Slack error webhook
export const logger = createLogger({
  appName: 'palmeiras-calendar-sync',
  environment: process.env.NODE_ENV || 'production',
  debug: {
    enabled: true,
    filter: ['SYNC'], // Enable debug logs for SYNC-related messages
  },
  slack: {
    enabled: !!process.env.SLACK_ERROR_WEBHOOK,
    webhookUrl: process.env.SLACK_ERROR_WEBHOOK, // Required: default webhook URL
    webhookUrls: {
      error: process.env.SLACK_ERROR_WEBHOOK, // Override for errors specifically
    },
    skipInDevelopment: true,
  },
});

