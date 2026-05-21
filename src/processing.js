/**
 * Match processing logic
 * 
 * This module processes matches from retrieval logic before syncing to calendar.
 * Works with standardized Match format - independent of retrieval source.
 */

import { logger } from './logger.js';

const PLACEHOLDER_OPPONENTS = new Set([
  'sistema',
  'a_definir',
  'adversario',
  'tbd',
  'tba',
  'a_confirmar',
  'confirmar',
]);

/**
 * @param {Date} date
 * @returns {string} YYYY-MM-DD in America/Sao_Paulo
 */
export function toSaoPauloDateKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/**
 * @param {Match} match
 * @returns {string}
 */
export function getMatchDayKey(match) {
  return toSaoPauloDateKey(match.date);
}

/**
 * One Palmeiras fixture per calendar day (São Paulo).
 * @param {Match} match
 * @returns {string}
 */
export function getMatchUniqueKey(match) {
  return `palmeiras_${getMatchDayKey(match)}`;
}

/**
 * @param {string} opponent
 * @returns {boolean}
 */
export function isPlaceholderOpponent(opponent) {
  const normalized = opponent
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return PLACEHOLDER_OPPONENTS.has(normalized) || normalized.length < 2;
}

/**
 * Prefer richer scrape data when the same day appears on multiple pages.
 * @param {Match} match
 * @returns {number}
 */
function matchQualityScore(match) {
  let score = 0;
  if (match.location) score += 10;
  if (match.broadcast) score += 5;
  const isHomePage =
    match.source?.endsWith('verdao.net/') || match.source?.endsWith('verdao.net');
  if (!isHomePage) score += 5;
  if (match.isHome) score += 3;
  return score;
}

/**
 * @param {Match} existing
 * @param {Match} candidate
 * @returns {Match}
 */
function pickBetterMatch(existing, candidate) {
  const existingLen = existing.opponent.trim().length;
  const candidateLen = candidate.opponent.trim().length;
  if (candidateLen !== existingLen) {
    return candidateLen > existingLen ? candidate : existing;
  }
  return matchQualityScore(candidate) > matchQualityScore(existing) ? candidate : existing;
}

/**
 * Filters and processes matches: removes past matches, deduplicates, sorts
 * @param {Match[]} matches - Raw matches from retrieval logic
 * @returns {Match[]} Processed matches ready for calendar sync
 */
export function processMatches(matches) {
  const now = new Date();

  const futureMatches = matches.filter(
    (match) => match.date > now && !isPlaceholderOpponent(match.opponent)
  );

  const matchMap = new Map();

  for (const match of futureMatches) {
    const key = getMatchUniqueKey(match);
    const existing = matchMap.get(key);

    if (!existing) {
      matchMap.set(key, match);
    } else {
      matchMap.set(key, pickBetterMatch(existing, match));
    }
  }

  const uniqueMatches = Array.from(matchMap.values());

  uniqueMatches.sort((a, b) => a.date.getTime() - b.date.getTime());

  const dropped = matches.length - uniqueMatches.length;
  if (dropped > 0) {
    logger.info(
      `[PROCESSING] Dropped ${dropped} duplicate/placeholder/past matches (${matches.length} raw → ${uniqueMatches.length} unique)`
    );
  }
  logger.info(`[PROCESSING] Processed ${matches.length} matches: ${uniqueMatches.length} unique upcoming fixtures`);

  uniqueMatches.slice(0, 5).forEach((match, idx) => {
    const diff = match.date.getTime() - now.getTime();
    const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
    const teams = match.isHome ? `Palmeiras vs ${match.opponent}` : `${match.opponent} vs Palmeiras`;
    logger.info(
      `[PROCESSING] Match ${idx + 1}: ${match.isHome ? '🏠' : '✈️'} ${teams} - ${match.competition} - Date: ${match.date.toISOString()}, diff: ${diffDays} days${match.broadcast ? ` - TV: ${match.broadcast}` : ''}`
    );
  });

  return uniqueMatches;
}
