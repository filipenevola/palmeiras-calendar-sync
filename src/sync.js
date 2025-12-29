import { google } from 'googleapis';
import { logger } from './logger.js';
import { saveRunStatus } from './storage.js';
import * as cheerio from 'cheerio';

// ============================================================================
// STANDARDIZED MATCH FORMAT
// ============================================================================
// All retrieval logic must return matches in this format.
// This allows swapping retrieval implementations without affecting calendar sync.
/**
 * @typedef {Object} Match
 * @property {Date} date - Match date/time (JavaScript Date object)
 * @property {string} opponent - Opponent team name
 * @property {boolean} isHome - true if Palmeiras is playing at home
 * @property {string} competition - Competition name (e.g., "Brasileirão 2026", "Paulista 2026")
 * @property {string} location - Venue/location name
 * @property {string} broadcast - Broadcast channels (e.g., "Record, Cazé TV") - optional
 * @property {string} source - Source identifier for debugging (e.g., "ptd.verdao.net")
 */

// ============================================================================
// CONFIGURATION
// ============================================================================
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // Base64 encoded service account JSON
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// ============================================================================
// RETRIEVAL LOGIC - ISOLATED FROM CALENDAR SYNC
// ============================================================================
// This section contains all code related to fetching/scraping match data.
// To change the data source, only modify functions in this section.
// All functions here must return matches in the standardized Match format above.

const VERDAO_BASE_URL = 'https://ptd.verdao.net';
const VERDAO_PAGES = [
  { url: `${VERDAO_BASE_URL}/brasileirao-2026/`, competition: 'Brasileirão 2026' },
  { url: `${VERDAO_BASE_URL}/paulista-2026/`, competition: 'Paulista 2026' },
  { url: `${VERDAO_BASE_URL}/copa-do-brasil-2025/`, competition: 'Copa do Brasil 2025' },
  { url: `${VERDAO_BASE_URL}/libertadores-2025/`, competition: 'Libertadores 2025' },
  { url: `${VERDAO_BASE_URL}/`, competition: 'Próximos Jogos' }, // Home page
];

const VERDAO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://ptd.verdao.net/',
  'Cache-Control': 'no-cache'
};

async function fetchHTML(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      logger.debug(`[RETRIEVAL] Fetching HTML: ${url} (attempt ${i + 1}/${retries})`);
      const response = await fetch(url, { headers: VERDAO_HEADERS });
      
      if (response.ok) {
        const html = await response.text();
        logger.debug(`[RETRIEVAL] Success! Got ${html.length} bytes`);
        return html;
      }
      
      logger.warn(`[RETRIEVAL] HTTP ${response.status} - ${response.statusText}`);
    } catch (error) {
      logger.warn(`[RETRIEVAL] Attempt ${i + 1} failed: ${error.message}`);
    }
    
    if (i < retries - 1) {
      const delay = 1000 * (i + 1);
      logger.debug(`[RETRIEVAL] Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Failed to fetch HTML after ${retries} attempts`);
}

function parseDateTime(dateTimeStr, competition) {
  const match = dateTimeStr.match(/(\d{1,2})\/(\d{1,2})\s*[–-]\s*(\d{1,2})h(\d{2})/);
  if (!match) {
    logger.warn(`[RETRIEVAL] Could not parse date-time: ${dateTimeStr}`);
    return null;
  }
  
  const [, day, month, hour, minute] = match;
  const now = new Date();
  let year = now.getFullYear();
  
  if (competition.includes('2026')) {
    year = 2026;
  } else if (competition.includes('2025')) {
    year = 2025;
  }
  
  let date = new Date(year, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));
  
  if (date < now && now.getMonth() >= 11) {
    date = new Date(year + 1, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));
  }
  
  return date;
}

