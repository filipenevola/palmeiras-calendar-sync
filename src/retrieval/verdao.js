/**
 * Retrieval logic for ptd.verdao.net
 * 
 * This module contains all code related to fetching/scraping match data from verdao.net.
 * To change the data source, create a new retrieval module and update the import in sync.js.
 * All functions here must return matches in the standardized Match format.
 */

import { logger, ensureError } from '../logger.js';
import * as cheerio from 'cheerio';

const VERDAO_BASE_URL = 'https://ptd.verdao.net';

/**
 * Generates the list of pages to scrape based on current year
 * If we're past December 20th, use next year instead
 * @returns {Array<{url: string, competition: string}>}
 */
export function getVerdaoPages() {
  const now = new Date();
  const currentYear = now.getFullYear();
  // If we're past December 20th, use next year for URLs
  const year = (now.getMonth() === 11 && now.getDate() > 20) ? currentYear + 1 : currentYear;
  return [
    { url: `${VERDAO_BASE_URL}/brasileirao-${year}/`, competition: `Brasileirão ${year}` },
    { url: `${VERDAO_BASE_URL}/paulista-${year}/`, competition: `Paulista ${year}` },
    { url: `${VERDAO_BASE_URL}/copa-do-brasil-${year}/`, competition: `Copa do Brasil ${year}` },
    { url: `${VERDAO_BASE_URL}/libertadores-${year}/`, competition: `Libertadores ${year}` },
    { url: `${VERDAO_BASE_URL}/`, competition: 'Próximos Jogos' }, // Home page
  ];
}

const VERDAO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Referer': 'https://www.google.com/',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Fetches HTML from a URL with retry logic
 * Returns null if the page is not found (404), not published yet, or unreachable after retries.
 * @param {string} url - URL to fetch
 * @param {number} retries - Number of retry attempts
 * @returns {Promise<string|null>} - HTML content or null
 */
const FETCH_TIMEOUT_MS = 60_000;

