#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import chalk from 'chalk';
import ora from 'ora';
import PQueue from 'p-queue';
import {
  createBulkStatusJob,
  pollJobStatus,
  getJobDetails,
  fetchMarkdown,
  shouldProcessResource,
  isMediaFile,
} from './discovery.js';
import {
  extractMediaReferences, batchEntries, getContentType, extractDimensions, extractMediaHash,
} from './parser.js';
import {
  sendMediaLogBatch, saveFailedBatch, generateReport, verifyMediaLog, enrichEntriesWithUser,
} from './ingestor.js';
import { validateToken } from './token-manager.js';

dotenv.config();

// Helper Functions
function showTokenHelp() {
  console.log(chalk.blue.bold('\n=== How to Get Your Authentication Token ===\n'));

  console.log(chalk.cyan('Option 1: Extract from AEM Sidekick Extension (Recommended)\n'));
  console.log(chalk.gray('1. Make sure you are logged into your project via Sidekick'));
  console.log(chalk.gray('   If not logged in, open: ') + chalk.white('https://main--{repo}--{org}.aem.page/'));
  console.log(chalk.gray('   and use Sidekick to login\n'));
  console.log(chalk.gray('2. Open Chrome and go to: ') + chalk.white('chrome://extensions/?id=igkmdomcgoebiipaifhmpfjhbjccggml'));
  console.log(chalk.gray('3. Click the blue ') + chalk.white('"service worker"') + chalk.gray(' link under "Inspect views"'));
  console.log(chalk.gray('4. In the Console tab, paste and run:\n'));
  console.log(chalk.green(`   chrome.storage.session.get('projects').then(data => {
     data.projects.forEach(p => {
       if (p.authToken) {
         console.log(\`\\n\${p.owner}/\${p.repo}:\`);
         console.log(p.authToken);
       }
     });
   })\n`));
  console.log(chalk.gray('5. Find your org/repo and copy the token below it\n'));
  console.log(chalk.yellow('   Note: Sidekick tokens are org/repo specific!'));
  console.log(chalk.gray('   Visit: ') + chalk.white('https://main--{repo}--{org}.aem.page/') + chalk.gray(' and use Sidekick first\n'));

  console.log(chalk.cyan('Option 2: Create Admin API Key\n'));
  console.log(chalk.yellow('   Note: You must have "admin" role to create API keys!\n'));
  console.log(chalk.gray('1. Visit: ') + chalk.white('https://admin.hlx.page/login'));
  console.log(chalk.gray('2. Sign in with your Adobe credentials'));
  console.log(chalk.gray('3. Go to: ') + chalk.white('https://admin.hlx.page/config/{org}/sites/{site}/apiKeys.json'));
  console.log(chalk.gray('4. POST to create new API key with these settings:'));
  console.log(chalk.gray('   - Role: ') + chalk.white('admin'));
  console.log(chalk.gray('   - Scopes: ') + chalk.white('log:read, log:write'));
  console.log(chalk.gray('5. Copy the returned API key\n'));

  console.log(chalk.cyan('Required Permissions:\n'));
  console.log(chalk.gray('For user enrichment from preview logs, your token needs:'));
  console.log(chalk.gray('  - ') + chalk.white('log:read') + chalk.gray(' permission (included in "author" role or higher)'));
  console.log(chalk.gray('  - Reference: ') + chalk.white('https://www.aem.live/docs/authentication-setup-authoring'));
  console.log(chalk.gray('\nIf your token lacks log:read permissions:'));
  console.log(chalk.gray('  - You\'ll see 403 errors when fetching preview logs'));
  console.log(chalk.gray('  - Use ') + chalk.white('--skip-user-enrichment') + chalk.gray(' flag to disable user enrichment'));
  console.log(chalk.gray('  - Media entries will be created without user attribution\n'));

  console.log(chalk.cyan('Then use your token:\n'));
  console.log(chalk.white('  Method 1:') + chalk.gray(' Add to .env file'));
  console.log(chalk.green('    ADMIN_TOKEN=your-token-here\n'));
  console.log(chalk.white('  Method 2:') + chalk.gray(' Pass as command argument'));
  console.log(chalk.green('    logmedia --org myorg --repo myrepo --token your-token-here\n'));
}

