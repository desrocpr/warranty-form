/**
 * Health Check & Keep-Alive — Vercel Cron Function
 *
 * Runs every 5 minutes (configured in vercel.json). Checks:
 * 1. Cloudflare Turnstile — verifies API reachable and secret key valid
 * 2. HubSpot Forms API — verifies endpoint is responding
 *
 * Tracks failure state across runs in Upstash Redis to send:
 * - One alert when a service goes down (not on every subsequent run)
 * - A recovery alert when a previously-failing service comes back up
 *
 * Environment Variables:
 * - CRON_SECRET (Vercel sets Authorization: Bearer <CRON_SECRET> on cron invocations)
 * - TURNSTILE_SECRET_KEY (for Turnstile health check)
 * - HUBSPOT_PORTAL_ID, HUBSPOT_FORM_ID (for HubSpot health check)
 * - UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (auto-set by Vercel Marketplace integration)
 */
import { Redis } from '@upstash/redis';
import { sendAlert } from '../lib/alerts.js';

const ALERT_SOURCE = 'Keep-Alive Health Check';
const REDIS_KEY = 'keepalive:failures';

const SERVICE_LABELS = {
  turnstile: 'Cloudflare Turnstile',
  hubspot: 'HubSpot Forms API',
};

function getRedis() {
  // Vercel Marketplace provisions Upstash credentials as KV_REST_API_URL / KV_REST_API_TOKEN.
  // Fall back to the canonical UPSTASH_REDIS_REST_* names if a project sets those manually.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }
  return new Redis({ url, token });
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify CRON_SECRET — fail closed if not configured
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${cronSecret}`) {
    console.warn('[KeepAlive] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Run all health checks in parallel
  const [turnstileResult, hubspotResult] = await Promise.allSettled([
    checkTurnstile(),
    checkHubSpot(),
  ]);

  const turnstile = {
    success: turnstileResult.status === 'fulfilled' && turnstileResult.value.success,
    error: turnstileResult.status === 'rejected'
      ? turnstileResult.reason.message
      : (turnstileResult.value && !turnstileResult.value.success ? turnstileResult.value.error : undefined),
  };

  const hubspot = {
    success: hubspotResult.status === 'fulfilled' && hubspotResult.value.success,
    error: hubspotResult.status === 'rejected'
      ? hubspotResult.reason.message
      : (hubspotResult.value && !hubspotResult.value.success ? hubspotResult.value.error : undefined),
  };

  // Build current failure state
  const now = Date.now();
  const currentFailures = {};
  if (!turnstile.success) currentFailures.turnstile = { error: turnstile.error || 'unknown', since: now };
  if (!hubspot.success) currentFailures.hubspot = { error: hubspot.error || 'unknown', since: now };

  console.log(
    `[KeepAlive] Turnstile: ${turnstile.success ? 'OK' : 'FAIL'} — HubSpot: ${hubspot.success ? 'OK' : 'FAIL'}`
  );

  // Compare with previous run state for new-failure / recovery detection
  const redis = getRedis();
  let previousFailures = {};
  if (redis) {
    try {
      const stored = await redis.get(REDIS_KEY);
      if (stored && typeof stored === 'object') {
        previousFailures = stored;
      }
    } catch (err) {
      console.error('[KeepAlive] Redis get failed:', err.message);
    }
  } else {
    console.warn('[KeepAlive] Upstash Redis not configured — recovery tracking disabled');
  }

  // Carry over `since` timestamps for ongoing failures so the next recovery shows full duration
  for (const key of Object.keys(currentFailures)) {
    if (previousFailures[key]?.since) {
      currentFailures[key].since = previousFailures[key].since;
    }
  }

  // Detect transitions
  const newFailures = Object.keys(currentFailures).filter((k) => !previousFailures[k]);
  const recoveries = Object.keys(previousFailures).filter((k) => !currentFailures[k]);

  // Send alert for newly-failed services
  if (newFailures.length > 0) {
    const lines = newFailures.map((k) => `${SERVICE_LABELS[k] || k}: ${currentFailures[k].error}`);
    await sendAlert(
      `${newFailures.length} service(s) down`,
      lines.join('\n'),
      ALERT_SOURCE
    ).catch((err) => {
      console.error('[KeepAlive] Failure alert send failed:', err);
    });
  }

  // Send recovery alert for services that came back up
  if (recoveries.length > 0) {
    const lines = recoveries.map((k) => {
      const since = previousFailures[k].since;
      const duration = since ? formatDuration(now - since) : 'unknown';
      return `${SERVICE_LABELS[k] || k} recovered (was down for ${duration})`;
    });
    await sendAlert(
      `${recoveries.length} service(s) recovered`,
      lines.join('\n'),
      ALERT_SOURCE
    ).catch((err) => {
      console.error('[KeepAlive] Recovery alert send failed:', err);
    });
  }

  // Persist current state
  if (redis) {
    try {
      if (Object.keys(currentFailures).length === 0) {
        await redis.del(REDIS_KEY);
      } else {
        await redis.set(REDIS_KEY, currentFailures);
      }
    } catch (err) {
      console.error('[KeepAlive] Redis set failed:', err.message);
    }
  }

  return res.status(200).json({
    success: Object.keys(currentFailures).length === 0,
    turnstile,
    hubspot,
    transitions: {
      newFailures,
      recoveries,
      ongoing: Object.keys(currentFailures).filter((k) => previousFailures[k]),
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Check Turnstile API reachability and secret key validity.
 * Posts a dummy token — expects `invalid-input-response` (not `invalid-input-secret`).
 */
async function checkTurnstile() {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { success: true, error: undefined }; // Not configured = skip
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: 'health-check-dummy-token' }),
  });

  if (!response.ok) {
    return { success: false, error: `Turnstile API returned ${response.status}` };
  }

  const data = await response.json();
  const errorCodes = data['error-codes'] || [];

  // `invalid-input-response` means the API is up and our secret key is valid
  // `invalid-input-secret` means our key is bad
  if (errorCodes.includes('invalid-input-secret')) {
    return { success: false, error: 'Invalid Turnstile secret key' };
  }

  return { success: true };
}

/**
 * Check HubSpot Forms API is responding.
 * Posts an empty payload — expects a 4xx validation error (not 5xx).
 */
async function checkHubSpot() {
  const portalId = process.env.HUBSPOT_PORTAL_ID || '2719512';
  const formId = process.env.HUBSPOT_FORM_ID || 'eeafd136-fe2c-4a6a-852b-499e913cce16';

  const response = await fetch(
    `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: [] }),
    }
  );

  // 4xx = API is up, rejecting bad input (expected)
  // 5xx = HubSpot is having issues
  if (response.status >= 500) {
    return { success: false, error: `HubSpot API returned ${response.status}` };
  }

  return { success: true };
}