function parseBroadcast(tvText) {
  if (!tvText || tvText.trim() === '') return '';
  
  const channelMap = {
    '1': 'Record',
    '2': 'Cazé TV',
    '3': 'TNT',
    '4': 'HBO Max',
    'Globo': 'Globo',
    'Sportv': 'Sportv',
    'Premiere': 'Premiere',
    'Amazon Prime': 'Amazon Prime',
  };
  
  const channels = [];
  const parts = tvText.split(/[,\|]/).map(p => p.trim());
  
  for (const part of parts) {
    if (channelMap[part]) {
      channels.push(channelMap[part]);
    } else if (part.match(/^\d+$/)) {
      if (channelMap[part]) {
        channels.push(channelMap[part]);
      }
    } else {
      const found = Object.entries(channelMap).find(([key, value]) => 
        part.toLowerCase().includes(value.toLowerCase()) || part.toLowerCase().includes(key.toLowerCase())
      );
      if (found) {
        channels.push(found[1]);
      } else {
        channels.push(part);
      }
    }
  }
  
  return channels.length > 0 ? channels.join(', ') : tvText;
}

function parseMatchesFromHTML(html, competition, pageUrl) {
  const $ = cheerio.load(html);
  const matches = [];
  
  $('table').each((idx, table) => {
    const $table = $(table);
    const tableText = $table.text().toLowerCase();
    
    if (!tableText.includes('data') && !tableText.includes('horário') && !tableText.includes('adversário')) {
      return;
    }
    
    $table.find('tr').each((rowIdx, row) => {
      const $row = $(row);
      const cells = $row.find('td').map((i, cell) => $(cell).text().trim()).get();
      
      if (cells.length < 3) return;
      
      const dateTimeStr = cells[0];
      const opponent = cells[1];
      const location = cells[2] || '';
      const tv = cells[3] || '';
      
      if (dateTimeStr.toLowerCase().includes('data') || 
          dateTimeStr.toLowerCase().includes('horário') ||
          opponent.toLowerCase().includes('adversário') ||
          opponent === 'x' || opponent === '' ||
          dateTimeStr === '' || !dateTimeStr.match(/\d/)) {
        return;
      }
      
      const matchDate = parseDateTime(dateTimeStr, competition);
      if (!matchDate) return;
      
      const locationLower = location.toLowerCase();
      const isHome = locationLower.includes('barueri') || 
                     locationLower.includes('allianz');
      
      matches.push({
        date: matchDate,
        opponent: opponent.trim(),
        location: location.trim(),
        broadcast: parseBroadcast(tv),
        competition: competition,
        isHome: isHome,
        source: pageUrl
      });
    });
  });
  
  // Also check for "PRÓXIMOS JOGOS" section on home page
  if (pageUrl.includes('verdao.net/') && !pageUrl.includes('/brasileirao') && 
      !pageUrl.includes('/paulista') && !pageUrl.includes('/copa') && !pageUrl.includes('/libertadores')) {
    $('*:contains("PRÓXIMOS JOGOS")').each((idx, elem) => {
      const $section = $(elem).closest('section, div, table');
      $section.find('tr, div').each((rowIdx, row) => {
        const $row = $(row);
        const text = $row.text();
        
        const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})\s*[|]\s*(\d{1,2})h(\d{2})/);
        if (dateMatch) {
          const [, day, month, hour, minute] = dateMatch;
          const dateTimeStr = `${day}/${month} – ${hour}h${minute}`;
          const matchDate = parseDateTime(dateTimeStr, competition);
          
          if (!matchDate) return;
          
          const opponentImg = $row.find('img[alt]').last();
          const opponent = opponentImg.attr('alt') || '';
          
          if (opponent && opponent !== 'Palmeiras' && opponent.trim() !== '') {
            const locationMatch = text.match(/\[([^\]]+)\]/);
            const location = locationMatch ? locationMatch[1] : '';
            const broadcastMatch = text.match(/(Record|Cazé|TNT|HBO|Globo|Sportv|Premiere|Amazon)/g);
            const broadcast = broadcastMatch ? broadcastMatch.join(', ') : '';
            
            const locationLower = location.toLowerCase();
            const isHome = locationLower.includes('barueri') || 
                           locationLower.includes('allianz') ||
                           (!locationLower.includes('canindé') && !locationLower.includes('novo horizonte') && !locationLower.includes('itaquera'));
            
            matches.push({
              date: matchDate,
              opponent: opponent.trim(),
              location: location.trim(),
              broadcast: parseBroadcast(broadcast),
              competition: competition,
              isHome: isHome,
              source: pageUrl
            });
          }
        }
      });
    });
  }
  
  return matches;
}

