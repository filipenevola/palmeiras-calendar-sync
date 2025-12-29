# Palmeiras Calendar Sync ⚽

Automatically sync Palmeiras fixtures to your Google Calendar using Football-Data.org API.

## Features

- 🌐 **Web Dashboard** - Simple UI to view sync status and trigger manual syncs
- 📊 **Enhanced Logging** - Detailed logs stored in `/tmp` for debugging
- 🔄 Daily automatic sync via GitHub Actions
- 📅 Creates/updates Google Calendar events
- 🏠 Shows home (🏠) vs away (✈️) games
- ⏰ 1-hour and 15-minute reminders
- 🏆 Covers all competitions (Brasileirão, Copa do Brasil, Libertadores, Paulistão)
- ✅ Supports future fixtures (no season restrictions!)

## Setup

### 1. Football-Data.org API Key

1. Sign up at [Football-Data.org](https://www.football-data.org/)
2. Get your free API key (10 requests/minute)
3. Add as GitHub secret: `FOOTBALL_DATA_API_KEY`

### 2. Google Calendar Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the **Google Calendar API**
4. Go to **IAM & Admin > Service Accounts**
5. Create a service account
6. Create a JSON key and download it
7. Base64 encode the JSON: `base64 -i service-account.json`
8. Add as GitHub secret: `GOOGLE_CREDENTIALS`

### 3. Share Calendar with Service Account

1. Open Google Calendar
2. Go to calendar settings
3. Under "Share with specific people", add the service account email
4. Give it "Make changes to events" permission
5. Copy the calendar ID (for your primary calendar, use your email)
6. Add as GitHub secret: `GOOGLE_CALENDAR_ID`

### 4. Quave Cloud Deployment

The app is configured to deploy automatically to Quave Cloud via GitHub Actions.

1. Add your Quave Cloud environment token as a GitHub secret:
   - Go to your repository **Settings** > **Secrets and variables** > **Actions**
   - Click **New repository secret**
   - Name: `ZCLOUD_USER_TOKEN`
   - Value: Your environment token (get it from [Quave Cloud](https://app.quave.cloud))
2. The GitHub Actions workflow will automatically deploy when you push to `main`
3. App environment: `filipenevola-palmeiras-calendar-sync-production`

### GitHub Secrets Required

| Secret | Description |
|--------|-------------|
| `FOOTBALL_DATA_API_KEY` | Football-Data.org API key |
| `GOOGLE_CREDENTIALS` | Base64 encoded service account JSON |
| `GOOGLE_CALENDAR_ID` | Google Calendar ID (or `primary`) |
| `ZCLOUD_USER_TOKEN` | Quave Cloud environment token (required for deployment) |

## How It Works

1. The app runs on Quave Cloud and syncs Palmeiras fixtures to your Google Calendar
2. Fetches upcoming Palmeiras fixtures from Football-Data.org API
3. Creates/updates events in your Google Calendar
4. Each event includes:
   - Match title with home/away indicator
   - Competition name and matchday
   - Venue information
   - Automatic reminders

## Why Football-Data.org?

The app was migrated from API-Football because their free plan restricts access to future seasons. Football-Data.org's free tier provides access to scheduled/future fixtures without season restrictions, making it perfect for calendar syncs!

### Deployment

- **Automatic**: Pushing to `main` branch triggers deployment via GitHub Actions
- **Manual**: Use the "Run workflow" button in the GitHub Actions tab

## Web Dashboard

Once deployed, the app includes a web dashboard accessible at your app's URL:

- **View Status**: See the latest sync run details, including:
  - Number of fixtures found
  - Events created/updated
  - Any errors encountered
  - Execution duration and timestamps
- **Trigger Sync**: Click the button to manually trigger a new sync
- **Auto-refresh**: Status updates every 10 seconds

The dashboard is available at the root URL of your deployed app (e.g., `https://your-app-url.zcloud.ws/`).

## Manual Sync

You can trigger a manual sync in two ways:

1. **Via Web Dashboard**: Visit your app URL and click "Executar Sincronização"
2. **Via GitHub Actions**:
   - Go to Actions tab in GitHub
   - Select "Palmeiras Calendar Sync"
   - Click "Run workflow"

## Local Development

This project uses [Bun](https://bun.sh) for fast JavaScript runtime and package management.

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Set environment variables
export FOOTBALL_DATA_API_KEY="your-key"  # Get free key at https://www.football-data.org/
export GOOGLE_CREDENTIALS="base64-encoded-credentials"
export GOOGLE_CALENDAR_ID="your-calendar-id"

# Start the web server (includes dashboard)
bun run start

# The server will be available at http://localhost:3000
# You can also trigger syncs via the web UI or API:
# - GET /api/status - Get latest sync status
# - POST /api/sync - Trigger a new sync
# - GET /health - Health check endpoint
```

## License

MIT

---

🌴 Vai Palmeiras! 🌴
