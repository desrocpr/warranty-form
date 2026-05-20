import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock alerts
const mockSendAlert = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/alerts.js', () => ({
  sendAlert: (...args) => mockSendAlert(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-12345';

function createReq({ method = 'POST', body = {}, authorized = true } = {}) {
  const headers = {};
  if (authorized) {
    headers['authorization'] = 'Bearer ' + TEST_API_KEY;
  }
  return { method, body, headers };
}

function createRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    _headers: {},
    setHeader(key, value) { res._headers[key] = value; },
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    end() { res._ended = true; return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('booking-callback handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockSendAlert.mockClear();
    process.env.CONTACT_API_KEY = TEST_API_KEY;
    const mod = await import('../../api/booking-callback.js');
    handler = mod.default;
  });

  it('handles OPTIONS preflight', async () => {
    const res = createRes();
    await handler(createReq({ method: 'OPTIONS' }), res);
    expect(res._status).toBe(200);
    expect(res._ended).toBe(true);
  });

  it('rejects non-POST methods with 405', async () => {
    const res = createRes();
    await handler(createReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when no auth header provided', async () => {
    const res = createRes();
    await handler(createReq({ authorized: false, body: { type: 'cal', contact: { email: 'a@b.com' } } }), res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe('Unauthorized');
  });

  it('returns 401 when auth header has wrong key', async () => {
    const res = createRes();
    const req = createReq({ authorized: false, body: { type: 'cal', contact: { email: 'a@b.com' } } });
    req.headers['authorization'] = 'Bearer wrong-key';
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when type is missing', async () => {
    const res = createRes();
    await handler(createReq({ body: { contact: { email: 'a@b.com' } } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain('type');
  });

  it('returns 400 when contact.email is missing', async () => {
    const res = createRes();
    await handler(createReq({ body: { type: 'cal', contact: {} } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when contact is missing entirely', async () => {
    const res = createRes();
    await handler(createReq({ body: { type: 'cal' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 200 and sends alert for valid Cal.com booking', async () => {
    const res = createRes();
    await handler(createReq({
      body: {
        type: 'cal',
        contact: {
          firstname: 'Jane',
          lastname: 'Smith',
          email: 'jane@example.com',
          phone: '(703) 555-1234',
          zip: '22030',
        },
        bookingData: { slot: '2026-03-15T10:00:00Z' },
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert.mock.calls[0][0]).toBe('Discovery Call Booked');
    expect(mockSendAlert.mock.calls[0][1]).toContain('Cal.com');
    expect(mockSendAlert.mock.calls[0][1]).toContain('jane@example.com');
  });

  it('returns 200 and sends alert for valid HubSpot booking', async () => {
    const res = createRes();
    await handler(createReq({
      body: {
        type: 'hubspot',
        contact: {
          firstname: 'John',
          lastname: 'Doe',
          email: 'john@example.com',
          phone: '(703) 555-5678',
          zip: '20170',
        },
        bookingData: {},
      },
    }), res);

    expect(res._status).toBe(200);
    expect(mockSendAlert.mock.calls[0][1]).toContain('HubSpot Meetings');
  });

  it('handles missing optional contact fields gracefully', async () => {
    const res = createRes();
    await handler(createReq({
      body: {
        type: 'cal',
        contact: { email: 'minimal@example.com' },
        bookingData: {},
      },
    }), res);

    expect(res._status).toBe(200);
    expect(mockSendAlert.mock.calls[0][1]).toContain('minimal@example.com');
  });

  // CORS headers are now handled by vercel.json, not individual handlers
});
