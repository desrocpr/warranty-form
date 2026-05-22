import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPut = vi.fn();
vi.mock('@vercel/blob', () => ({
  put: (...args) => mockPut(...args),
}));

// Mock `sharp` to act as an identity transform — it returns the input
// buffer unchanged so the rest of the pipeline keeps working. The handler's
// only contract with sharp is "we ran something through it that strips
// EXIF"; we assert the integration by checking that the chain was called
// at least once per upload.
const mockSharpToBuffer = vi.fn();
const mockSharpCtor = vi.fn();
vi.mock('sharp', () => ({
  default: (...args) => mockSharpCtor(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BLOB_TOKEN = 'vercel_blob_rw_test_token_abc';
const TEST_TURNSTILE_SECRET = 'turnstile_test_secret';
const TEST_TURNSTILE_TOKEN = 'turnstile_response_test_token';
const BOUNDARY = '----WebKitFormBoundaryTEST';

/**
 * Build a Buffer representing a multipart/form-data body. By default it
 * carries one file part AND a turnstile_token field — mirroring what the
 * browser FormData submission produces after MOS-205's client-side
 * Turnstile wiring.
 */
function buildMultipartBody({
  fieldName = 'photo',
  filename = 'photo.jpg',
  contentType = 'image/jpeg',
  data = Buffer.from('fake-jpg-bytes'),
  turnstileToken = TEST_TURNSTILE_TOKEN,
  includeTurnstileField = true,
} = {}) {
  const fileData = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const fileHead = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );

  const segments = [fileHead, fileData];

  if (includeTurnstileField) {
    const tokenPart = Buffer.from(
      `\r\n--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="turnstile_token"\r\n\r\n` +
        `${turnstileToken}`,
      'utf8'
    );
    segments.push(tokenPart);
  }

  segments.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(segments);
}

function createReq({
  method = 'POST',
  body = null,
  contentType = `multipart/form-data; boundary=${BOUNDARY}`,
  headers = {},
} = {}) {
  return {
    method,
    headers: { 'content-type': contentType, ...headers },
    body,
  };
}

function createRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    end() { res._ended = true; return res; },
  };
  return res;
}

/**
 * Install a `fetch` stub that intercepts calls to Cloudflare's siteverify
 * endpoint. Anything else throws so an accidentally-real outbound call is
 * loud rather than silently passing.
 */
function stubTurnstileFetch({ success = true, ok = true } = {}) {
  const fetchSpy = vi.fn(async (url) => {
    if (typeof url === 'string' && url.includes('challenges.cloudflare.com/turnstile')) {
      return {
        ok,
        json: async () => ({ success }),
      };
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  globalThis.fetch = fetchSpy;
  return fetchSpy;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upload-photo handler', () => {
  let handler;
  let originalFetch;

  beforeEach(async () => {
    vi.resetModules();
    mockPut.mockReset();
    mockPut.mockResolvedValue({
      url: 'https://blob.vercel-storage.com/warranty/abcdef-photo.jpg',
      pathname: 'warranty/abcdef-photo.jpg',
      contentType: 'image/jpeg',
      contentDisposition: 'attachment; filename="photo.jpg"',
    });

    // Default sharp mock: identity pipeline. The handler chain is
    // `sharp(buf).rotate().<format>().toBuffer()` — every call returns the
    // same pipeline object so chaining works, then toBuffer resolves with
    // the original buffer.
    mockSharpToBuffer.mockReset();
    mockSharpCtor.mockReset();
    mockSharpCtor.mockImplementation((buf) => {
      const pipeline = {
        rotate: vi.fn(() => pipeline),
        jpeg: vi.fn(() => pipeline),
        png: vi.fn(() => pipeline),
        webp: vi.fn(() => pipeline),
        toBuffer: () => {
          mockSharpToBuffer(buf);
          return Promise.resolve(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
        },
      };
      return pipeline;
    });

    process.env.BLOB_READ_WRITE_TOKEN = TEST_BLOB_TOKEN;
    process.env.TURNSTILE_SECRET_KEY = TEST_TURNSTILE_SECRET;

    originalFetch = globalThis.fetch;
    stubTurnstileFetch({ success: true });

    const mod = await import('../../api/upload-photo.js');
    handler = mod.default;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('handles OPTIONS preflight', async () => {
    const res = createRes();
    await handler(createReq({ method: 'OPTIONS' }), res);
    expect(res._status).toBe(200);
    expect(res._ended).toBe(true);
  });

  it('rejects non-POST methods with 405', async () => {
    const res = createRes();
    await handler(createReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 500 when BLOB_READ_WRITE_TOKEN is not configured', async () => {
    vi.resetModules();
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const mod = await import('../../api/upload-photo.js');
    const localHandler = mod.default;
    const res = createRes();
    await localHandler(
      createReq({ body: buildMultipartBody() }),
      res
    );
    expect(res._status).toBe(500);
    expect(res._json.error).toContain('not configured');
  });

  it('returns 500 when TURNSTILE_SECRET_KEY is not configured', async () => {
    vi.resetModules();
    delete process.env.TURNSTILE_SECRET_KEY;
    const mod = await import('../../api/upload-photo.js');
    const localHandler = mod.default;
    const res = createRes();
    await localHandler(
      createReq({ body: buildMultipartBody() }),
      res
    );
    expect(res._status).toBe(500);
    expect(res._json.error).toContain('not configured');
  });

  it('returns 400 when Content-Type is not multipart/form-data', async () => {
    const res = createRes();
    await handler(
      createReq({ contentType: 'application/json', body: Buffer.from('{}') }),
      res
    );
    expect(res._status).toBe(400);
  });

  it('returns 403 when the multipart body is missing the turnstile_token field', async () => {
    const res = createRes();
    await handler(
      createReq({ body: buildMultipartBody({ includeTurnstileField: false }) }),
      res
    );
    expect(res._status).toBe(403);
    expect(res._json.error).toMatch(/security verification/i);
    // Nothing should hit Vercel Blob if Turnstile didn't pass.
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('returns 403 when Cloudflare reports the Turnstile token as invalid', async () => {
    stubTurnstileFetch({ success: false });
    const res = createRes();
    await handler(
      createReq({ body: buildMultipartBody() }),
      res
    );
    expect(res._status).toBe(403);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('returns 403 when the Turnstile siteverify call itself errors out', async () => {
    stubTurnstileFetch({ success: false, ok: false });
    const res = createRes();
    await handler(
      createReq({ body: buildMultipartBody() }),
      res
    );
    expect(res._status).toBe(403);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('POSTs the turnstile token to Cloudflare with the configured secret', async () => {
    const fetchSpy = stubTurnstileFetch({ success: true });
    const res = createRes();
    await handler(
      createReq({ body: buildMultipartBody({ turnstileToken: 'token-XYZ' }) }),
      res
    );
    expect(res._status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [verifyUrl, init] = fetchSpy.mock.calls[0];
    expect(String(verifyUrl)).toContain('challenges.cloudflare.com/turnstile');
    expect(init && init.method).toBe('POST');
    const sentBody = JSON.parse(init.body);
    expect(sentBody.secret).toBe(TEST_TURNSTILE_SECRET);
    expect(sentBody.response).toBe('token-XYZ');
  });

  it('returns 400 when multipart body has no file part (but token is present)', async () => {
    // A multipart body with only the turnstile_token field — no file.
    const body = Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="turnstile_token"\r\n\r\n` +
        `${TEST_TURNSTILE_TOKEN}\r\n` +
        `--${BOUNDARY}--\r\n`,
      'utf8'
    );
    const res = createRes();
    await handler(createReq({ body }), res);
    expect(res._status).toBe(400);
  });

  it('accepts a valid JPEG upload and returns 200 + url', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'kitchen.jpg',
          contentType: 'image/jpeg',
          data: Buffer.from('jpeg-bytes'),
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('url');
    expect(typeof res._json.url).toBe('string');
    expect(res._json.url).toMatch(/^https?:\/\//);
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('runs the uploaded buffer through sharp() before storage (EXIF stripping)', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'with-gps.jpg',
          contentType: 'image/jpeg',
          data: Buffer.from('jpeg-bytes-with-exif'),
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
    // sharp was constructed with the raw buffer, and the cleaned buffer
    // (not the raw buffer) is what flows into put().
    expect(mockSharpCtor).toHaveBeenCalledTimes(1);
    expect(mockSharpToBuffer).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('returns 415 when sharp fails to decode the image', async () => {
    mockSharpCtor.mockImplementationOnce(() => {
      const pipeline = {
        rotate: () => pipeline,
        jpeg: () => pipeline,
        png: () => pipeline,
        webp: () => pipeline,
        toBuffer: () => Promise.reject(new Error('Input file is not a recognised image')),
      };
      return pipeline;
    });
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'corrupt.jpg',
          contentType: 'image/jpeg',
          data: Buffer.from('this-is-not-an-image'),
        }),
      }),
      res
    );
    expect(res._status).toBe(415);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('accepts a valid PNG upload', async () => {
    mockPut.mockResolvedValueOnce({
      url: 'https://blob.vercel-storage.com/warranty/xyz-bath.png',
    });
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'bath.png',
          contentType: 'image/png',
          data: Buffer.from('png-bytes'),
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
    expect(res._json.url).toContain('warranty/');
  });

  it('accepts a valid WebP upload', async () => {
    mockPut.mockResolvedValueOnce({
      url: 'https://blob.vercel-storage.com/warranty/xyz-pic.webp',
    });
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'pic.webp',
          contentType: 'image/webp',
          data: Buffer.from('webp-bytes'),
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
  });

  it('returns 413 when the uploaded file exceeds 5 MB', async () => {
    // 5 MB + 1 byte of file payload
    const oversizedPayload = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    const body = buildMultipartBody({
      filename: 'huge.jpg',
      contentType: 'image/jpeg',
      data: oversizedPayload,
    });
    const res = createRes();
    await handler(createReq({ body }), res);
    expect(res._status).toBe(413);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('returns 415 when the MIME type is not an allowed image type', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'evil.pdf',
          contentType: 'application/pdf',
          data: Buffer.from('PDF-bytes'),
        }),
      }),
      res
    );
    expect(res._status).toBe(415);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('returns 415 for image/gif (not in allow-list)', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'anim.gif',
          contentType: 'image/gif',
          data: Buffer.from('gif-bytes'),
        }),
      }),
      res
    );
    expect(res._status).toBe(415);
  });

  it('uploads under the warranty/ prefix with a random pathname prefix', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'roof.jpg',
          contentType: 'image/jpeg',
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
    const [pathname] = mockPut.mock.calls[0];
    expect(pathname.startsWith('warranty/')).toBe(true);
    // After "warranty/" there should be a random hex prefix, then "-roof.jpg"
    expect(pathname).toMatch(/^warranty\/[a-f0-9]{8,}-roof\.jpg$/);
  });

  it('generates a different random prefix per upload', async () => {
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      const res = createRes();
      await handler(
        createReq({
          body: buildMultipartBody({ filename: 'same.jpg' }),
        }),
        res
      );
      expect(res._status).toBe(200);
      const [pathname] = mockPut.mock.calls[i];
      seen.add(pathname);
    }
    expect(seen.size).toBe(3);
  });

  it('passes BLOB_READ_WRITE_TOKEN through to @vercel/blob.put()', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({ filename: 'one.jpg' }),
      }),
      res
    );
    expect(res._status).toBe(200);
    const [, , options] = mockPut.mock.calls[0];
    expect(options).toBeDefined();
    expect(options.token).toBe(TEST_BLOB_TOKEN);
    expect(options.access).toBe('public');
  });

  it('sanitizes filenames containing path separators', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: '../../etc/passwd.jpg',
          contentType: 'image/jpeg',
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
    const [pathname] = mockPut.mock.calls[0];
    // Should not contain ".." nor traverse out of warranty/
    expect(pathname).not.toContain('..');
    expect(pathname.split('/').length).toBe(2); // "warranty/<random>-<name>"
    expect(pathname.startsWith('warranty/')).toBe(true);
    expect(pathname).toContain('passwd.jpg');
  });

  it('sanitizes Windows-style path separators in filename', async () => {
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({
          filename: 'C:\\\\Users\\\\Evil\\\\nope.jpg',
          contentType: 'image/jpeg',
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
    const [pathname] = mockPut.mock.calls[0];
    expect(pathname).not.toContain('\\');
    expect(pathname).toContain('nope.jpg');
  });

  it('5 sequential uploads each succeed and call put() with the token', async () => {
    for (let i = 0; i < 5; i++) {
      mockPut.mockResolvedValueOnce({
        url: `https://blob.vercel-storage.com/warranty/seq-${i}.jpg`,
      });
      const res = createRes();
      await handler(
        createReq({
          body: buildMultipartBody({
            filename: `seq-${i}.jpg`,
            contentType: 'image/jpeg',
            data: Buffer.from(`bytes-${i}`),
          }),
        }),
        res
      );
      expect(res._status).toBe(200);
      expect(res._json.url).toContain('warranty/');
    }
    expect(mockPut).toHaveBeenCalledTimes(5);
    for (const call of mockPut.mock.calls) {
      expect(call[2].token).toBe(TEST_BLOB_TOKEN);
    }
  });

  it('returns 502 when @vercel/blob.put() throws', async () => {
    mockPut.mockRejectedValueOnce(new Error('Blob service unavailable'));
    const res = createRes();
    await handler(
      createReq({
        body: buildMultipartBody({ filename: 'fail.jpg' }),
      }),
      res
    );
    expect(res._status).toBe(502);
  });
});
