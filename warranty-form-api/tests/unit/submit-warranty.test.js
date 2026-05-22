import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACCESS_TOKEN = 'pat-test-12345';
const TEST_TURNSTILE_SECRET = 'turnstile-secret-test';
const TEST_PIPELINE_ID = '902566925';
const TEST_STAGE_NEW = '1365055596';

function createReq({ method = 'POST', body = {} } = {}) {
  return { method, body, headers: {} };
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

function validPayload(overrides = {}) {
  return {
    name: 'Jane Smith',
    email: 'jane@example.com',
    phone: '(703) 555-1234',
    originalAddress: '123 Main St, Fairfax, VA 22030',
    completionYear: 2022,
    issueCategory: 'Plumbing',
    issueDescription: 'Leak under the kitchen sink, water damage to cabinet.',
    photoUrls: ['https://blob.example/photo1.jpg', 'https://blob.example/photo2.jpg'],
    turnstileToken: 'tok-test',
    ...overrides,
  };
}

function turnstileOkResponse() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true }),
  });
}

function turnstileFailResponse() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: false, 'error-codes': ['invalid-input-response'] }),
  });
}

function contactSearchHit(contactId = 'contact-123') {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ results: [{ id: contactId }] }),
  });
}

function contactSearchMiss() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ results: [] }),
  });
}

function contactCreateResponse(contactId = 'new-contact-456') {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ id: contactId }),
  });
}

function ticketCreateResponse(ticketId = 'ticket-789') {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ id: ticketId }),
  });
}

function hubspotErrorResponse(status = 500, body = 'Internal Server Error') {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({ message: body }),
  });
}

/**
 * Default-mock fetch sequence:
 * 1. Turnstile siteverify  → success
 * 2. Contact search        → hit
 * 3. Ticket create         → ok
 */
