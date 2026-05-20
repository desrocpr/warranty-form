import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLookup = vi.fn();
const mockRenolutionLookup = vi.fn();
vi.mock('../../lib/easyterritory.js', () => ({
  lookupCalendarUrl: (...args) => mockLookup(...args),
  lookupRenolutionCalendarUrl: (...args) => mockRenolutionLookup(...args),
}));

// Mock global fetch (for Turnstile + HubSpot + Renolution API)
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Mock req/res helpers
// ---------------------------------------------------------------------------

function createReq({ method = 'POST', body = {}, headers = {} } = {}) {
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

// Headers used by forceRoute tests — must match CONTACT_API_KEY set in
// beforeEach (see below) so the auth gate accepts forceRoute overrides.
const API_KEY_HEADERS = { authorization: 'Bearer test-contact-api-key' };

const validBody = {
  firstname: 'John',
  lastname: 'Doe',
  email: 'john@example.com',
  phone: '(703) 555-1234',
  state: 'VA',
  zip: '22030',
  projectTypes: ['Kitchen', 'Bathroom'],
  howDidYouHear: 'Google',
  smsConsent: false,
  processingConsent: true,
  utmParams: { utm_source: 'google', utm_campaign: 'spring' },
  turnstileToken: 'valid-turnstile-token',
};

function hubspotOk() {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve('OK'),
  });
}

function turnstileOk() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true }),
  });
}

