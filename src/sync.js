import { google } from 'googleapis';
import { logger } from './logger.js';
import { saveRunStatus } from './storage.js';
import * as cheerio from 'cheerio';

// Configuration
const VERDAO_BASE_URL = 'https://ptd.verdao.net';
const VERDAO_PAGES = [
  { url: `${VERDAO_BASE_URL}/brasileirao-2026/`, competition: 'Brasileirão 2026' },
  { url: `${VERDAO_BASE_URL}/paulista-2026/`, competition: 'Paulista 2026' },
  { url: `${VERDAO_BASE_URL}/copa-do-brasil-2025/`, competition: 'Copa do Brasil 2025' },
  { url: `${VERDAO_BASE_URL}/libertadores-2025/`, competition: 'Libertadores 2025' },
  { url: `${VERDAO_BASE_URL}/`, competition: 'Próximos Jogos' }, // Home page
];
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // Base64 encoded service account JSON
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Headers for verdao.net requests
const VERDAO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://ptd.verdao.net/',
  'Cache-Control': 'no-cache'
};

// Helper function to fetch HTML with retry logic
async function fetchHTML(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      logger.debug(`[SYNC] Fetching HTML: ${url} (attempt ${i + 1}/${retries})`);
      const response = await fetch(url, { headers: VERDAO_HEADERS });
      
      if (response.ok) {
        const html = await response.text();
        logger.debug(`[SYNC] Success! Got ${html.length} bytes`);
        return html;
      }
      
      logger.warn(`[SYNC] HTTP ${response.status} - ${response.statusText}`);
    } catch (error) {
      logger.warn(`[SYNC] Attempt ${i + 1} failed: ${error.message}`);
    }
    
    if (i < retries - 1) {
      const delay = 1000 * (i + 1);
      logger.debug(`[SYNC] Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Failed to fetch HTML after ${retries} attempts`);
}

// Parse date-time string from verdao.net format (e.g., "10/1 – 20h30" or "10/01 – 20h30")
function parseDateTime(dateTimeStr, competition) {
  // Format: "10/1 – 20h30" or "10/01 – 20h30"
  const match = dateTimeStr.match(/(\d{1,2})\/(\d{1,2})\s*[–-]\s*(\d{1,2})h(\d{2})/);
  if (!match) {
    logger.warn(`[SYNC] Could not parse date-time: ${dateTimeStr}`);
    return null;
  }
  
  const [, day, month, hour, minute] = match;
  const now = new Date();
  let year = now.getFullYear();
  
  // Determine year based on competition
  if (competition.includes('2026')) {
    year = 2026;
  } else if (competition.includes('2025')) {
    year = 2025;
  } else {
    // Default to current year, but if date is in the past, assume next year
    year = now.getFullYear();
  }
  
  // Create date in America/Sao_Paulo timezone
  let date = new Date(year, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));
  
  // If the date is in the past and we're in December/January, it might be next year
  if (date < now && now.getMonth() >= 11) {
    date = new Date(year + 1, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));
  }
  
  return date;
}

