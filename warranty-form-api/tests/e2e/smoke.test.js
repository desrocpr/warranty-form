// MOSS Warranty Form — production E2E smoke test (MOS-208)
//
// What this does
// --------------
// Hits the deployed production /api/submit-warranty endpoint with a clearly
// marked smoke-test payload, asserts the response shape (ticketId + bookingUrl),
// round-trips the ticket via the HubSpot Tickets API to verify the properties
// landed correctly, asserts the returned bookingUrl matches the cal.com pattern,
// and prints the bookingUrl so Paul can click through and manually verify the
// cal.com scheduling flow + iCal delivery.
//
// SELF-GUARD — why this file does not run accidentally
// ----------------------------------------------------
// This test is placed in tests/e2e/ (Playwright's testDir) so it lives next to
// the existing browser e2e suite, but it must NOT run as part of the regular
// CI / dev test loop, because it submits a real lead to production HubSpot and
// hits real third-party APIs. The guard mechanism, in order of defense:
//
//   1. vitest.config.js explicitly includes only tests/unit/** and
//      tests/integration/**, so `npm test`, `npm run test:unit`, and
//      `npm run test:integration` never see this file.
//   2. This file uses Playwright's `test.skip(condition, reason)` keyed on the
//      RUN_SMOKE env var, so `npm run test:e2e` loads it but skips it.
//   3. The `npm run test:smoke` script (added in package.json for this issue)
//      is the only invocation path that sets RUN_SMOKE=1.
//
// Required environment variables (read at runtime, fail-fast if missing when
// RUN_SMOKE=1):
//   - WARRANTY_API_URL        — full URL to production submit endpoint.
//                                Defaults to
//                                https://warranty-form.vercel.app/api/submit-warranty
//                                if unset (override per environment / preview).
//   - HUBSPOT_ACCESS_TOKEN    — HubSpot private app token with Tickets scope.
//                                Required to fetch the created ticket back.
//
// Note: this test depends on /api/submit-warranty existing — that endpoint
// ships in MOS-204, photo upload via Vercel Blob in MOS-205, and the cal.com
// redirect logic in MOS-206. Until those land + are deployed to production,
// running this smoke test will fail. That's expected; the test is the
// post-deploy verification gate for those three issues.

import { test, expect } from '@playwright/test';

const RUN_SMOKE = !!process.env.RUN_SMOKE;
const WARRANTY_API_URL =
  process.env.WARRANTY_API_URL ||
  'https://warranty-form.vercel.app/api/submit-warranty';
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || '';
const HUBSPOT_TICKETS_API =
  'https://api.hubapi.com/crm/v3/objects/tickets';

// Cal.com URL pattern — host must be cal.com (or a subdomain), and the URL
// must carry the prefilled customer info as query params so the booking page
// renders pre-populated. Adjust the required-params list if the redirect
// integration (MOS-206) settles on a different param set.
const CAL_COM_URL_REGEX = /^https:\/\/([a-z0-9-]+\.)?cal\.com\//i;
const REQUIRED_CAL_PARAMS = ['name', 'email'];

// Smoke payload — keep the name explicit so HubSpot reviewers can filter
// these out of real-customer lists. Text-only (no photo upload) per scope:
// MOS-205 owns Blob/photo flow; smoke verifies only the text path.
const SMOKE_PAYLOAD = {
  name: 'Smoke Test',
  email: 'test@mossbuildinganddesign.com',
  phone: '555-555-0100',
  projectAddress: '4216 Evergreen Lane, Annandale, VA 22003',
  completionYear: String(new Date().getFullYear() - 1),
  issueCategory: 'Other',
  description:
    'Automated smoke test from warranty-form CI (MOS-208). ' +
    'Safe to delete. Created at ' + new Date().toISOString() + '.',
};

