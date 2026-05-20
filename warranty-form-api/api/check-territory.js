/**
 * Check Territory — Vercel Serverless Function
 *
 * Server-to-server endpoint that answers "is this ZIP in MOSS or Renolution
 * territory?" without submitting a lead. Used by the moss-website chat agent
 * (Natalie) so customer-service answers stay in sync with the lead-capture
 * routing decision, which is also driven by EasyTerritory.
 *
 * Flow:
 * 1. Require Authorization: Bearer ${CONTACT_API_KEY} (no Turnstile — never
 *    called from the browser).
 * 2. Look up the ZIP in the MOSS EasyTerritory project.
 * 3. Look up the same ZIP in the Renolution EasyTerritory project.
 * 4. Return both results — Natalie decides what to say.
 *
 * Method: GET (idempotent, cache-friendly)
 * Query:  ?zip=XXXXX  (5-digit US ZIP; first 5 digits used)
 *
 * Response (200):
 *   {
 *     "zip": "22030",
 *     "inMossTerritory": true,
 *     "inRenolutionTerritory": false,
 *     "mossCalendarUrl": "https://...",          // null if not in MOSS territory
 *     "renolutionCalendarUrl": null              // null if not in Renolution territory
 *   }
 *
 * Errors:
 *   400  — missing or invalid zip
 *   401  — missing or wrong Authorization header
 *   500  — CONTACT_API_KEY not configured, or EasyTerritory lookup threw
 *
 * Environment Variables:
 * - CONTACT_API_KEY                     (required — Bearer token)
 * - EASYTERRITORY_*                     (see lib/easyterritory.js)
 * - RENOLUTION_EASYTERRITORY_PROJECT_ID (optional — without it, Renolution
 *                                        lookup short-circuits to null)
 */
import { lookupCalendarUrl, lookupRenolutionCalendarUrl } from '../lib/easyterritory.js';

export default async function handler(req, res) {
  // CORS preflight (vercel.json already sets the headers)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ---------------------------------------------------------------------------
  // Auth — require Bearer CONTACT_API_KEY. Fail closed if key isn't configured.
  // ---------------------------------------------------------------------------
  const CONTACT_API_KEY = process.env.CONTACT_API_KEY;
  if (!CONTACT_API_KEY) {
    console.error('[CheckTerritory] CONTACT_API_KEY not configured');
    return res.status(500).json({ success: false, error: 'Server not configured' });
  }

  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (bearerToken !== CONTACT_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // ---------------------------------------------------------------------------
  // Validate zip
  // ---------------------------------------------------------------------------
  const rawZip = typeof req.query?.zip === 'string' ? req.query.zip : '';
  const zip5 = rawZip.replace(/\D/g, '').slice(0, 5);
  if (zip5.length !== 5) {
    return res.status(400).json({
      success: false,
      error: 'zip query parameter must contain 5 digits',
    });
  }

  // ---------------------------------------------------------------------------
  // Look up both territories in parallel
  // ---------------------------------------------------------------------------
  try {
    const [mossResult, renolutionResult] = await Promise.allSettled([
      lookupCalendarUrl(zip5),
      lookupRenolutionCalendarUrl(zip5),
    ]);

    const mossCalendarUrl =
      mossResult.status === 'fulfilled' ? mossResult.value || null : null;
    const renolutionCalendarUrl =
      renolutionResult.status === 'fulfilled' ? renolutionResult.value || null : null;

    if (mossResult.status === 'rejected') {
      console.error('[CheckTerritory] MOSS lookup failed:', mossResult.reason?.message);
    }
    if (renolutionResult.status === 'rejected') {
      console.error('[CheckTerritory] Renolution lookup failed:', renolutionResult.reason?.message);
    }

    // If BOTH lookups threw (not "no territory found", but a real error like
    // EasyTerritory being down), surface as 500 so the caller can retry rather
    // than incorrectly tell the customer they're out-of-area.
    if (mossResult.status === 'rejected' && renolutionResult.status === 'rejected') {
      return res.status(500).json({
        success: false,
        error: 'Territory lookup failed',
      });
    }

    return res.status(200).json({
      success: true,
      zip: zip5,
      inMossTerritory: !!mossCalendarUrl,
      inRenolutionTerritory: !!renolutionCalendarUrl,
      mossCalendarUrl,
      renolutionCalendarUrl,
    });
  } catch (err) {
    console.error('[CheckTerritory] Unhandled error:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal error',
    });
  }
}
