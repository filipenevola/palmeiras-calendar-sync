import { google } from 'googleapis';

// Configuration
const PALMEIRAS_TEAM_ID = 121; // API-Football team ID for Palmeiras
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS; // Base64 encoded service account JSON
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Validate environment
function validateEnv() {
  const missing = [];
  if (!API_FOOTBALL_KEY) missing.push('API_FOOTBALL_KEY');
  if (!GOOGLE_CREDENTIALS) missing.push('GOOGLE_CREDENTIALS');
  
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// Fetch fixtures from API-Football
async function fetchPalmeirasFixtures() {
  console.log('🔍 Fetching Palmeiras fixtures from API-Football...');
  
  const currentYear = new Date().getFullYear();
  const url = `https://v3.football.api-sports.io/fixtures?team=${PALMEIRAS_TEAM_ID}&season=${currentYear}`;
  
  const response = await fetch(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY
    }
  });
  
  if (!response.ok) {
    throw new Error(`API-Football error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
  }
  
  // Filter for future fixtures only
  const now = new Date();
  const futureFixtures = (data.response || []).filter(fixture => {
    const fixtureDate = new Date(fixture.fixture.date);
    return fixtureDate > now;
  });
  
  console.log(`✅ Found ${futureFixtures.length} upcoming fixtures`);
  
  return futureFixtures;
}

// Convert API-Football fixture to Google Calendar event
function fixtureToCalendarEvent(fixture) {
  const isHome = fixture.teams.home.id === PALMEIRAS_TEAM_ID;
  const opponent = isHome ? fixture.teams.away.name : fixture.teams.home.name;
  const venue = isHome ? '🏠' : '✈️';
  
  const startDateTime = new Date(fixture.fixture.date);
  const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours
  
  return {
    summary: `${venue} Palmeiras vs ${opponent}`,
    description: [
      `⚽ ${fixture.league.name} - ${fixture.league.round || ''}`,
      `📍 ${fixture.fixture.venue?.name || 'TBD'}`,
      ``,
      `Source: API-Football`,
      `Fixture ID: ${fixture.fixture.id}`
    ].join('\n'),
    location: fixture.fixture.venue?.name || '',
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
        fixtureId: String(fixture.fixture.id),
      }
    }
  };
}

// Get Google Calendar client
async function getCalendarClient() {
  const credentials = JSON.parse(
    Buffer.from(GOOGLE_CREDENTIALS, 'base64').toString('utf-8')
  );
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  
  return google.calendar({ version: 'v3', auth });
}

// Get existing Palmeiras events from calendar
async function getExistingEvents(calendar) {
  const now = new Date();
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  
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
  
  return fixtureMap;
}

// Sync fixtures to calendar
async function syncToCalendar(fixtures) {
  console.log('\n📅 Syncing to Google Calendar...');
  
  const calendar = await getCalendarClient();
  const existingEvents = await getExistingEvents(calendar);
  
  let created = 0;
  let updated = 0;
  let skipped = 0;
  
  for (const fixture of fixtures) {
    const event = fixtureToCalendarEvent(fixture);
    const fixtureId = String(fixture.fixture.id);
    const existingEventId = existingEvents.get(fixtureId);
    
    try {
      if (existingEventId) {
        // Update existing event
        await calendar.events.update({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: existingEventId,
          resource: event,
        });
        console.log(`  🔄 Updated: ${event.summary}`);
        updated++;
      } else {
        // Create new event
        await calendar.events.insert({
          calendarId: GOOGLE_CALENDAR_ID,
          resource: event,
        });
        console.log(`  ✅ Created: ${event.summary}`);
        created++;
      }
    } catch (err) {
      console.log(`  ❌ Error: ${event.summary} - ${err.message}`);
      skipped++;
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`\n📊 Summary: ${created} created, ${updated} updated, ${skipped} errors`);
}

// Main
async function main() {
  console.log('⚽ Palmeiras Calendar Sync');
  console.log('═'.repeat(50));
  console.log(`📅 ${new Date().toISOString()}\n`);
  
  validateEnv();
  
  try {
    const fixtures = await fetchPalmeirasFixtures();
    
    if (fixtures.length === 0) {
      console.log('\n⚠️  No upcoming fixtures found');
      return;
    }
    
    // Print fixtures
    console.log('\n📋 Fixtures to sync:');
    fixtures.slice(0, 10).forEach(f => {
      const isHome = f.teams.home.id === PALMEIRAS_TEAM_ID;
      const opponent = isHome ? f.teams.away.name : f.teams.home.name;
      const date = new Date(f.fixture.date).toLocaleString('pt-BR', { 
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short'
      });
      console.log(`   ${date} - ${isHome ? '🏠' : '✈️'} vs ${opponent} [${f.league.name}]`);
    });
    
    if (fixtures.length > 10) {
      console.log(`   ... and ${fixtures.length - 10} more`);
    }
    
    await syncToCalendar(fixtures);
    
    console.log('\n🎉 Sync complete! Vai Palmeiras!');
    
  } catch (err) {
    console.error('\n❌ Sync failed:', err.message);
    process.exit(1);
  }
}

main();
