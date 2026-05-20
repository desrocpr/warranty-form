import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock alerts
const mockSendAlert = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/alerts.js', () => ({
  sendAlert: (...args) => mockSendAlert(...args),
}));

// Mock fetch for webhook
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

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

describe('embed-failure handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockSendAlert.mockClear();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({ ok: true });
    process.env.CONTACT_API_KEY = TEST_API_KEY;
    delete process.env.EMBED_FAILURE_WEBHOOK_URL;
    const mod = await import('../../api/embed-failure.js');
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
    await handler(createReq({ authorized: false, body: { contact: { email: 'a@b.com' } } }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when contact is missing', async () => {
    const res = createRes();
    await handler(createReq({ body: { embedType: 'hubspot' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when contact.email is missing', async () => {
    const res = createRes();
    await handler(createReq({ body: { contact: { firstname: 'Jane' } } }), res);
    expect(res._status).toBe(400);
  });

  it('uses default sendAlert when no webhook URL configured', async () => {
    const res = createRes();
    await handler(createReq({
      body: {
        contact: { firstname: 'Jane', lastname: 'Smith', email: 'jane@example.com', phone: '703-555-1234', zip: '22030' },
        embedType: 'hubspot',
        error: 'Script failed to load',
      },
    }), res);

    expect(res._status).toBe(200);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert.mock.calls[0][0]).toContain('Follow-Up');
    expect(mockSendAlert.mock.calls[0][1]).toContain('jane@example.com');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends to dedicated webhook when EMBED_FAILURE_WEBHOOK_URL is set', async () => {
    vi.resetModules();
    process.env.CONTACT_API_KEY = TEST_API_KEY;
    process.env.EMBED_FAILURE_WEBHOOK_URL = 'https://webhook.example.com/test';
    const mod = await import('../../api/embed-failure.js');
    handler = mod.default;

    const res = createRes();
    await handler(createReq({
      body: {
        contact: { firstname: 'John', lastname: 'Doe', email: 'john@example.com', phone: '703-555-5678', zip: '20170' },
        embedType: 'calcom',
        calendarUrl: 'https://cal.com/test',
        error: 'Cal.com SDK failed',
      },
    }), res);

    expect(res._status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://webhook.example.com/test');
    const body = JSON.parse(options.body);
    expect(body.type).toBe('message');
    expect(body.attachments[0].content.body[2].facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Email', value: 'john@example.com' }),
      ])
    );
    // Should NOT use default sendAlert when webhook is configured
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('handles missing optional contact fields gracefully', async () => {
    const res = createRes();
    await handler(createReq({
      body: {
        contact: { email: 'minimal@example.com' },
        embedType: 'hubspot',
      },
    }), res);

    expect(res._status).toBe(200);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert.mock.calls[0][1]).toContain('minimal@example.com');
  });
});