test.describe('warranty form production smoke', () => {
  test.skip(
    !RUN_SMOKE,
    'Set RUN_SMOKE=1 (e.g. `npm run test:smoke`) to execute this against production.'
  );

  test('submits payload, creates HubSpot ticket, returns cal.com booking URL', async () => {
    test.setTimeout(60_000);

    if (!HUBSPOT_ACCESS_TOKEN) {
      throw new Error(
        'HUBSPOT_ACCESS_TOKEN is required to verify the created ticket via ' +
          'the HubSpot Tickets API. Pull it from Doppler ' +
          '(`doppler secrets get HUBSPOT_ACCESS_TOKEN -p warranty-form -c prd`) ' +
          'and re-run.'
      );
    }

    // 1. POST to production submit endpoint
    const submitResponse = await fetch(WARRANTY_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SMOKE_PAYLOAD),
    });

    expect(
      submitResponse.status,
      `POST ${WARRANTY_API_URL} expected 200, got ${submitResponse.status}`
    ).toBe(200);

    const submitJson = await submitResponse.json();
    expect(submitJson, 'response JSON should include ticketId').toHaveProperty(
      'ticketId'
    );
    expect(submitJson, 'response JSON should include bookingUrl').toHaveProperty(
      'bookingUrl'
    );

    const { ticketId, bookingUrl } = submitJson;
    expect(typeof ticketId, 'ticketId should be a string or number').toMatch(
      /^(string|number)$/
    );
    expect(typeof bookingUrl, 'bookingUrl should be a string').toBe('string');

    // 2. Fetch the created ticket from HubSpot and verify properties round-tripped
    const ticketUrl =
      HUBSPOT_TICKETS_API +
      '/' +
      encodeURIComponent(String(ticketId)) +
      '?properties=subject,content,hs_pipeline,hs_pipeline_stage,email';

    const ticketResponse = await fetch(ticketUrl, {
      headers: {
        authorization: 'Bearer ' + HUBSPOT_ACCESS_TOKEN,
        'content-type': 'application/json',
      },
    });

    expect(
      ticketResponse.status,
      `HubSpot ticket GET ${ticketUrl} expected 200, got ${ticketResponse.status}`
    ).toBe(200);

    const ticketJson = await ticketResponse.json();
    expect(ticketJson, 'HubSpot response should include properties').toHaveProperty(
      'properties'
    );

    // The ticket's content/description should include the smoke marker so we
    // can prove the payload actually round-tripped (not stale data).
    const ticketBlob = JSON.stringify(ticketJson.properties || {});
    expect(
      ticketBlob,
      'ticket properties should contain the smoke-test marker string'
    ).toContain('MOS-208');

    // 3. Assert bookingUrl looks like a cal.com URL with the expected params
    expect(
      bookingUrl,
      `bookingUrl should match cal.com pattern, got: ${bookingUrl}`
    ).toMatch(CAL_COM_URL_REGEX);

    const parsedBookingUrl = new URL(bookingUrl);
    for (const param of REQUIRED_CAL_PARAMS) {
      expect(
        parsedBookingUrl.searchParams.has(param),
        `bookingUrl should carry "${param}" query param for prefill`
      ).toBe(true);
    }

    // 4. Print the URL for Paul's manual verification
    // eslint-disable-next-line no-console
    console.log('\n=========================================================');
    // eslint-disable-next-line no-console
    console.log('SMOKE TEST PASSED — manual verification step:');
    // eslint-disable-next-line no-console
    console.log('  HubSpot Ticket ID: ' + ticketId);
    // eslint-disable-next-line no-console
    console.log('  Booking URL:       ' + bookingUrl);
    // eslint-disable-next-line no-console
    console.log('Click the booking URL above to confirm the cal.com flow ');
    // eslint-disable-next-line no-console
    console.log('renders prefilled, completes a booking, and that the iCal');
    // eslint-disable-next-line no-console
    console.log('attachment arrives at ' + SMOKE_PAYLOAD.email + '.');
    // eslint-disable-next-line no-console
    console.log('=========================================================\n');
  });
});
