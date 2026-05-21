# Warranty Form — Operations Playbook

Operational reference for the MOSS Warranty Form (HubSpot module +
`warranty-form-api` Vercel project). For the high-level customer flow see
`README.md`; for current deployment / known-issue state see `STATE.md`.

---

## 1. Architecture

The warranty form mirrors the `moss-contact-form` pattern: a HubSpot custom
module renders the UI on a CMS page, a Vercel serverless API processes the
submission, and the customer is redirected to a scheduling tool. The diffs
versus the contact form are intentional and listed below.

```
HubSpot CMS page (/warranty)
        │
        │  embeds
        ▼
HubSpot custom module  ─────────►  Cloudflare Turnstile
(warranty-form.module)             (bot protection, client-side)
        │
        │  POST application/json (or multipart for photos)
        ▼
Vercel function: warranty-form-api
        │
        ├─►  Cloudflare Turnstile verify
        ├─►  Vercel Blob (photo upload, MOS-205)
        ├─►  HubSpot Tickets API  ──── create Ticket in Warranty pipeline
        └─►  return { ticketId, bookingUrl }
        │
        ▼
Browser redirects to cal.com booking page
(query params prefill name / email / project info)
        │
        ▼
Customer confirms time → cal.com emails iCal attachment
```

### Diffs vs. `moss-contact-form`

| Concern | `moss-contact-form` | `warranty-form` |
|---|---|---|
| Routing | EasyTerritory ZIP lookup → Moss vs. Renolution vs. out-of-service | **Removed (MOS-202).** Warranty is for existing MOSS customers only; no territory split. |
| Lead destination | HubSpot **Forms** API → contact + lead record | HubSpot **Tickets** API → ticket in the Warranty pipeline (MOS-204) |
| Redirect target | calendar URL from EasyTerritory | cal.com "Warranty Appointment" event type (MOS-206) |
| File uploads | none | photo upload via Vercel Blob (MOS-205) |
| Fields | contact fields + project types + how-heard | name / email / phone / project address / completion year / issue category / description / photos (MOS-203) |
| Adjacent endpoints | `submit-contact`, `check-territory`, `keep-alive` | `submit-warranty`, plus template carry-overs (`booking-callback`, `client-error`, `embed-failure`, `keep-alive`, `project-types`) until pruned |

### Repo layout

```
warranty-form/
├── hubspot/modules/warranty-form.module/    # form UI (HubL + JS + CSS)
├── warranty-form-api/                       # Vercel serverless API
│   ├── api/                                 # endpoints
│   ├── lib/                                 # shared helpers
│   ├── tests/unit/                          # vitest unit tests
│   ├── tests/integration/                   # vitest integration tests
│   └── tests/e2e/                           # Playwright browser tests
│       ├── contact-form.spec.js             # template leftover (to be removed)
│       ├── playwright.config.js
│       └── smoke.test.js                    # production smoke (MOS-208)
├── docs/playbook.md                         # this file
├── STATE.md                                 # deployment + first-real-run status
└── README.md
```

---

## 2. How to update the field set in the HubSpot module

Field definitions live in two files inside
`hubspot/modules/warranty-form.module/`:

1. `fields.json` — module-level configurable fields exposed to the page editor
   (e.g. endpoint URL, Turnstile site key, section copy). Edit here when the
   page editor needs a new knob.
2. `module.html` — the HubL template that renders the form inputs. Each form
   input's label / options are pulled dynamically from HubSpot CRM property
   definitions via `crm_property_definition()` calls (mirrors the contact-form
   pattern; HubL has a 10-property-per-page cap on these calls). Edit here
   when you add/remove an input or change which CRM property backs it.

To add a new field:

1. Create the CRM property on the **Ticket** object in HubSpot (Settings →
   Properties → Tickets). Note the internal name.
2. Add a new `<crm_property_definition>` block in `module.html` referencing
   the internal name to fetch the label + options.
3. Render the input + matching error span. Follow the existing pattern for
   conditional fields (`window.WARRANTY_CONTACT_CONFIG` from HubL → JS).
4. If the new field needs client-side validation, wire it in `module.js`.
5. Add the new field to the JSON body the form POSTs to
   `/api/submit-warranty`, and update the API handler (MOS-204) to map it
   onto the Ticket payload.
6. Push to `main`; GitHub Actions deploys the module to HubSpot.

The module field UI itself (whether the form renders the input) is owned by
**MOS-203**; the API-side property mapping is owned by **MOS-204**. Keep
those two in sync when you add a field.

---

## 3. How to update the cal.com event type config

The booking redirect URL is constructed by the API handler (MOS-206). Two
moving parts:

1. **cal.com console** — the "Warranty Appointment" event type. Edit here to
   change duration, availability, location, intake questions, confirmation
   email copy, iCal title, etc.
