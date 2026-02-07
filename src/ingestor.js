import { fetch } from '@adobe/fetch';
import fs from 'fs/promises';

const MEDIALOG_API = 'https://admin.hlx.page/medialog';
const LOG_API = 'https://admin.hlx.page/log';

export async function sendMediaLogBatch(org, repo, ref, entries, token, dryRun = false, maxRetries = 3) {
  if (dryRun) {
    return { success: true, dryRun: true, status: 200 };
  }

  const url = `${MEDIALOG_API}/${org}/${repo}/${ref}/`;
  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ entries })
    });

    if (response.ok) {
      return { success: true, status: response.status };
    }

    // Handle rate limiting (403 or 429)
    if ((response.status === 403 || response.status === 429) && attempt < maxRetries) {
      const backoffMs = 2 ** attempt * 1000; // 1s, 2s, 4s
      await sleep(backoffMs);
      continue;
    }

    // Non-retryable error or max retries exceeded
    const text = await response.text();
    throw new Error(`Media log API error: ${response.status} - ${text}`);
  }

  // This should never be reached due to throw, but ESLint requires it
  return null;
}

export async function verifyMediaLog(org, repo, ref, token, limit = 10) {
  const url = `${MEDIALOG_API}/${org}/${repo}/${ref}/?since=5m&limit=${limit}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to verify media log: ${response.status}`);
  }

  const data = await response.json();
  return {
    count: data.entries?.length || 0,
    entries: data.entries || []
  };
}

