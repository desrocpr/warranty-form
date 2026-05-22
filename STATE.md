# Warranty Form — State

Lightweight running notes on what's deployed, what's known-broken, and the
result of the first real production run. For deeper ops detail see
`docs/playbook.md`.

---

## Deployment status

| Component | Environment | Status | Notes |
|---|---|---|---|
| HubSpot module (`warranty-form.module`) | HubSpot Design Tools | Not yet deployed | GitHub Actions workflow exists; first deploy gated on MOS-203 / MOS-207 finishing module content. |
| HubSpot landing page (`/warranty`) | mossbuildinganddesign.com | Not yet embedded | Pending module deploy. |
| Vercel project (`warranty-form-api`) | Vercel Production | Not yet deployed | `vercel link` + first `git push` to main pending; depends on MOS-204 endpoint code landing. |
| Vercel project (`warranty-form-api`) | Vercel Preview | Not yet deployed | Auto on PRs once linked. |
| Vercel Blob | Vercel Production | Not yet enabled | Auto-provisions `BLOB_READ_WRITE_TOKEN`; gated on MOS-205. |
| HubSpot Tickets pipeline (Warranty) | HubSpot CRM | Not yet configured | Stages: New → Triage → Scheduled → Resolved. |
| HubSpot private app (Tickets scope) | HubSpot | Not yet created | Token will live in Doppler `warranty-form/prd:HUBSPOT_ACCESS_TOKEN`. |
| cal.com "Warranty Appointment" event | cal.com | Not yet created | Booking URL will live in Doppler `warranty-form/prd:CAL_COM_BOOKING_URL`. |
| Doppler ↔ Vercel integration | Doppler | Not yet configured | Mapping: `dev → Development`, `stg → Preview`, `prd → Production`. |
| Production smoke test | local / CI | Authored, not yet executed | `warranty-form-api/tests/e2e/smoke.test.js` — runs only with `RUN_SMOKE=1`. |

---

## Pre-flight setup (Paul, manual)

These are one-time external setup items the harness cannot do. Tick them off
as each completes. See `docs/playbook.md` for the why / context behind each.

- [ ] HubSpot Tickets pipeline configured (stages: New → Triage → Scheduled → Resolved)
- [ ] HubSpot private app token created with Tickets scope → push to Doppler `warranty-form/prd:HUBSPOT_ACCESS_TOKEN`
- [ ] cal.com account created + "Warranty Appointment" event type → URL → push to Doppler `warranty-form/prd:CAL_COM_BOOKING_URL`
- [ ] Vercel project `warranty-form` deployed (`vercel link` + `git push` to main)
- [ ] Vercel Blob storage enabled on the project (auto-provisions `BLOB_READ_WRITE_TOKEN`)
- [ ] Doppler ↔ Vercel integration configured: `dev → Development`, `stg → Preview`, `prd → Production`
- [ ] HubSpot module deployed via existing GitHub Actions workflow (push to main)
- [ ] HubSpot module embedded on `mossbuildinganddesign.com/warranty` landing page

---

## Known limitations

- The production smoke test (`warranty-form-api/tests/e2e/smoke.test.js`) is
  scaffolded but cannot pass end-to-end until MOS-204 (API submit handler),
  MOS-205 (photo upload), and MOS-206 (cal.com redirect) ship to production.
- Smoke test covers the text-only submission path. Photo upload via Vercel
  Blob (MOS-205) is not exercised by the smoke test.
- iCal delivery is verified manually: the smoke test prints the
  `bookingUrl`; a human clicks through, books, and confirms the calendar
  invite arrives in `test@mossbuildinganddesign.com`.
- The HubSpot Warranty pipeline (stage names, automation, required fields)
  is configured in HubSpot Settings, not in this repo. Changes are tracked
  in `docs/playbook.md`.
- Several `warranty-form-api/api/*` files (`booking-callback`, `client-error`,
  `embed-failure`, `keep-alive`, `project-types`) and the
  `tests/e2e/contact-form.spec.js` file are leftovers from the
  `moss-contact-form` template; they are not yet pruned and are not part of
  the warranty form's contract.

---

## First real run

_Update this section once the first real-customer warranty submission lands
in HubSpot via the deployed form._

- **Date / time (UTC):** _pending_
- **Submitted by:** _pending_
- **HubSpot Ticket ID:** _pending_
- **cal.com booking confirmed:** _pending_
- **iCal delivered:** _pending_
- **Issues observed / follow-ups:** _pending_

### Smoke-test runs (CI-driven gate before "first real run")

| Date (UTC) | Triggered by | Ticket ID | Booking URL | Result | Notes |
|---|---|---|---|---|---|
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
