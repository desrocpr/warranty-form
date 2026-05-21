/**
 * cal.com Booking URL Builder
 *
 * Constructs a cal.com booking URL with customer info prefilled, so a
 * customer who just submitted the warranty form can be redirected straight
 * into the scheduling flow.
 *
 * The base URL is configured per-environment via `CAL_COM_BOOKING_URL`
 * (e.g. `https://cal.com/moss-warranty/warranty-appointment`). Prefill
 * params follow cal.com's documented schema:
 *   https://cal.com/docs/core-features/event-types/booking-questions
 *
 * Encoding: uses URLSearchParams (spaces -> `+`, brackets -> `%5B`/`%5D`).
 * The brackets in `metadata[ticketId]` / `metadata[issueCategory]` MUST be
 * percent-encoded to survive intermediate HTTP stacks; cal.com accepts the
 * encoded form.
 */

/**
 * Build a cal.com booking URL with prefilled customer info.
 *
 * @param {Object} params
 * @param {string} [params.name]          - Customer's full name (firstname + " " + lastname).
 * @param {string} [params.email]         - Customer email address.
 * @param {string} [params.ticketId]      - HubSpot Ticket id, attached as metadata.
 * @param {string} [params.issueCategory] - Warranty issue category, attached as metadata.
 * @returns {string|null} Fully-encoded booking URL, or `null` when `CAL_COM_BOOKING_URL` is unset/empty.
 */
export function buildCalComBookingUrl({ name, email, ticketId, issueCategory } = {}) {
  const baseUrl = process.env.CAL_COM_BOOKING_URL;
  if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    return null;
  }

  const params = new URLSearchParams();

  if (name) {
    params.append('name', String(name));
  }
  if (email) {
    params.append('email', String(email));
  }
  if (ticketId) {
    // Brackets get percent-encoded to %5B / %5D — see file header.
    params.append('metadata[ticketId]', String(ticketId));
  }
  if (issueCategory) {
    params.append('metadata[issueCategory]', String(issueCategory));
  }

  const query = params.toString();
  if (!query) {
    return baseUrl;
  }

  // Preserve any pre-existing query string on the configured base URL.
  const separator = baseUrl.indexOf('?') === -1 ? '?' : '&';
  return baseUrl + separator + query;
}
