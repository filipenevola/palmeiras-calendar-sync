# Palmeiras Calendar Sync ⚽

Automatically sync Palmeiras fixtures to your Google Calendar using API-Football.

## Features

- 🔄 Daily automatic sync via GitHub Actions
- 📅 Creates/updates Google Calendar events
- 🏠 Shows home (🏠) vs away (✈️) games
- ⏰ 1-hour and 15-minute reminders
- 🏆 Covers all competitions (Brasileirão, Copa do Brasil, Libertadores, Paulistão)

## Setup

### 1. API-Football Key

1. Sign up at [API-Football](https://www.api-football.com/)
2. Get your free API key (100 requests/day)
3. Add as GitHub secret: `API_FOOTBALL_KEY`

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
| `API_FOOTBALL_KEY` | API-Football API key |
| `GOOGLE_CREDENTIALS` | Base64 encoded service account JSON |
| `GOOGLE_CALENDAR_ID` | Google Calendar ID (or `primary`) |
| `ZCLOUD_USER_TOKEN` | Quave Cloud environment token (required for deployment) |

## How It Works

1. The app runs on Quave Cloud and syncs Palmeiras fixtures to your Google Calendar
2. Fetches upcoming Palmeiras fixtures from API-Football
3. Creates/updates events in your Google Calendar
4. Each event includes:
   - Match title with home/away indicator
   - Competition name and round
   - Venue information
   - Automatic reminders

### Deployment

- **Automatic**: Pushing to `main` branch triggers deployment via GitHub Actions
- **Manual**: Use the "Run workflow" button in the GitHub Actions tab

## Manual Sync

You can trigger a manual sync:
1. Go to Actions tab in GitHub
2. Select "Palmeiras Calendar Sync"
3. Click "Run workflow"

## Local Development

This project uses [Bun](https://bun.sh) for fast JavaScript runtime and package management.

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Set environment variables
export API_FOOTBALL_KEY="your-key"
export GOOGLE_CREDENTIALS="base64-encoded-credentials"
export GOOGLE_CALENDAR_ID="your-calendar-id"

# Run sync
bun run sync
```

## License

MIT

---

🌴 Vai Palmeiras! 🌴
