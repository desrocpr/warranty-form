/**
 * Embed Failure Endpoint
 *
 * Called by client JS when a calendar embed (Cal.com or HubSpot) fails to load.
 * Sends the customer's contact info to a dedicated Teams webhook so the team
 * can follow up directly.
 *
 * POST { contact: { firstname, lastname, email, phone, zip }, embedType, calendarUrl, error }
 *
 * Environment Variables:
 * - EMBED_FAILURE_WEBHOOK_URL (dedicated Teams webhook for follow-up)
 * - CONTACT_API_KEY (bearer token auth)
 */
import { sendAlert } from '../lib/alerts.js';

function sanitizeField(val, maxLen = 200) {
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

  // Require CONTACT_API_KEY
  const CONTACT_API_KEY = process.env.CONTACT_API_KEY;
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!CONTACT_API_KEY || bearerToken !== CONTACT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { contact, embedType, calendarUrl, error } = req.body || {};

  if (!contact || !contact.email) {
    return res.status(400).json({ error: 'Missing contact info (email required)' });
  }

  const name = `${contact.firstname || ''} ${contact.lastname || ''}`.trim() || 'Unknown';
  console.log(`[EmbedFailure] type=${sanitizeField(embedType)} zip=${sanitizeField(contact.zip)}`);

  // Send to dedicated webhook if configured, otherwise fall back to default alerts
  const webhookUrl = process.env.EMBED_FAILURE_WEBHOOK_URL;

  if (webhookUrl) {
    const timestamp = new Date().toISOString();
    const card = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: '📞 Customer Needs Follow-Up',
                weight: 'Bolder',
                size: 'Medium',
                color: 'Attention',
              },
              {
                type: 'TextBlock',
                text: 'Calendar embed failed to load — customer is waiting for someone to reach out.',
                wrap: true,
              },
              {
                type: 'FactSet',
                facts: [
                  { title: 'Name', value: name },
                  { title: 'Email', value: contact.email },
                  { title: 'Phone', value: contact.phone || 'N/A' },
                  { title: 'Zip', value: contact.zip || 'N/A' },
                  { title: 'Embed Type', value: embedType === 'hubspot' ? 'HubSpot Meetings' : 'Cal.com' },
                  { title: 'Calendar URL', value: calendarUrl || 'N/A' },
                ],
              },
              {
                type: 'TextBlock',
                text: `Error: ${sanitizeField(error, 300)}`,
                wrap: true,
                fontType: 'Monospace',
                size: 'Small',
                isSubtle: true,
              },
              {
                type: 'TextBlock',
                text: `Reported: ${timestamp}`,
                isSubtle: true,
                size: 'Small',
              },
            ],
          },
        },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        console.error('[EmbedFailure] Webhook failed:', response.status, errText);
      }
    } catch (err) {
      console.error('[EmbedFailure] Webhook error:', err.message);
    } finally {
      clearTimeout(timeout);
    }
  } else {
    // Fall back to default alert channels
    await sendAlert(
      'Customer Needs Follow-Up — Embed Failed',
      `Name: ${name}\nEmail: ${contact.email}\nPhone: ${contact.phone || 'N/A'}\nZip: ${contact.zip || 'N/A'}\nEmbed: ${embedType || 'unknown'}\nError: ${sanitizeField(error, 300)}`,
      'Customer Browser'
    ).catch((err) => {
      console.error('[EmbedFailure] Alert send failed:', err);
    });
  }

  return res.status(200).json({ success: true });
}
