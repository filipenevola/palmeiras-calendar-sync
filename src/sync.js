import { google } from 'googleapis';
import { logger } from './logger.js';
import { saveRunStatus } from './storage.js';

// Configuration
// Palmeiras team ID in Football-Data.org
// To find your team ID: GET https://api.football-data.org/v4/teams?name=Palmeiras
let PALMEIRAS_TEAM_ID_FOOTBALL_DATA = 1769; // Football-Data.org team ID for Palmeiras (SE Palmeiras)
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // Base64 encoded service account JSON
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Helper function to search for Palmeiras team ID across multiple competitions
async function findPalmeirasTeamId() {
  try {
    logger.info('[SYNC] Searching for Palmeiras team ID across all competitions...');
    
    // Search in multiple competitions where Palmeiras plays:
    // - Brazilian Serie A (2013)
    // - Copa do Brasil (2014)
    // - Copa Libertadores (2152)
    // - Paulistão/São Paulo State Championship (check if available)
    const competitions = [
      { id: 2013, name: 'Brazilian Serie A' },
      { id: 2014, name: 'Copa do Brasil' },
      { id: 2152, name: 'Copa Libertadores' },
    ];
    
    for (const comp of competitions) {
      try {
        const url = `https://api.football-data.org/v4/competitions/${comp.id}/teams`;
        logger.info(`[SYNC] Searching in ${comp.name} (competition ${comp.id})...`);
        
        const response = await fetch(url, {
          headers: {
            'X-Auth-Token': FOOTBALL_DATA_API_KEY,
            'Accept': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.teams && data.teams.length > 0) {
            logger.info(`[SYNC] Found ${data.teams.length} teams in ${comp.name}`);
            
            // Look for Palmeiras
            const palmeiras = data.teams.find(t => {
              const name = (t.name || '').toLowerCase();
              const shortName = (t.shortName || '').toLowerCase();
              const tla = (t.tla || '').toLowerCase();
              
              return name.includes('palmeiras') || 
                     shortName.includes('palmeiras') || 
                     tla === 'pal' ||
                     name.includes('sociedade esportiva palmeiras');
            });
            
            if (palmeiras) {
              logger.info(`[SYNC] Found Palmeiras team: ${palmeiras.name} (ID: ${palmeiras.id}, TLA: ${palmeiras.tla}) in ${comp.name}`);
              return palmeiras.id;
            }
          }
        } else {
          logger.debug(`[SYNC] ${comp.name} not available (${response.status})`);
        }
      } catch (err) {
        logger.debug(`[SYNC] Error searching ${comp.name}:`, err.message);
      }
    }
    
    // Fallback: Try direct team search with Brazilian filter
    logger.info('[SYNC] Trying direct team search...');
    const searchUrl = `https://api.football-data.org/v4/teams?name=${encodeURIComponent('Palmeiras')}`;
    const searchResponse = await fetch(searchUrl, {
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_API_KEY,
        'Accept': 'application/json'
      }
    });
    
    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      if (searchData.teams && searchData.teams.length > 0) {
        // Filter for Brazilian teams only
        const brazilianTeams = searchData.teams.filter(t => 
          (t.area?.name || '').toLowerCase() === 'brazil'
        );
        
        if (brazilianTeams.length > 0) {
          logger.info(`[SYNC] Found ${brazilianTeams.length} Brazilian teams matching "Palmeiras"`);
          const palmeiras = brazilianTeams.find(t => {
            const name = (t.name || '').toLowerCase();
            return name.includes('palmeiras');
          });
          
          if (palmeiras) {
            logger.info(`[SYNC] Found Palmeiras team: ${palmeiras.name} (ID: ${palmeiras.id}, TLA: ${palmeiras.tla})`);
            return palmeiras.id;
          }
        }
      }
    }
    
    logger.warn('[SYNC] Could not find Palmeiras team ID via search');
  } catch (err) {
    logger.warn('[SYNC] Failed to search for team ID', err);
  }
  return null;
}

// Validate environment
function validateEnv() {
  const missing = [];
  if (!FOOTBALL_DATA_API_KEY) missing.push('FOOTBALL_DATA_API_KEY');
  if (!GOOGLE_CREDENTIALS) missing.push('GOOGLE_CREDENTIALS');
  
  if (missing.length > 0) {
    const errorMsg = `Missing environment variables: ${missing.join(', ')}`;
    logger.error('[SYNC] Missing environment variables', new Error(errorMsg));
    throw new Error(errorMsg);
  }
}