function setupHappyPath({ contactId = 'contact-123', ticketId = 'ticket-789' } = {}) {
  mockFetch.mockImplementation((url) => {
    if (typeof url === 'string') {
      if (url.includes('turnstile')) return turnstileOkResponse();
      if (url.includes('/crm/v3/objects/contacts/search')) return contactSearchHit(contactId);
      if (url.includes('/crm/v3/objects/contacts')) return contactCreateResponse(contactId);
      if (url.includes('/crm/v3/objects/tickets')) return ticketCreateResponse(ticketId);
    }
    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('submit-warranty handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();
    process.env.TURNSTILE_SECRET_KEY = TEST_TURNSTILE_SECRET;
    process.env.HUBSPOT_ACCESS_TOKEN = TEST_ACCESS_TOKEN;
    process.env.HUBSPOT_TICKET_PIPELINE_ID = TEST_PIPELINE_ID;
    process.env.HUBSPOT_TICKET_STAGE_NEW = TEST_STAGE_NEW;
    process.env.DEFAULT_CALENDAR_URL = 'https://cal.example/placeholder';
    const mod = await import('../../api/submit-warranty.js');
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

  it('returns 200 and ticketId on valid payload (contact found)', async () => {
    setupHappyPath();

    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);

    expect(res._status).toBe(200);
    expect(res._json.ticketId).toBe('ticket-789');
    expect(res._json.bookingUrl).toBe('https://cal.example/placeholder');
  });

  it('returns 403 when Turnstile verification fails', async () => {
    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('turnstile')) return turnstileFailResponse();
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);

    expect(res._status).toBe(403);
    expect(res._json.error).toMatch(/turnstile/i);
  });

  it.each([
    'name', 'email', 'phone', 'originalAddress', 'completionYear',
    'issueCategory', 'issueDescription', 'turnstileToken',
  ])('returns 400 when required field %s is missing', async (field) => {
    const payload = validPayload();
    delete payload[field];

    const res = createRes();
    await handler(createReq({ body: payload }), res);

    expect(res._status).toBe(400);
    expect(res._json.error).toContain(field);
  });

  it('treats empty string as a missing required field', async () => {
    const payload = validPayload({ originalAddress: '   ' });
    const res = createRes();
    await handler(createReq({ body: payload }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain('originalAddress');
  });

  it('accepts payload with missing/empty photoUrls (optional field)', async () => {
    setupHappyPath();

    const res = createRes();
    await handler(createReq({ body: validPayload({ photoUrls: undefined }) }), res);
    expect(res._status).toBe(200);

    // Verify the ticket create body had empty photo_urls
    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    expect(ticketCall).toBeTruthy();
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.photo_urls).toBe('');
  });

  it('joins photoUrls with semicolons on the ticket', async () => {
    setupHappyPath();

    const res = createRes();
    await handler(
      createReq({
        body: validPayload({
          photoUrls: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg'],
        }),
      }),
      res
    );
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.photo_urls).toBe(
      'https://a/1.jpg;https://a/2.jpg;https://a/3.jpg'
    );
  });

  it('routes Structural category as HIGH priority', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ issueCategory: 'Structural' }) }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.hs_ticket_priority).toBe('HIGH');
    expect(ticketBody.properties.subject).toBe('Warranty claim — Structural');
  });

  it('routes Electrical category as HIGH priority', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ issueCategory: 'Electrical' }) }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.hs_ticket_priority).toBe('HIGH');
  });

  it('routes Plumbing category as MEDIUM priority', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ issueCategory: 'Plumbing' }) }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.hs_ticket_priority).toBe('MEDIUM');
  });

  it('routes uncategorized issues as MEDIUM priority', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ issueCategory: 'Cosmetic' }) }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.hs_ticket_priority).toBe('MEDIUM');
  });

  it('creates a new HubSpot contact when search misses', async () => {
    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string') {
        if (url.includes('turnstile')) return turnstileOkResponse();
        if (url.includes('/crm/v3/objects/contacts/search')) return contactSearchMiss();
        if (url.includes('/crm/v3/objects/contacts')) return contactCreateResponse('new-456');
        if (url.includes('/crm/v3/objects/tickets')) return ticketCreateResponse('ticket-999');
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = createRes();
    await handler(createReq({ body: validPayload({ name: 'Mary Jane Watson' }) }), res);

    expect(res._status).toBe(200);
    expect(res._json.ticketId).toBe('ticket-999');

    // Contact create call should have happened (4 calls total)
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const contactCreateCall = mockFetch.mock.calls.find(
      ([url, opts]) =>
        typeof url === 'string' &&
        url.endsWith('/crm/v3/objects/contacts') &&
        opts?.method === 'POST'
    );
    expect(contactCreateCall).toBeTruthy();
    const contactBody = JSON.parse(contactCreateCall[1].body);
    expect(contactBody.properties.email).toBe('jane@example.com');
    expect(contactBody.properties.firstname).toBe('Mary Jane');
    expect(contactBody.properties.lastname).toBe('Watson');
  });

  it('puts single-token name into firstname only', async () => {
    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string') {
        if (url.includes('turnstile')) return turnstileOkResponse();
        if (url.includes('/crm/v3/objects/contacts/search')) return contactSearchMiss();
        if (url.includes('/crm/v3/objects/contacts')) return contactCreateResponse();
        if (url.includes('/crm/v3/objects/tickets')) return ticketCreateResponse();
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = createRes();
    await handler(createReq({ body: validPayload({ name: 'Cher' }) }), res);
    expect(res._status).toBe(200);

    const contactCreateCall = mockFetch.mock.calls.find(
      ([url, opts]) =>
        typeof url === 'string' &&
        url.endsWith('/crm/v3/objects/contacts') &&
        opts?.method === 'POST'
    );
    const contactBody = JSON.parse(contactCreateCall[1].body);
    expect(contactBody.properties.firstname).toBe('Cher');
    expect(contactBody.properties.lastname).toBe('');
  });

  it('sends Authorization header with HUBSPOT_ACCESS_TOKEN to HubSpot', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    expect(ticketCall[1].headers.Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('includes pipeline + stage + ticket fields on the ticket', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.hs_pipeline).toBe(TEST_PIPELINE_ID);
    expect(ticketBody.properties.hs_pipeline_stage).toBe(TEST_STAGE_NEW);
    expect(ticketBody.properties.subject).toBe('Warranty claim — Plumbing');
    expect(ticketBody.properties.content).toBe(
      'Leak under the kitchen sink, water damage to cabinet.'
    );
    expect(ticketBody.properties.original_address).toBe('123 Main St, Fairfax, VA 22030');
    expect(ticketBody.properties.completion_year).toBe('2022');
    expect(ticketBody.properties.issue_category).toBe('Plumbing');
  });

  it('associates the ticket to the contact inline', async () => {
    setupHappyPath({ contactId: 'contact-abc' });
    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(Array.isArray(ticketBody.associations)).toBe(true);
    expect(ticketBody.associations[0].to.id).toBe('contact-abc');
  });

  it('returns 500 and logs when HubSpot ticket creation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string') {
        if (url.includes('turnstile')) return turnstileOkResponse();
        if (url.includes('/crm/v3/objects/contacts/search')) return contactSearchHit();
        if (url.includes('/crm/v3/objects/tickets')) return hubspotErrorResponse(500, 'boom');
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);

    expect(res._status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns 500 and logs when HubSpot contact search fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string') {
        if (url.includes('turnstile')) return turnstileOkResponse();
        if (url.includes('/crm/v3/objects/contacts/search')) {
          return hubspotErrorResponse(401, 'Unauthorized');
        }
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);

    expect(res._status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns 500 when required env vars are not configured', async () => {
    vi.resetModules();
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('turnstile')) return turnstileOkResponse();
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const mod = await import('../../api/submit-warranty.js');
    const localHandler = mod.default;

    const res = createRes();
    await localHandler(createReq({ body: validPayload() }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/not configured/i);
    errorSpy.mockRestore();
  });

  it('returns bookingUrl as null when DEFAULT_CALENDAR_URL is unset', async () => {
    vi.resetModules();
    delete process.env.DEFAULT_CALENDAR_URL;
    setupHappyPath();

    const mod = await import('../../api/submit-warranty.js');
    const localHandler = mod.default;

    const res = createRes();
    await localHandler(createReq({ body: validPayload() }), res);
    expect(res._status).toBe(200);
    expect(res._json.bookingUrl).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Input validation (PR-2 review: length caps, email format, year range)
  // -------------------------------------------------------------------------

  it('rejects issueDescription longer than 5000 chars with 400', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(
      createReq({ body: validPayload({ issueDescription: 'a'.repeat(5001) }) }),
      res
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/issueDescription/);
    expect(res._json.error).toMatch(/5000/);
  });

  it('rejects name longer than 200 chars with 400', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ name: 'A'.repeat(201) }) }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/name/);
  });

  it('rejects originalAddress longer than 500 chars with 400', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(
      createReq({ body: validPayload({ originalAddress: 'x'.repeat(501) }) }),
      res
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/originalAddress/);
  });

  it('accepts free-text fields at the maximum allowed length', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(
      createReq({
        body: validPayload({
          name: 'A'.repeat(200),
          issueDescription: 'b'.repeat(5000),
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
  });

  it.each([
    'not-an-email',
    'missing-at-sign.com',
    'no-domain@',
    '@no-local.com',
    'has spaces@example.com',
    'two@@signs.com',
  ])('rejects malformed email %s with 400', async (email) => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ email }) }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/email/i);
  });

  it.each([
    'not-a-year',
    1899,
    '1899',
    1.5,
    '1990.5',
    NaN,
  ])('rejects invalid completionYear %p with 400', async (completionYear) => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ completionYear }) }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/completionYear/);
  });

  it('rejects completionYear far in the future with 400', async () => {
    setupHappyPath();
    const res = createRes();
    const future = new Date().getUTCFullYear() + 50;
    await handler(createReq({ body: validPayload({ completionYear: future }) }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/completionYear/);
  });

  it('accepts completionYear as numeric string', async () => {
    setupHappyPath();
    const res = createRes();
    await handler(createReq({ body: validPayload({ completionYear: '2020' }) }), res);
    expect(res._status).toBe(200);

    const ticketCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/crm/v3/objects/tickets')
    );
    const ticketBody = JSON.parse(ticketCall[1].body);
    expect(ticketBody.properties.completion_year).toBe('2020');
  });

  // -------------------------------------------------------------------------
  // HubSpot error logging sanitization (PR-2 review MEDIUM-3)
  // -------------------------------------------------------------------------

  it('does not include raw HubSpot error body in the thrown Error message', async () => {
    // The Error message propagated to console.error must NOT echo the raw
    // HubSpot response body — that body sometimes contains property values or
    // header names we don't want pasted into Vercel logs verbatim.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sensitive = 'AUTH_TOKEN_LEAK_xxxxxxxxxxxxxxxxxxxxxxxx';

    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string') {
        if (url.includes('turnstile')) return turnstileOkResponse();
        if (url.includes('/crm/v3/objects/contacts/search')) return contactSearchHit();
        if (url.includes('/crm/v3/objects/tickets')) {
          return hubspotErrorResponse(400, sensitive);
        }
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);
    expect(res._status).toBe(500);

    // Inspect the err object passed to console.error in the handler's catch.
    // The Error.message itself should not contain the raw body — only status.
    const handlerCall = errorSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('HubSpot API error')
    );
    expect(handlerCall).toBeTruthy();
    const errObj = handlerCall[1];
    expect(errObj).toBeInstanceOf(Error);
    expect(errObj.message).not.toContain(sensitive);
    expect(errObj.message).toMatch(/400/);
    errorSpy.mockRestore();
  });

  it('truncates HubSpot error response bodies before logging', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const huge = 'X'.repeat(5000);

    mockFetch.mockImplementation((url) => {
      if (typeof url === 'string') {
        if (url.includes('turnstile')) return turnstileOkResponse();
        if (url.includes('/crm/v3/objects/contacts/search')) return contactSearchHit();
        if (url.includes('/crm/v3/objects/tickets')) return hubspotErrorResponse(500, huge);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = createRes();
    await handler(createReq({ body: validPayload() }), res);
    expect(res._status).toBe(500);

    // The dedicated ticket-create error log line is `[SubmitWarranty] HubSpot
    // ticket create failed:` followed by status + truncated body.
    const ticketLogCall = errorSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('HubSpot ticket create failed')
    );
    expect(ticketLogCall).toBeTruthy();
    const truncatedBody = ticketLogCall[2];
    expect(typeof truncatedBody).toBe('string');
    // Should be well under the original 5000 char input.
    expect(truncatedBody.length).toBeLessThan(huge.length);
    expect(truncatedBody).toMatch(/truncated/);
    errorSpy.mockRestore();
  });
});
