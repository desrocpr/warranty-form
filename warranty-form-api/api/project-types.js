/**
 * Project Types Endpoint
 *
 * Returns the project type options from the HubSpot CRM property definition.
 * Supports optional exclusion via ?exclude=value1;value2 query param.
 *
 * GET /api/project-types
 * GET /api/project-types?exclude=Handyman%20Services;Other
 *
 * Environment Variables:
 * - HUBSPOT_ACCESS_TOKEN (HubSpot private app token with crm.schemas.contacts.read scope)
 */

const PROPERTY_NAME = 'please_select_the_project_types_that_most_closely_match_your_current_request_';

// Cache property options in memory (refreshed every 15 minutes)
let cachedOptions = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 15 * 60 * 1000;

// Rate limiting: max 60 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  // CORS handled by vercel.json

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!HUBSPOT_ACCESS_TOKEN) {
    console.error('[ProjectTypes] HUBSPOT_ACCESS_TOKEN not configured');
    return res.status(500).json({ error: 'Service not configured' });
  }

  try {
    const now = Date.now();

    // Use cached options if still fresh
    if (!cachedOptions || now - cacheTimestamp > CACHE_TTL_MS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const hsRes = await fetch(
          `https://api.hubapi.com/crm/v3/properties/contact/${PROPERTY_NAME}`,
          {
            method: 'GET',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
            },
          }
        );

        if (!hsRes.ok) {
          const errText = await hsRes.text().catch(() => 'unknown');
          console.error('[ProjectTypes] HubSpot API failed:', hsRes.status, errText);
          // Return stale cache if available
          if (cachedOptions) {
            console.warn('[ProjectTypes] Returning stale cache');
          } else {
            return res.status(502).json({ error: 'Failed to fetch project types' });
          }
        } else {
          const property = await hsRes.json();
          cachedOptions = (property.options || []).map((opt) => ({
            value: opt.value,
            label: opt.label,
          }));
          cacheTimestamp = now;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    // Apply exclusion filter if provided
    let options = cachedOptions;
    const exclude = req.query.exclude;
    if (exclude) {
      const excludeSet = new Set(exclude.split(';').map((v) => v.trim()));
      options = options.filter((opt) => !excludeSet.has(opt.value));
    }

    return res.status(200).json({ options });
  } catch (err) {
    console.error('[ProjectTypes] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
