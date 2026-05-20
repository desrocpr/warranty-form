import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock alerts
const mockSendAlert = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/alerts.js', () => ({
  sendAlert: (...args) => mockSendAlert(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReq({ method = 'POST', body = {} } = {}) {
  return { method, body };
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

describe('client-error handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockSendAlert.mockClear();
    const mod = await import('../../api/client-error.js');
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

  it('returns 400 when type is missing', async () => {
    const res = createRes();
    await handler(createReq({ body: { message: 'something' } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain('type');
  });

  it('alerts on calcom_load errors', async () => {
    const res = createRes();
    await handler(createReq({
      body: {
        type: 'calcom_load',
        message: 'Cal.com SDK failed to load',
        url: 'https://www.mossbuildinganddesign.com/contact',
        userAgent: 'Mozilla/5.0',
      },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert.mock.calls[0][0]).toContain('calcom_load');
  });

  it('alerts on hubspot_embed_load errors', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'hubspot_embed_load', message: 'iframe failed' },
    }), res);

    expect(res._status).toBe(200);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('alerts on calcom_error', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'calcom_error', message: 'embed crashed' },
    }), res);

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('alerts on hubspot_embed_error', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'hubspot_embed_error', message: 'embed error' },
    }), res);

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT alert on turnstile_load errors (ad blocker noise)', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'turnstile_load', message: 'blocked by ad blocker' },
    }), res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert on turnstile_error', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'turnstile_error', message: 'widget error' },
    }), res);

    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert on form_submit_error', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'form_submit_error', message: 'network failed' },
    }), res);

    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert on unknown error types', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'some_random_type', message: 'whatever' },
    }), res);

    expect(res._status).toBe(200);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  // CORS headers are now handled by vercel.json, not individual handlers

  it('suppresses duplicate alerts within cooldown period', async () => {
    const res1 = createRes();
    await handler(createReq({ body: { type: 'calcom_load', message: 'first' } }), res1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);

    const res2 = createRes();
    await handler(createReq({ body: { type: 'calcom_load', message: 'second' } }), res2);
    expect(res2._status).toBe(200);
    // Alert should NOT fire again within cooldown
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('handles missing optional fields gracefully', async () => {
    const res = createRes();
    await handler(createReq({
      body: { type: 'calcom_load' },
    }), res);

    expect(res._status).toBe(200);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });
});
