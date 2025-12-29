import { google } from 'googleapis';
import { logger } from './logger.js';
import { saveRunStatus } from './storage.js';

// Configuration
// Palmeiras team ID in Sofascore API
const PALMEIRAS_TEAM_ID_SOFASCORE = 1963; // Sofascore team ID for Palmeiras
const SOFASCORE_BASE_URL = 'https://api.sofascore.com/api/v1';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // Base64 encoded service account JSON
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Sofascore API headers to mimic browser request
const SOFASCORE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
  'Referer': 'https://www.sofascore.com/',
  'Origin': 'https://www.sofascore.com',
  'Cache-Control': 'no-cache'
};

// Helper function to fetch with retry logic for Sofascore API
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      logger.debug(`[SYNC] Fetching: ${url} (attempt ${i + 1}/${retries})`);
      const response = await fetch(url, { headers: SOFASCORE_HEADERS });
      
      if (response.ok) {
        const data = await response.json();
        return data;
      }
      
      logger.warn(`[SYNC] HTTP ${response.status} - ${response.statusText}`);
    } catch (error) {
      logger.warn(`[SYNC] Attempt ${i + 1} failed: ${error.message}`);
    }
    
    if (i < retries - 1) {
      const delay = 2000 * (i + 1);
      logger.debug(`[SYNC] Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Failed to fetch after ${retries} attempts`);
}

// Validate environment
function validateEnv() {
  const missing = [];
  if (!GOOGLE_CREDENTIALS) missing.push('GOOGLE_CREDENTIALS');
  
  if (missing.length > 0) {
    const errorMsg = `Missing environment variables: ${missing.join(', ')}`;
    logger.error('[SYNC] Missing environment variables', new Error(errorMsg));
    throw new Error(errorMsg);
  }
}

// Fetch fixtures from Sofascore API
async function fetchPalmeirasFixtures() {
  logger.info('[SYNC] Fetching Palmeiras fixtures from Sofascore API...');
  logger.info(`[SYNC] Using team ID: ${PALMEIRAS_TEAM_ID_SOFASCORE}`);
  
  try {
    const now = new Date();
    logger.info(`[SYNC] Current date/time: ${now.toISOString()} (${now.getTime()})`);
    
    // Fetch upcoming fixtures (next events)
    logger.info('[SYNC] Fetching upcoming fixtures...');
    const nextEventsUrl = `${SOFASCORE_BASE_URL}/team/${PALMEIRAS_TEAM_ID_SOFASCORE}/events/next/0`;
    const nextEventsData = await fetchWithRetry(nextEventsUrl);
    const nextEvents = nextEventsData.events || [];
    
    logger.info(`[SYNC] Sofascore API returned ${nextEvents.length} upcoming events`);
    
    // Debug: log what we received
    if (nextEvents.length > 0) {
      const tournaments = new Set();
      const statuses = new Set();
      
      nextEvents.forEach(event => {
        const tournamentName = event.tournament?.name || event.tournament?.uniqueTournament?.name || 'Unknown';
        tournaments.add(tournamentName);
        if (event.status?.description) {
          statuses.add(event.status.description);
        }
      });
      
      logger.info(`[SYNC] Tournaments found: ${Array.from(tournaments).join(', ')}`);
      logger.info(`[SYNC] Statuses found: ${Array.from(statuses).join(', ')}`);
      
      // Log first few events for debugging
      nextEvents.slice(0, 5).forEach((event, idx) => {
        const startTime = new Date(event.startTimestamp * 1000);
        const homeTeam = event.homeTeam?.name || 'TBD';
        const awayTeam = event.awayTeam?.name || 'TBD';
        const tournament = event.tournament?.name || event.tournament?.uniqueTournament?.name || 'Unknown';
        const diff = startTime.getTime() - now.getTime();
        const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
        const isFuture = startTime > now;
        
        logger.info(`[SYNC] Event ${idx + 1}: ${homeTeam} vs ${awayTeam} - Tournament: ${tournament} - Date: ${startTime.toISOString()}, diff: ${diffDays} days, isFuture: ${isFuture}`);
      });
    }
    
    // Filter for future fixtures only - check date
    const futureFixtures = nextEvents.filter(event => {
      if (!event.startTimestamp) return false;
      const matchDate = new Date(event.startTimestamp * 1000); // Convert Unix timestamp (seconds) to milliseconds
      return matchDate > now;
    });
    
    logger.info(`[SYNC] Found ${futureFixtures.length} upcoming fixtures for Palmeiras`);
    
    // Store teamId in fixtures for later use
    futureFixtures.forEach(fixture => {
      fixture._teamId = PALMEIRAS_TEAM_ID_SOFASCORE;
    });
    
    return futureFixtures;
  } catch (err) {
    logger.error('[SYNC] Failed to fetch fixtures', err);
    throw err;
  }
}

