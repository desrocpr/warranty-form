/**
 * Alert Module — SendGrid Email + MS Teams Webhook
 *
 * Sends alerts to both channels in parallel via Promise.allSettled.
 * If either channel's env vars are missing, that channel is silently skipped.
 * Errors in the alert module itself are console.error only (no infinite loops).
 *
 * Environment Variables:
 * - SENDGRID_API_KEY
 * - SENDGRID_FROM_EMAIL (verified sender)
 * - ALERT_EMAIL (recipient)
 * - TEAMS_WEBHOOK_URL (MS Teams incoming webhook)
 */

/**
 * Send an alert to both email and MS Teams.
 * @param {string} title - Short alert title (e.g. "HubSpot Submission Failed")
 * @param {string} details - Multi-line details (error messages, context)
 * @param {string} [source] - Optional origin tag, prefixed onto the title (e.g. "Keep-Alive Health Check", "Customer Submission")
 */
export async function sendAlert(title, details, source) {
  const timestamp = new Date().toISOString();
  if (source) {
    title = `[${source}] ${title}`;
  }

  const promises = [];

  // SendGrid email
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  const toEmail = process.env.ALERT_EMAIL;

  if (apiKey && fromEmail && toEmail) {
    promises.push(
      sendEmailAlert(apiKey, fromEmail, toEmail, title, details, timestamp)
    );
  }

  // MS Teams webhook
  const teamsUrl = process.env.TEAMS_WEBHOOK_URL;

  if (teamsUrl) {
    promises.push(
      sendTeamsAlert(teamsUrl, title, details, timestamp)
    );
  }

  if (promises.length === 0) {
    console.warn('[Alert] No alert channels configured — skipping alert:', title);
    return;
  }

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[Alert] Channel failed:', result.reason);
    }
  }
}

async function sendEmailAlert(apiKey, from, to, title, details, timestamp) {
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px;">
      <h2 style="color: #c0392b; margin: 0 0 16px 0;">⚠ ${escapeHtml(title)}</h2>
      <pre style="background: #f8f9fa; padding: 16px; border-radius: 4px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(details)}</pre>
      <p style="color: #888; font-size: 12px; margin-top: 16px;">MOSS Contact Form Alert — ${timestamp}</p>
    </div>
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: 'MOSS Contact Form' },
        subject: `[MOSS Contact Form] ${title}`,
        content: [{ type: 'text/html', value: htmlBody }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      throw new Error(`SendGrid ${response.status}: ${errText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTeamsAlert(webhookUrl, title, details, timestamp) {
  // Power Automate Workflows require Adaptive Card payload
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
              text: `⚠ ${title}`,
              weight: 'Bolder',
              size: 'Medium',
              color: 'Attention',
            },
            {
              type: 'TextBlock',
              text: details,
              wrap: true,
              fontType: 'Monospace',
              size: 'Small',
            },
            {
              type: 'TextBlock',
              text: `MOSS Contact Form — ${timestamp}`,
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
      throw new Error(`Teams webhook ${response.status}: ${errText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
