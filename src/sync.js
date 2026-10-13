/**
 * Main sync orchestration
 * 
 * This module orchestrates the entire sync process:
 * 1. Retrieve matches from data source
 * 2. Process matches (filter, deduplicate, sort)
 * 3. Sync matches to Google Calendar
 */

import { logger, ensureError } from './logger.js';
import { saveRunStatus } from './storage.js';
import { GOOGLE_CREDENTIALS } from './config.js';
import { fetchPalmeirasFixtures } from './retrieval/verdao.js';
import { processMatches } from './processing.js';
import { syncMatchesToCalendar } from './calendar.js';
import { reportToFactory, handoffText } from './factory.js';

function validateEnv() {
  const missing = [];
  if (!GOOGLE_CREDENTIALS) missing.push('GOOGLE_CREDENTIALS');
  
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

export async function sync() {
  const runId = `sync-${Date.now()}`;
  const startTime = Date.now();
  
  logger.info('⚽ Palmeiras Calendar Sync Started', { runId });
  logger.info('══════════════════════════════════════════════════');
  
  try {
    validateEnv();
    
    // Step 1: Retrieve matches (isolated retrieval logic)
    const rawMatches = await fetchPalmeirasFixtures();
    
    // Step 2: Process matches (filter, deduplicate, sort)
    const processedMatches = processMatches(rawMatches);
    
    if (processedMatches.length === 0) {
      logger.info('[SYNC] No upcoming fixtures found');
      const result = {
        runId,
        status: 'success',
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        duration: Date.now() - startTime,
        fixturesFound: 0,
        fixturesCreated: 0,
        fixturesUpdated: 0,
        fixturesSkipped: 0,
      };
      
      await saveRunStatus(result);
      return result;
    }
    
    // Log fixtures summary
    logger.info(`[SYNC] Fixtures to sync: ${processedMatches.length}`);
    processedMatches.slice(0, 5).forEach(f => {
      const date = f.date.toLocaleString('pt-BR', { 
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short'
      });
      logger.info(`  ${date} - ${f.isHome ? '🏠' : '✈️'} vs ${f.opponent} [${f.competition}]${f.broadcast ? ` 📺 ${f.broadcast}` : ''}`);
    });
    if (processedMatches.length > 5) {
      logger.info(`  ... and ${processedMatches.length - 5} more`);
    }
    
    // Step 3: Sync to calendar (isolated calendar sync logic)
    const syncResult = await syncMatchesToCalendar(processedMatches);
    
    const result = {
      runId,
      status: 'success',
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      fixturesFound: processedMatches.length,
      fixturesCreated: syncResult.created,
      fixturesUpdated: syncResult.updated,
      fixturesSkipped: syncResult.skipped,
      errors: syncResult.errors.length > 0 ? syncResult.errors : undefined,
    };
    
    logger.info('══════════════════════════════════════════════════');
    logger.info('✅ Sync completed successfully', result);

    // Events that failed to write are real errors even though the run finished.
    if (syncResult.errors.length > 0) {
      const summary = syncResult.errors.map(e => `${e.fixture}: ${e.error}`).join('; ');
      const failure = new Error(`${syncResult.errors.length} calendar event(s) failed to sync: ${summary}`);
      logger.error(`❌ ${failure.message}\n\n${handoffText(await reportToFactory(failure))}`, failure);
    }
    
    await saveRunStatus(result);
    return result;
  } catch (err) {
    const result = {
      runId,
      status: 'error',
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: err.message,
    };
    
    // The single place a failed sync is reported: Factory investigates, Slack says what happened.
    const error = ensureError(err);
    const factory = await reportToFactory(error);
    logger.error(`❌ Sync failed: ${error.message}\n\n${handoffText(factory)}`, error);
    await saveRunStatus(result);
    throw err;
  }
}
