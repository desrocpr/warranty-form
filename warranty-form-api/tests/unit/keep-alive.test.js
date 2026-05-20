import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the easyterritory module
const mockLookup = vi.fn();
const mockRenolutionLookup = vi.fn();
vi.mock('../../lib/easyterritory.js', () => ({
  lookupCalendarUrl: (...args) => mockLookup(...args),
  lookupRenolutionCalendarUrl: (...args) => mockRenolutionLookup(...args),
}));

// Mock the alerts module
const mockSendAlert = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/alerts.js', () => ({
  sendAlert: (...args) => mockSendAlert(...args),
}));

// Mock @upstash/redis — module-level state simulates Redis store
let redisStore = {};
const mockRedisGet = vi.fn(async (key) => redisStore[key] ?? null);
const mockRedisSet = vi.fn(async (key, value) => { redisStore[key] = value; });
const mockRedisDel = vi.fn(async (key) => { delete redisStore[key]; });
const mockRedisInstance = {
  get: mockRedisGet,
  set: mockRedisSet,
  del: mockRedisDel,
};
vi.mock('@upstash/redis', () => ({
  Redis: Object.assign(
    function () { return mockRedisInstance; },
    { fromEnv: () => mockRedisInstance }
  ),
}));

// Mock global fetch (for Turnstile + HubSpot health checks)
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Mock req/res helpers
// ---------------------------------------------------------------------------

function createReq({ method = 'GET', headers = {} } = {}) {
  return { method, headers };
}

