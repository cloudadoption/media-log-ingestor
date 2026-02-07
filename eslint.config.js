/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/*
 * ESLint Configuration Notes:
 *
 * no-await-in-loop: Disabled for this CLI tool
 * Rationale: This tool implements three patterns that require sequential async operations:
 *   1. Rate-limited API requests: 10 req/sec limit requires 100ms delays between batches
 *   2. Retry logic with exponential backoff: Must wait before retrying failed requests
 *   3. Paginated API fetching: Next page URL only available after previous response
 *
 * These patterns are best practices for API interactions and cannot be parallelized
 * without violating rate limits or breaking pagination. Using Promise.all() would
 * defeat the purpose of rate limiting and proper retry behavior.
 */

import { defineConfig, globalIgnores } from '@eslint/config-helpers';
import { recommended, source, test } from '@adobe/eslint-config-helix';

export default defineConfig([
  globalIgnores([
    'node_modules/**',
    'coverage/**',
    '*.json',
    '.env',
    '.env.*',
    'failed-entries.json',
  ]),
  {
    extends: [recommended],
  },
  source,
  test,
  {
    rules: {
      // Allow console statements in CLI tool
      'no-console': 'off',
      // Disable header requirement (not an Adobe project)
      'header/header': 'off',
      // Ignore unresolved imports for p-queue (ESM compatibility issue)
      'import/no-unresolved': ['error', { ignore: ['^p-queue$'] }],
      // Allow await in loops for rate limiting, retry logic, and pagination
      'no-await-in-loop': 'off',
    },
  },
]);
