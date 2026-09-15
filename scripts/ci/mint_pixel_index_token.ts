/**
 * Mints a bearer token for a throwaway pixel-index user, to authenticate
 * POST /api/v1/assets calls from publish_examples_to_pixel_index.py against
 * a pixel-index instance this workflow itself just started (see
 * .github/workflows/pixel-index-publish-check.yml).
 *
 * Copied into vendor/pixel-index/services/api/ and run from there with
 * `npx tsx` so its relative imports (this file's own `./src/auth/tokens.js`)
 * and bare imports (`pg`) resolve against that workspace's real,
 * already-installed node_modules — the same shape as pixel-index's own
 * services/api/e2e/run.ts, which this deliberately mirrors: insert a user
 * row directly (no Discord OAuth round trip) and sign an access token with
 * the real signAccessToken(), the exact function the API verifies requests
 * with. No guild is configured in the e2e compose fixture this workflow
 * starts, so any inserted 'user'-role account is immediately submission-
 * eligible (services/api/src/auth/capability.ts's `if (!guild)` branch) —
 * nothing here needs admin/moderator elevation.
 */
import { Client } from 'pg';

import { signAccessToken } from './src/auth/tokens.js';

const databaseUrl = process.env.DATABASE_URL;
const sessionSecret = process.env.SESSION_SECRET;
if (!databaseUrl || !sessionSecret) {
  throw new Error('DATABASE_URL and SESSION_SECRET are required');
}

const discordId = `pixel-art-mcp-ci-${Date.now()}`;

const db = new Client({ connectionString: databaseUrl });
await db.connect();
try {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (discord_id, username, role) VALUES ($1, $1, 'user') RETURNING id`,
    [discordId],
  );
  const user = rows[0];
  if (!user) throw new Error('INSERT ... RETURNING id returned no row');
  // 30 minutes comfortably covers publishing every example; this token and
  // the user behind it only ever exist inside this job's own throwaway
  // compose stack, torn down (`docker compose down --volumes`) once it ends.
  const token = await signAccessToken({ sub: user.id }, sessionSecret, 30 * 60_000);
  process.stdout.write(token);
} finally {
  await db.end();
}
