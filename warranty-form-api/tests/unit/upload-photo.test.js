import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPut = vi.fn();
vi.mock('@vercel/blob', () => ({
  put: (...args) => mockPut(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'vercel_blob_rw_test_token_abc';
const BOUNDARY = '----WebKitFormBoundaryTEST';

/**
 * Build a Buffer representing a multipart/form-data body containing a single
 * file part. Mirrors what a browser FormData submission would produce.
 */
function buildMultipartBody({
  fieldName = 'photo',
  filename = 'photo.jpg',
  contentType = 'image/jpeg',
  data = Buffer.from('fake-jpg-bytes'),
} = {}) {
  const fileData = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8');
  return Buffer.concat([head, fileData, tail]);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upload-photo handler', () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    mockPut.mockReset();
    mockPut.mockResolvedValue({
      url: 'https://blob.vercel-storage.com/warranty/abcdef-photo.jpg',
      pathname: 'warranty/abcdef-photo.jpg',
      contentType: 'image/jpeg',
      contentDisposition: 'attachment; filename="photo.jpg"',
    });
    process.env.BLOB_READ_WRITE_TOKEN = TEST_TOKEN;
    const mod = await import('../../api/upload-photo.js');
    handler = mod.default;
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

  it('returns 400 when Content-Type is not multipart/form-data', async () => {
    const res = createRes();
    await handler(
      createReq({ contentType: 'application/json', body: Buffer.from('{}') }),
      res
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when multipart body has no file part', async () => {
    // A multipart body with only a non-file field
    const body = Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="not-a-file"\r\n\r\n` +
        `hello\r\n` +
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
    expect(options.token).toBe(TEST_TOKEN);
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
      expect(call[2].token).toBe(TEST_TOKEN);
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
