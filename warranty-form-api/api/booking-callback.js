/**
 * Booking Callback Endpoint
 *
 * Receives booking confirmation from client JS when Cal.com or HubSpot
 * meetings booking completes. Logs the booking and sends an alert so
 * the team knows a discovery call was scheduled.
 *
 * POST { type: "cal"|"hubspot", contact: { firstname, lastname, email, phone, zip }, bookingData: { ... } }
 */
import { sendAlert } from '../lib/alerts.js';

export default async function handler(req, res) {
  // CORS handled by vercel.json

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require CONTACT_API_KEY — prevents unauthenticated alert spam
  const CONTACT_API_KEY = process.env.CONTACT_API_KEY;
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!CONTACT_API_KEY || bearerToken !== CONTACT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, contact, bookingData } = req.body || {};

  if (!['cal', 'hubspot'].includes(type) || !contact || !contact.email) {
    return res.status(400).json({ error: 'Missing required fields (type must be cal|hubspot, contact.email required)' });
  }

  const name = `${contact.firstname || ''} ${contact.lastname || ''}`.trim();
  console.log(`[BookingCallback] type=${type} zip=${contact.zip || 'unknown'}`);

  // Await alert before returning — Vercel freezes the function after res.send()
  await sendAlert(
    'Discovery Call Booked',
    `Platform: ${type === 'cal' ? 'Cal.com' : 'HubSpot Meetings'}\nName: ${name}\nEmail: ${contact.email}\nPhone: ${contact.phone || 'N/A'}\nZip: ${contact.zip || 'N/A'}`,
    'Customer Booking'
  ).catch((err) => {
    console.error('[BookingCallback] Alert send failed:', err);
  });

  return res.status(200).json({ success: true });
}