// Fetch fixtures from Football-Data.org API
async function fetchPalmeirasFixtures() {
  logger.info('[SYNC] Fetching Palmeiras fixtures from Football-Data.org...');
  
  // Try to verify/find the correct team ID
  let teamId = PALMEIRAS_TEAM_ID_FOOTBALL_DATA;
  const foundTeamId = await findPalmeirasTeamId();
  if (foundTeamId && foundTeamId !== teamId) {
    logger.warn(`[SYNC] Found different team ID (${foundTeamId}) than configured (${teamId}), using found ID`);
    teamId = foundTeamId;
  }
  
  logger.info(`[SYNC] Using team ID: ${teamId}`);
  
  try {
    // Fetch matches from all competitions (the team endpoint returns matches from all competitions)
    // Use dateFrom parameter to get future matches (today onwards)
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const url = `https://api.football-data.org/v4/teams/${teamId}/matches?limit=100&dateFrom=${today}`;
    
    logger.info(`[SYNC] Fetching matches from all competitions for team ${teamId}...`);
    logger.info(`[SYNC] Using dateFrom: ${today} to get future matches`);
    logger.debug('[SYNC] Fetching matches from', url);
    
    const response = await fetch(url, {
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_API_KEY,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Football-Data.org HTTP error: ${response.status} ${response.statusText}. ${errorText}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.errorText = errorText;
      logger.error('[SYNC] Football-Data.org HTTP error', error);
      
      // If 401, provide helpful error message
      if (response.status === 401) {
        const authError = new Error('Football-Data.org authentication failed. Please check your API key. Get a free key at https://www.football-data.org/');
        logger.error('[SYNC] Authentication failed', authError);
        throw authError;
      }
      
      throw error;
    }
    
    const data = await response.json();
    
    // Debug: log what we received
    logger.info(`[SYNC] API returned ${data.matches?.length || 0} total matches`);
    if (data.matches && data.matches.length > 0) {
      const statuses = {};
      const competitions = new Set();
      const teamsInMatches = new Set();
      
      data.matches.forEach(match => {
        statuses[match.status] = (statuses[match.status] || 0) + 1;
        if (match.competition) {
          competitions.add(`${match.competition.name} (${match.competition.code || 'N/A'})`);
        }
        teamsInMatches.add(`${match.homeTeam.name} (ID: ${match.homeTeam.id})`);
        teamsInMatches.add(`${match.awayTeam.name} (ID: ${match.awayTeam.id})`);
      });
      
      logger.info(`[SYNC] Match statuses: ${JSON.stringify(statuses)}`);
      logger.info(`[SYNC] Competitions found: ${Array.from(competitions).join(', ')}`);
      logger.info(`[SYNC] Teams in matches: ${Array.from(teamsInMatches).slice(0, 5).join(', ')}`);
      logger.info(`[SYNC] Looking for team ID: ${teamId}`);
      
      // Check if any matches involve our team
      const matchesWithOurTeam = data.matches.filter(m => 
        m.homeTeam.id === teamId || m.awayTeam.id === teamId
      );
      logger.info(`[SYNC] Matches involving team ID ${teamId}: ${matchesWithOurTeam.length}`);
      
      // Log first few matches with competition info for debugging
      data.matches.slice(0, 5).forEach(match => {
        const involvesOurTeam = match.homeTeam.id === teamId || match.awayTeam.id === teamId;
        const compName = match.competition?.name || 'Unknown';
        logger.info(`[SYNC] Sample match: ${match.homeTeam.name} (${match.homeTeam.id}) vs ${match.awayTeam.name} (${match.awayTeam.id}) - Competition: ${compName} - Status: ${match.status} - Date: ${match.utcDate} - Our team: ${involvesOurTeam ? 'YES' : 'NO'}`);
      });
    }
    
    // Filter for future fixtures only - ignore status, just check date
    const now = new Date();
    logger.info(`[SYNC] Current date/time: ${now.toISOString()} (${now.getTime()})`);
    
    // First, get all Palmeiras matches for debugging
    const palmeirasMatches = (data.matches || []).filter(match => 
      match.homeTeam.id === teamId || match.awayTeam.id === teamId
    );
    logger.info(`[SYNC] Found ${palmeirasMatches.length} total Palmeiras matches`);
    
    // Debug: check first few match dates
    palmeirasMatches.slice(0, 5).forEach((match, idx) => {
      if (!match.utcDate) {
        logger.warn(`[SYNC] Match ${idx + 1} has no utcDate`);
        return;
      }
      const matchDate = new Date(match.utcDate);
      const diff = matchDate.getTime() - now.getTime();
      const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
      const isFuture = matchDate > now;
      logger.info(`[SYNC] Match ${idx + 1}: ${match.utcDate} -> ${matchDate.toISOString()}, diff: ${diffDays} days, isFuture: ${isFuture}`);
    });
    
    // Filter for future matches only
    const futureFixtures = palmeirasMatches.filter(match => {
      // Only check if match date is in the future - ignore status completely
      if (!match.utcDate) return false;
      const matchDate = new Date(match.utcDate);
      return matchDate > now;
    });
    
    logger.info(`[SYNC] Found ${futureFixtures.length} upcoming fixtures for Palmeiras`);
    
    // Store teamId in fixtures for later use
    futureFixtures.forEach(fixture => {
      fixture._teamId = teamId;
    });
    
    return futureFixtures;
  } catch (err) {
    logger.error('[SYNC] Failed to fetch fixtures', err);
    throw err;
  }
}

// Convert Football-Data.org match to Google Calendar event
function fixtureToCalendarEvent(match, teamId = PALMEIRAS_TEAM_ID_FOOTBALL_DATA) {
  // Football-Data.org structure: match.homeTeam, match.awayTeam
  const isHome = match.homeTeam.id === teamId;
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
    const teamId = fixture._teamId || PALMEIRAS_TEAM_ID_FOOTBALL_DATA;
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
      const teamId = f._teamId || PALMEIRAS_TEAM_ID_FOOTBALL_DATA;
      const isHome = f.homeTeam.id === teamId;
      const opponent = isHome ? f.awayTeam.name : f.homeTeam.name;
      const date = new Date(f.utcDate).toLocaleString('pt-BR', { 
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short'
      });
      logger.info(`  ${date} - ${isHome ? '🏠' : '✈️'} vs ${opponent} [${f.competition.name}]`);
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

