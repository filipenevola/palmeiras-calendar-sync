/**
 * Match processing logic
 * 
 * This module processes matches from retrieval logic before syncing to calendar.
 * Works with standardized Match format - independent of retrieval source.
 */

import { logger } from './logger.js';

/**
 * Generates a unique key for a match based on teams and date (day only).
 * Uses opponent + date so the same match scraped from different pages
 * (e.g., competition page and homepage) produces the same key.
 * @param {Match} match - Match object
 * @returns {string} Unique key for the match
 */
export function getMatchUniqueKey(match) {
  const normalize = (str) => str.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const opponent = normalize(match.opponent);
  const dateStr = match.date.toISOString().slice(0, 10); // YYYY-MM-DD
  
  return `palmeiras_vs_${opponent}_${dateStr}`;
}

/**
 * Filters and processes matches: removes past matches, deduplicates, sorts
 * @param {Match[]} matches - Raw matches from retrieval logic
 * @returns {Match[]} Processed matches ready for calendar sync
 */
export function processMatches(matches) {
  const now = new Date();
  
  // Filter for future matches only
  const futureMatches = matches.filter(match => match.date > now);
  
  // Remove duplicates using unique key (opponent + date)
  // If same opponent+date appears multiple times, keep the first occurrence
  const matchMap = new Map();
  
  for (const match of futureMatches) {
    const key = getMatchUniqueKey(match);
    const existing = matchMap.get(key);
    
    if (!existing || match.date < existing.date) {
      matchMap.set(key, match);
    }
  }
  
  const uniqueMatches = Array.from(matchMap.values());
  
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

