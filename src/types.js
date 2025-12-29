/**
 * Standardized Match format
 * 
 * All retrieval logic must return matches in this format.
 * This allows swapping retrieval implementations without affecting calendar sync.
 * 
 * @typedef {Object} Match
 * @property {Date} date - Match date/time (JavaScript Date object)
 * @property {string} opponent - Opponent team name
 * @property {boolean} isHome - true if Palmeiras is playing at home
 * @property {string} competition - Competition name (e.g., "Brasileirão 2026", "Paulista 2026")
 * @property {string} location - Venue/location name
 * @property {string} broadcast - Broadcast channels (e.g., "Record, Cazé TV") - optional
 * @property {string} source - Source identifier for debugging (e.g., "ptd.verdao.net")
 */

export {};

