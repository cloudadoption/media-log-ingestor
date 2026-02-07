# Media Log Ingestor

Retroactively ingest media references into AEM Admin media logs by discovering pages via Bulk Status API, fetching markdown content, and extracting media references.

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd media-log-ingestor

# 2. Install dependencies
npm install

# 3. Set up your admin token
cp .env.example .env
# Edit .env and add your ADMIN_TOKEN

# 4. Run the tool
npm link
logmedia --org <org> --repo <repo>
```

## Usage

### Basic Command

```bash
logmedia --org franklin --repo my-site
```

### With Options

```bash
logmedia \
  --org franklin \
  --repo my-site \
  --ref main \
  --path "/products/*" \
  --token "your-jwt-token" \
  --user "media-backfill-bot" \
  --verify \
  --verbose
```

### Dry Run (Preview)

```bash
logmedia --org franklin --repo my-site --dry-run --verbose
```

### Test User Mapping Only

```bash
# Test if preview logs contain user information (no ingestion)
logmedia --org franklin --repo my-site --user-mapping --verbose
```

### Skip User Enrichment

```bash
# Run ingestion without enriching entries with user information
logmedia --org franklin --repo my-site --skip-user-enrichment
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--org` | Organization name (required) | - |
| `--repo` | Repository name (required) | - |
| `--ref` | Git branch/reference | `main` |
| `--path` | Path filter (e.g., `/products/*`) | `/*` |
| `--token` | Admin JWT token (or use ADMIN_TOKEN env) | (from env) |
| `--user` | Fallback user identifier for log entries | (omitted) |
| `--dry-run` | Preview without sending to API | `false` |
| `--verify` | Verify entries after sending | `false` |
| `--skip-user-enrichment` | Skip enriching entries with preview log users | `false` |
| `--user-mapping` | Test user mapping only (no ingestion) | `false` |
| `--verbose` | Detailed logging | `false` |
| `--concurrency` | Parallel markdown fetching | `3` |
| `--batch-size` | Entries per batch (max 10) | `10` |
| `--poll-interval` | Job polling interval (ms) | `10000` |

## Authentication

### Getting Your Token

Run the token help command to see detailed instructions:

```bash
logmedia token
```

This will show you two methods to obtain an authentication token:

**Method 1: Extract from AEM Sidekick Extension (Recommended)**

1. Make sure you are logged into your project via Sidekick
   - If not, visit `https://main--{repo}--{org}.aem.page/` and login via Sidekick
2. Open Chrome and go to: `chrome://extensions/?id=igkmdomcgoebiipaifhmpfjhbjccggml`
3. Click the blue "service worker" link under "Inspect views"
4. In the Console tab, paste and run:
   ```javascript
   chrome.storage.session.get('projects').then(data => {
     data.projects.forEach(p => {
       if (p.authToken) {
         console.log(`\n${p.owner}/${p.repo}:`);
         console.log(p.authToken);
       }
     });
   })
   ```
5. Find your org/repo and copy the token

**Method 2: Create Admin API Key**

> ⚠️ **Note:** You must have "admin" role to create API keys

1. Visit: `https://admin.hlx.page/login`
2. Sign in with your Adobe credentials
3. Go to: `https://admin.hlx.page/config/{org}/sites/{site}/apiKeys.json`
4. POST to create new API key with:
   - Role: `admin` (or `author` for minimum permissions)
   - Scopes: `log:read` (for user enrichment), `log:write` (for media log)
5. Copy the returned API key

**Token Permissions:**
- **`log:write`**: Required for media log ingestion
- **`log:read`**: Optional, enables user enrichment from preview logs (part of "author" role or higher)
- If token lacks `log:read`, use `--skip-user-enrichment` flag

### Using Your Token

**Option 1: CLI parameter (recommended for one-time use)**

```bash
logmedia --org franklin --repo my-site --token "your-jwt-token"
```

**Option 2: Environment variable (recommended for repeated use)**

```bash
export ADMIN_TOKEN="your-jwt-token-here"
logmedia --org franklin --repo my-site
```

**Option 3: .env file**

```bash
echo "ADMIN_TOKEN=your-jwt-token-here" > .env
logmedia --org franklin --repo my-site
```

Priority: `--token` flag > `ADMIN_TOKEN` env variable

## User Enrichment

By default, the tool enriches media log entries with user information from preview logs. This helps track who last previewed/worked on each page containing the media.

### How It Works

1. Fetches preview logs from the last 30 days via Admin Log API
2. Builds a map of `path → user` from preview events
3. Enriches each media entry with the user who last previewed its source page
4. Falls back to `--user` flag value if no preview user is found

### Required Permissions

User enrichment requires the token to have **`log:read`** permission, which is included in:
- **`author`** role or higher (author, publish, admin)
- Reference: [AEM Authentication Setup](https://www.aem.live/docs/authentication-setup-authoring)

### If Token Lacks Permissions

If your token doesn't have `log:read` permissions, you'll see:
- `403 Forbidden` errors when fetching preview logs
- Warning: "User enrichment completed but no users found"

**Options:**
1. Use `--skip-user-enrichment` to disable the feature
2. Provide `--user` fallback value for all entries
3. Get a token with "author" role or higher

### Testing User Mapping

Before running full ingestion, test if your token can access preview logs:

```bash
logmedia --org franklin --repo my-site --user-mapping --verbose
```

This will:
- Fetch all pages from bulk status API
- Query preview logs and build user map
- Show coverage statistics
- **Skip** all parsing, media extraction, and API writes

## How It Works

1. **Creates bulk status job** via AEM Admin API to discover all pages
2. **Polls job** until complete (handles large sites with 1000+ pages)
3. **Fetches markdown** for each page from preview partition
4. **Extracts media** references (images, videos, documents)
5. **Enriches with user info** from preview logs (if not skipped)
6. **Batches entries** (max 10 per request) with `action: "add"`
7. **Sends to media log API** for ingestion

## Output

```
📊 Media Log Ingestion Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pages discovered:    156
Pages processed:     142
Media found:         87
Batches sent:        9
Errors:              0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Verifying Logging Works

**Option 1: Use --verify flag**

```bash
logmedia --org franklin --repo my-site --verify
```

This queries the media log after sending entries and displays recent entries.

**Option 2: Manual verification via API**

```bash
# Query recent entries (last 5 minutes)
curl "https://admin.hlx.page/medialog/{org}/{repo}/{ref}?limit=100" \
  -H "Authorization: token $ADMIN_TOKEN"
```

**Option 3: Check the output**

The tool displays:
- HTTP status codes (201 = success)
- Batch confirmation messages
- Direct query URL at the end

## Important Notes

### Duplicate Entries

⚠️ **The media log API is append-only and does NOT filter duplicates.**

- Running the tool multiple times will create multiple log entries for the same media
- Each entry has a unique timestamp
- This is by design - the log tracks all media operations over time
- Use `--dry-run` first to preview what will be logged

### Log Entry Structure

**For media referenced in markdown pages:**
```json
{
  "action": "add",
  "path": "https://main--repo--org.aem.page/media_abc123.png",
  "sourcePath": "https://main--repo--org.aem.page/products/page",
  "alt": "Product screenshot",
  "user": "media-backfill-bot"
}
```

**For standalone media files:**
```json
{
  "action": "add",
  "path": "/icons/logo.svg",
  "user": "media-backfill-bot"
}
```

**Fields:**
- `action`: Always "add"
- `path`: The media file path or URL
- `sourcePath`: Full URL to the markdown page that references this media (omitted for standalone media files)
- `alt`: Alternative text for images (only included if alt text is present in markdown)
- `user`: User who last previewed the source page (from preview logs), or fallback to `--user` flag value
- `timestamp`: Automatically added by the API

## Error Handling

Failed batches are saved to `failed-entries.json` for manual retry.

## Troubleshooting

### No Token Found

If you see "No authentication token found":

```bash
logmedia token
```

This command shows detailed instructions for obtaining a token from the Sidekick extension or creating an admin API key.

### Invalid or Expired Token

If you see "Invalid token" or "Token has expired":

1. Get a fresh token using `logmedia token` instructions
2. Tokens from Sidekick are typically valid for 24 hours
3. Admin API keys may have longer expiration periods

The tool will automatically validate your token and show expiration warnings if it expires in less than 7 days.

### 403 Forbidden Errors

**For Media Log API:**

If you receive `403` errors when sending batches to the media log API:

1. **Check admin permissions**: Verify you are an admin on the site (`{org}/{repo}`)
2. **Check token permissions**: Ensure your admin JWT token has the required role:
   - `log:write` - required for adding media log entries

**For Preview Log API (User Enrichment):**

If you see `403` errors when fetching preview logs for user enrichment:

1. **Token lacks log:read permission**: Your token needs "author" role or higher
   - `log:read` is included in: author, publish, admin roles
   - Reference: [AEM Authentication Setup](https://www.aem.live/docs/authentication-setup-authoring)
2. **Token is for different org/repo**: Sidekick tokens are org/repo specific
3. **Workaround**: Use `--skip-user-enrichment` flag to bypass preview logs

You can verify your token's roles by decoding the JWT at [jwt.io](https://jwt.io).

### Rate Limiting

The tool respects the **10 requests per second** rate limit for `admin.hlx.page`. If you encounter intermittent errors:

- The tool automatically retries with exponential backoff (1s, 2s, 4s)
- Reduce `--concurrency` if needed (default: 3)
- Large ingestion jobs will take time (~160 seconds for 1600 batches)

## Requirements

- Node.js >= 18
- Valid AEM Admin JWT token with:
  - `log:write` permission (required for media log ingestion)
  - `log:read` permission (optional, for user enrichment from preview logs - included in "author" role or higher)
- Admin access to the target org/repo