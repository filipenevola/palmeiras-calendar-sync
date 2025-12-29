import { logger } from './logger.js';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const STATUS_FILE = '/tmp/palmeiras-sync-status.json';

export async function saveRunStatus(status) {
  try {
    await writeFile(STATUS_FILE, JSON.stringify(status, null, 2), 'utf-8');
  } catch (err) {
    logger.error('[STORAGE] Failed to save run status', err);
  }
}

export async function getLatestRunStatus() {
  try {
    if (!existsSync(STATUS_FILE)) {
      return {
        status: 'no_runs',
        message: 'No sync runs have been executed yet'
      };
    }
    
    const content = await readFile(STATUS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    logger.error('[STORAGE] Failed to read run status', err);
    return {
      status: 'error',
      message: `Failed to read status: ${err.message}`
    };
  }
}