export async function saveFailedBatch(batch, error, filename = 'failed-entries.json') {
  const failedEntry = {
    timestamp: new Date().toISOString(),
    error: error.message,
    entries: batch
  };

  try {
    let existing = [];
    try {
      const content = await fs.readFile(filename, 'utf-8');
      existing = JSON.parse(content);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    existing.push(failedEntry);
    await fs.writeFile(filename, JSON.stringify(existing, null, 2));
  } catch (saveError) {
    console.error('Failed to save error batch:', saveError.message);
  }
}

/**
 * Fetches preview log entries and builds a path-to-user map
 * @param {string} org - Organization name
 * @param {string} repo - Repository name
 * @param {string} ref - Git reference
 * @param {string} token - Auth token
 * @param {boolean} verbose - Enable verbose logging
 * @returns {Promise<Map<string, string>>} Map of path to last preview user
 */
export async function buildPreviewUserMap(org, repo, ref, token, verbose = false) {
  const userMap = new Map();

  try {
    // Query last 30 days of logs using relative time format
    let url = `${LOG_API}/${org}/${repo}/${ref}/?since=30d&limit=1000`;
    let hasMore = true;
    let pageCount = 0;
    let totalEntries = 0;

    if (verbose) {
      console.log('\n  Fetching preview logs from last 30 days');
      console.log(`  API URL: ${url}`);
    }

    // Fetch all log pages (handle pagination)
    while (hasMore) {
      const response = await fetch(url, {
        headers: {
          Authorization: `token ${token}`
        }
      });

      if (!response.ok) {
        if (verbose) {
          const responseText = await response.text();
          const errorHeader = response.headers.get('x-error');
          console.log(`  ✗ Log API error: ${response.status}`);
          if (errorHeader) {
            console.log(`  Error: ${errorHeader}`);
          } else if (responseText) {
            console.log(`  Response: ${responseText}`);
          }
        }

        // Special handling for 403 - permission issue
        if (response.status === 403 && verbose) {
          console.log(`\n  ⚠️  403 Forbidden - Token lacks 'log:read' permission for ${org}/${repo}`);
          console.log('  User mapping will not be available\n');
        }
        break;
      }

      const data = await response.json();
      const entries = data.entries || [];
      pageCount += 1; // eslint-disable-line no-plusplus
      totalEntries += entries.length;

      if (verbose && pageCount === 1) {
        console.log(`\n  Fetched ${entries.length} log entries`);
        if (entries.length > 0) {
          const uniqueRoutes = [...new Set(entries.map((e) => e.route))];
          const entriesWithUser = entries.filter((e) => e.user).length;
          console.log(`  Unique routes: ${uniqueRoutes.join(', ')}`);
          console.log(`  Entries with user info: ${entriesWithUser}/${entries.length}`);
        }
      }

      for (const entry of entries) {
        if (entry.route === 'preview' && entry.path && entry.user) {
          // Only set if not already in map (first = most recent)
          if (!userMap.has(entry.path)) {
            userMap.set(entry.path, entry.user);
          }
        }
      }

      // Check for pagination
      if (data.links?.next) {
        url = data.links.next;
        if (verbose && pageCount === 1) {
          console.log('  More pages available, continuing...');
        }
      } else {
        hasMore = false;
      }
    }

    if (verbose) {
      console.log(`  Processed ${totalEntries} total log entries across ${pageCount} pages`);
      console.log(`  Found preview users for ${userMap.size} unique paths`);
      if (userMap.size > 0) {
        const samplePaths = Array.from(userMap.entries()).slice(0, 3);
        console.log('  Sample mappings:');
        samplePaths.forEach(([path, user]) => {
          console.log(`    ${path} -> ${user}`);
        });
      }
    }
  } catch (error) {
    if (verbose) {
      console.log(`  ✗ Error building user map: ${error.message}`);
    }
  }

  return userMap;
}

/**
 * Enriches media log entries with user information from preview logs
 * @param {Array} entries - Media log entries
 * @param {string} org - Organization name
 * @param {string} repo - Repository name
 * @param {string} ref - Git reference
 * @param {string} token - Auth token
 * @param {string} fallbackUser - Optional fallback user (from --user flag)
 * @param {boolean} verbose - Enable verbose logging
 * @returns {Promise<Array>} Enriched entries with user information
 */
export async function enrichEntriesWithUser(entries, org, repo, ref, token, fallbackUser, verbose = false) {
  // Build map of path -> user from preview logs (single bulk fetch)
  const previewUserMap = await buildPreviewUserMap(org, repo, ref, token, verbose);

  let foundUsers = 0;
  let usedFallback = 0;
  let noUser = 0;

  const enrichedEntries = entries.map((entry, index) => {
    const enriched = { ...entry };

    // If entry has sourcePath, try to get the user who last previewed that page
    if (entry.sourcePath) {
      // Extract path from sourcePath URL (e.g., https://main--repo--org.aem.page/my-page -> /my-page)
      const urlMatch = entry.sourcePath.match(/\.aem\.page(\/.*?)$/);
      if (urlMatch) {
        const sourcePath = urlMatch[1];
        const user = previewUserMap.get(sourcePath);

        if (verbose && index < 3) {
          console.log(`\n  Entry ${index + 1}:`);
          console.log(`    sourcePath: ${entry.sourcePath}`);
          console.log(`    extracted path: ${sourcePath}`);
          console.log(`    found user: ${user || 'none'}`);
          console.log(`    fallback user: ${fallbackUser || 'none'}`);
        }

        if (user) {
          enriched.user = user;
          foundUsers += 1; // eslint-disable-line no-plusplus
        } else if (fallbackUser) {
          enriched.user = fallbackUser;
          usedFallback += 1; // eslint-disable-line no-plusplus
        } else {
          noUser += 1; // eslint-disable-line no-plusplus
        }
      } else {
        if (verbose && index < 3) {
          console.log(`\n  Entry ${index + 1}: Failed to extract path from ${entry.sourcePath}`);
        }
        if (fallbackUser) {
          enriched.user = fallbackUser;
          usedFallback += 1; // eslint-disable-line no-plusplus
        } else {
          noUser += 1; // eslint-disable-line no-plusplus
        }
      }
    } else if (fallbackUser) {
      // No sourcePath (standalone media), use fallback user
      enriched.user = fallbackUser;
      usedFallback += 1; // eslint-disable-line no-plusplus
    } else {
      noUser += 1; // eslint-disable-line no-plusplus
    }

    return enriched;
  });

  if (verbose) {
    console.log('\n  User enrichment summary:');
    console.log(`    Found from preview logs: ${foundUsers}`);
    console.log(`    Used fallback user: ${usedFallback}`);
    console.log(`    No user assigned: ${noUser}`);
  }

  return enrichedEntries;
}

export function generateReport(stats) {
  const {
    pagesDiscovered,
    markdownPagesProcessed,
    standaloneMediaFound,
    mediaFromMarkdown,
    totalMediaFound,
    batchesSent,
    errors
  } = stats;

  return `
📊 Media Log Ingestion Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Resources discovered:        ${pagesDiscovered}
Markdown pages processed:    ${markdownPagesProcessed}
Standalone media found:      ${standaloneMediaFound}
Media from markdown:         ${mediaFromMarkdown}
Total media logged:          ${totalMediaFound}
Batches sent:                ${batchesSent}
Errors:                      ${errors}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `;
}
