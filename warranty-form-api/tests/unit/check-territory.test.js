import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the easyterritory module
// ---------------------------------------------------------------------------
const mockLookup = vi.fn();
const mockRenolutionLookup = vi.fn();
vi.mock('../../lib/easyterritory.js', () => ({
  lookupCalendarUrl: (...args) => mockLookup(...args),
  lookupRenolutionCalendarUrl: (...args) => mockRenolutionLookup(...args),
}));

// ---------------------------------------------------------------------------
// req/res helpers (mirror keep-alive.test.js)
// ---------------------------------------------------------------------------

function createReq({ method = 'GET', headers = {}, query = {} } = {}) {
  return { method, headers, query };
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

const AUTH_OK = { authorization: 'Bearer test-contact-api-key' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('check-territory handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockLookup.mockReset();
    mockRenolutionLookup.mockReset();
    process.env.CONTACT_API_KEY = 'test-contact-api-key';
    const mod = await import('../../api/check-territory.js');
    handler = mod.default;
  });

  describe('method handling', () => {
    it('returns 200 + ends on OPTIONS (preflight)', async () => {
      const req = createReq({ method: 'OPTIONS' });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(200);
      expect(res._ended).toBe(true);
    });

    it('rejects non-GET methods with 405', async () => {
      const req = createReq({ method: 'POST', headers: AUTH_OK });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(405);
      expect(res._json).toMatchObject({ success: false });
    });
  });

  describe('auth', () => {
    it('returns 500 when CONTACT_API_KEY is not configured', async () => {
      delete process.env.CONTACT_API_KEY;
      vi.resetModules();
      const mod = await import('../../api/check-territory.js');
      const req = createReq({ headers: { authorization: 'Bearer whatever' }, query: { zip: '22030' } });
      const res = createRes();
      await mod.default(req, res);
      expect(res._status).toBe(500);
      process.env.CONTACT_API_KEY = 'test-contact-api-key';
    });

    it('returns 401 when Authorization header is missing', async () => {
      const req = createReq({ query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(401);
    });

    it('returns 401 when Bearer token does not match', async () => {
      const req = createReq({ headers: { authorization: 'Bearer wrong-key' }, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(401);
    });

    it('returns 401 when Authorization is missing the Bearer prefix', async () => {
      const req = createReq({ headers: { authorization: 'test-contact-api-key' }, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('auth edge cases', () => {
    it('returns 401 when Authorization is just "Bearer " with no token', async () => {
      const req = createReq({ headers: { authorization: 'Bearer ' }, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(401);
    });

    it('returns 401 when Bearer token has extra leading whitespace', async () => {
      const req = createReq({
        headers: { authorization: 'Bearer  test-contact-api-key' },
        query: { zip: '22030' },
      });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(401);
    });

    it('is case-sensitive on the Bearer prefix', async () => {
      const req = createReq({
        headers: { authorization: 'bearer test-contact-api-key' },
        query: { zip: '22030' },
      });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('zip validation', () => {
    it('returns 400 when zip is missing', async () => {
      const req = createReq({ headers: AUTH_OK });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/5 digits/);
    });

    it('returns 400 when zip has fewer than 5 digits', async () => {
      const req = createReq({ headers: AUTH_OK, query: { zip: '123' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(400);
    });

    it('strips non-digit characters before validating length', async () => {
      mockLookup.mockResolvedValue('https://cal.com/moss');
      mockRenolutionLookup.mockResolvedValue(null);
      const req = createReq({ headers: AUTH_OK, query: { zip: '220-30 ' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(200);
      expect(mockLookup).toHaveBeenCalledWith('22030');
    });

    it('truncates ZIP+4 to first 5 digits', async () => {
      mockLookup.mockResolvedValue('https://cal.com/moss');
      mockRenolutionLookup.mockResolvedValue(null);
      const req = createReq({ headers: AUTH_OK, query: { zip: '22030-1234' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(200);
      expect(res._json.zip).toBe('22030');
    });

    it('returns 400 when zip is empty string', async () => {
      const req = createReq({ headers: AUTH_OK, query: { zip: '' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(400);
    });

    it('returns 400 when zip is an array (duplicate query param)', async () => {
      // e.g. ?zip=12345&zip=67890 — Vercel parses as ['12345', '67890']
      const req = createReq({
        headers: AUTH_OK,
        query: { zip: ['22030', '99999'] },
      });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(400);
    });

    it('returns 400 when zip is all non-digit characters', async () => {
      const req = createReq({ headers: AUTH_OK, query: { zip: 'abcde' } });
      const res = createRes();
      await handler(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('territory lookup', () => {
    it('returns inMossTerritory=true when MOSS lookup returns a URL', async () => {
      mockLookup.mockResolvedValue('https://cal.com/moss-fairfax');
      mockRenolutionLookup.mockResolvedValue(null);

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        success: true,
        zip: '22030',
        inMossTerritory: true,
        inRenolutionTerritory: false,
        mossCalendarUrl: 'https://cal.com/moss-fairfax',
        renolutionCalendarUrl: null,
      });
    });

    it('returns inRenolutionTerritory=true when Renolution lookup returns a URL', async () => {
      mockLookup.mockResolvedValue(null);
      mockRenolutionLookup.mockResolvedValue('https://cal.com/renolution');

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);

      expect(res._json).toMatchObject({
        inMossTerritory: false,
        inRenolutionTerritory: true,
        mossCalendarUrl: null,
        renolutionCalendarUrl: 'https://cal.com/renolution',
      });
    });

    it('returns both true when ZIP is in both territories', async () => {
      mockLookup.mockResolvedValue('https://cal.com/moss');
      mockRenolutionLookup.mockResolvedValue('https://cal.com/renolution');

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);

      expect(res._json.inMossTerritory).toBe(true);
      expect(res._json.inRenolutionTerritory).toBe(true);
    });

    it('returns both false when neither territory matches', async () => {
      mockLookup.mockResolvedValue(null);
      mockRenolutionLookup.mockResolvedValue(null);

      const req = createReq({ headers: AUTH_OK, query: { zip: '99999' } });
      const res = createRes();
      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._json.inMossTerritory).toBe(false);
      expect(res._json.inRenolutionTerritory).toBe(false);
    });

    it('looks up MOSS and Renolution in parallel', async () => {
      let mossResolve, renoResolve;
      mockLookup.mockReturnValue(new Promise((r) => { mossResolve = r; }));
      mockRenolutionLookup.mockReturnValue(new Promise((r) => { renoResolve = r; }));

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030' } });
      const res = createRes();
      const promise = handler(req, res);

      // Both lookups should be in-flight at the same time
      expect(mockLookup).toHaveBeenCalledTimes(1);
      expect(mockRenolutionLookup).toHaveBeenCalledTimes(1);

      mossResolve('https://cal.com/moss');
      renoResolve(null);
      await promise;

      expect(res._status).toBe(200);
    });
  });

  describe('response shape', () => {
    it('includes success: true on 200 responses', async () => {
      mockLookup.mockResolvedValue('https://cal.com/moss');
      mockRenolutionLookup.mockResolvedValue(null);

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);

      expect(res._json.success).toBe(true);
    });

    it('echoes the normalized 5-digit zip in the response', async () => {
      mockLookup.mockResolvedValue('https://cal.com/moss');
      mockRenolutionLookup.mockResolvedValue(null);

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030-9999' } });
      const res = createRes();
      await handler(req, res);

      expect(res._json.zip).toBe('22030');
    });

    it('returns 5-digit zip even when input was padded shorter', async () => {
      mockLookup.mockResolvedValue('https://cal.com/moss');
      mockRenolutionLookup.mockResolvedValue(null);

      // 5-digit minimum is enforced by the 400; this just confirms response field
      const req = createReq({ headers: AUTH_OK, query: { zip: '12345' } });
      const res = createRes();
      await handler(req, res);

      expect(res._json.zip).toBe('12345');
    });
  });

  describe('error handling', () => {
    it('returns 200 with partial data when one lookup throws and the other succeeds', async () => {
      mockLookup.mockRejectedValue(new Error('Moss lookup boom'));
      mockRenolutionLookup.mockResolvedValue('https://cal.com/renolution');

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._json.inMossTerritory).toBe(false);
      expect(res._json.inRenolutionTerritory).toBe(true);
    });

    it('returns 500 when BOTH lookups throw', async () => {
      mockLookup.mockRejectedValue(new Error('Moss down'));
      mockRenolutionLookup.mockRejectedValue(new Error('Renolution down'));

      const req = createReq({ headers: AUTH_OK, query: { zip: '22030' } });
      const res = createRes();
      await handler(req, res);

      expect(res._status).toBe(500);
      expect(res._json.success).toBe(false);
    });
  });
});