async function runUserMappingTest(org, repo, ref, path, token, pollInterval, verbose) {
  const spinner = ora();

  try {
    console.log(chalk.blue.bold('\n=== User Mapping Test Mode ===\n'));
    console.log(chalk.yellow('This will test user mapping by fetching preview logs only.\n'));
    console.log(chalk.gray('Skipping: markdown parsing, media extraction, and medialog API calls\n'));

    spinner.start('Creating bulk status job...');
    const { jobId, jobUrl } = await createBulkStatusJob(org, repo, ref, path, token);
    spinner.succeed(`Job created: ${chalk.cyan(jobId)}`);

    spinner.start('Polling job status...');
    await pollJobStatus(jobUrl, token, parseInt(pollInterval, 10), (progress) => {
      if (verbose) {
        spinner.text = `Processing: ${progress.processed}/${progress.total} pages`;
      }
    });
    spinner.succeed('Job completed');

    spinner.start('Fetching job details...');
    const resources = await getJobDetails(jobUrl, token);
    spinner.succeed(`Discovered ${chalk.cyan(resources.length)} resources`);

    const processableResources = resources.filter(shouldProcessResource);
    const markdownCount = processableResources.filter((r) => !isMediaFile(r.path)).length;
    const mediaCount = processableResources.filter((r) => isMediaFile(r.path)).length;

    console.log(chalk.gray(`\nFound ${markdownCount} markdown pages and ${mediaCount} standalone media files`));

    spinner.start('Building preview user map from logs...');
    const { buildPreviewUserMap } = await import('./ingestor.js');
    const userMap = await buildPreviewUserMap(org, repo, ref, token, verbose);
    spinner.succeed(`Built user map with ${chalk.cyan(userMap.size)} path-to-user mappings`);

    // Display results
    console.log(chalk.green.bold('\n📊 User Mapping Test Results\n'));
    console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.white(`Total resources discovered:     ${resources.length}`));
    console.log(chalk.white(`Processable resources:          ${processableResources.length}`));
    console.log(chalk.white(`  - Markdown pages:             ${markdownCount}`));
    console.log(chalk.white(`  - Standalone media:           ${mediaCount}`));
    console.log(chalk.cyan(`Paths with user mapping:        ${userMap.size}`));

    const coveragePercent = processableResources.length > 0
      ? ((userMap.size / markdownCount) * 100).toFixed(1)
      : 0;
    console.log(chalk.cyan(`Coverage for markdown pages:    ${coveragePercent}%`));
    console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    // Show sample mappings
    if (userMap.size > 0) {
      console.log(chalk.blue.bold('Sample Path → User Mappings:\n'));
      const samples = Array.from(userMap.entries()).slice(0, 10);
      samples.forEach(([pagePath, user]) => {
        console.log(chalk.gray(`  ${pagePath}`));
        console.log(chalk.green(`    → ${user}\n`));
      });

      if (userMap.size > 10) {
        console.log(chalk.gray(`  ... and ${userMap.size - 10} more mappings\n`));
      }
    } else {
      console.log(chalk.yellow('⚠️  No user mappings found in preview logs\n'));
      console.log(chalk.gray('This could mean:'));
      console.log(chalk.gray('  - No pages have been previewed in the last 30 days'));
      console.log(chalk.gray('  - Preview logs don\'t contain user information'));
      console.log(chalk.gray('  - The token lacks log:read permissions (403 error)'));
      console.log(chalk.gray('  - The token is for a different org/repo\n'));

      console.log(chalk.cyan('💡 Required Permissions:'));
      console.log(chalk.gray('  - Token needs ') + chalk.white('log:read') + chalk.gray(' permission'));
      console.log(chalk.gray('  - Part of "author" role or higher in AEM'));
      console.log(chalk.gray('  - Reference: ') + chalk.white('https://www.aem.live/docs/authentication-setup-authoring'));
      console.log(chalk.gray('\n  If your token lacks permissions:'));
      console.log(chalk.gray('  - Use ') + chalk.white('--skip-user-enrichment') + chalk.gray(' during ingestion'));
      console.log(chalk.gray('  - Verify the token is for the correct org/repo'));
      console.log(chalk.gray('  - Sidekick tokens are org/repo specific\n'));
    }

    console.log(chalk.green('✓ User mapping test completed\n'));
    process.exit(0);
  } catch (error) {
    spinner.fail('Error');
    console.error(chalk.red(`\n✗ ${error.message}\n`));
    process.exit(1);
  }
}

