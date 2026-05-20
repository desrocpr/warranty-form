# MOSS Contact Form - Task Tracker

## Completed
- [x] Make form fields data-driven from HubSpot properties via `crm_property_definition()`
- [x] Replace hardcoded labels with `{{ prop.label }}` for all 8 fields
- [x] Replace hardcoded option lists with `{% for %}` loops (state, project types, how-heard)
- [x] Pass conditional trigger values via config so JS matches on internal property values
- [x] Update `setupConditionalFields()` in module.js to use config values
- [x] Rename `vercel-server/` to `moss-contact-api/` to match Vercel project name
- [x] Fix project types property name (`please_select_the_project_types_that_most_closely_match_your_current_request_`)
- [x] Add "What's Next" steps content to module
- [x] Change submit button text to "Submit"
- [x] Move to two-column side-by-side layout (text left, form right)
- [x] Replace hardcoded What's Next section with `section_text` rich text HubL field

## Open / In Progress
- [ ] Investigate Turnstile widget not rendering (site key is configured but widget doesn't appear)
- [ ] Verify deploy succeeds after property name fix
- [ ] Test form submission end-to-end on HubSpot preview page
- [ ] Confirm conditional fields (referral name, event details) show/hide correctly with dynamic values
