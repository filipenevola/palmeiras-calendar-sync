/**
 * Cron scheduler for daily sync
 * 
 * Handles automatic scheduling of the sync process using node-cron.
 * The schedule can be customized via the CRON_SCHEDULE environment variable.
 */

import cron from 'node-cron';
import { sync } from './sync.js';
import { logger } from './logger.js';

/**
 * Starts the cron scheduler for daily sync
 * 
 * Default schedule: 2 AM UTC daily
 * Can be overridden with CRON_SCHEDULE env var (e.g., "0 2 * * *" for 2 AM UTC daily)
 */
export function startCronScheduler() {
  // Default: 2 AM UTC (11 PM previous day / 10 PM previous day in Brazil depending on DST)
  // Can be overridden with CRON_SCHEDULE env var
  const cronSchedule = process.env.CRON_SCHEDULE || '0 2 * * *';

  logger.info(`📅 Scheduling daily sync with cron: ${cronSchedule}`);

  cron.schedule(cronSchedule, async () => {
    logger.info('⏰ Scheduled sync triggered');
    try {
      await sync();
      logger.info('✅ Scheduled sync completed successfully');
    } catch (err) {
      logger.error('❌ Scheduled sync failed', err);
    }
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  logger.info('✅ Daily sync scheduler started');
}