async function runIngest(options) {
  const spinner = ora();

  try {
    console.log(chalk.blue.bold('\n=== Media Log Ingestor ===\n'));

    // Get token from CLI arg or env var
    const token = options.token || process.env.ADMIN_TOKEN;

    if (!token) {
      console.log(chalk.red('✗ No authentication token found\n'));
      console.log(chalk.gray('  Run this command to see how to get a token:\n'));
      console.log(chalk.cyan('    logmedia token\n'));
      process.exit(1);
    }

    // Validate token
    const validation = validateToken(token);
    if (!validation.valid) {
      console.log(chalk.red(`✗ Invalid token: ${validation.error}\n`));
      if (validation.expired) {
        console.log(chalk.yellow('  Your token has expired. Please get a new one.\n'));
      }
      console.log(chalk.gray('  Run: ') + chalk.cyan('logmedia token\n'));
      process.exit(1);
    }

    // Show token info
    if (validation.expiresAt) {
      const msLeft = validation.expiresAt - Date.now();
      const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));
      const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));

      if (daysLeft < 1) {
        console.log(chalk.yellow(
          `⚠️  Token expires in ${hoursLeft} hours (${validation.expiresAt.toLocaleString()})\n`,
        ));
      } else if (daysLeft < 7) {
        console.log(chalk.yellow(
          `⚠️  Token expires in ${daysLeft} days (${validation.expiresAt.toLocaleDateString()})\n`,
        ));
      }
    }
    const {
      org, repo, ref, path, user, dryRun, verify, skipUserEnrichment,
      concurrency, batchSize, pollInterval, verbose, userMapping,
    } = options;

    // User mapping test mode - skip parsing/sending, just test user mapping
    if (userMapping) {
      await runUserMappingTest(org, repo, ref, path, token, pollInterval, verbose);
      return;
    }

    const stats = {
      pagesDiscovered: 0,
      markdownPagesProcessed: 0,
      standaloneMediaFound: 0,
      mediaFromMarkdown: 0,
      totalMediaFound: 0,
      batchesSent: 0,
      errors: 0,
    };

    if (dryRun) {
      console.log(chalk.yellow('*** DRY RUN MODE - No data will be sent ***\n'));
    }

    spinner.start('Creating bulk status job...');
    const { jobId, jobUrl } = await createBulkStatusJob(org, repo, ref, path, token);
    spinner.succeed(`Job created: ${chalk.cyan(jobId)}`);

    spinner.start('Polling job status...');
    await pollJobStatus(jobUrl, token, parseInt(pollInterval, 10), (progress) => {
      if (verbose) {
        spinner.text = `Processing: ${progress.processed}/${progress.total} pages`;
      }
    });
    spinner.succeed('Job completed');

    spinner.start('Fetching job details...');
    const resources = await getJobDetails(jobUrl, token);
    stats.pagesDiscovered = resources.length;
    spinner.succeed(`Discovered ${chalk.cyan(resources.length)} resources`);

    const processableResources = resources.filter(shouldProcessResource);
    const markdownCount = processableResources.filter((r) => !isMediaFile(r.path)).length;
    const mediaCount = processableResources.filter((r) => isMediaFile(r.path)).length;
    console.log(chalk.gray(`Processing ${markdownCount} markdown pages and ${mediaCount} standalone media files...\n`));

    const queue = new PQueue({ concurrency: parseInt(concurrency, 10) });
    const allEntries = [];

    spinner.start('Fetching and parsing markdown files...');

    await queue.addAll(
      processableResources.map((resource) => async () => {
        try {
          if (isMediaFile(resource.path)) {
            const entry = {
              owner: org,
              repo,
              operation: 'ingest',
              path: resource.path,
              contentSourceType: 'markup',
            };

            // Add content type if we can determine it
            const contentType = getContentType(resource.path);
            if (contentType) {
              entry.contentType = contentType;
            }

            // Extract width and height from URL fragment if present
            const dimensions = extractDimensions(resource.path);
            if (dimensions) {
              entry.width = dimensions.width;
              entry.height = dimensions.height;
            }

            // Don't add user here - will be enriched later
            allEntries.push(entry);
            stats.standaloneMediaFound += 1;

            if (verbose) {
              console.log(chalk.gray(`  ${resource.path}: standalone media`));
            }
          } else {
            const markdown = await fetchMarkdown(org, repo, ref, resource.path, token);
            const entries = extractMediaReferences(markdown, resource.path, org, repo, ref);

            stats.markdownPagesProcessed += 1;

            if (entries.length > 0) {
              allEntries.push(...entries);
              stats.mediaFromMarkdown += entries.length;

              if (verbose) {
                console.log(chalk.gray(`  ${resource.path}: ${entries.length} media from markdown`));
                entries.forEach((entry) => {
                  console.log(chalk.gray(`    - ${entry.path}`));
                });
              }
            }
          }
        } catch (error) {
          stats.errors += 1;
          if (verbose) {
            console.error(chalk.red(`  ✗ ${resource.path}: ${error.message}`));
          }
        }
      }),
    );

    spinner.succeed(
      `Parsed ${stats.markdownPagesProcessed} markdown pages, found ${stats.standaloneMediaFound} standalone media`,
    );
    stats.totalMediaFound = allEntries.length;

    if (allEntries.length === 0) {
      console.log(chalk.yellow('\n⚠️  No media found'));
      return;
    }

    console.log(chalk.green(
      `\n✓ Total media: ${allEntries.length} (${stats.standaloneMediaFound} standalone + ${stats.mediaFromMarkdown} from markdown)`,
    ));

    // Apply deduplication: first occurrence is "ingest", subsequent are "reuse"
    spinner.start('Applying deduplication logic...');
    const seenHashes = new Set();
    let ingestCount = 0;
    let reuseCount = 0;

    const deduplicatedEntries = allEntries.map((entry) => {
      const hash = extractMediaHash(entry.path);
      let operation = 'ingest';

      if (hash) {
        if (seenHashes.has(hash)) {
          operation = 'reuse';
          reuseCount += 1;
        } else {
          seenHashes.add(hash);
          operation = 'ingest';
          ingestCount += 1;
        }
      } else {
        // No hash found (shouldn't happen for media URLs, but keep as ingest)
        operation = 'ingest';
        ingestCount += 1;
      }

      return { ...entry, operation };
    });

    spinner.succeed(
      `Deduplication complete: ${ingestCount} unique media (ingest), ${reuseCount} reuses`,
    );

    if (verbose && reuseCount > 0) {
      console.log(chalk.gray(`  Found ${seenHashes.size} unique media hashes`));
      console.log(chalk.gray(`  ${reuseCount} entries marked as "reuse"`));
    }

    // Replace allEntries with deduplicated entries
    allEntries.length = 0;
    allEntries.push(...deduplicatedEntries);

    // Enrich entries with user information from preview logs
    if (!dryRun && !skipUserEnrichment) {
      spinner.start('Enriching entries with user information from preview logs...');
      try {
        const enrichedEntries = await enrichEntriesWithUser(
          allEntries,
          org,
          repo,
          ref,
          token,
          user,
          verbose,
        );
        allEntries.length = 0;
        allEntries.push(...enrichedEntries);

        const entriesWithUsers = enrichedEntries.filter((e) => e.user).length;
        if (entriesWithUsers > 0) {
          spinner.succeed(`Enriched entries (${entriesWithUsers}/${allEntries.length} have user info)`);
        } else {
          spinner.warn('User enrichment completed but no users found (check token permissions)');
        }
      } catch (error) {
        spinner.warn(`User enrichment failed: ${error.message}`);
        console.log(chalk.yellow('\n  ⚠️  Continuing without user information...\n'));
      }
    } else if (skipUserEnrichment) {
      console.log(chalk.gray(
        '\n⏭️  Skipping user enrichment (--skip-user-enrichment flag set)\n',
      ));
    }

    const batches = batchEntries(allEntries, Math.min(parseInt(batchSize, 10), 10));
    console.log(chalk.gray(`Sending ${batches.length} batches...\n`));
    const estimatedTime = Math.ceil(batches.length / 10);
    console.log(chalk.yellow(
      `⏱️  Rate limit: 10 requests per second (estimated time: ~${estimatedTime} seconds)\n`,
    ));

    // Wait 2s to let rate limit recover after markdown fetching
    if (!dryRun) {
      console.log(chalk.gray('⏸️  Waiting 2s for rate limit recovery...\n'));
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }

    spinner.start('Sending to media log API...');

    const sleep = (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

    // Note: Sequential processing with await-in-loop is intentional here
    // to respect API rate limits (10 req/sec = 100ms between requests)
    for (const [index, batch] of batches.entries()) {
      try {
        await sendMediaLogBatch(org, repo, ref, batch, token, dryRun);
        stats.batchesSent += 1;

        if (verbose) {
          spinner.text = `Sent batch ${index + 1}/${batches.length}`;
        }

        // Respect rate limit: 10 requests per second = 100ms between requests
        if (index < batches.length - 1 && !dryRun) {
          await sleep(100);
        }
      } catch (error) {
        stats.errors += 1;
        await saveFailedBatch(batch, error);
        if (verbose) {
          console.error(chalk.red(`\n  ✗ Batch ${index + 1} failed: ${error.message}`));
        }
      }
    }

    spinner.succeed('Media log ingestion complete');

    if (verify && !dryRun && stats.batchesSent > 0) {
      spinner.start('Verifying entries in media log...');
      try {
        const result = await verifyMediaLog(org, repo, ref, token, 50);
        spinner.succeed(`Verified ${chalk.cyan(result.count)} recent entries in media log`);

        if (verbose && result.entries.length > 0) {
          console.log(chalk.gray('\nRecent entries (sample):'));
          result.entries.slice(0, 5).forEach((entry) => {
            const op = entry.operation || 'N/A';
            const src = entry.originalFilename || 'N/A';
            console.log(chalk.gray(`  ${op} | ${src} | ${entry.user || 'N/A'}`));
          });
        }
      } catch (error) {
        spinner.warn(`Verification failed: ${error.message}`);
      }
    }

    console.log(generateReport(stats));

    if (!dryRun && stats.batchesSent > 0) {
      console.log(chalk.green('\n✓ Entries successfully sent to media log'));
      const queryUrl = `https://admin.hlx.page/medialog/${org}/${repo}/${ref}?limit=100`;
      console.log(chalk.gray(`  Query: ${chalk.cyan(queryUrl)}`));
    }
  } catch (error) {
    spinner.fail('Error');
    console.error(chalk.red(`\n✗ ${error.message}\n`));
    process.exit(1);
  }
}

