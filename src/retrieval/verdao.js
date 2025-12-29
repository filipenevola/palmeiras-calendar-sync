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
export async function fetchPalmeirasFixtures() {
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
    const error = ensureError(err);
    logger.error('[RETRIEVAL] Failed to fetch fixtures', error);
    throw err;
  }
}

