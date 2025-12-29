/**
 * Match processing logic
 * 
 * This module processes matches from retrieval logic before syncing to calendar.
 * Works with standardized Match format - independent of retrieval source.
 */

import { logger } from './logger.js';

/**
 * Filters and processes matches: removes past matches, deduplicates, sorts
 * @param {Match[]} matches - Raw matches from retrieval logic
 * @returns {Match[]} Processed matches ready for calendar sync
 */
export function processMatches(matches) {
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