// Convert Sofascore event to Google Calendar event
function fixtureToCalendarEvent(event, teamId = PALMEIRAS_TEAM_ID_SOFASCORE) {
  // Sofascore structure: event.homeTeam, event.awayTeam, event.startTimestamp (Unix timestamp in seconds)
  const isHome = event.homeTeam?.id === teamId;
  const homeTeam = event.homeTeam?.name || 'TBD';
  const awayTeam = event.awayTeam?.name || 'TBD';
  const opponent = isHome ? awayTeam : homeTeam;
  const venue = isHome ? '🏠' : '✈️';
  
  // Convert Unix timestamp (seconds) to Date
  const startDateTime = new Date(event.startTimestamp * 1000);
  const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours
  
  const tournament = event.tournament?.name || event.tournament?.uniqueTournament?.name || 'Unknown';
  const round = event.roundInfo?.round ? `Round ${event.roundInfo.round}` : '';
  const venueName = event.venue?.stadium?.name || event.homeTeam?.venue?.stadium?.name || '';
  
  return {
    summary: `${venue} Palmeiras vs ${opponent}`,
    description: [
      `⚽ ${tournament}${round ? ` - ${round}` : ''}`,
      `📍 ${venueName || 'TBD'}`,
      ``,
      `Source: Sofascore`,
      `Event ID: ${event.id}`
    ].join('\n'),
    location: venueName || '',
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
    extendedProperties: {
      private: {
        palmeirasSync: 'true',
        fixtureId: String(event.id),
      }
    }
  };
}

// Get Google Calendar client
async function getCalendarClient() {
  try {
    const credentials = JSON.parse(
      Buffer.from(GOOGLE_CREDENTIALS, 'base64').toString('utf-8')
    );
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    
    logger.info('[SYNC] Google Calendar client initialized successfully');
    return google.calendar({ version: 'v3', auth });
  } catch (err) {
    logger.error('[SYNC] Failed to initialize Google Calendar client', err);
    throw err;
  }
}

// Get existing Palmeiras events from calendar
async function getExistingEvents(calendar) {
  const now = new Date();
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  
  try {
    const response = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: oneYearFromNow.toISOString(),
      maxResults: 100,
      singleEvents: true,
      q: 'Palmeiras',
    });
    
    // Filter for events created by this sync
    const palmeirasEvents = (response.data.items || []).filter(event => 
      event.extendedProperties?.private?.palmeirasSync === 'true'
    );
    
    // Create a map of fixtureId -> eventId
    const fixtureMap = new Map();
    for (const event of palmeirasEvents) {
      const fixtureId = event.extendedProperties?.private?.fixtureId;
      if (fixtureId) {
        fixtureMap.set(fixtureId, event.id);
      }
    }
    
    logger.info(`[SYNC] Found ${fixtureMap.size} existing Palmeiras events in calendar`);
    return fixtureMap;
  } catch (err) {
    logger.error('[SYNC] Failed to fetch existing events', err);
    throw err;
  }
}