2. **`CAL_COM_BOOKING_URL` env var** — base URL the API uses for redirects.
   Stored in Doppler at `warranty-form/prd:CAL_COM_BOOKING_URL` (also dev /
   stg), wired to Vercel via the Doppler → Vercel integration.

To swap event types or change the slug:

1. Create / clone the event type in cal.com. Copy the public URL (e.g.
   `https://cal.com/moss-warranty/warranty-appointment`).
2. Update the env var in Doppler:
   `doppler secrets set CAL_COM_BOOKING_URL=<new-url> -p warranty-form -c prd`
   (repeat for `dev`, `stg`).
3. Trigger a Vercel redeploy so the new value is picked up (Doppler webhook
   should auto-redeploy if the integration is configured; otherwise
   `vercel --prod` or push an empty commit).
4. Run `npm run test:smoke` to verify the new URL is returned and matches the
   cal.com pattern check.

To change which fields cal.com prefills from the redirect query params, edit
both:

- the URL-construction logic in the API handler (MOS-206)
- the matching intake questions in the cal.com event type

Mismatched param names → cal.com silently ignores them. The smoke test
asserts presence of the documented required params (`name`, `email`) — extend
that list when you add a prefilled field.

---

## 4. How to triage warranty tickets (HubSpot Tickets pipeline)

The form creates tickets in the **Warranty** pipeline. Stages:

| Stage | Meaning | Next action |
|---|---|---|
| New | Just submitted via the form. | Confirm customer is on file, sanity-check description + photos. |
| Triage | Reviewed by warranty coordinator. | Determine whether it's a covered warranty item, in-scope repair, or out-of-warranty. Reach out for clarification if needed. |
| Scheduled | Customer booked a cal.com appointment (or one was manually scheduled). | Coordinate field tech, prep paperwork. |
| Resolved | Visit complete + customer signed off. | Close ticket; capture root cause / cost in custom properties for reporting. |

### Daily triage checklist

1. Filter the Warranty pipeline by **New** stage, oldest-first.
2. For each ticket:
   - Verify the customer exists in HubSpot Contacts (project address + email
     match a real MOSS job). If not, flag for clarification — could be a
     mis-routed lead, mailing-list signup error, or smoke test (subject /
     description will include `MOS-208` and the email
     `test@mossbuildinganddesign.com`; **delete smoke-test tickets**).
   - Skim the description + any uploaded photos for severity / safety
     concerns. Escalate water intrusion, structural, electrical, gas hazards.
   - Move to **Triage** with an internal note summarizing scope.
3. Coordinator owns Triage → Scheduled transition (coordinate with cal.com /
   field calendar).
4. Tech updates → Resolved on completion.

### Filtering smoke-test tickets

The smoke test (MOS-208) submits with:

- name `Smoke Test`
- email `test@mossbuildinganddesign.com`
- description containing the literal string `MOS-208`

Build a saved view in HubSpot that filters those out of the New queue (or
deletes them periodically). The smoke test embeds a UTC timestamp in the
description so duplicates are distinguishable.

---

## 5. Known limitations

- **First-real-run validation pending** — the smoke test
  (`warranty-form-api/tests/e2e/smoke.test.js`) is in place but cannot run
  end-to-end until MOS-204 (API submit handler), MOS-205 (photo upload), and
  MOS-206 (cal.com redirect) all ship to production. Tracking status in
  `STATE.md`.
- **Smoke test is text-only** — it does not exercise the photo upload path
  (Vercel Blob). Multipart / Blob smoke coverage is deferred; the API-side
  photo handling is unit-tested at the MOS-205 level.
- **iCal delivery is manual to verify** — the smoke test prints the
  `bookingUrl` and asks Paul to click through and complete a booking to
  confirm cal.com sends the iCal attachment. There is no automated check
  that the calendar invite arrives.
- **Warranty pipeline lives in HubSpot, not in code** — pipeline stage names,
  required properties, and automation rules are configured in HubSpot Settings
  and are not version-controlled. Changes are tracked manually in this
  playbook and `STATE.md`.
- **Template leftovers** — several endpoints under `warranty-form-api/api/`
  (`booking-callback.js`, `client-error.js`, `embed-failure.js`,
  `keep-alive.js`, `project-types.js`) and the `tests/e2e/contact-form.spec.js`
  file are carry-overs from the `moss-contact-form` template. Pruning belongs
  to a later cleanup pass; behavior is not guaranteed for the warranty form.
- **Production URL hard-default** — the smoke test defaults
  `WARRANTY_API_URL` to `https://warranty-form.vercel.app/api/submit-warranty`.
  Override the env var when running against a preview deploy or a custom
  domain.
