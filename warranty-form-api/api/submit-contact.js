/**
 * MOSS Contact Form - Vercel Serverless Function
 *
 * Flow:
 * 1. Verify Cloudflare Turnstile token
 * 2. Look up calendar URL from Moss EasyTerritory by zip code
 * 3. If Moss returns out-of-service-area, try Renolution EasyTerritory
 *    - If Renolution has territory: fire-and-forget lead to Renolution API, return Renolution URL
 *    - If no territory: return out-of-service URL
 * 4. If Moss has territory: fire-and-forget HubSpot submission, return Moss URL
 * 5. Return { success: true, calendarUrl }
 *
 * Environment Variables:
 * - TURNSTILE_SECRET_KEY
 * - HUBSPOT_PORTAL_ID (default: 2719512)
 * - HUBSPOT_FORM_ID (default: eeafd136-fe2c-4a6a-852b-499e913cce16)
 * - EASYTERRITORY_BASE_URL, EASYTERRITORY_GUID, EASYTERRITORY_INSTANCE_TYPE,
 *   EASYTERRITORY_USERNAME, EASYTERRITORY_PASSWORD, EASYTERRITORY_PROJECT_ID
 * - RENOLUTION_EASYTERRITORY_PROJECT_ID (Renolution fallback)
 * - RENOLUTION_API_URL, RENOLUTION_API_KEY (Renolution lead creation)
 * - OUT_OF_SERVICE_URL (default: https://www.mossbuildinganddesign.com/out-of-service-area)
 * - DEFAULT_CALENDAR_URL (default: https://www.mossbuildinganddesign.com/default-meetings)
 */
import { lookupCalendarUrl, lookupRenolutionCalendarUrl } from '../lib/easyterritory.js';
import { sendAlert } from '../lib/alerts.js';

const ALERT_SOURCE = 'Customer Submission';

