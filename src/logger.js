import { createLogger } from '@quave/logger';

// Initialize logger with Slack error webhook
export const logger = createLogger({
  appName: 'palmeiras-calendar-sync',
  environment: process.env.NODE_ENV || 'production',
  slack: {
    enabled: !!process.env.SLACK_ERROR_WEBHOOK,
    webhookUrls: {
      error: process.env.SLACK_ERROR_WEBHOOK,
    },
    skipInDevelopment: true,
  },
});

