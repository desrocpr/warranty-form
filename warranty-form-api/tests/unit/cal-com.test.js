import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { buildCalComBookingUrl } from '../../lib/cal-com.js';

const BASE_URL = 'https://cal.com/moss-warranty/warranty-appointment';

describe('buildCalComBookingUrl', () => {
  beforeEach(() => {
    process.env.CAL_COM_BOOKING_URL = BASE_URL;
  });

  afterEach(() => {
    delete process.env.CAL_COM_BOOKING_URL;
  });

  it('returns null when CAL_COM_BOOKING_URL is unset', () => {
    delete process.env.CAL_COM_BOOKING_URL;
    expect(
      buildCalComBookingUrl({
        name: 'Jane Doe',
        email: 'jane@example.com',
        ticketId: '12345',
        issueCategory: 'Plumbing',
      })
    ).toBeNull();
  });

  it('returns null when CAL_COM_BOOKING_URL is an empty string', () => {
    process.env.CAL_COM_BOOKING_URL = '';
    expect(
      buildCalComBookingUrl({
        name: 'Jane Doe',
        email: 'jane@example.com',
        ticketId: '12345',
        issueCategory: 'Plumbing',
      })
    ).toBeNull();
  });

  it('returns null when CAL_COM_BOOKING_URL is whitespace only', () => {
    process.env.CAL_COM_BOOKING_URL = '   ';
    expect(buildCalComBookingUrl({ name: 'Jane' })).toBeNull();
  });

  it('does not throw when called with no arguments', () => {
    expect(() => buildCalComBookingUrl()).not.toThrow();
    expect(buildCalComBookingUrl()).toBe(BASE_URL);
  });

  it('builds a URL starting with the configured base URL', () => {
    const url = buildCalComBookingUrl({
      name: 'Jane Doe',
      email: 'jane@example.com',
      ticketId: '12345',
      issueCategory: 'Plumbing',
    });
    expect(url.startsWith(BASE_URL + '?')).toBe(true);
  });

  it('encodes name with URLSearchParams (space becomes +)', () => {
    const url = buildCalComBookingUrl({
      name: 'Jane Doe',
      email: 'jane@example.com',
      ticketId: '12345',
      issueCategory: 'Plumbing',
    });
    expect(url).toContain('name=Jane+Doe');
  });

  it('encodes email (@ becomes %40)', () => {
    const url = buildCalComBookingUrl({
      name: 'Jane Doe',
      email: 'jane@example.com',
      ticketId: '12345',
      issueCategory: 'Plumbing',
    });
    expect(url).toContain('email=jane%40example.com');
  });

  it('percent-encodes the brackets in metadata[ticketId] and metadata[issueCategory]', () => {
    const url = buildCalComBookingUrl({
      name: 'Jane Doe',
      email: 'jane@example.com',
      ticketId: '12345',
      issueCategory: 'Plumbing',
    });
    expect(url).toContain('metadata%5BticketId%5D=12345');
    expect(url).toContain('metadata%5BissueCategory%5D=Plumbing');
    // And make sure the literal bracket form is NOT emitted
    expect(url).not.toContain('metadata[ticketId]');
    expect(url).not.toContain('metadata[issueCategory]');
  });

  it('properly encodes special characters: apostrophes, accents, ampersands, plus signs', () => {
    const url = buildCalComBookingUrl({
      name: "O'Brien Ñoño",
      email: 'a+b@example.com',
      ticketId: 'T-1',
      issueCategory: 'HVAC & Electrical',
    });

    // The raw special characters should NOT appear unencoded in the query string.
    const query = url.slice(url.indexOf('?') + 1);
    expect(query).not.toContain("'");
    expect(query).not.toContain('Ñ');
    expect(query).not.toContain('&Electrical');
    // The literal "+" in the email must be encoded (URLSearchParams does this).
    expect(url).toContain('email=a%2Bb%40example.com');

    // Apostrophe encodes to %27
    expect(url).toContain('%27');
    // ñ -> %C3%B1 (UTF-8 encoded)
    expect(url).toContain('%C3%B1');
    // Ampersand inside the issueCategory value encodes to %26 (must not be parsed as a separator)
    expect(url).toContain('HVAC+%26+Electrical');
    expect(url).toContain('metadata%5BticketId%5D=T-1');
    expect(url).toContain('metadata%5BissueCategory%5D=HVAC+%26+Electrical');

    // The URL must round-trip cleanly through the WHATWG URL parser.
    const parsed = new URL(url);
    expect(parsed.searchParams.get('name')).toBe("O'Brien Ñoño");
    expect(parsed.searchParams.get('email')).toBe('a+b@example.com');
    expect(parsed.searchParams.get('metadata[ticketId]')).toBe('T-1');
    expect(parsed.searchParams.get('metadata[issueCategory]')).toBe('HVAC & Electrical');
  });

  it('omits optional params when they are missing', () => {
    const url = buildCalComBookingUrl({
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
    expect(url).toContain('name=Jane+Doe');
    expect(url).toContain('email=jane%40example.com');
    expect(url).not.toContain('metadata%5BticketId%5D');
    expect(url).not.toContain('metadata%5BissueCategory%5D');
  });

  it('omits ticketId/issueCategory when explicitly falsy', () => {
    const url = buildCalComBookingUrl({
      name: 'Jane Doe',
      email: 'jane@example.com',
      ticketId: '',
      issueCategory: null,
    });
    expect(url).not.toContain('metadata%5BticketId%5D');
    expect(url).not.toContain('metadata%5BissueCategory%5D');
  });

  it('returns the bare base URL when all params are missing/empty', () => {
    expect(buildCalComBookingUrl({})).toBe(BASE_URL);
    expect(
      buildCalComBookingUrl({ name: '', email: '', ticketId: '', issueCategory: '' })
    ).toBe(BASE_URL);
  });

  it('preserves a pre-existing query string on the base URL', () => {
    process.env.CAL_COM_BOOKING_URL = BASE_URL + '?source=warranty';
    const url = buildCalComBookingUrl({
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
    expect(url.startsWith(BASE_URL + '?source=warranty&')).toBe(true);
    expect(url).toContain('name=Jane+Doe');
    expect(url).toContain('email=jane%40example.com');
  });
});