/**
 * Retrieves Palmeiras fixtures from ptd.verdao.net
 * @returns {Promise<Match[]>} Array of matches in standardized format
 */
async function fetchPalmeirasFixtures() {
  logger.info('[RETRIEVAL] Fetching Palmeiras fixtures from ptd.verdao.net...');
  
  try {
    const now = new Date();
    logger.info(`[RETRIEVAL] Current date/time: ${now.toISOString()}`);
    
    const allMatches = [];
    
    for (const page of VERDAO_PAGES) {
      try {
        logger.info(`[RETRIEVAL] Fetching ${page.competition} from ${page.url}...`);
        const html = await fetchHTML(page.url);
        const matches = parseMatchesFromHTML(html, page.competition, page.url);
        
        logger.info(`[RETRIEVAL] Found ${matches.length} matches from ${page.competition}`);
        allMatches.push(...matches);
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.warn(`[RETRIEVAL] Failed to fetch ${page.competition}:`, err.message);
      }
    }
    
    logger.info(`[RETRIEVAL] Total matches found: ${allMatches.length}`);
    return allMatches;
  } catch (err) {
    logger.error('[RETRIEVAL] Failed to fetch fixtures', err);
    throw err;
  }
}

// ============================================================================
// MATCH PROCESSING - FILTERS AND PROCESSES MATCHES
// ============================================================================
// This section processes matches from retrieval logic before syncing to calendar.
// Works with standardized Match format.

/**
 * Filters and processes matches: removes past matches, deduplicates, sorts
 * @param {Match[]} matches - Raw matches from retrieval logic
 * @returns {Match[]} Processed matches ready for calendar sync
 */
function processMatches(matches) {
  const now = new Date();
  
  // Filter for future matches only
  const futureMatches = matches.filter(match => match.date > now);
  
  // Remove duplicates (same date + opponent)
  const uniqueMatches = [];
  const seen = new Set();
  
  for (const match of futureMatches) {
    const key = `${match.date.toISOString()}_${match.opponent}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueMatches.push(match);
    }
  }
  
  // Sort by date
  uniqueMatches.sort((a, b) => a.date.getTime() - b.date.getTime());
  
  logger.info(`[PROCESSING] Processed ${matches.length} matches: ${uniqueMatches.length} unique upcoming fixtures`);
  
  // Log first few matches
  uniqueMatches.slice(0, 5).forEach((match, idx) => {
    const diff = match.date.getTime() - now.getTime();
    const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
    logger.info(`[PROCESSING] Match ${idx + 1}: ${match.isHome ? '🏠' : '✈️'} vs ${match.opponent} - ${match.competition} - Date: ${match.date.toISOString()}, diff: ${diffDays} days${match.broadcast ? ` - TV: ${match.broadcast}` : ''}`);
  });
  
  return uniqueMatches;
}

// ============================================================================
// CALENDAR SYNC LOGIC - CONVERTS MATCHES TO CALENDAR EVENTS
// ============================================================================
// This section converts standardized Match format to Google Calendar events.
// Works only with standardized Match format - independent of retrieval logic.

/**
 * Converts a Match to a Google Calendar event
 * @param {Match} match - Match in standardized format
 * @returns {Object} Google Calendar event resource
 */
function matchToCalendarEvent(match) {
  const venue = match.isHome ? '🏠' : '✈️';
  const startDateTime = match.date;
  const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours
  
  let summary = `${venue} Palmeiras vs ${match.opponent}`;
  if (match.broadcast) {
    summary += ` 📺 ${match.broadcast}`;
  }
  
  return {
    summary: summary,
    description: [
      `⚽ ${match.competition}`,
      `📍 ${match.location || 'TBD'}`,
      match.broadcast ? `📺 ${match.broadcast}` : '',
      ``,
      `Source: ${match.source}`,
      `Match Date: ${startDateTime.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
    ].filter(Boolean).join('\n'),
    location: match.location || '',
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
        fixtureId: `${match.date.toISOString()}_${match.opponent}_${match.competition}`,
      }
    }
  };
}

