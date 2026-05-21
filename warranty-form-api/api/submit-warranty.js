/**
 * Submit Warranty Endpoint
 *
 * Accepts a warranty-claim payload from the warranty form, verifies the
 * Cloudflare Turnstile token, looks up (or creates) a HubSpot contact,
 * creates a HubSpot Ticket on the warranty pipeline associated to that
 * contact, and returns the ticket ID + a booking URL placeholder.
 *
 * POST {
 *   name, email, phone,
 *   originalAddress, completionYear, issueCategory, issueDescription,
 *   photoUrls?: string[],
 *   turnstileToken
 * }
 *
 * Environment Variables:
 * - TURNSTILE_SECRET_KEY        Cloudflare Turnstile server-side secret
 * - HUBSPOT_ACCESS_TOKEN        HubSpot private app token (tickets + contacts scope)
 * - HUBSPOT_TICKET_PIPELINE_ID  Warranty Tickets pipeline ID
 * - HUBSPOT_TICKET_STAGE_NEW    Initial stage ID for new warranty tickets
 * - DEFAULT_CALENDAR_URL        Placeholder booking URL (cal.com integration is MOS-206)
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const CONTACT_TO_TICKET_ASSOCIATION_TYPE_ID = 16; // HubSpot default: contact_to_ticket

const HIGH_PRIORITY_CATEGORIES = new Set(['Structural', 'Electrical']);

const REQUIRED_FIELDS = [
  'name',
  'email',
  'phone',
  'originalAddress',
  'completionYear',
  'issueCategory',
  'issueDescription',
  'turnstileToken',
];

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

function splitName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { firstname: '', lastname: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstname: parts[0], lastname: '' };
  }
  const lastname = parts[parts.length - 1];
  const firstname = parts.slice(0, -1).join(' ');
  return { firstname, lastname };
}

async function verifyTurnstile(token, secret) {
  const params = new URLSearchParams();
  params.append('secret', secret);
  params.append('response', token);

  const resp = await fetch(TURNSTILE_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) return false;
  const data = await resp.json().catch(() => ({}));
  return !!data.success;
}

async function findContactByEmail(email, accessToken) {
  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
        },
      ],
      properties: ['email'],
      limit: 1,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => 'unknown');
    throw new Error(`HubSpot contact search failed: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  if (data.results && data.results.length > 0) {
    return data.results[0].id;
  }
  return null;
}

async function createContact({ name, email, phone }, accessToken) {
  const { firstname, lastname } = splitName(name);
  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        firstname,
        lastname,
        email,
        phone,
      },
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => 'unknown');
    throw new Error(`HubSpot contact create failed: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  return data.id;
}

async function createTicket(
  {
    contactId,
    subject,
    content,
    originalAddress,
    completionYear,
    issueCategory,
    photoUrls,
    pipelineId,
    stageId,
    priority,
  },
  accessToken
) {
  const body = {
    properties: {
      subject,
      content,
      original_address: originalAddress,
      completion_year: String(completionYear),
      issue_category: issueCategory,
      photo_urls: Array.isArray(photoUrls) ? photoUrls.join(';') : '',
      hs_pipeline: pipelineId,
      hs_pipeline_stage: stageId,
      hs_ticket_priority: priority,
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: CONTACT_TO_TICKET_ASSOCIATION_TYPE_ID,
          },
        ],
      },
    ],
  };

  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/tickets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => 'unknown');
    throw new Error(`HubSpot ticket create failed: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  return data.id;
}

export default async function handler(req, res) {
  // CORS handled by vercel.json
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const {
    name,
    email,
    phone,
    originalAddress,
    completionYear,
    issueCategory,
    issueDescription,
    photoUrls,
    turnstileToken,
  } = body;

  // Validate required fields
  for (const field of REQUIRED_FIELDS) {
    if (!hasValue(body[field])) {
      return res.status(400).json({ error: `Missing required field: ${field}` });
    }
  }

  // Verify Turnstile
  const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
  if (!TURNSTILE_SECRET_KEY) {
    console.error('[SubmitWarranty] TURNSTILE_SECRET_KEY not configured');
    return res.status(500).json({ error: 'Service not configured' });
  }

  let turnstileOk = false;
  try {
    turnstileOk = await verifyTurnstile(turnstileToken, TURNSTILE_SECRET_KEY);
  } catch (err) {
    console.error('[SubmitWarranty] Turnstile verification error:', err);
    return res.status(403).json({ error: 'Turnstile verification failed' });
  }
  if (!turnstileOk) {
    return res.status(403).json({ error: 'Turnstile verification failed' });
  }

  // HubSpot config
  const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  const HUBSPOT_TICKET_PIPELINE_ID = process.env.HUBSPOT_TICKET_PIPELINE_ID;
  const HUBSPOT_TICKET_STAGE_NEW = process.env.HUBSPOT_TICKET_STAGE_NEW;
  if (!HUBSPOT_ACCESS_TOKEN || !HUBSPOT_TICKET_PIPELINE_ID || !HUBSPOT_TICKET_STAGE_NEW) {
    console.error('[SubmitWarranty] HubSpot environment not configured');
    return res.status(500).json({ error: 'Service not configured' });
  }

  const priority = HIGH_PRIORITY_CATEGORIES.has(issueCategory) ? 'HIGH' : 'MEDIUM';

  try {
    // Look up or create contact
    let contactId = await findContactByEmail(email, HUBSPOT_ACCESS_TOKEN);
    if (!contactId) {
      contactId = await createContact({ name, email, phone }, HUBSPOT_ACCESS_TOKEN);
    }

    // Create ticket with inline association to contact
    const ticketId = await createTicket(
      {
        contactId,
        subject: `Warranty claim — ${issueCategory}`,
        content: issueDescription,
        originalAddress,
        completionYear,
        issueCategory,
        photoUrls,
        pipelineId: HUBSPOT_TICKET_PIPELINE_ID,
        stageId: HUBSPOT_TICKET_STAGE_NEW,
        priority,
      },
      HUBSPOT_ACCESS_TOKEN
    );

    // bookingUrl is a placeholder — real cal.com wiring lives in MOS-206.
    const bookingUrl = process.env.DEFAULT_CALENDAR_URL || null;

    return res.status(200).json({ ticketId, bookingUrl });
  } catch (err) {
    console.error('[SubmitWarranty] HubSpot API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
