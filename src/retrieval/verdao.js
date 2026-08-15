/**
 * Retrieval logic for ptd.verdao.net
 * 
 * This module contains all code related to fetching/scraping match data from verdao.net.
 * To change the data source, create a new retrieval module and update the import in sync.js.
 * All functions here must return matches in the standardized Match format.
 */

import { logger, ensureError } from '../logger.js';
import { normalizeOpponentName } from '../processing.js';
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

const VERDAO_BASE_URL = 'https://ptd.verdao.net';

/**
 * Generates the list of pages to scrape based on the current season.
 * The Paulista page is seasonal: after March, omit the dedicated page until
 * the next season is published, while the other competitions remain on the
 * current calendar year until the December rollover.
 * @returns {Array<{url: string, competition: string}>}
 */
export function getVerdaoPages(now = new Date()) {
  const currentYear = now.getFullYear();
  // If we're past December 20th, use next year for URLs
  const year = (now.getMonth() === 11 && now.getDate() > 20) ? currentYear + 1 : currentYear;
  const pages = [
    { url: `${VERDAO_BASE_URL}/brasileirao-${year}/`, competition: `Brasileirão ${year}` },
    { url: `${VERDAO_BASE_URL}/copa-do-brasil-${year}/`, competition: `Copa do Brasil ${year}` },
    { url: `${VERDAO_BASE_URL}/libertadores-${year}/`, competition: `Libertadores ${year}` },
    { url: `${VERDAO_BASE_URL}/`, competition: 'Próximos Jogos' }, // Home page
  ];

  // The current Paulista edition is over after March. Avoid requesting the
  // unpublished next edition until the December rollover, when its page may
  // become available again.
  const isPaulistaSeason = now.getMonth() <= 2 || (now.getMonth() === 11 && now.getDate() > 20);
  if (isPaulistaSeason) {
    pages.splice(1, 0, {
      url: `${VERDAO_BASE_URL}/paulista-${year}/`,
      competition: `Paulista ${year}`,
    });
  }

  return pages;
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
// Verdão normally answers in well under a second. A 60-second timeout with four
// attempts made one temporary network blackhole consume four minutes per page
// (and produced a Slack message for every attempt). Keep the live probe short
// and fall back to the last successful response instead.
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_RETRIES = 2;
const CACHE_DIR_NAME = 'verdao-html-cache';

function getCacheDir() {
  return join(process.env.DATA_DIR || '/data', CACHE_DIR_NAME);
}

function getCacheFile(url) {
  const key = createHash('sha256').update(url).digest('hex');
  return join(getCacheDir(), `${key}.json`);
}

async function saveCachedHTML(url, html) {
  const cacheDir = getCacheDir();
  const cacheFile = getCacheFile(url);
  const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(temporaryFile, JSON.stringify({ url, savedAt: new Date().toISOString(), html }), 'utf-8');
  await rename(temporaryFile, cacheFile);
}

async function readCachedHTML(url) {
  try {
    const cached = JSON.parse(await readFile(getCacheFile(url), 'utf-8'));
    if (cached.url !== url || typeof cached.html !== 'string' || !cached.html) return null;
    return cached;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.info(`[RETRIEVAL] Ignoring unreadable cache for ${url}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Decodes an HTTP response body respecting its charset.
 * ptd.verdao.net pages are UTF-8, but the embedded fixtures iframe
 * (www.verdao.net/campeonato_base.php) is served as windows-1252.
 * @param {ArrayBuffer} buffer
 * @param {string|null} contentType
 * @returns {string}
 */
function decodeResponseBody(buffer, contentType) {
  const bytes = new Uint8Array(buffer);
  let charset = null;

  const ctMatch = (contentType || '').toLowerCase().match(/charset=["']?([\w-]+)/);
  if (ctMatch) {
    charset = ctMatch[1];
  } else {
    // No charset header (campeonato_base.php); sniff the <meta> tag from the head bytes.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096)).toLowerCase();
    const metaMatch = head.match(/charset=["']?([\w-]+)/);
    if (metaMatch) charset = metaMatch[1];
  }

  if (charset && /(1252|8859-1|latin1)/.test(charset)) charset = 'windows-1252';
  if (!charset) charset = 'utf-8';

  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function fetchHTML(url, retries = DEFAULT_FETCH_RETRIES) {
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
        const buffer = await response.arrayBuffer();
        const html = decodeResponseBody(buffer, response.headers.get('content-type'));
        logger.info(`[RETRIEVAL] Success: ${url} - ${html.length} chars`);
        return html;
      }
      
      if (response.status === 404 || response.status === 410) {
        logger.info(`[RETRIEVAL] Page not found (${response.status}): ${url} - likely not published yet`);
        return null;
      }
      
      const detail = `HTTP ${response.status} (${response.statusText})`;
      attemptErrors.push(detail);
      logger.info(`[RETRIEVAL] Attempt ${i + 1}/${retries} ${detail} for ${url}`);
    } catch (error) {
      const detail = `${error.name}: ${error.message}`;
      attemptErrors.push(detail);
      logger.info(`[RETRIEVAL] Attempt ${i + 1}/${retries} failed for ${url}: ${detail}`);
    }
    
    if (i < retries - 1) {
      const delay = 3000 * (i + 1);
      logger.info(`[RETRIEVAL] Waiting ${delay}ms before retry...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  logger.info(`[RETRIEVAL] All ${retries} attempts failed for ${url}. Errors: ${attemptErrors.join(' | ')}`);
  return null;
}

/**
 * Fetches a page and persists every successful response. When ptd.verdao.net
 * temporarily blackholes the Quave ONE pod, use the last known-good HTML so a
 * transient source outage cannot turn a healthy calendar into an empty sync.
 */
export async function fetchHTMLWithCache(url, retries = DEFAULT_FETCH_RETRIES) {
  const html = await fetchHTML(url, retries);
  if (html) {
    try {
      await saveCachedHTML(url, html);
    } catch (error) {
      logger.info(`[RETRIEVAL] Could not update cache for ${url}: ${error.message}`);
    }
    return { html, source: 'live', savedAt: null };
  }

  const cached = await readCachedHTML(url);
  if (cached) {
    const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(cached.savedAt)) / 60_000));
    logger.info(`[RETRIEVAL] Using cached HTML for ${url} (${ageMinutes} minutes old)`);
    return { html: cached.html, source: 'cache', savedAt: cached.savedAt };
  }

  return { html: null, source: 'unavailable', savedAt: null };
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
      const isHome =
        locationLower.includes('barueri') ||
        locationLower.includes('allianz') ||
        locationLower.includes('nubank');
      const cleanOpponent = normalizeOpponentName(
        opponent.trim().replace(/^x\s+/i, '').replace(/\s+x$/i, '').trim()
      );

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
      const isHome =
        isPalmeirasLeft ||
        locationLower.includes('barueri') ||
        locationLower.includes('allianz') ||
        locationLower.includes('nubank');

      matches.push({
        date: matchDate,
        opponent: normalizeOpponentName(opponent.trim()),
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

/** A real campeonato_base fixture date cell, e.g. "26/07 - 19h30". */
const CAMPEONATO_DATE_RE = /\d{1,2}\/\d{1,2}\s*[-–]\s*\d{1,2}h\d{2}/;

/**
 * Broadcast channel legend used by www.verdao.net/campeonato_base.php.
 * (Different from the homepage codes handled in parseBroadcast.)
 */
const CAMPEONATO_TV_CODES = {
  '1': 'Globo',
  '2': 'Record',
  '3': 'Sportv',
  '4': 'Amazon Prime',
  '5': 'YouTube',
  '6': 'Premiere',
};

function parseCampeonatoBroadcast(tvText) {
  const codes = (tvText || '').match(/\d/g);
  if (!codes) return '';
  const channels = [];
  const seen = new Set();
  for (const code of codes) {
    const name = CAMPEONATO_TV_CODES[code];
    if (name && !seen.has(name)) {
      seen.add(name);
      channels.push(name);
    }
  }
  return channels.join(', ');
}

/**
 * Finds the embedded fixtures iframe (campeonato_base.php) on a competition page.
 * verdao.net moved the per-competition fixture tables into this iframe.
 * @param {string} html
 * @returns {string|null} Absolute iframe URL, or null if none present.
 */
function extractCampeonatoIframeUrl(html) {
  const $ = cheerio.load(html);
  let iframeUrl = null;
  $('iframe[src]').each((_i, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('campeonato_base.php')) {
      iframeUrl = src;
      return false; // stop at the first match
    }
  });
  if (!iframeUrl) return null;
  try {
    return new URL(iframeUrl, VERDAO_BASE_URL).toString();
  } catch {
    return iframeUrl;
  }
}

/**
 * Parses the campeonato_base.php fixtures table (turno/returno layout).
 *
 * Each round is two rows sharing one opponent (home and away legs). The
 * opponent cell uses rowspan=2, so cheerio sees it only on the turno row:
 *   Turno leg (6 cells):   [Rodada, Data-Horário, Adversário, Placar, Local, TV]
 *   Returno leg (5 cells):  [Rodada, Data-Horário, Placar, Local, TV]  ← opponent inherited
 *
 * We iterate every row document-wide using only DIRECT child <td>s so nested
 * layout tables (standings, regulation, etc.) are naturally ignored: their
 * rows never have a date-time cell in position 1.
 *
 * @param {string} html
 * @param {string} competition
 * @param {string} pageUrl
 * @returns {Match[]}
 */
function parseCampeonatoBase(html, competition, pageUrl) {
  const $ = cheerio.load(html);
  const matches = [];
  let carriedOpponent = null;

  $('tr').each((_ri, row) => {
    const cells = $(row)
      .children('td')
      .map((_ci, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
      .get();

    if (cells.length !== 5 && cells.length !== 6) return;

    let dateStr;
    let opponentRaw;
    let location;
    let tv;

    if (cells.length === 6) {
      // Turno leg — carries the opponent for its paired returno leg.
      [, dateStr, opponentRaw, , location, tv] = cells;
      if (opponentRaw && !/^x$/i.test(opponentRaw) && !/adversário/i.test(opponentRaw)) {
        carriedOpponent = opponentRaw;
      }
    } else {
      // Returno leg — opponent comes from the turno leg above (rowspan cell).
      [, dateStr, , location, tv] = cells;
      opponentRaw = carriedOpponent;
    }

    // Skip header rows ("Data - Horário", "Rodada") and undefined dates ("A/D")
    // without noise — only real date cells reach parseDateTime.
    if (!CAMPEONATO_DATE_RE.test(dateStr || '')) return;
    if (!opponentRaw) return;

    const matchDate = parseDateTime(dateStr, competition);
    if (!matchDate) return;

    const locationLower = (location || '').toLowerCase();
    const isHome =
      locationLower.includes('barueri') ||
      locationLower.includes('allianz') ||
      locationLower.includes('nubank');

    matches.push({
      date: matchDate,
      opponent: normalizeOpponentName(opponentRaw.trim()),
      location: (location || '').trim(),
      broadcast: parseCampeonatoBroadcast(tv),
      competition,
      isHome,
      source: pageUrl,
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
    let availablePages = 0;
    const pages = getVerdaoPages();
    
    for (const page of pages) {
      try {
        logger.info(`[RETRIEVAL] Fetching ${page.competition} from ${page.url}...`);
        const pageResult = await fetchHTMLWithCache(page.url);
        const html = pageResult.html;
        
        if (html === null) {
          logger.info(`[RETRIEVAL] Skipping ${page.competition} - no live response or cached copy available`);
          continue;
        }
        availablePages += 1;
        
        const matches = parseMatchesFromHTML(html, page.competition, page.url);

        // verdao.net moved per-competition fixture tables into an embedded
        // iframe (campeonato_base.php). Follow it and parse that table too.
        const iframeUrl = extractCampeonatoIframeUrl(html);
        if (iframeUrl) {
          logger.info(`[RETRIEVAL] ${page.competition}: following fixtures iframe ${iframeUrl}`);
          const iframeResult = await fetchHTMLWithCache(iframeUrl);
          const iframeHtml = iframeResult.html;
          if (iframeHtml) {
            const iframeMatches = parseCampeonatoBase(iframeHtml, page.competition, iframeUrl);
            logger.info(`[RETRIEVAL] ${page.competition}: iframe yielded ${iframeMatches.length} matches`);
            matches.push(...iframeMatches);
          }
        }

        logger.info(`[RETRIEVAL] Found ${matches.length} matches from ${page.competition}`);
        allMatches.push(...matches);
        
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        logger.warn(`[RETRIEVAL] Error processing ${page.competition}: ${err.message}`);
      }
    }

    if (availablePages === 0) {
      throw new Error('Verdão retrieval unavailable: no live pages or cached copies could be loaded');
    }
    
    logger.info(`[RETRIEVAL] Total matches found: ${allMatches.length}`);
    return allMatches;
  } catch (err) {
    const error = ensureError(err);
    logger.error('[RETRIEVAL] Failed to fetch fixtures', error);
    throw err;
  }
}
