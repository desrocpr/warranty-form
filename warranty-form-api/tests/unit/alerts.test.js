import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('alerts module', () => {
  let sendAlert;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();
    // Set all env vars by default
    process.env.SENDGRID_API_KEY = 'sg-test-key';
    process.env.SENDGRID_FROM_EMAIL = 'alerts@test.com';
    process.env.ALERT_EMAIL = 'user@test.com';
    process.env.TEAMS_WEBHOOK_URL = 'https://teams.webhook.test/hook';

    const mod = await import('../../lib/alerts.js');
    sendAlert = mod.sendAlert;
  });

  afterEach(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM_EMAIL;
    delete process.env.ALERT_EMAIL;
    delete process.env.TEAMS_WEBHOOK_URL;
  });

  it('sends to both SendGrid and Teams in parallel', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await sendAlert('Test Alert', 'Something failed');

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify SendGrid call
    const sgCall = mockFetch.mock.calls.find(c => c[0].includes('sendgrid'));
    expect(sgCall).toBeDefined();
    expect(sgCall[1].method).toBe('POST');
    const sgBody = JSON.parse(sgCall[1].body);
    expect(sgBody.personalizations[0].to[0].email).toBe('user@test.com');
    expect(sgBody.from.email).toBe('alerts@test.com');
    expect(sgBody.subject).toBe('[MOSS Contact Form] Test Alert');

    // Verify Teams call
    const teamsCall = mockFetch.mock.calls.find(c => c[0].includes('teams.webhook'));
    expect(teamsCall).toBeDefined();
    const teamsBody = JSON.parse(teamsCall[1].body);
    expect(teamsBody.type).toBe('message');
    expect(teamsBody.attachments[0].content.body[0].text).toContain('Test Alert');
  });

  it('skips SendGrid when env vars are missing', async () => {
    delete process.env.SENDGRID_API_KEY;
    vi.resetModules();
    const mod = await import('../../lib/alerts.js');

    mockFetch.mockResolvedValue({ ok: true });
    await mod.sendAlert('Test', 'details');

    // Only Teams call should be made
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('teams.webhook');
  });

  it('skips Teams when webhook URL is missing', async () => {
    delete process.env.TEAMS_WEBHOOK_URL;
    vi.resetModules();
    const mod = await import('../../lib/alerts.js');

    mockFetch.mockResolvedValue({ ok: true });
    await mod.sendAlert('Test', 'details');

    // Only SendGrid call should be made
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('sendgrid');
  });

  it('does not throw when both channels fail', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    // Should not throw
    await sendAlert('Test', 'details');
  });

  it('continues when one channel fails and other succeeds', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('first fails'));
      return Promise.resolve({ ok: true });
    });

    await sendAlert('Test', 'details');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('logs warning when no channels are configured', async () => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.TEAMS_WEBHOOK_URL;
    vi.resetModules();
    const mod = await import('../../lib/alerts.js');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mod.sendAlert('Test', 'details');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No alert channels configured'),
      expect.any(String)
    );
    expect(mockFetch).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('includes Authorization header for SendGrid', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await sendAlert('Test', 'details');

    const sgCall = mockFetch.mock.calls.find(c => c[0].includes('sendgrid'));
    expect(sgCall[1].headers.Authorization).toBe('Bearer sg-test-key');
  });

  it('sends Adaptive Card format to Teams webhook', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await sendAlert('Test Title', 'Error details here');

    const teamsCall = mockFetch.mock.calls.find(c => c[0].includes('teams.webhook'));
    const body = JSON.parse(teamsCall[1].body);
    const card = body.attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.4');
    expect(card.body[0].text).toContain('Test Title');
    expect(card.body[1].text).toBe('Error details here');
  });
});