function createRes() {
  const res = {
    _status: null,
    _json: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

// Default: Turnstile returns invalid-input-response (healthy), HubSpot returns 400 (healthy)
function setupHealthyFetch() {
  mockFetch.mockImplementation((url) => {
    if (url.includes('turnstile')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
      });
    }
    if (url.includes('hsforms')) {
      return Promise.resolve({ status: 400, ok: false });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('keep-alive handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockLookup.mockReset();
    mockRenolutionLookup.mockReset();
    mockSendAlert.mockClear();
    mockFetch.mockReset();
    mockRedisGet.mockClear();
    mockRedisSet.mockClear();
    mockRedisDel.mockClear();
    redisStore = {};
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.HUBSPOT_PORTAL_ID = '2719512';
    process.env.HUBSPOT_FORM_ID = 'test-form-id';
    process.env.KV_REST_API_URL = 'https://test.upstash.io';
    process.env.KV_REST_API_TOKEN = 'test-token';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    setupHealthyFetch();

    const mod = await import('../../api/keep-alive.js');
    handler = mod.default;
  });

  it('rejects non-GET methods with 405', async () => {
    const res = createRes();
    await handler(createReq({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json.error).toBe('Method not allowed');
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    vi.resetModules();
    setupHealthyFetch();
    const mod = await import('../../api/keep-alive.js');

    const res = createRes();
    await mod.default(createReq(), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe('CRON_SECRET not configured');
  });

  it('returns 401 for wrong authorization header', async () => {
    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer wrong-secret' } }),
      res
    );
    expect(res._status).toBe(401);
  });

  it('returns 401 for missing authorization header', async () => {
    const res = createRes();
    await handler(createReq(), res);
    expect(res._status).toBe(401);
  });

  it('returns 200 with all service results on success', async () => {
    mockLookup.mockResolvedValue('https://calendly.com/alpha');
    mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.moss.success).toBe(true);
    expect(res._json.moss.calendarUrl).toBe('https://calendly.com/alpha');
    expect(res._json.renolution.success).toBe(true);
    expect(res._json.renolution.calendarUrl).toBe('https://calendly.com/renolution');
    expect(res._json.turnstile.success).toBe(true);
    expect(res._json.hubspot.success).toBe(true);
    expect(res._json.timestamp).toBeDefined();
  });

  it('calls lookupCalendarUrl with 22030', async () => {
    mockLookup.mockResolvedValue(null);
    mockRenolutionLookup.mockResolvedValue(null);

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(mockLookup).toHaveBeenCalledWith('22030');
    expect(mockRenolutionLookup).toHaveBeenCalledWith('22030');
  });

  it('reports Moss failure while Renolution succeeds', async () => {
    mockLookup.mockRejectedValue(new Error('Moss ET down'));
    mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(false); // At least one failure = not fully healthy
    expect(res._json.moss.success).toBe(false);
    expect(res._json.moss.error).toBe('Moss ET down');
    expect(res._json.renolution.success).toBe(true);
    // Alert should have been called
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert.mock.calls[0][0]).toContain('1 service(s) down');
  });

  it('reports both EasyTerritory failures', async () => {
    mockLookup.mockRejectedValue(new Error('Moss ET down'));
    mockRenolutionLookup.mockRejectedValue(new Error('Renolution ET down'));

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(false);
    expect(res._json.moss.error).toBe('Moss ET down');
    expect(res._json.renolution.error).toBe('Renolution ET down');
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('reports Turnstile failure', async () => {
    mockLookup.mockResolvedValue('https://calendly.com/alpha');
    mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

    mockFetch.mockImplementation((url) => {
      if (url.includes('turnstile')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: false, 'error-codes': ['invalid-input-secret'] }),
        });
      }
      if (url.includes('hsforms')) {
        return Promise.resolve({ status: 400, ok: false });
      }
      return Promise.resolve({ ok: true });
    });

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._json.turnstile.success).toBe(false);
    expect(res._json.turnstile.error).toContain('Invalid Turnstile secret key');
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('reports HubSpot 500 failure', async () => {
    mockLookup.mockResolvedValue('https://calendly.com/alpha');
    mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

    mockFetch.mockImplementation((url) => {
      if (url.includes('turnstile')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
        });
      }
      if (url.includes('hsforms')) {
        return Promise.resolve({ status: 500, ok: false });
      }
      return Promise.resolve({ ok: true });
    });

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._json.hubspot.success).toBe(false);
    expect(res._json.hubspot.error).toContain('HubSpot API returned 500');
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('does not alert when all services are healthy', async () => {
    mockLookup.mockResolvedValue('https://calendly.com/alpha');
    mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._json.success).toBe(true);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('returns null calendarUrl when lookups return null', async () => {
    mockLookup.mockResolvedValue(null);
    mockRenolutionLookup.mockResolvedValue(null);

    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.moss.calendarUrl).toBeNull();
    expect(res._json.renolution.calendarUrl).toBeNull();
  });

  it('skips Turnstile check when TURNSTILE_SECRET_KEY not configured', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    vi.resetModules();
    setupHealthyFetch();
    const mod = await import('../../api/keep-alive.js');

    mockLookup.mockResolvedValue('https://calendly.com/alpha');
    mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

    const res = createRes();
    await mod.default(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._json.turnstile.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Source tagging and recovery detection
  // -------------------------------------------------------------------------

  describe('source tagging and recovery', () => {
    it('passes Keep-Alive Health Check source to sendAlert', async () => {
      mockLookup.mockRejectedValue(new Error('Moss ET down'));
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

      const res = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAlert.mock.calls[0][2]).toBe('Keep-Alive Health Check');
    });

    it('does not re-alert on the same ongoing failure', async () => {
      // First run: Moss fails
      mockLookup.mockRejectedValue(new Error('Moss ET down'));
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
      expect(res1._json.transitions.newFailures).toContain('moss');

      // Second run: Moss still failing — no new alert
      const res2 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res2
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1); // Still just one
      expect(res2._json.transitions.newFailures).toEqual([]);
      expect(res2._json.transitions.ongoing).toContain('moss');
    });

    it('sends recovery alert when a previously-failing service comes back up', async () => {
      // Run 1: Moss fails
      mockLookup.mockRejectedValueOnce(new Error('Moss ET down'));
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAlert.mock.calls[0][0]).toContain('1 service(s) down');

      // Run 2: Moss recovered
      mockLookup.mockResolvedValueOnce('https://calendly.com/alpha');

      const res2 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res2
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(2);
      expect(mockSendAlert.mock.calls[1][0]).toContain('1 service(s) recovered');
      expect(mockSendAlert.mock.calls[1][1]).toContain('EasyTerritory (Moss) recovered');
      expect(res2._json.transitions.recoveries).toContain('moss');
    });

    it('only alerts on newly-failed services (not ongoing)', async () => {
      // Run 1: Moss fails
      mockLookup.mockRejectedValueOnce(new Error('Moss ET down'));
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1);

      // Run 2: Moss still failing AND now Renolution fails
      mockLookup.mockRejectedValueOnce(new Error('Moss ET down'));
      mockRenolutionLookup.mockRejectedValueOnce(new Error('Renolution down'));

      const res2 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res2
      );
      // Second alert should only mention Renolution as new
      expect(mockSendAlert).toHaveBeenCalledTimes(2);
      expect(mockSendAlert.mock.calls[1][0]).toContain('1 service(s) down');
      expect(mockSendAlert.mock.calls[1][1]).toContain('EasyTerritory (Renolution)');
      expect(mockSendAlert.mock.calls[1][1]).not.toContain('Moss');
    });

    it('clears Redis state when all services recover', async () => {
      // Run 1: Moss fails
      mockLookup.mockRejectedValueOnce(new Error('Moss ET down'));
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(redisStore['keepalive:failures']).toBeDefined();

      // Run 2: All healthy
      mockLookup.mockResolvedValueOnce('https://calendly.com/alpha');

      const res2 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res2
      );
      expect(redisStore['keepalive:failures']).toBeUndefined();
    });

    it('works without Upstash configured (recovery tracking disabled)', async () => {
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      vi.resetModules();
      setupHealthyFetch();
      const mod = await import('../../api/keep-alive.js');

      mockLookup.mockRejectedValue(new Error('Moss ET down'));
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');

      const res = createRes();
      await mod.default(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res
      );
      expect(res._status).toBe(200);
      // Should still alert on failure (just no recovery tracking)
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
    });
  });
});