async function getCalendarClient() {
  try {
    const credentials = JSON.parse(
      Buffer.from(GOOGLE_CREDENTIALS, 'base64').toString('utf-8')
    );
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    
    logger.info('[CALENDAR] Google Calendar client initialized successfully');
    return google.calendar({ version: 'v3', auth });
  } catch (err) {
    logger.error('[CALENDAR] Failed to initialize Google Calendar client', err);
    throw err;
  }
}

async function getExistingEvents(calendar) {
  try {
    const now = new Date();
    const response = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      maxResults: 2500,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const palmeirasEvents = (response.data.items || []).filter(event => 
      event.extendedProperties?.private?.palmeirasSync === 'true'
    );
    
    const fixtureMap = new Map();
    for (const event of palmeirasEvents) {
      const fixtureId = event.extendedProperties?.private?.fixtureId;
      if (fixtureId) {
        fixtureMap.set(fixtureId, event.id);
      }
    }
    
    logger.info(`[CALENDAR] Found ${fixtureMap.size} existing Palmeiras events in calendar`);
    return fixtureMap;
  } catch (err) {
    logger.error('[CALENDAR] Failed to fetch existing events', err);
    throw err;
  }
}

/**
 * Syncs matches to Google Calendar
 * @param {Match[]} matches - Matches in standardized format
 * @returns {Promise<Object>} Sync result with counts
 */
async function syncMatchesToCalendar(matches) {
  logger.info('[CALENDAR] Starting calendar sync...');
  
  const calendar = await getCalendarClient();
  const existingEvents = await getExistingEvents(calendar);
  
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  
  for (const match of matches) {
    const event = matchToCalendarEvent(match);
    const fixtureId = event.extendedProperties.private.fixtureId;
    const existingEventId = existingEvents.get(fixtureId);
    
    try {
      if (existingEventId) {
        await calendar.events.update({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: existingEventId,
          resource: event,
        });
        logger.info(`[CALENDAR] Updated: ${event.summary}`);
        updated++;
      } else {
        await calendar.events.insert({
          calendarId: GOOGLE_CALENDAR_ID,
          resource: event,
        });
        logger.info(`[CALENDAR] Created: ${event.summary}`);
        created++;
      }
    } catch (err) {
      const errorMsg = `${event.summary} - ${err.message}`;
      err.fixture = event.summary;
      err.fixtureId = fixtureId;
      logger.error(`[CALENDAR] Failed to sync event: ${errorMsg}`, err);
      errors.push({ fixture: event.summary, error: err.message });
      skipped++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return {
    created,
    updated,
    skipped,
    errors,
    total: matches.length
  };
}

// ============================================================================
// MAIN SYNC FUNCTION - ORCHESTRATES RETRIEVAL, PROCESSING, AND SYNC
// ============================================================================

function validateEnv() {
  const missing = [];
  if (!GOOGLE_CREDENTIALS) missing.push('GOOGLE_CREDENTIALS');
  
  if (missing.length > 0) {
    const errorMsg = `Missing environment variables: ${missing.join(', ')}`;
    logger.error('[SYNC] Missing environment variables', new Error(errorMsg));
    throw new Error(errorMsg);
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
    
    logger.error('❌ Sync failed', err);
    await saveRunStatus(result);
    throw err;
  }
}