export default async function handler(req, res) {
  // CORS handled by vercel.json

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const {
      firstname,
      lastname,
      email,
      phone,
      state,
      zip,
      projectTypes,
      howDidYouHear,
      referralName,
      eventDetails,
      natalieChatTranscript,
      smsConsent,
      processingConsent,
      utmParams,
      hutk,
      turnstileToken,
      forceRoute
    } = req.body;

    // Validate required fields
    if (!firstname || !lastname || !email || !phone || !state || !zip || !projectTypes || !howDidYouHear) {
      return res.status(400).json({
        success: false,
        error: 'Please fill in all required fields.'
      });
    }

    // -------------------------------------------------------------------------
    // 1. Check for API key bypass (external callers skip Turnstile)
    // -------------------------------------------------------------------------
    const CONTACT_API_KEY = process.env.CONTACT_API_KEY;
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const isApiKeyAuth = CONTACT_API_KEY && bearerToken === CONTACT_API_KEY;

    // `forceRoute` is an optional routing override sent by trusted server-to-
    // server callers (e.g. the moss-website chat agent). 'renolution' skips
    // MOSS entirely; 'moss' skips the Renolution fallback. The override is
    // ONLY honored for API-key-authenticated callers — anonymous browser
    // submissions cannot mis-route their own lead. Without this guard a
    // visitor could set forceRoute='renolution' on the public form and
    // permanently shift their lead away from HubSpot.
    const forceRouteValid = forceRoute === 'renolution' || forceRoute === 'moss';
    const normalizedForceRoute = isApiKeyAuth && forceRouteValid ? forceRoute : null;
    if (forceRouteValid && !isApiKeyAuth) {
      console.warn(`[ContactForm] Ignoring forceRoute=${forceRoute} from non-API-key caller (email=${email})`);
    }

    // -------------------------------------------------------------------------
    // 2. Verify Cloudflare Turnstile Token (skipped for API key callers)
    // -------------------------------------------------------------------------
    if (!isApiKeyAuth) {
      const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
      if (TURNSTILE_SECRET_KEY) {
        if (!turnstileToken) {
          return res.status(400).json({
            success: false,
            error: 'Security verification is required. Please complete the verification and try again.'
          });
        }

        const turnstileController = new AbortController();
        const turnstileTimeout = setTimeout(() => turnstileController.abort(), 10000);
        let turnstileResponse;
        try {
          turnstileResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            signal: turnstileController.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              secret: TURNSTILE_SECRET_KEY,
              response: turnstileToken
            })
          });
        } finally {
          clearTimeout(turnstileTimeout);
        }

        const turnstileResult = await turnstileResponse.json();

        if (!turnstileResult.success) {
          console.error('Turnstile verification failed:', turnstileResult);
          return res.status(403).json({
            success: false,
            error: 'Security verification failed. Please refresh the page and try again.'
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Look up calendar URL from EasyTerritory (Moss first, Renolution fallback)
    // -------------------------------------------------------------------------
    const DEFAULT_CALENDAR_URL = process.env.DEFAULT_CALENDAR_URL || 'https://www.mossbuildinganddesign.com/default-meetings';
    const OUT_OF_SERVICE_URL = process.env.OUT_OF_SERVICE_URL || 'https://www.mossbuildinganddesign.com/out-of-service-area';

    let calendarUrl = DEFAULT_CALENDAR_URL;
    let isRenolutionLead = false;

    try {
      if (normalizedForceRoute === 'renolution') {
        // Trusted caller is force-routing this lead to Renolution. Skip MOSS
        // lookup entirely — go straight to Renolution. No fallback to MOSS
        // even if Renolution has no territory for this ZIP.
        console.log(`[ContactForm] forceRoute=renolution — skipping MOSS lookup, going direct to Renolution`);
        const renolutionUrl = await lookupRenolutionCalendarUrl(zip);

        if (renolutionUrl) {
          calendarUrl = renolutionUrl;
          isRenolutionLead = true;
          console.log(`[ContactForm] Renolution territory found: ${renolutionUrl}`);
        } else {
          // Renolution can't take this ZIP — treat as out-of-service.
          // Still mark as Renolution lead so we don't accidentally HubSpot it.
          calendarUrl = OUT_OF_SERVICE_URL;
          isRenolutionLead = true;
          console.log('[ContactForm] forceRoute=renolution but no Renolution territory — out of service');
        }
      } else if (normalizedForceRoute === 'moss') {
        // Trusted caller is forcing MOSS routing — skip the Renolution
        // fallback. If MOSS has no territory, go out-of-service.
        console.log(`[ContactForm] forceRoute=moss — skipping Renolution fallback`);
        const mossUrl = await lookupCalendarUrl(zip);
        // The out-of-service-area substring check is intentional: operators
        // can encode an out-of-service URL directly into a polygon tag in
        // EasyTerritory (a "soft denial") in addition to having no polygon
        // at all. Both cases should be treated as no MOSS coverage.
        if (mossUrl && !mossUrl.includes('out-of-service-area')) {
          calendarUrl = mossUrl;
        } else {
          calendarUrl = OUT_OF_SERVICE_URL;
          console.log('[ContactForm] forceRoute=moss but no MOSS territory — out of service');
        }
      } else {
        // Default behavior — try MOSS first, fall back to Renolution.
        const mossUrl = await lookupCalendarUrl(zip);

        // See note above re: tag-encoded out-of-service URLs.
        if (mossUrl && !mossUrl.includes('out-of-service-area')) {
          calendarUrl = mossUrl;
        } else {
          console.log('[ContactForm] No Moss territory, trying Renolution fallback');
          const renolutionUrl = await lookupRenolutionCalendarUrl(zip);

          if (renolutionUrl) {
            calendarUrl = renolutionUrl;
            isRenolutionLead = true;
            console.log(`[ContactForm] Renolution territory found: ${renolutionUrl}`);
          } else {
            calendarUrl = OUT_OF_SERVICE_URL;
            console.log('[ContactForm] No Renolution territory either, using out-of-service URL');
          }
        }
      }
    } catch (err) {
      console.error('[ContactForm] EasyTerritory lookup error:', err);
      // Preserve the routing intent on error: if the caller forced Renolution,
      // mark the lead as Renolution so it still goes to the Renolution CRM
      // (not HubSpot) even though we don't have a calendar URL. Same for
      // forceRoute='moss' — keep it on the HubSpot path.
      if (normalizedForceRoute === 'renolution') {
        isRenolutionLead = true;
      }
      await sendAlert(
        'EasyTerritory Lookup Failed',
        `Error: ${err.message}\nZip: ${zip}\nEmail: ${email}\nforceRoute: ${normalizedForceRoute || 'none'}`,
        ALERT_SOURCE
      ).catch(() => {});
    }

    // -------------------------------------------------------------------------
    // 4. Route to correct CRM (fire-and-forget)
    // -------------------------------------------------------------------------
    if (isRenolutionLead) {
      // Send lead to Renolution API (skip HubSpot)
      const RENOLUTION_API_URL = process.env.RENOLUTION_API_URL;
      const RENOLUTION_API_KEY = process.env.RENOLUTION_API_KEY;

      if (RENOLUTION_API_URL && RENOLUTION_API_KEY) {
        const renController = new AbortController();
        const renTimeout = setTimeout(() => renController.abort(), 10000);
        try {
          const renRes = await fetch(RENOLUTION_API_URL, {
            method: 'POST',
            signal: renController.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${RENOLUTION_API_KEY}`,
            },
            body: JSON.stringify({
              firstname,
              lastname,
              email,
              phone,
              state,
              zip,
              projectTypes: Array.isArray(projectTypes) ? projectTypes : [projectTypes],
              howDidYouHear,
              referralName: referralName || null,
              eventDetails: eventDetails || null,
              natalieChatTranscript: natalieChatTranscript || null,
            }),
          });
          if (renRes && !renRes.ok) {
            const renError = await renRes.text().catch(() => 'unknown');
            console.error('[ContactForm] Renolution API failed:', renRes.status, renError);
            await sendAlert(
              'Renolution API Failed',
              `Status: ${renRes.status}\nError: ${renError}\nEmail: ${email}\nZip: ${zip}`,
              ALERT_SOURCE
            ).catch(() => {});
          }
        } catch (err) {
          console.error('[ContactForm] Renolution API error:', err);
          await sendAlert(
            'Renolution API Error',
            `Error: ${err.message}\nEmail: ${email}\nZip: ${zip}`,
            ALERT_SOURCE
          ).catch(() => {});
        } finally {
          clearTimeout(renTimeout);
        }
      } else {
        console.warn('[ContactForm] Renolution API not configured, skipping lead creation');
      }
    } else {
      // Submit to HubSpot (Moss territory or fallback)
      const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '2719512';
      const HUBSPOT_FORM_ID = process.env.HUBSPOT_FORM_ID || 'eeafd136-fe2c-4a6a-852b-499e913cce16';

      const hubspotFields = [
        { name: 'firstname', value: firstname },
        { name: 'lastname', value: lastname },
        { name: 'email', value: email },
        { name: 'phone', value: phone },
        { name: 'state_contact_form', value: state },
        { name: 'zip', value: zip },
        { name: 'please_select_the_project_types_that_most_closely_match_your_current_request_', value: Array.isArray(projectTypes) ? projectTypes.join(';') : projectTypes },
        { name: 'how_did_you_hear_about_us_', value: howDidYouHear }
      ];

      if (referralName) {
        hubspotFields.push({ name: 'referral_name', value: referralName });
      }
      if (eventDetails) {
        hubspotFields.push({ name: 'event_details', value: eventDetails });
      }
      if (natalieChatTranscript) {
        hubspotFields.push({ name: 'natalie_chat_transcript', value: natalieChatTranscript });
      }

      if (utmParams) {
        if (utmParams.utm_campaign) hubspotFields.push({ name: 'utm_campaign', value: utmParams.utm_campaign });
        if (utmParams.utm_term) hubspotFields.push({ name: 'utm_term', value: utmParams.utm_term });
        if (utmParams.utm_source) hubspotFields.push({ name: 'utm_source', value: utmParams.utm_source });
        if (utmParams.utm_content) hubspotFields.push({ name: 'utm_content', value: utmParams.utm_content });
        if (utmParams.utm_medium) hubspotFields.push({ name: 'utm_medium', value: utmParams.utm_medium });
      }

      // HubSpot consent — legitimateInterest format requires value + legalBasis
      const consentData = {};
      if (processingConsent) {
        consentData.value = true;
        consentData.legalBasis = 'LEGITIMATE_INTEREST_PQL';
        consentData.text = 'I agree to allow Moss Building & Design to store and process my personal data.';
      }
      if (smsConsent) {
        consentData.communications = [
          {
            value: true,
            subscriptionTypeId: 999,
            text: 'I agree to receive text messages from Moss Building & Design.'
          }
        ];
      }

      const hubspotContext = {
        pageUri: 'https://www.mossbuildinganddesign.com/contact-moss',
        pageName: 'Contact MOSS'
      };
      if (hutk) {
        hubspotContext.hutk = hutk;
      }

      const hubspotBody = {
        fields: hubspotFields,
        context: hubspotContext
      };

      if (Object.keys(consentData).length > 0) {
        hubspotBody.legalConsentOptions = {
          legitimateInterest: consentData
        };
      }

      // Await HubSpot submission so alerts can fire before Vercel freezes the function
      const hsUrl = `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_ID}`;
      const hsController = new AbortController();
      const hsTimeout = setTimeout(() => hsController.abort(), 10000);
      try {
        let hsRes = await fetch(hsUrl, {
          method: 'POST',
          signal: hsController.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hubspotBody)
        });

        // Read response body once (can only be consumed once)
        if (!hsRes.ok) {
          const hsError = await hsRes.text().catch(() => 'unknown');

          // If hutk was invalid, retry without it
          if (hubspotContext.hutk && hsError.includes('INVALID_HUTK')) {
            console.warn('[ContactForm] Invalid hutk, retrying without it');
            delete hubspotContext.hutk;
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), 10000);
            try {
              hsRes = await fetch(hsUrl, {
                method: 'POST',
                signal: retryController.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(hubspotBody)
              });
            } finally {
              clearTimeout(retryTimeout);
            }

            if (!hsRes.ok) {
              const retryError = await hsRes.text().catch(() => 'unknown');
              console.error('[ContactForm] HubSpot submission failed after hutk retry:', hsRes.status, retryError);
              await sendAlert(
                'HubSpot Submission Failed',
                `Status: ${hsRes.status}\nError: ${retryError}\nEmail: ${email}\nZip: ${zip}`,
                ALERT_SOURCE
              ).catch(() => {});
            }
          } else {
            console.error('[ContactForm] HubSpot submission failed:', hsRes.status, hsError);
            await sendAlert(
              'HubSpot Submission Failed',
              `Status: ${hsRes.status}\nError: ${hsError}\nEmail: ${email}\nZip: ${zip}`,
              ALERT_SOURCE
            ).catch(() => {});
          }
        }
      } catch (err) {
        console.error('[ContactForm] HubSpot submission error:', err);
        await sendAlert(
          'HubSpot Submission Error',
          `Error: ${err.message}\nEmail: ${email}\nZip: ${zip}`,
          ALERT_SOURCE
        ).catch(() => {});
      } finally {
        clearTimeout(hsTimeout);
      }
    }

    return res.status(200).json({
      success: true,
      calendarUrl
    });

  } catch (error) {
    console.error('[ContactForm] Server error:', error);
    await sendAlert(
      'Contact Form Server Error',
      `Error: ${error.message}\nStack: ${error.stack}`,
      ALERT_SOURCE
    ).catch(() => {});
    return res.status(500).json({
      success: false,
      error: 'An error occurred processing your request. Please try again.'
    });
  }
}
