import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.turnstile.success).toBe(true);
    expect(res._json.hubspot.success).toBe(true);
    expect(res._json.timestamp).toBeDefined();
  });

  it('reports Turnstile failure', async () => {
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
    const res = createRes();
    await handler(
      createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
      res
    );
    expect(res._json.success).toBe(true);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('skips Turnstile check when TURNSTILE_SECRET_KEY not configured', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    vi.resetModules();
    setupHealthyFetch();
    const mod = await import('../../api/keep-alive.js');

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
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAlert.mock.calls[0][2]).toBe('Keep-Alive Health Check');
    });

    it('does not re-alert on the same ongoing failure', async () => {
      // Make Turnstile fail
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

      // First run: Turnstile fails
      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
      expect(res1._json.transitions.newFailures).toContain('turnstile');

      // Second run: Turnstile still failing — no new alert
      const res2 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res2
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1); // Still just one
      expect(res2._json.transitions.newFailures).toEqual([]);
      expect(res2._json.transitions.ongoing).toContain('turnstile');
    });

    it('sends recovery alert when a previously-failing service comes back up', async () => {
      // Run 1: Turnstile fails
      mockFetch.mockImplementationOnce((url) => {
        if (url.includes('turnstile')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: false, 'error-codes': ['invalid-input-secret'] }),
          });
        }
        return Promise.resolve({ status: 400, ok: false });
      }).mockImplementationOnce((url) => {
        // HubSpot on first run
        return Promise.resolve({ status: 400, ok: false });
      });

      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAlert.mock.calls[0][0]).toContain('1 service(s) down');

      // Run 2: Turnstile recovered
      setupHealthyFetch();

      const res2 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res2
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(2);
      expect(mockSendAlert.mock.calls[1][0]).toContain('1 service(s) recovered');
      expect(mockSendAlert.mock.calls[1][1]).toContain('Cloudflare Turnstile recovered');
      expect(res2._json.transitions.recoveries).toContain('turnstile');
    });

    it('only alerts on newly-failed services (not ongoing)', async () => {
      // Run 1: Turnstile fails
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

      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(mockSendAlert).toHaveBeenCalledTimes(1);

      // Run 2: Turnstile still failing AND now HubSpot fails too
      mockFetch.mockImplementation((url) => {
        if (url.includes('turnstile')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: false, 'error-codes': ['invalid-input-secret'] }),
          });
        }
        if (url.includes('hsforms')) {
          return Promise.resolve({ status: 500, ok: false });
        }
        return Promise.resolve({ ok: true });
      });

      const res2 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res2
      );
      // Second alert should only mention HubSpot as new
      expect(mockSendAlert).toHaveBeenCalledTimes(2);
      expect(mockSendAlert.mock.calls[1][0]).toContain('1 service(s) down');
      expect(mockSendAlert.mock.calls[1][1]).toContain('HubSpot Forms API');
      expect(mockSendAlert.mock.calls[1][1]).not.toContain('Turnstile');
    });

    it('clears Redis state when all services recover', async () => {
      // Run 1: Turnstile fails
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

      const res1 = createRes();
      await handler(
        createReq({ headers: { authorization: 'Bearer test-cron-secret' } }),
        res1
      );
      expect(redisStore['keepalive:failures']).toBeDefined();

      // Run 2: All healthy
      setupHealthyFetch();

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

      const mod = await import('../../api/keep-alive.js');

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
