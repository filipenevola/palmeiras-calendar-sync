import { google } from 'googleapis';
import { saveRunStatus } from './storage.js';

// Configuration
const PALMEIRAS_TEAM_ID_FOOTBALL_DATA = 1780; // Football-Data.org team ID for Palmeiras
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || process.env.API_FOOTBALL_KEY; // Support both env var names
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // Base64 encoded service account JSON
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Enhanced logging
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level}] ${message}`;
  console.log(logEntry);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Validate environment
function validateEnv() {
  const missing = [];
  if (!FOOTBALL_DATA_API_KEY) missing.push('FOOTBALL_DATA_API_KEY (or API_FOOTBALL_KEY)');
  if (!GOOGLE_CREDENTIALS) missing.push('GOOGLE_CREDENTIALS');
  
  if (missing.length > 0) {
    log('ERROR', `Missing environment variables: ${missing.join(', ')}`);
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

// Fetch fixtures from Football-Data.org API
async function fetchPalmeirasFixtures() {
  log('INFO', 'Fetching Palmeiras fixtures from Football-Data.org...');
  
  try {
    // Football-Data.org API endpoint for team matches
    const url = `https://api.football-data.org/v4/teams/${PALMEIRAS_TEAM_ID_FOOTBALL_DATA}/matches?status=SCHEDULED`;
    
    const response = await fetch(url, {
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_API_KEY,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log('ERROR', `Football-Data.org HTTP error: ${response.status} ${response.statusText}`, { errorText });
      
      // If 401, provide helpful error message
      if (response.status === 401) {
        throw new Error('Football-Data.org authentication failed. Please check your API key. Get a free key at https://www.football-data.org/');
      }
      
      throw new Error(`Football-Data.org error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Filter for future fixtures only
    const now = new Date();
    const futureFixtures = (data.matches || []).filter(match => {
      const matchDate = new Date(match.utcDate);
      return matchDate > now;
    });
    
    log('INFO', `Found ${futureFixtures.length} upcoming fixtures`);
    
    return futureFixtures;
  } catch (err) {
    log('ERROR', 'Failed to fetch fixtures', { error: err.message, stack: err.stack });
    throw err;
  }
}

// Convert Football-Data.org match to Google Calendar event
function fixtureToCalendarEvent(match) {
  // Football-Data.org structure: match.homeTeam, match.awayTeam
  const isHome = match.homeTeam.id === PALMEIRAS_TEAM_ID_FOOTBALL_DATA;
  const opponent = isHome ? match.awayTeam.name : match.homeTeam.name;
  const venue = isHome ? '🏠' : '✈️';
  
  const startDateTime = new Date(match.utcDate);
  const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours
  
  return {
    summary: `${venue} Palmeiras vs ${opponent}`,
    description: [
      `⚽ ${match.competition.name}${match.matchday ? ` - Matchday ${match.matchday}` : ''}`,
      `📍 ${match.venue || 'TBD'}`,
      ``,
      `Source: Football-Data.org`,
      `Match ID: ${match.id}`
    ].join('\n'),
    location: match.venue || '',
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
        fixtureId: String(match.id),
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
    
    log('INFO', 'Google Calendar client initialized successfully');
    return google.calendar({ version: 'v3', auth });
  } catch (err) {
    log('ERROR', 'Failed to initialize Google Calendar client', { error: err.message });
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
    
    log('INFO', `Found ${fixtureMap.size} existing Palmeiras events in calendar`);
    return fixtureMap;
  } catch (err) {
    log('ERROR', 'Failed to fetch existing events', { error: err.message });
    throw err;
  }
}

// Sync fixtures to calendar
async function syncToCalendar(fixtures) {
  log('INFO', 'Starting calendar sync...');
  
  const calendar = await getCalendarClient();
  const existingEvents = await getExistingEvents(calendar);
  
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  
  for (const fixture of fixtures) {
    const event = fixtureToCalendarEvent(fixture);
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
        log('INFO', `Updated: ${event.summary}`);
        updated++;
      } else {
        // Create new event
        await calendar.events.insert({
          calendarId: GOOGLE_CALENDAR_ID,
          resource: event,
        });
        log('INFO', `Created: ${event.summary}`);
        created++;
      }
    } catch (err) {
      const errorMsg = `${event.summary} - ${err.message}`;
      log('ERROR', `Failed to sync event: ${errorMsg}`);
      errors.push({ fixture: event.summary, error: err.message });
      skipped++;
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  log('INFO', `Sync complete: ${created} created, ${updated} updated, ${skipped} errors`);
  
  return { created, updated, skipped, errors };
}

// Main sync function
export async function runSync() {
  const startTime = Date.now();
  const runId = `sync-${Date.now()}`;
  
  log('INFO', '⚽ Palmeiras Calendar Sync Started', { runId });
  log('INFO', '═'.repeat(50));
  
  try {
    validateEnv();
    
    const fixtures = await fetchPalmeirasFixtures();
    
    if (fixtures.length === 0) {
      log('WARN', 'No upcoming fixtures found');
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
    log('INFO', `Fixtures to sync: ${fixtures.length}`);
    fixtures.slice(0, 5).forEach(f => {
      const isHome = f.homeTeam.id === PALMEIRAS_TEAM_ID_FOOTBALL_DATA;
      const opponent = isHome ? f.awayTeam.name : f.homeTeam.name;
      const date = new Date(f.utcDate).toLocaleString('pt-BR', { 
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short'
      });
      log('INFO', `  ${date} - ${isHome ? '🏠' : '✈️'} vs ${opponent} [${f.competition.name}]`);
    });
    if (fixtures.length > 5) {
      log('INFO', `  ... and ${fixtures.length - 5} more`);
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
    log('INFO', '🎉 Sync complete! Vai Palmeiras!');
    
    return result;
    
  } catch (err) {
    log('ERROR', 'Sync failed', { error: err.message, stack: err.stack });
    
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

