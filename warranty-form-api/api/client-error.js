/**
 * Client Error Reporting Endpoint
 *
 * Receives browser-side error reports for widget/embed failures.
 * Logs all errors; only alerts on embed load failures (not Turnstile — ad blocker noise).
 *
 * POST { type, message, url, userAgent }
 */
import { sendAlert } from '../lib/alerts.js';

const ALERT_SOURCE = 'Customer Browser';

// Error types that warrant an alert (embed failures = genuine service issues)
const ALERT_TYPES = new Set([
  'calcom_load',
  'hubspot_embed_load',
  'calcom_error',
  'hubspot_embed_error',
]);

// Per-instance alert cooldown to prevent alert flooding during outages
const lastAlertTime = {};
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes per error type

function sanitizeLogField(val, maxLen = 200) {
  return String(val || '').replace(/[\r\n\t]/g, ' ').slice(0, maxLen);
}

export default async function handler(req, res) {
  // CORS handled by vercel.json

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, message, url, userAgent } = req.body || {};

  if (!type) {
    return res.status(400).json({ error: 'Missing error type' });
  }

  console.log(`[ClientError] type=${sanitizeLogField(type)} message=${sanitizeLogField(message)} url=${sanitizeLogField(url)}`);

  // Only alert on embed failures — Turnstile failures are often ad blockers
  // Cooldown prevents alert flooding during prolonged outages
  if (ALERT_TYPES.has(type)) {
    const now = Date.now();
    if (lastAlertTime[type] && now - lastAlertTime[type] < ALERT_COOLDOWN_MS) {
      console.log(`[ClientError] Alert suppressed (cooldown): ${type}`);
    } else {
      lastAlertTime[type] = now;
      await sendAlert(
        `Client Error: ${type}`,
        `Type: ${type}\nMessage: ${sanitizeLogField(message, 500)}\nPage: ${sanitizeLogField(url, 500)}\nUser Agent: ${sanitizeLogField(userAgent, 300)}`,
        ALERT_SOURCE
      ).catch((err) => {
        console.error('[ClientError] Alert send failed:', err);
      });
    }
  }

  return res.status(200).json({ success: true });
}
