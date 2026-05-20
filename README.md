# MOSS Warranty Form

Custom HubSpot module for MOSS Building & Design warranty claims with Cloudflare Turnstile bot protection, HubSpot Tickets integration, photo upload via Vercel Blob, and cal.com scheduling redirect.

This project mirrors the architecture of `desrocpr/moss-contact-form` — the same HubSpot-module + Vercel-API pattern, customized for warranty claims (no ZIP territory routing; warranty is for existing customers only).

## Project Structure

```
warranty-form/
├── .github/workflows/hubspot-deploy.yml   # CI/CD → HubSpot
├── hubspot/modules/warranty-form.module/   # HubSpot custom module
│   ├── meta.json                          # Module metadata
│   ├── fields.json                        # Configurable fields
│   ├── module.html                        # HubL template
│   ├── module.js                          # Client-side logic
│   └── module.css                         # Styles
├── warranty-form-api/                     # Serverless backend (Vercel)
│   ├── vercel.json                        # CORS config
│   ├── .env.example                       # Env var template
│   └── api/                               # Form processing endpoints
└── README.md
```

## Customer Flow

1. Customer fills out the warranty form (embedded on a MOSS landing page via the HubSpot module)
2. Form submits to the Vercel API with: name, email, phone, project address, project completion date, issue description, photos
3. API creates a HubSpot Ticket with the warranty details
4. API returns a cal.com booking URL with prefilled customer info
5. Customer redirects to cal.com to book a warranty appointment
6. cal.com sends iCal attachment via email on confirmation

## Setup

(Setup instructions filled in by the harness as it ships each piece — see Linear project "Warranty Form".)