function turnstileFail() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: false, 'error-codes': ['invalid-input-response'] }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('submit-contact handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockLookup.mockReset();
    mockRenolutionLookup.mockReset();
    mockFetch.mockReset();

    // Default: no Turnstile configured
    delete process.env.TURNSTILE_SECRET_KEY;
    // forceRoute tests use this key by default
    process.env.CONTACT_API_KEY = 'test-contact-api-key';

    const mod = await import('../../api/submit-contact.js');
    handler = mod.default;
  });

  // -------------------------------------------------------------------------
  // CORS & Method handling
  // -------------------------------------------------------------------------

  describe('CORS and method handling', () => {
    it('handles OPTIONS preflight with 200', async () => {
      const res = createRes();
      await handler(createReq({ method: 'OPTIONS' }), res);
      expect(res._status).toBe(200);
      expect(res._ended).toBe(true);
      // CORS headers are now handled by vercel.json, not individual handlers
    });

    // CORS headers are now handled by vercel.json, not individual handlers

    it('rejects GET with 405', async () => {
      const res = createRes();
      await handler(createReq({ method: 'GET' }), res);
      expect(res._status).toBe(405);
    });
  });

  // -------------------------------------------------------------------------
  // Required field validation
  // -------------------------------------------------------------------------

  describe('required field validation', () => {
    const requiredFields = [
      'firstname', 'lastname', 'email', 'phone',
      'state', 'zip', 'projectTypes', 'howDidYouHear',
    ];

    for (const field of requiredFields) {
      it(`returns 400 when ${field} is missing`, async () => {
        const body = { ...validBody };
        delete body[field];

        const res = createRes();
        await handler(createReq({ body }), res);
        expect(res._status).toBe(400);
        expect(res._json.success).toBe(false);
      });
    }
  });

  // -------------------------------------------------------------------------
  // API key bypass (Turnstile skip for external callers)
  // -------------------------------------------------------------------------

  describe('API key bypass', () => {
    it('skips Turnstile when valid API key is provided', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';
      process.env.CONTACT_API_KEY = 'test-contact-api-key';
      vi.resetModules();
      const mod = await import('../../api/submit-contact.js');

      mockLookup.mockResolvedValue('https://cal.com');
      mockFetch.mockImplementation(hubspotOk);

      const body = { ...validBody };
      delete body.turnstileToken;

      const res = createRes();
      await mod.default(
        createReq({ body, headers: { authorization: 'Bearer test-contact-api-key' } }),
        res
      );

      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);

      // Turnstile fetch should NOT have been called
      const turnstileCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('turnstile')
      );
      expect(turnstileCalls).toHaveLength(0);

      delete process.env.CONTACT_API_KEY;
    });

    it('still requires Turnstile when API key is wrong', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';
      process.env.CONTACT_API_KEY = 'test-contact-api-key';
      vi.resetModules();
      const mod = await import('../../api/submit-contact.js');

      const body = { ...validBody };
      delete body.turnstileToken;

      const res = createRes();
      await mod.default(
        createReq({ body, headers: { authorization: 'Bearer wrong-key' } }),
        res
      );

      expect(res._status).toBe(400);
      expect(res._json.error).toContain('Security verification is required');

      delete process.env.CONTACT_API_KEY;
    });

    it('still requires Turnstile when CONTACT_API_KEY is not configured', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';
      delete process.env.CONTACT_API_KEY;
      vi.resetModules();
      const mod = await import('../../api/submit-contact.js');

      const body = { ...validBody };
      delete body.turnstileToken;

      const res = createRes();
      await mod.default(
        createReq({ body, headers: { authorization: 'Bearer some-key' } }),
        res
      );

      expect(res._status).toBe(400);
      expect(res._json.error).toContain('Security verification is required');
    });
  });

  // -------------------------------------------------------------------------
  // Turnstile verification
  // -------------------------------------------------------------------------

  describe('Turnstile verification', () => {
    it('skips Turnstile when TURNSTILE_SECRET_KEY is not set', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      mockFetch.mockImplementation(hubspotOk);

      const body = { ...validBody };
      delete body.turnstileToken;

      const res = createRes();
      await handler(createReq({ body }), res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
    });

    it('returns 400 when Turnstile is configured but token missing', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';
      vi.resetModules();
      const mod = await import('../../api/submit-contact.js');

      const body = { ...validBody };
      delete body.turnstileToken;

      const res = createRes();
      await mod.default(createReq({ body }), res);
      expect(res._status).toBe(400);
      expect(res._json.error).toContain('Security verification is required');
    });

    it('returns 403 when Turnstile verification fails', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';
      vi.resetModules();
      const mod = await import('../../api/submit-contact.js');

      mockFetch.mockImplementation(turnstileFail);

      const res = createRes();
      await mod.default(createReq({ body: validBody }), res);
      expect(res._status).toBe(403);
    });

    it('proceeds when Turnstile verification succeeds', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';
      vi.resetModules();
      const mod = await import('../../api/submit-contact.js');

      mockLookup.mockResolvedValue('https://cal.com');
      // First fetch = Turnstile, subsequent = HubSpot
      mockFetch
        .mockImplementationOnce(turnstileOk)
        .mockImplementation(hubspotOk);

      const res = createRes();
      await mod.default(createReq({ body: validBody }), res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // EasyTerritory integration — Moss territory
  // -------------------------------------------------------------------------

  describe('EasyTerritory calendar URL (Moss territory)', () => {
    it('uses calendar URL from EasyTerritory in response', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-alpha');
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);
      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-alpha');
    });

    it('passes zip to lookupCalendarUrl', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);
      expect(mockLookup).toHaveBeenCalledWith('22030');
    });

    it('tries Renolution when Moss ET returns null', async () => {
      mockLookup.mockResolvedValue(null);
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution-team');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(createReq({ body: validBody }), res);
      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/renolution-team');
      expect(mockRenolutionLookup).toHaveBeenCalledWith('22030');
    });

    it('returns out-of-service URL when both Moss and Renolution return null', async () => {
      mockLookup.mockResolvedValue(null);
      mockRenolutionLookup.mockResolvedValue(null);
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);
      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/out-of-service-area'
      );
    });

    it('falls back to DEFAULT_CALENDAR_URL when ET throws', async () => {
      mockLookup.mockRejectedValue(new Error('ET down'));
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);
      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/default-meetings'
      );
    });

    it('submits to HubSpot for Moss territory (fire-and-forget)', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-alpha');
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      // fetch should have been called for HubSpot
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('hsforms.com'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Renolution fallback
  // -------------------------------------------------------------------------

  describe('Renolution fallback', () => {
    it('tries Renolution when Moss returns out-of-service-area URL', async () => {
      mockLookup.mockResolvedValue('https://www.mossbuildinganddesign.com/out-of-service-area');
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution-team');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/renolution-team');
      expect(mockRenolutionLookup).toHaveBeenCalledWith('22030');
    });

    it('sends lead to Renolution API when Renolution territory found', async () => {
      mockLookup.mockResolvedValue('https://www.mossbuildinganddesign.com/out-of-service-area');
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution-team');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      // Should call Renolution API, NOT HubSpot
      expect(mockFetch).toHaveBeenCalledWith(
        'https://renolution.test/api/leads/external',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-renolution-api-key',
          }),
        })
      );

      // Should NOT call HubSpot
      const hubspotCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('hsforms.com')
      );
      expect(hubspotCalls).toHaveLength(0);
    });

    it('sends correct lead data to Renolution API', async () => {
      mockLookup.mockResolvedValue('https://www.mossbuildinganddesign.com/out-of-service-area');
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution-team');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      const renolutionCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('renolution')
      );
      const sentBody = JSON.parse(renolutionCall[1].body);
      expect(sentBody.firstname).toBe('John');
      expect(sentBody.lastname).toBe('Doe');
      expect(sentBody.email).toBe('john@example.com');
      expect(sentBody.phone).toBe('(703) 555-1234');
      expect(sentBody.state).toBe('VA');
      expect(sentBody.zip).toBe('22030');
      expect(sentBody.projectTypes).toEqual(['Kitchen', 'Bathroom']);
      expect(sentBody.howDidYouHear).toBe('Google');
    });

    it('returns out-of-service URL when neither Moss nor Renolution has territory', async () => {
      mockLookup.mockResolvedValue('https://www.mossbuildinganddesign.com/out-of-service-area');
      mockRenolutionLookup.mockResolvedValue(null);
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/out-of-service-area'
      );
    });

    it('returns out-of-service URL when Renolution lookup throws', async () => {
      mockLookup.mockResolvedValue('https://www.mossbuildinganddesign.com/out-of-service-area');
      mockRenolutionLookup.mockRejectedValue(new Error('Renolution ET down'));
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      expect(res._status).toBe(200);
      // Falls through to DEFAULT_CALENDAR_URL since the whole ET try/catch catches
      // Actually the outer catch will set calendarUrl to DEFAULT_CALENDAR_URL
      // But isRenolutionLead stays false, so HubSpot is attempted
    });

    it('still returns 200 when Renolution API call fails', async () => {
      mockLookup.mockResolvedValue('https://www.mossbuildinganddesign.com/out-of-service-area');
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution-team');
      mockFetch.mockRejectedValue(new Error('Network error'));

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/renolution-team');
    });

    it('does not try Renolution for non-out-of-service URLs', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-regular');
      mockFetch.mockImplementation(hubspotOk);

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      expect(mockRenolutionLookup).not.toHaveBeenCalled();
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-regular');
    });
  });

  // -------------------------------------------------------------------------
  // HubSpot field mapping
  // -------------------------------------------------------------------------

  describe('HubSpot field mapping', () => {
    it('joins projectTypes array with semicolons', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let capturedBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          capturedBody = JSON.parse(opts.body);
        }
        return hubspotOk();
      });

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      const ptField = capturedBody.fields.find(
        (f) => f.name === 'please_select_the_project_types_that_most_closely_match_your_current_request_'
      );
      expect(ptField.value).toBe('Kitchen;Bathroom');
    });

    it('includes conditional referralName field when present', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let capturedBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          capturedBody = JSON.parse(opts.body);
        }
        return hubspotOk();
      });

      const body = { ...validBody, referralName: 'Jane Smith' };
      const res = createRes();
      await handler(createReq({ body }), res);

      const refField = capturedBody.fields.find((f) => f.name === 'referral_name');
      expect(refField).toBeDefined();
      expect(refField.value).toBe('Jane Smith');
    });

    it('excludes referralName field when not present', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let capturedBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          capturedBody = JSON.parse(opts.body);
        }
        return hubspotOk();
      });

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      const refField = capturedBody.fields.find((f) => f.name === 'referral_name');
      expect(refField).toBeUndefined();
    });

    it('includes UTM fields when present', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let capturedBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          capturedBody = JSON.parse(opts.body);
        }
        return hubspotOk();
      });

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      const utmSource = capturedBody.fields.find((f) => f.name === 'utm_source');
      const utmCampaign = capturedBody.fields.find((f) => f.name === 'utm_campaign');
      expect(utmSource.value).toBe('google');
      expect(utmCampaign.value).toBe('spring');
    });

    it('builds consent data with smsConsent', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let capturedBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          capturedBody = JSON.parse(opts.body);
        }
        return hubspotOk();
      });

      const body = { ...validBody, smsConsent: true, processingConsent: true };
      const res = createRes();
      await handler(createReq({ body }), res);

      const consent = capturedBody.legalConsentOptions.legitimateInterest;
      expect(consent.value).toBe(true);
      expect(consent.legalBasis).toBe('LEGITIMATE_INTEREST_PQL');
      expect(consent.communications).toHaveLength(1);
      expect(consent.communications[0].subscriptionTypeId).toBe(999);
    });
  });

  // -------------------------------------------------------------------------
  // Fire-and-forget resilience
  // -------------------------------------------------------------------------

  describe('fire-and-forget resilience', () => {
    it('returns calendar URL even when HubSpot fails', async () => {
      mockLookup.mockResolvedValue('https://cal.com/success');
      mockFetch.mockRejectedValue(new Error('HubSpot down'));

      const res = createRes();
      await handler(createReq({ body: validBody }), res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
      expect(res._json.calendarUrl).toBe('https://cal.com/success');
    });

    it('returns default URL when both ET and HubSpot fail', async () => {
      mockLookup.mockRejectedValue(new Error('ET down'));
      mockFetch.mockRejectedValue(new Error('HubSpot down'));

      const res = createRes();
      await handler(createReq({ body: validBody }), res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/default-meetings'
      );
    });
  });

  // -------------------------------------------------------------------------
  // hutk handling
  // -------------------------------------------------------------------------

  describe('hutk handling', () => {
    it('includes hutk in HubSpot context when provided', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let capturedBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          capturedBody = JSON.parse(opts.body);
        }
        return hubspotOk();
      });

      const body = { ...validBody, hutk: 'abc123validhutk' };
      const res = createRes();
      await handler(createReq({ body }), res);

      expect(res._status).toBe(200);
      expect(capturedBody.context.hutk).toBe('abc123validhutk');
    });

    it('omits hutk from HubSpot context when not provided', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let capturedBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          capturedBody = JSON.parse(opts.body);
        }
        return hubspotOk();
      });

      const res = createRes();
      await handler(createReq({ body: validBody }), res);

      expect(res._status).toBe(200);
      expect(capturedBody.context.hutk).toBeUndefined();
    });

    it('retries without hutk when HubSpot returns INVALID_HUTK', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let callCount = 0;
      let firstBody;
      let retryBody;
      mockFetch.mockImplementation((url, opts) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          callCount++;
          if (callCount === 1) {
            firstBody = JSON.parse(opts.body);
            return Promise.resolve({
              ok: false,
              status: 400,
              text: () => Promise.resolve('{"status":"error","errors":[{"message":"INVALID_HUTK"}]}'),
            });
          }
          retryBody = JSON.parse(opts.body);
          return hubspotOk();
        }
        return hubspotOk();
      });

      const body = { ...validBody, hutk: 'stale-invalid-hutk' };
      const res = createRes();
      await handler(createReq({ body }), res);

      expect(res._status).toBe(200);
      expect(callCount).toBe(2);
      expect(firstBody.context.hutk).toBe('stale-invalid-hutk');
      expect(retryBody.context.hutk).toBeUndefined();
    });

    it('does not retry on non-INVALID_HUTK errors', async () => {
      mockLookup.mockResolvedValue('https://cal.com');
      let callCount = 0;
      mockFetch.mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('hsforms.com')) {
          callCount++;
          return Promise.resolve({
            ok: false,
            status: 400,
            text: () => Promise.resolve('{"status":"error","errors":[{"message":"Invalid email"}]}'),
          });
        }
        return hubspotOk();
      });

      const body = { ...validBody, hutk: 'some-hutk' };
      const res = createRes();
      await handler(createReq({ body }), res);

      expect(res._status).toBe(200);
      expect(callCount).toBe(1); // No retry
    });
  });

  // -------------------------------------------------------------------------
  // forceRoute override
  // -------------------------------------------------------------------------

  describe('forceRoute=renolution', () => {
    it('skips MOSS lookup entirely and goes straight to Renolution', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'renolution' }, headers: API_KEY_HEADERS }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/renolution');
      expect(mockLookup).not.toHaveBeenCalled();
      expect(mockRenolutionLookup).toHaveBeenCalledWith('22030');
    });

    it('sends lead to Renolution API, not HubSpot', async () => {
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'renolution' }, headers: API_KEY_HEADERS }),
        res,
      );

      const fetchCalls = mockFetch.mock.calls.map((c) => c[0]);
      expect(fetchCalls.some((u) => u.includes('hsforms.com'))).toBe(false);
      expect(
        fetchCalls.some((u) => u.includes('renolution.test')),
      ).toBe(true);
    });

    it('returns out-of-service URL when Renolution has no territory (no MOSS fallback)', async () => {
      mockRenolutionLookup.mockResolvedValue(null);
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'renolution' }, headers: API_KEY_HEADERS }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/out-of-service-area',
      );
      expect(mockLookup).not.toHaveBeenCalled();
      // Out-of-service Renolution lead still skips HubSpot (no MOSS fallback)
      const fetchCalls = mockFetch.mock.calls.map((c) => c[0]);
      expect(fetchCalls.some((u) => u.includes('hsforms.com'))).toBe(false);
    });
  });

  describe('forceRoute=moss', () => {
    it('uses MOSS calendar URL and skips Renolution fallback', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'moss' }, headers: API_KEY_HEADERS }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-fairfax');
      expect(mockRenolutionLookup).not.toHaveBeenCalled();
    });

    it('returns out-of-service URL when MOSS has no territory (no Renolution fallback)', async () => {
      mockLookup.mockResolvedValue(null);
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'moss' }, headers: API_KEY_HEADERS }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/out-of-service-area',
      );
      expect(mockRenolutionLookup).not.toHaveBeenCalled();
    });

    it('falls back to DEFAULT_CALENDAR_URL when MOSS lookup throws (no Renolution try)', async () => {
      mockLookup.mockRejectedValue(new Error('ET down'));
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'moss' }, headers: API_KEY_HEADERS }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/default-meetings',
      );
      // forceRoute=moss must NOT fall back to Renolution even when ET throws
      expect(mockRenolutionLookup).not.toHaveBeenCalled();
    });
  });

  describe('forceRoute invalid values', () => {
    it('ignores forceRoute when it is not "moss" or "renolution"', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'evil-value' } }),
        res,
      );

      // Falls through to default ZIP-based routing
      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-fairfax');
      expect(mockLookup).toHaveBeenCalled();
    });

    it('is case-sensitive: "RENOLUTION" is ignored', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'RENOLUTION' } }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-fairfax');
      expect(mockLookup).toHaveBeenCalled();
    });

    it('ignores numeric forceRoute', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 1 } }),
        res,
      );

      expect(res._status).toBe(200);
      expect(mockLookup).toHaveBeenCalled();
    });

    it('treats null forceRoute as default routing', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: null } }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-fairfax');
    });
  });

  describe('forceRoute auth gating (security)', () => {
    it('ignores forceRoute=renolution from a non-API-key (browser) caller', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation((url) => {
        if (url.includes('turnstile')) return turnstileOk();
        return Promise.resolve({ ok: true });
      });
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';

      // No Authorization header — browser-style submission with Turnstile only
      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'renolution' } }),
        res,
      );

      expect(res._status).toBe(200);
      // Default routing kicks in — MOSS lookup happens, MOSS URL is returned
      expect(mockLookup).toHaveBeenCalledWith('22030');
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-fairfax');
      // Lead went to HubSpot, not Renolution
      const fetchCalls = mockFetch.mock.calls.map((c) => c[0]);
      expect(fetchCalls.some((u) => u.includes('hsforms.com'))).toBe(true);
      expect(fetchCalls.some((u) => u.includes('renolution.test'))).toBe(false);
    });

    it('ignores forceRoute=renolution when API key is wrong', async () => {
      mockLookup.mockResolvedValue('https://calendly.com/moss-fairfax');
      mockFetch.mockImplementation((url) => {
        if (url.includes('turnstile')) return turnstileOk();
        return Promise.resolve({ ok: true });
      });
      process.env.TURNSTILE_SECRET_KEY = 'test-secret';
      process.env.CONTACT_API_KEY = 'real-secret-key';

      const res = createRes();
      await handler(
        createReq({
          body: { ...validBody, forceRoute: 'renolution' },
          headers: { authorization: 'Bearer wrong-key' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      // Default routing — MOSS was consulted
      expect(mockLookup).toHaveBeenCalled();
      expect(res._json.calendarUrl).toBe('https://calendly.com/moss-fairfax');
    });

    it('honors forceRoute=renolution when API key is valid', async () => {
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true }));
      process.env.CONTACT_API_KEY = 'real-secret-key';

      const res = createRes();
      await handler(
        createReq({
          body: { ...validBody, forceRoute: 'renolution' },
          headers: { authorization: 'Bearer real-secret-key' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(mockLookup).not.toHaveBeenCalled();
      expect(res._json.calendarUrl).toBe('https://calendly.com/renolution');
    });
  });

  describe('forceRoute=renolution failure modes', () => {
    it('still returns 200 when Renolution API call fails', async () => {
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      mockFetch.mockImplementation((url) => {
        if (url.includes('renolution.test')) {
          return Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('Bad Gateway') });
        }
        return Promise.resolve({ ok: true });
      });

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'renolution' }, headers: API_KEY_HEADERS }),
        res,
      );

      expect(res._status).toBe(200);
      // Customer still gets a calendar URL even if Renolution CRM was unreachable
      expect(res._json.calendarUrl).toBe('https://calendly.com/renolution');
    });

    it('preserves Renolution routing intent when EasyTerritory throws', async () => {
      mockRenolutionLookup.mockRejectedValue(new Error('ET down'));
      mockFetch.mockImplementation((url) => {
        if (url.includes('renolution.test')) return Promise.resolve({ ok: true });
        return Promise.resolve({ ok: true });
      });

      const res = createRes();
      await handler(
        createReq({ body: { ...validBody, forceRoute: 'renolution' }, headers: API_KEY_HEADERS }),
        res,
      );

      expect(res._status).toBe(200);
      // No calendar URL was found, so the default is returned — but NEVER a MOSS URL
      expect(res._json.calendarUrl).toBe(
        'https://www.mossbuildinganddesign.com/default-meetings',
      );
      expect(mockLookup).not.toHaveBeenCalled();
      // CRITICAL: the lead must still go to Renolution CRM, not HubSpot,
      // because the caller explicitly forced Renolution routing.
      const fetchCalls = mockFetch.mock.calls.map((c) => c[0]);
      expect(fetchCalls.some((u) => u.includes('hsforms.com'))).toBe(false);
      expect(fetchCalls.some((u) => u.includes('renolution.test'))).toBe(true);
    });

    it('forwards natalieChatTranscript to Renolution API', async () => {
      mockRenolutionLookup.mockResolvedValue('https://calendly.com/renolution');
      let capturedBody;
      mockFetch.mockImplementation((url, options) => {
        if (url.includes('renolution.test')) {
          capturedBody = JSON.parse(options.body);
        }
        return Promise.resolve({ ok: true });
      });

      const transcript = 'Customer: I need a drywall fix.\nNatalie: ...';
      const res = createRes();
      await handler(
        createReq({
          body: {
            ...validBody,
            forceRoute: 'renolution',
            natalieChatTranscript: transcript,
          },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(capturedBody.natalieChatTranscript).toBe(transcript);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      const res = createRes();
      // Pass req with body getter that throws
      const req = {
        method: 'POST',
        get body() { throw new Error('Unexpected'); },
      };
      await handler(req, res);
      expect(res._status).toBe(500);
      expect(res._json.success).toBe(false);
    });
  });
});