// Sync fixtures to calendar
async function syncToCalendar(fixtures) {
  logger.info('[SYNC] Starting calendar sync...');
  
  const calendar = await getCalendarClient();
  const existingEvents = await getExistingEvents(calendar);
  
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  
  for (const fixture of fixtures) {
    const teamId = fixture._teamId || PALMEIRAS_TEAM_ID_SOFASCORE;
    const event = fixtureToCalendarEvent(fixture, teamId);
    const fixtureId = String(fixture.id);
    const existingEventId = existingEvents.get(fixtureId);
    
    try {
      if (existingEventId) {
        // Update existing event
        await calendar.events.update({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: existingEventId,
          resource: event,
        });
        logger.info(`[SYNC] Updated: ${event.summary}`);
        updated++;
      } else {
        // Create new event
        await calendar.events.insert({
          calendarId: GOOGLE_CALENDAR_ID,
          resource: event,
        });
        logger.info(`[SYNC] Created: ${event.summary}`);
        created++;
      }
    } catch (err) {
      const errorMsg = `${event.summary} - ${err.message}`;
      err.fixture = event.summary;
      err.fixtureId = fixtureId;
      logger.error(`[SYNC] Failed to sync event: ${errorMsg}`, err);
      errors.push({ fixture: event.summary, error: err.message });
      skipped++;
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  logger.info(`[SYNC] Sync complete: ${created} created, ${updated} updated, ${skipped} errors`);
  
  return { created, updated, skipped, errors };
}

// Main sync function
export async function runSync() {
  const startTime = Date.now();
  const runId = `sync-${Date.now()}`;
  
  logger.info('⚽ Palmeiras Calendar Sync Started', { runId });
  logger.info('═'.repeat(50));
  
  try {
    validateEnv();
    
    const fixtures = await fetchPalmeirasFixtures();
    
    if (fixtures.length === 0) {
      logger.warn('[SYNC] No upcoming fixtures found');
      const result = {
        runId,
        status: 'success',
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        duration: Date.now() - startTime,
        fixturesFound: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [],
        message: 'No upcoming fixtures found'
      };
      await saveRunStatus(result);
      return result;
    }
    
    // Log fixtures summary
    logger.info(`[SYNC] Fixtures to sync: ${fixtures.length}`);
    fixtures.slice(0, 5).forEach(f => {
      const teamId = f._teamId || PALMEIRAS_TEAM_ID_SOFASCORE;
      const isHome = f.homeTeam?.id === teamId;
      const opponent = isHome ? (f.awayTeam?.name || 'TBD') : (f.homeTeam?.name || 'TBD');
      const date = new Date(f.startTimestamp * 1000).toLocaleString('pt-BR', { 
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short'
      });
      const tournament = f.tournament?.name || f.tournament?.uniqueTournament?.name || 'Unknown';
      logger.info(`  ${date} - ${isHome ? '🏠' : '✈️'} vs ${opponent} [${tournament}]`);
    });
    if (fixtures.length > 5) {
      logger.info(`  ... and ${fixtures.length - 5} more`);
    }
    
    const syncResult = await syncToCalendar(fixtures);
    
    const result = {
      runId,
      status: 'success',
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      fixturesFound: fixtures.length,
      created: syncResult.created,
      updated: syncResult.updated,
      skipped: syncResult.skipped,
      errors: syncResult.errors,
      message: `Sync complete! ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.skipped} errors`
    };
    
    await saveRunStatus(result);
    logger.info('🎉 Sync complete! Vai Palmeiras!');
    
    return result;
    
  } catch (err) {
    logger.error('[SYNC] Sync failed', err);
    
    const result = {
      runId,
      status: 'error',
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      fixturesFound: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [{ error: err.message }],
      message: `Sync failed: ${err.message}`
    };
    
    await saveRunStatus(result);
    throw err;
  }
}

