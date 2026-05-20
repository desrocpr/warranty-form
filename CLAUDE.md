# MOSS Contact Form - HubSpot Custom Module

## Architecture
- **HubSpot custom module** (vanilla JS/HTML/CSS + HubL) for the contact form UI
- **Vercel serverless function** (`moss-contact-api`) for server-side processing (Turnstile verification, HubSpot Forms API, EasyTerritory lookup)
- **Cloudflare Turnstile** for bot protection
- **EasyTerritory API** returns the correct calendar URL based on zip code territory lookup
- **Vercel Cron** pings EasyTerritory every 5 minutes to prevent cold starts
- **HubL `crm_property_definition()`** pulls field labels and options dynamically from HubSpot CRM properties (8 calls, max 10/page)

## Data Flow
1. User fills form on HubSpot page
2. Cloudflare Turnstile validates (client-side)
3. JS POSTs form data + Turnstile token to Vercel function
4. Vercel function: verify Turnstile → Moss EasyTerritory lookup
5. If Moss returns out-of-service-area → Renolution EasyTerritory lookup
   - Renolution has territory → fire-and-forget lead to Renolution API, return Renolution calendar URL
   - No territory → return out-of-service URL
6. If Moss has territory → fire-and-forget HubSpot submission, return Moss calendar URL
7. JS redirects to calendar URL with pre-filled query params

## Module Layout
- Two-column side-by-side: `section_text` rich text field (left), form inputs (right)
- Stacks vertically on mobile (< 768px)
- `section_text` is a HubL `richtext` field — end users edit content in HubSpot editor

## Key Files
- `hubspot/modules/contact-form.module/` - HubSpot custom module
  - `module.html` - HubL template with `crm_property_definition()` for dynamic labels/options
  - `module.js` - Client-side logic (validation, conditional fields, Turnstile, submission)
  - `module.css` - Styles (two-column layout, responsive)
  - `fields.json` - Module field definitions (endpoint URL, Turnstile key, section text, etc.)
  - `meta.json` - Module metadata
- `moss-contact-api/api/submit-contact.js` - Vercel serverless function (lead submission)
- `moss-contact-api/api/check-territory.js` - Server-to-server territory check by ZIP (no lead created). Used by the moss-website chat agent. Bearer-auth via `CONTACT_API_KEY`.
- `moss-contact-api/api/keep-alive.js` - Cron endpoint to keep EasyTerritory warm (every 5 min)
- `moss-contact-api/lib/easyterritory.js` - EasyTerritory API client (login, territory lookup)
- `.github/workflows/hubspot-deploy.yml` - CI/CD to HubSpot

## HubSpot Property Names (verified)
- `firstname`, `lastname`, `email`, `phone` - Standard contact properties
- `state_contact_form` - Custom state dropdown
- `zip` - Zip code
- `please_select_the_project_types_that_most_closely_match_your_current_request_` - Project types (checkboxes)
- `how_did_you_hear_about_us_` - How heard dropdown

## Conditional Fields (JS)
- "Referred by a Friend" → shows Referral Name input
- "Community Sponsorship" or "Event" → shows Event Details input
- Trigger values passed from HubL to JS via `window.MOSS_CONTACT_CONFIG` using `selectattr`/`map`/`first` filters

## Environment Variables (Vercel)
- `TURNSTILE_SECRET_KEY` - Cloudflare Turnstile server-side secret
- `HUBSPOT_PORTAL_ID` - 2719512
- `HUBSPOT_FORM_ID` - eeafd136-fe2c-4a6a-852b-499e913cce16
- `EASYTERRITORY_BASE_URL` - https://apps.easyterritory.com
- `EASYTERRITORY_GUID` - EasyTerritory account GUID
- `EASYTERRITORY_INSTANCE_TYPE` - APP
- `EASYTERRITORY_USERNAME` - Service account username
- `EASYTERRITORY_PASSWORD` - Service account password
- `EASYTERRITORY_PROJECT_ID` - Moss territory project ID
- `RENOLUTION_EASYTERRITORY_PROJECT_ID` - Renolution territory project ID (fallback)
- `RENOLUTION_API_URL` - Renolution external lead API endpoint
- `RENOLUTION_API_KEY` - Shared API key for Renolution lead creation
- `OUT_OF_SERVICE_URL` - URL when neither Moss nor Renolution has territory
- `CONTACT_API_KEY` - API key for external callers and internal callbacks (see production.enc.yaml)
- `CRON_SECRET` - Secures the keep-alive cron endpoint
- `DEFAULT_CALENDAR_URL` - Fallback URL

## Deployment
- **HubSpot module**: Push to `main` branch triggers GitHub Actions deploy via `hs upload`
- **Vercel function**: Deployed as `moss-contact-api` project on Vercel (`https://moss-contact-api.vercel.app/api/submit-contact`)
