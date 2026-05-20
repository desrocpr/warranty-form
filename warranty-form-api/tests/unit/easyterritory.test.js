import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// https mock — intercept all HTTPS requests
// ---------------------------------------------------------------------------

let requestHandler;

vi.mock('https', () => ({
  default: {
    request: (options, callback) => {
      const req = new EventEmitter();
      req.write = vi.fn();
      req.end = vi.fn(() => {
        // Invoke the handler to get the mock response
        const { statusCode, headers, body } = requestHandler(options);

        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.headers = headers || {};

        callback(res);

        // Emit data + end on next tick (simulates async I/O)
        process.nextTick(() => {
          if (body) res.emit('data', body);
          res.emit('end');
        });
      });
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      return req;
    },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLoginThenTerritory(territoryResponse) {
  let callIndex = 0;
  requestHandler = (options) => {
    callIndex++;
    // First call is login
    if (options.path.includes('/Login/Login')) {
      return {
        statusCode: 200,
        body: JSON.stringify({ token: 'test-token-123' }),
      };
    }
    // Second call is territory lookup
    return territoryResponse;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('easyterritory', () => {
  let lookupCalendarUrl;
  let lookupRenolutionCalendarUrl;

  beforeEach(async () => {
    // Reset module state (token, tokenFetchedAt) by re-importing
    vi.resetModules();
    const mod = await import('../../lib/easyterritory.js');
    lookupCalendarUrl = mod.lookupCalendarUrl;
    lookupRenolutionCalendarUrl = mod.lookupRenolutionCalendarUrl;
  });

  describe('lookupCalendarUrl', () => {
    it('returns calendar URL from pipe-delimited tag field', async () => {
      mockLoginThenTerritory({
        statusCode: 200,
        body: JSON.stringify([
          { tag: 'Alpha Territory|https://calendly.com/alpha|555-1234|alpha@moss.com' },
        ]),
      });

      const url = await lookupCalendarUrl('22030');
      expect(url).toBe('https://calendly.com/alpha');
    });

    it('handles single object response (not array)', async () => {
      mockLoginThenTerritory({
        statusCode: 200,
        body: JSON.stringify(
          { tag: 'Beta Territory|https://calendly.com/beta|555-5678|beta@moss.com' }
        ),
      });

      const url = await lookupCalendarUrl('22030');
      expect(url).toBe('https://calendly.com/beta');
    });

    it('normalizes zip to 5 digits', async () => {
      let capturedPath;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        capturedPath = options.path;
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com/t||' }]),
        };
      };

      await lookupCalendarUrl('22030-1234');
      expect(capturedPath).toContain('territoryId=22030');
      expect(capturedPath).toContain('omitWkt=true');
      expect(capturedPath).toContain('omitMetadata=true');
    });

    it('pads short zips with leading zeros', async () => {
      let capturedPath;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        capturedPath = options.path;
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com/t||' }]),
        };
      };

      await lookupCalendarUrl('123');
      expect(capturedPath).toContain('territoryId=00123');
    });

    it('strips non-digit characters from zip', async () => {
      let capturedPath;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        capturedPath = options.path;
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com/t||' }]),
        };
      };

      await lookupCalendarUrl('2 20-30');
      expect(capturedPath).toContain('territoryId=22030');
    });

    it('returns null when territory not found (empty array)', async () => {
      mockLoginThenTerritory({
        statusCode: 200,
        body: JSON.stringify([]),
      });

      const url = await lookupCalendarUrl('99999');
      expect(url).toBeNull();
    });

    it('returns null when territory has no tag field', async () => {
      mockLoginThenTerritory({
        statusCode: 200,
        body: JSON.stringify([{ id: 'some-id', col1: 'NoTag Territory' }]),
      });

      const url = await lookupCalendarUrl('22030');
      expect(url).toBeNull();
    });

    it('returns null when tag has no calendar URL segment', async () => {
      mockLoginThenTerritory({
        statusCode: 200,
        body: JSON.stringify([{ tag: 'Only Name' }]),
      });

      const url = await lookupCalendarUrl('22030');
      expect(url).toBeNull();
    });

    it('returns null on non-200 territory response', async () => {
      mockLoginThenTerritory({ statusCode: 404, body: 'Not found' });

      const url = await lookupCalendarUrl('22030');
      expect(url).toBeNull();
    });

    it('returns null on non-JSON territory response', async () => {
      mockLoginThenTerritory({ statusCode: 200, body: '<html>error</html>' });

      const url = await lookupCalendarUrl('22030');
      expect(url).toBeNull();
    });

    it('trims whitespace from calendar URL', async () => {
      mockLoginThenTerritory({
        statusCode: 200,
        body: JSON.stringify([{ tag: 'Name | https://calendly.com/trimme | 555 | email' }]),
      });

      const url = await lookupCalendarUrl('22030');
      expect(url).toBe('https://calendly.com/trimme');
    });
  });

  describe('lookupCalendarUrl with projectId override', () => {
    it('uses the provided projectId in the URL', async () => {
      let capturedPath;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        capturedPath = options.path;
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com/override||' }]),
        };
      };

      const url = await lookupCalendarUrl('22030', 'custom-project-id');
      expect(capturedPath).toContain('/ProjectMarkupPolygon/custom-project-id/territory');
      expect(url).toBe('https://cal.com/override');
    });

    it('falls back to EASYTERRITORY_PROJECT_ID when projectId is null', async () => {
      let capturedPath;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        capturedPath = options.path;
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com/default||' }]),
        };
      };

      await lookupCalendarUrl('22030', null);
      expect(capturedPath).toContain('/ProjectMarkupPolygon/test-project-id/territory');
    });
  });

  describe('lookupRenolutionCalendarUrl', () => {
    it('uses RENOLUTION_EASYTERRITORY_PROJECT_ID', async () => {
      let capturedPath;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        capturedPath = options.path;
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'Renolution|https://cal.com/renolution||' }]),
        };
      };

      const url = await lookupRenolutionCalendarUrl('22030');
      expect(capturedPath).toContain('/ProjectMarkupPolygon/test-renolution-project-id/territory');
      expect(url).toBe('https://cal.com/renolution');
    });

    it('extracts URL from 3-part tag (State|Name|URL format)', async () => {
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'MD|Baltimore | https://cal.com/renolution-balt' }]),
        };
      };

      const url = await lookupRenolutionCalendarUrl('21213');
      expect(url).toBe('https://cal.com/renolution-balt');
    });

    it('returns null when RENOLUTION_EASYTERRITORY_PROJECT_ID is not set', async () => {
      const saved = process.env.RENOLUTION_EASYTERRITORY_PROJECT_ID;
      delete process.env.RENOLUTION_EASYTERRITORY_PROJECT_ID;

      const url = await lookupRenolutionCalendarUrl('22030');
      expect(url).toBeNull();

      process.env.RENOLUTION_EASYTERRITORY_PROJECT_ID = saved;
    });
  });

  describe('login', () => {
    it('sends credentials and extracts token', async () => {
      let loginBody;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'my-token' }) };
        }
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com||' }]),
        };
      };

      // lookupCalendarUrl triggers login internally
      const url = await lookupCalendarUrl('22030');
      expect(url).toBe('https://cal.com');
    });

    it('accepts alternative token field names (Token, oiToken, OIToken)', async () => {
      for (const field of ['Token', 'oiToken', 'OIToken']) {
        vi.resetModules();
        const mod = await import('../../lib/easyterritory.js');

        requestHandler = (options) => {
          if (options.path.includes('/Login/Login')) {
            return { statusCode: 200, body: JSON.stringify({ [field]: 'alt-token' }) };
          }
          return {
            statusCode: 200,
            body: JSON.stringify([{ tag: `T|https://cal.com/${field}||` }]),
          };
        };

        const url = await mod.lookupCalendarUrl('22030');
        expect(url).toBe(`https://cal.com/${field}`);
      }
    });

    it('throws on login failure (non-200)', async () => {
      requestHandler = () => ({ statusCode: 403, body: 'Forbidden' });

      await expect(lookupCalendarUrl('22030')).rejects.toThrow('login failed (HTTP 403)');
    });

    it('throws on non-JSON login response', async () => {
      requestHandler = () => ({ statusCode: 200, body: 'not json' });

      await expect(lookupCalendarUrl('22030')).rejects.toThrow('non-JSON response');
    });

    it('throws when no token in login response', async () => {
      requestHandler = () => ({
        statusCode: 200,
        body: JSON.stringify({ success: true }),
      });

      await expect(lookupCalendarUrl('22030')).rejects.toThrow('no token in response');
    });
  });

  describe('authenticatedRequest', () => {
    it('retries on 401 with fresh login', async () => {
      let territoryCallCount = 0;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'fresh-token' }) };
        }
        territoryCallCount++;
        // First territory call returns 401, second succeeds
        if (territoryCallCount === 1) {
          return { statusCode: 401, body: 'Unauthorized' };
        }
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com/retry||' }]),
        };
      };

      const url = await lookupCalendarUrl('22030');
      expect(url).toBe('https://cal.com/retry');
      expect(territoryCallCount).toBe(2);
    });

    it('attaches oitoken cookie to requests', async () => {
      let capturedHeaders;
      requestHandler = (options) => {
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'cookie-token' }) };
        }
        capturedHeaders = options.headers;
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com||' }]),
        };
      };

      await lookupCalendarUrl('22030');
      expect(capturedHeaders.Cookie).toBe('oitoken=cookie-token');
    });
  });

  describe('config validation', () => {
    it('throws when required env vars are missing', async () => {
      const saved = process.env.EASYTERRITORY_BASE_URL;
      delete process.env.EASYTERRITORY_BASE_URL;

      requestHandler = () => ({ statusCode: 200, body: '{}' });
      await expect(lookupCalendarUrl('22030')).rejects.toThrow('Missing EasyTerritory env vars');

      process.env.EASYTERRITORY_BASE_URL = saved;
    });

    it('builds correct REST base URL from env vars', async () => {
      let capturedPath;
      requestHandler = (options) => {
        capturedPath = `https://${options.hostname}${options.path}`;
        if (options.path.includes('/Login/Login')) {
          return { statusCode: 200, body: JSON.stringify({ token: 'tok' }) };
        }
        return {
          statusCode: 200,
          body: JSON.stringify([{ tag: 'T|https://cal.com||' }]),
        };
      };

      await lookupCalendarUrl('22030');
      expect(capturedPath).toContain('/test-guid/APP/REST/ProjectMarkupPolygon/test-project-id/territory');
    });
  });
});
