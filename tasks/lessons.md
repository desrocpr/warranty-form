# MOSS Contact Form - Lessons Learned

## HubSpot Property Names
- **Never guess abbreviated property names.** The property `please_select_the_project_types___` was an incorrect abbreviation. The actual HubSpot internal name is `please_select_the_project_types_that_most_closely_match_your_current_request_`. Always verify property names from the HubSpot form or property settings.
- **CSS class hints:** On live HubSpot pages, field CSS classes use the pattern `hs_<property_name>`. You can inspect the live page CSS to discover the real internal property name even without API access.

## HubL `crm_property_definition()`
- Limited to **10 calls per page**. Cache results in `{% set %}` variables and reuse throughout the template.
- Returns `.label` (display name) and `.options` (array of `{value, label}` for enumerations).
- If a property name doesn't exist, the HubSpot deploy will fail with: `The property 'X' does not exist in the object type 'contact'`.

## Vercel Project Naming
- The Vercel project was renamed to `moss-contact-api` on the Vercel dashboard. Keep the repo directory name in sync to avoid confusion. The deployed URL is `https://moss-contact-api.vercel.app/api/submit-contact`.

## HubSpot Forms API (submit-contact.js)
- The `name` field in the HubSpot Forms API fields array must match the exact internal property name — same rule as `crm_property_definition()`.
- Multi-value fields (like project types checkboxes) are joined with `;` for the Forms API.

## HubSpot Module Fields
- Use `richtext` type for content that end users need to format. This gives them the HubSpot WYSIWYG editor.
- Rich text fields output raw HTML, so the surrounding CSS needs to style `h3`, `h4`, `p`, `a`, `ul`, `ol` etc. generically for the rich text container.

## Conditional Field Values
- When form options come from HubSpot properties dynamically, the JS conditional logic can't use hardcoded label strings (they might change). Pass internal values from HubL to JS via the config object using `selectattr`/`map`/`first` filters.