// CLI Setup
const program = new Command();

program
  .name('logmedia')
  .version('1.0.0')
  .description('Retroactively populate AEM media log')
  .addHelpText('after', `
Examples:
  $ logmedia --org myorg --repo myrepo
  $ logmedia --org myorg --repo myrepo --token YOUR_TOKEN
  $ logmedia --org myorg --repo myrepo --dry-run --verbose
  $ logmedia --org myorg --repo myrepo --skip-user-enrichment
  $ logmedia --org myorg --repo myrepo --user-mapping --verbose

User Enrichment:
  By default, the tool enriches media entries with user information from preview logs.
  This requires the token to have 'log:read' permission (part of 'author' role or higher).
  Use --skip-user-enrichment to disable this feature if your token lacks log permissions.

Getting a token:
  Run 'logmedia token' for instructions on obtaining an authentication token
`);

// Token help command
program
  .command('token')
  .description('Show how to get authentication token')
  .action(() => {
    showTokenHelp();
  });

// Main ingest command (default)
program
  .command('ingest', { isDefault: true })
  .description('Ingest media references into AEM media log')
  .requiredOption('--org <org>', 'Organization name')
  .requiredOption('--repo <repo>', 'Repository name')
  .option('--ref <ref>', 'Git reference (branch)', 'main')
  .option('--path <path>', 'Path filter (e.g., /products/*)', '/*')
  .option('--token <token>', 'Admin JWT token (or use ADMIN_TOKEN env var)')
  .option('--user <user>', 'User identifier for log entries')
  .option('--dry-run', 'Run without sending to API', false)
  .option('--verify', 'Verify entries after sending', false)
  .option('--skip-user-enrichment', 'Skip user enrichment from preview logs', false)
  .option('--concurrency <n>', 'Parallel markdown fetching', '3')
  .option('--batch-size <n>', 'Entries per batch (max 10)', '10')
  .option('--poll-interval <ms>', 'Job polling interval', '10000')
  .option('--verbose', 'Detailed logging', false)
  .option('--user-mapping', 'Test user mapping only (skip parsing/sending)', false)
  .action(async (options) => {
    await runIngest(options);
  });

program.parse(process.argv);
