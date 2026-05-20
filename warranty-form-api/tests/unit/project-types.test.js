import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACCESS_TOKEN = 'pat-test-12345';

function createReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return {
    method,
    query,
    headers: { 'x-forwarded-for': '1.2.3.4', ...headers },
  };
}

function createRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    end() { res._ended = true; return res; },
  };
  return res;
}

function hubspotOptionsResponse(options) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      options: options.map((o) => ({
        value: o.value,
        label: o.label,
        displayOrder: 0,
        hidden: false,
      })),
    }),
  });
}

const sampleOptions = [
  { value: 'Kitchen Remodel', label: 'Kitchen Remodel' },
  { value: 'Bathroom Remodel', label: 'Bathroom Remodel' },
  { value: 'Addition', label: 'Addition (Adding space)' },
  { value: 'Home Services', label: 'Home Services' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project-types handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();
    process.env.HUBSPOT_ACCESS_TOKEN = TEST_ACCESS_TOKEN;
    const mod = await import('../../api/project-types.js');
    handler = mod.default;
  });

  it('handles OPTIONS preflight', async () => {
    const res = createRes();
    await handler(createReq({ method: 'OPTIONS' }), res);
    expect(res._status).toBe(200);
    expect(res._ended).toBe(true);
  });

  it('rejects non-GET methods with 405', async () => {
    const res = createRes();
    await handler(createReq({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 500 when HUBSPOT_ACCESS_TOKEN is missing', async () => {
    vi.resetModules();
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    const mod = await import('../../api/project-types.js');
    handler = mod.default;

    const res = createRes();
    await handler(createReq(), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toContain('not configured');
  });

  it('returns options from HubSpot API', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    const res = createRes();
    await handler(createReq(), res);

    expect(res._status).toBe(200);
    expect(res._json.options).toHaveLength(4);
    expect(res._json.options[0]).toEqual({ value: 'Kitchen Remodel', label: 'Kitchen Remodel' });
  });

  it('only returns value and label fields', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    const res = createRes();
    await handler(createReq(), res);

    const keys = Object.keys(res._json.options[0]);
    expect(keys).toEqual(['value', 'label']);
  });

  it('filters options with ?exclude param (semicolon-separated)', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    const res = createRes();
    await handler(createReq({ query: { exclude: 'Home Services;Addition' } }), res);

    expect(res._status).toBe(200);
    expect(res._json.options).toHaveLength(2);
    expect(res._json.options.map((o) => o.value)).toEqual(['Kitchen Remodel', 'Bathroom Remodel']);
  });

  it('trims whitespace in exclude values', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    const res = createRes();
    await handler(createReq({ query: { exclude: ' Home Services ; Addition ' } }), res);

    expect(res._json.options).toHaveLength(2);
  });

  it('returns 502 when HubSpot fails and no cache exists', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    }));

    const res = createRes();
    await handler(createReq(), res);
    expect(res._status).toBe(502);
  });

  it('sends Authorization header to HubSpot', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    const res = createRes();
    await handler(createReq(), res);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('returns 429 after exceeding rate limit', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    // First call populates cache
    const res1 = createRes();
    await handler(createReq(), res1);
    expect(res1._status).toBe(200);

    // Exhaust rate limit (60 per minute, already used 1)
    for (let i = 0; i < 59; i++) {
      const res = createRes();
      await handler(createReq(), res);
    }

    // 61st request should be rate limited
    const resLimited = createRes();
    await handler(createReq(), resLimited);
    expect(resLimited._status).toBe(429);
    expect(resLimited._json.error).toContain('Too many');
  });

  it('rate limits by IP address independently', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    // Exhaust limit for IP 1.2.3.4
    for (let i = 0; i < 61; i++) {
      const res = createRes();
      await handler(createReq(), res);
    }

    // Different IP should still work
    const res = createRes();
    await handler(createReq({ headers: { 'x-forwarded-for': '5.6.7.8' } }), res);
    expect(res._status).toBe(200);
  });

  it('handles HubSpot timeout gracefully', async () => {
    mockFetch.mockImplementation(() => {
      return new Promise((_, reject) => {
        reject(new Error('The operation was aborted'));
      });
    });

    const res = createRes();
    await handler(createReq(), res);
    expect(res._status).toBe(500);
  });

  it('returns all options when exclude param is empty', async () => {
    mockFetch.mockImplementation(() => hubspotOptionsResponse(sampleOptions));

    const res = createRes();
    await handler(createReq({ query: { exclude: '' } }), res);

    // Empty exclude should return all (empty string splits to [''] which doesn't match any value)
    expect(res._json.options).toHaveLength(4);
  });
});