// Parse broadcast channels from TV column
function parseBroadcast(tvText) {
  if (!tvText || tvText.trim() === '') return '';
  
  // Map common channel names
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
  
  // Extract channel numbers/names
  const channels = [];
  const parts = tvText.split(/[,\|]/).map(p => p.trim());
  
  for (const part of parts) {
    if (channelMap[part]) {
      channels.push(channelMap[part]);
    } else if (part.match(/^\d+$/)) {
      // Just a number
      if (channelMap[part]) {
        channels.push(channelMap[part]);
      }
    } else {
      // Try to find channel name
      const found = Object.entries(channelMap).find(([key, value]) => 
        part.toLowerCase().includes(value.toLowerCase()) || part.toLowerCase().includes(key.toLowerCase())
      );
      if (found) {
        channels.push(found[1]);
      } else {
        channels.push(part); // Keep original if not found
      }
    }
  }
  
  return channels.length > 0 ? channels.join(', ') : tvText;
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

// Parse matches from verdao.net HTML table
function parseMatchesFromHTML(html, competition, pageUrl) {
  const $ = cheerio.load(html);
  const matches = [];
  
  // Try to find the table with matches
  // Look for tables containing "Jogos do Palmeiras" or similar
  $('table').each((idx, table) => {
    const $table = $(table);
    const tableText = $table.text().toLowerCase();
    
    // Check if this table contains match data (has "Data-Horário" or "Adversário" headers)
    if (!tableText.includes('data') && !tableText.includes('horário') && !tableText.includes('adversário')) {
      return; // Skip this table
    }
    
    // Parse table rows
    $table.find('tr').each((rowIdx, row) => {
      const $row = $(row);
      const cells = $row.find('td').map((i, cell) => $(cell).text().trim()).get();
      
      // Need at least 3 columns: Date-Time, Opponent, Location
      if (cells.length < 3) return;
      
      const dateTimeStr = cells[0];
      const opponent = cells[1];
      const location = cells[2] || '';
      const tv = cells[3] || ''; // Broadcast info
      
      // Skip header rows
      if (dateTimeStr.toLowerCase().includes('data') || 
          dateTimeStr.toLowerCase().includes('horário') ||
          opponent.toLowerCase().includes('adversário') ||
          opponent === 'x' || opponent === '' ||
          dateTimeStr === '' || !dateTimeStr.match(/\d/)) {
        return;
      }
      
      // Parse date-time
      const matchDate = parseDateTime(dateTimeStr, competition);
      if (!matchDate) return;
      
      // Determine if Palmeiras is home or away
      // Home locations: Barueri, Allianz Parque
      // Away locations: Canindé, Novo Horizonte, Itaquera, Ribeirão Preto, etc.
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
    // Home page - look for "PRÓXIMOS JOGOS" section
    $('*:contains("PRÓXIMOS JOGOS")').each((idx, elem) => {
      const $section = $(elem).closest('section, div, table');
      $section.find('tr, div').each((rowIdx, row) => {
        const $row = $(row);
        const text = $row.text();
        
        // Look for date pattern (format: "10/01 | 20h30")
        const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})\s*[|]\s*(\d{1,2})h(\d{2})/);
        if (dateMatch) {
          const [, day, month, hour, minute] = dateMatch;
          const dateTimeStr = `${day}/${month} – ${hour}h${minute}`;
          const matchDate = parseDateTime(dateTimeStr, competition);
          
          if (!matchDate) return;
          
          // Extract opponent (look for team name or image alt)
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

// Fetch fixtures from verdao.net
async function fetchPalmeirasFixtures() {
  logger.info('[SYNC] Fetching Palmeiras fixtures from ptd.verdao.net...');
  
  try {
    const now = new Date();
    logger.info(`[SYNC] Current date/time: ${now.toISOString()} (${now.getTime()})`);
    
    const allMatches = [];
    
    // Fetch from all pages
    for (const page of VERDAO_PAGES) {
      try {
        logger.info(`[SYNC] Fetching ${page.competition} from ${page.url}...`);
        const html = await fetchHTML(page.url);
        const matches = parseMatchesFromHTML(html, page.competition, page.url);
        
        logger.info(`[SYNC] Found ${matches.length} matches from ${page.competition}`);
        allMatches.push(...matches);
        
        // Small delay between requests
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.warn(`[SYNC] Failed to fetch ${page.competition}:`, err.message);
      }
    }
    
    logger.info(`[SYNC] Total matches found: ${allMatches.length}`);
    
    // Filter for future matches only
    const futureFixtures = allMatches.filter(match => {
      return match.date > now;
    });
    
    // Remove duplicates (same date + opponent)
    const uniqueFixtures = [];
    const seen = new Set();
    
    for (const fixture of futureFixtures) {
      const key = `${fixture.date.toISOString()}_${fixture.opponent}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueFixtures.push(fixture);
      }
    }
    
    // Sort by date
    uniqueFixtures.sort((a, b) => a.date.getTime() - b.date.getTime());
    
    logger.info(`[SYNC] Found ${uniqueFixtures.length} unique upcoming fixtures for Palmeiras`);
    
    // Log first few matches
    uniqueFixtures.slice(0, 5).forEach((match, idx) => {
      const diff = match.date.getTime() - now.getTime();
      const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
      logger.info(`[SYNC] Match ${idx + 1}: ${match.isHome ? '🏠' : '✈️'} vs ${match.opponent} - ${match.competition} - Date: ${match.date.toISOString()}, diff: ${diffDays} days${match.broadcast ? ` - TV: ${match.broadcast}` : ''}`);
    });
    
    return uniqueFixtures;
  } catch (err) {
    logger.error('[SYNC] Failed to fetch fixtures', err);
    throw err;
  }
}

// Convert verdao.net match to Google Calendar event
function fixtureToCalendarEvent(match) {
  // verdao.net structure: match.date, match.opponent, match.location, match.broadcast, match.competition, match.isHome
  const venue = match.isHome ? '🏠' : '✈️';
  const startDateTime = match.date;
  const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours
  
  // Build title with broadcast info if available
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
      `Source: ptd.verdao.net`,
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
    const event = fixtureToCalendarEvent(fixture);
    const fixtureId = event.extendedProperties.private.fixtureId;
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
      const date = f.date.toLocaleString('pt-BR', { 
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short'
      });
      logger.info(`  ${date} - ${f.isHome ? '🏠' : '✈️'} vs ${f.opponent} [${f.competition}]${f.broadcast ? ` 📺 ${f.broadcast}` : ''}`);
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

