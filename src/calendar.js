/**
 * Calendar sync logic
 * 
 * This module converts standardized Match format to Google Calendar events.
 * Works only with standardized Match format - independent of retrieval logic.
 */

import { google } from 'googleapis';
import { logger } from './logger.js';
import { GOOGLE_CREDENTIALS, GOOGLE_CALENDAR_ID } from './config.js';

/**
 * Converts a Match to a Google Calendar event
 * @param {Match} match - Match in standardized format
 * @returns {Object} Google Calendar event resource
 */
export function matchToCalendarEvent(match) {
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

export async function getCalendarClient() {
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

export async function getExistingEvents(calendar) {
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
export async function syncMatchesToCalendar(matches) {
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