export async function fetchHTML(url, retries = 4) {
  const attemptErrors = [];

  for (let i = 0; i < retries; i++) {
    try {
      logger.info(`[RETRIEVAL] Fetching HTML: ${url} (attempt ${i + 1}/${retries})`);
      const response = await fetch(url, {
        headers: VERDAO_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      
      if (response.ok) {
        const html = await response.text();
        logger.info(`[RETRIEVAL] Success: ${url} - ${html.length} bytes`);
        return html;
      }
      
      if (response.status === 404 || response.status === 410) {
        logger.info(`[RETRIEVAL] Page not found (${response.status}): ${url} - likely not published yet`);
        return null;
      }
      
      const detail = `HTTP ${response.status} (${response.statusText})`;
      attemptErrors.push(detail);
      logger.warn(`[RETRIEVAL] Attempt ${i + 1}/${retries} ${detail} for ${url}`);
    } catch (error) {
      const detail = `${error.name}: ${error.message}`;
      attemptErrors.push(detail);
      logger.warn(`[RETRIEVAL] Attempt ${i + 1}/${retries} failed for ${url}: ${detail}`);
    }
    
    if (i < retries - 1) {
      const delay = 3000 * (i + 1);
      logger.info(`[RETRIEVAL] Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  logger.warn(`[RETRIEVAL] All ${retries} attempts failed for ${url}. Errors: ${attemptErrors.join(' | ')}`);
  return null;
}

/**
 * Creates a Date object representing a date/time in São Paulo timezone
 * verdao.net always uses São Paulo timezone (America/Sao_Paulo)
 * 
 * This function creates a date that represents the given time in São Paulo,
 * regardless of the server's timezone.
 */
function createDateInSaoPaulo(year, month, day, hour, minute) {
  // Create date string in ISO format (without timezone)
  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const hourStr = String(hour).padStart(2, '0');
  const minuteStr = String(minute).padStart(2, '0');
  
  // Create a date representing this time in São Paulo timezone
  // Strategy: Create date in UTC, then calculate São Paulo offset and adjust
  // We'll create a test date to determine the offset for this specific date
  
  // Create a date in UTC representing the São Paulo time
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  
  // Get what this UTC time represents when displayed in São Paulo timezone
  const saoPauloTimeStr = utcDate.toLocaleString('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  
  // Parse the São Paulo time string to get the actual São Paulo time
  // Format: "MM/DD/YYYY, HH:MM"
  const [datePart, timePart] = saoPauloTimeStr.split(', ');
  const [saoPauloMonth, saoPauloDay, saoPauloYear] = datePart.split('/');
  const [saoPauloHour, saoPauloMinute] = timePart.split(':');
  
  // Create a date representing what São Paulo time this UTC date shows
  const saoPauloAsUTC = new Date(Date.UTC(
    parseInt(saoPauloYear),
    parseInt(saoPauloMonth) - 1,
    parseInt(saoPauloDay),
    parseInt(saoPauloHour),
    parseInt(saoPauloMinute)
  ));
  
  // Calculate offset: difference between UTC and what São Paulo shows
  // If São Paulo is UTC-3, then UTC = SãoPaulo + 3 hours
  // offsetMs represents how many ms to add to São Paulo time to get UTC
  const offsetMs = utcDate.getTime() - saoPauloAsUTC.getTime();
  
  // Now create the date we want: São Paulo time converted to UTC
  // We want the UTC time that, when displayed in São Paulo, shows our target time
  // So: UTC = SãoPaulo + offset
  const targetUTC = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(targetUTC.getTime() + offsetMs);
}

function parseDateTime(dateTimeStr, competition) {
  if (/A\s*\/\s*D/i.test(dateTimeStr)) {
    logger.info(`[RETRIEVAL] Skipping match with undefined date/time (A/D): ${dateTimeStr}`);
    return null;
  }

  const match = dateTimeStr.match(/(\d{1,2})\/(\d{1,2})\s*[–-]\s*(\d{1,2})h(\d{2})/);
  if (!match) {
    logger.warn(`[RETRIEVAL] Could not parse date-time: ${dateTimeStr}`);
    return null;
  }
  
  const [, day, month, hour, minute] = match;
  const now = new Date();
  let year = now.getFullYear();
  
  // Extract year from competition name (e.g., "Brasileirão 2026" -> 2026)
  const yearMatch = competition.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }
  
  // Create date in São Paulo timezone (verdao.net always uses São Paulo time)
  let date = createDateInSaoPaulo(year, parseInt(month), parseInt(day), parseInt(hour), parseInt(minute));
  
  // Handle year rollover (if date is in the past and we're in December, it's probably next year)
  if (date < now && now.getMonth() >= 11) {
    date = createDateInSaoPaulo(year + 1, parseInt(month), parseInt(day), parseInt(hour), parseInt(minute));
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
    'Record': 'Record',
    'Cazé': 'Cazé TV',
    'HBO': 'HBO Max',
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
      // Only add if it matches a known channel (case-insensitive)
      const found = Object.entries(channelMap).find(([key, value]) => 
        part.toLowerCase().includes(value.toLowerCase()) || part.toLowerCase().includes(key.toLowerCase())
      );
      if (found) {
        channels.push(found[1]);
      }
      // Don't add unknown values (like stadium names) - they are not broadcast channels
    }
  }
  
  // Only return channels if we found known broadcast channels
  return channels.join(', ');
}

function parseCompetitionTable(html, competition, pageUrl) {
  const $ = cheerio.load(html);
  const matches = [];

  $('table').each((_idx, table) => {
    const $table = $(table);
    const tableText = $table.text().toLowerCase();

    if (!tableText.includes('data') && !tableText.includes('horário') && !tableText.includes('adversário')) {
      return;
    }

    const rows = $table.find('tr').toArray();
    // Detect column layout from header row
    const headerCells = $(rows[0]).find('td, th').map((_i, c) => $(c).text().trim().toLowerCase()).get();
    const hasScoreColumn = headerCells.some(h => h === 'x' || h === 'placar');
    const colOffset = hasScoreColumn ? 1 : 0; // skip score column if present

    for (let ri = 1; ri < rows.length; ri++) {
      const cells = $(rows[ri]).find('td').map((_i, cell) => $(cell).text().trim()).get();
      if (cells.length < 3) continue;

      const dateTimeStr = cells[0];
      const opponent = cells[1];
      const location = cells[2 + colOffset] || '';
      const tv = cells[3 + colOffset] || '';

      if (!dateTimeStr.match(/\d/) ||
          opponent.toLowerCase().includes('adversário') ||
          opponent === 'x' || opponent === '') {
        continue;
      }

      const matchDate = parseDateTime(dateTimeStr, competition);
      if (!matchDate) continue;

      const locationLower = location.toLowerCase();
      const isHome = locationLower.includes('barueri') || locationLower.includes('allianz');
      const cleanOpponent = opponent.trim().replace(/^x\s+/i, '').replace(/\s+x$/i, '').trim();

      matches.push({
        date: matchDate,
        opponent: cleanOpponent,
        location: location.trim(),
        broadcast: parseBroadcast(tv),
        competition,
        isHome,
        source: pageUrl,
      });
    }
  });

  return matches;
}

function parseHomePage(html, _fallbackCompetition, pageUrl) {
  const $ = cheerio.load(html);
  const matches = [];

  // Find the specific table that has "PRÓXIMOS JOGOS" in a header cell
  $('table').each((_idx, table) => {
    const $table = $(table);
    const headerRow = $table.find('tr').first();
    if (!headerRow.text().includes('PRÓXIMOS JOGOS')) return;

    $table.find('tr').each((_ri, row) => {
      const $row = $(row);
      const tds = $row.find('td');
      if (tds.length < 3) return;

      // Middle cell HTML: "18/03 | 19h00 | <a>Brasileirão</a><br>Allianz Parque | Sportv"
      const middleTd = tds.eq(1);
      // Replace <br> with \n so we can split properly
      const middleHtml = middleTd.html() || '';
      const middleText = middleHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

      const dateMatch = middleText.match(/(\d{1,2})\/(\d{1,2})\s*\|\s*(\d{1,2})h(\d{2})/);
      if (!dateMatch) return;

      const [, day, month, hour, minute] = dateMatch;
      const dateTimeStr = `${day}/${month} – ${hour}h${minute}`;

      // Extract competition from <a> tag
      const competitionLink = middleTd.find('a').first();
      const competition = competitionLink.text().trim() || 'Brasileirão';
      const yearSuffix = new Date().getFullYear();

      const matchDate = parseDateTime(dateTimeStr, `${competition} ${yearSuffix}`);
      if (!matchDate) return;

      // Get team images: [left team, right team]
      const imgs = $row.find('img[alt]').map((_i, img) => $(img).attr('alt')).get();
      const leftTeam = imgs[0] || '';
      const rightTeam = imgs[imgs.length - 1] || '';

      const isPalmeirasLeft = leftTeam === 'Palmeiras';
      const opponent = isPalmeirasLeft ? rightTeam : leftTeam;
      if (!opponent || opponent === 'Palmeiras') return;

      // Parse venue and broadcast from the last line (after competition name)
      // Lines: ["18/03 | 19h00 |", "Brasileirão", "Allianz Parque | Sportv"]
      const lines = middleText.split('\n').map(l => l.trim()).filter(Boolean);
      let location = '';
      let broadcast = '';
      const venueLine = lines.find(l => !l.match(/\d{1,2}\/\d{1,2}/) && l.includes('|'));
      if (venueLine) {
        const infoParts = venueLine.split('|').map(p => p.trim());
        location = infoParts[0] || '';
        broadcast = infoParts.slice(1).join(', ');
      }

      const locationLower = location.toLowerCase();
      const isHome = isPalmeirasLeft ||
                     locationLower.includes('barueri') ||
                     locationLower.includes('allianz');

      matches.push({
        date: matchDate,
        opponent: opponent.trim(),
        location: location.trim(),
        broadcast: parseBroadcast(broadcast),
        competition: `${competition} ${yearSuffix}`,
        isHome,
        source: pageUrl,
      });
    });
  });

  return matches;
}

function parseMatchesFromHTML(html, competition, pageUrl) {
  const isHomePage = pageUrl.endsWith('verdao.net/') || pageUrl.endsWith('verdao.net');
  if (isHomePage) {
    return parseHomePage(html, competition, pageUrl);
  }
  return parseCompetitionTable(html, competition, pageUrl);
}

/**
 * Retrieves Palmeiras fixtures from ptd.verdao.net
 * @returns {Promise<Match[]>} Array of matches in standardized format
 */
export async function fetchPalmeirasFixtures() {
  logger.info('[RETRIEVAL] Fetching Palmeiras fixtures from ptd.verdao.net...');
  
  try {
    const now = new Date();
    logger.info(`[RETRIEVAL] Current date/time: ${now.toISOString()}`);
    
    const allMatches = [];
    const pages = getVerdaoPages();
    
    for (const page of pages) {
      try {
        logger.info(`[RETRIEVAL] Fetching ${page.competition} from ${page.url}...`);
        const html = await fetchHTML(page.url);
        
        if (html === null) {
          logger.info(`[RETRIEVAL] Skipping ${page.competition} - page not available or unreachable`);
          continue;
        }
        
        const matches = parseMatchesFromHTML(html, page.competition, page.url);
        
        logger.info(`[RETRIEVAL] Found ${matches.length} matches from ${page.competition}`);
        allMatches.push(...matches);
        
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        logger.warn(`[RETRIEVAL] Error processing ${page.competition}: ${err.message}`);
      }
    }
    
    logger.info(`[RETRIEVAL] Total matches found: ${allMatches.length}`);
    return allMatches;
  } catch (err) {
    const error = ensureError(err);
    logger.error('[RETRIEVAL] Failed to fetch fixtures', error);
    throw err;
  }
}

