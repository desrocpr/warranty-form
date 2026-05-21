/**
 * Warranty Photo Upload Endpoint
 *
 * Accepts a single image file via multipart/form-data and uploads it to
 * Vercel Blob under the `warranty/` prefix. Returns the public blob URL,
 * which the main warranty form then submits alongside the rest of the
 * ticket fields (handled by MOS-204).
 *
 * POST /api/upload-photo
 *   Content-Type: multipart/form-data; boundary=...
 *   Body: a single file field (any name)
 *
 * Response: { url: "https://blob.vercel-storage.com/warranty/<random>-<filename>" }
 *
 * Validation:
 *   - Allowed MIME types: image/jpeg, image/png, image/webp
 *   - Max file size: 5 MB
 *   - Filename sanitised (no path traversal)
 *   - A short random prefix is prepended to the storage pathname to prevent
 *     collisions between uploads of identically-named files
 *
 * Environment:
 *   - BLOB_READ_WRITE_TOKEN — passed through to @vercel/blob's `put()`
 */

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { put } from '@vercel/blob';

// 5 MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// A modest cushion above MAX_FILE_SIZE to allow for the multipart envelope
// (headers + boundaries) while still rejecting obviously oversized payloads
// before parsing them. Keeps the parser bounded.
const MAX_BODY_SIZE = MAX_FILE_SIZE + 32 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

// Disable Vercel's default body parser so we receive the raw multipart payload.
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Read the request body as a Buffer, with an upper-bound size guard.
 *
 * Tests can pass a pre-built `req.body` Buffer (or Uint8Array / string) and the
 * helper will short-circuit; in production we drain `req` as a Readable stream.
 *
 * If the payload exceeds MAX_BODY_SIZE we throw a tagged error so the handler
 * can return 413 without buffering the whole thing.
 */
async function readRawBody(req) {
  if (req && req.body != null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (req.body instanceof Uint8Array) return Buffer.from(req.body);
    if (typeof req.body === 'string') return Buffer.from(req.body);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_SIZE) {
      const err = new Error('Request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Extract the boundary string from a multipart Content-Type header.
 * Returns null if the header is missing or not multipart/form-data.
 */
function parseBoundary(contentTypeHeader) {
  if (!contentTypeHeader || typeof contentTypeHeader !== 'string') return null;
  if (contentTypeHeader.toLowerCase().indexOf('multipart/form-data') === -1) {
    return null;
  }
  // boundary=foo or boundary="foo"
  const match = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;
  return (match[1] || match[2] || '').trim();
}

/**
 * Minimal multipart/form-data parser that returns the FIRST file part it
 * finds (filename + content-type + data). We only ever upload one file per
 * request — additional parts are ignored.
 *
 * Returns null if no file part is found / the body is malformed.
 */
function parseFirstFilePart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const CRLF = Buffer.from('\r\n');

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return null;

  while (cursor !== -1 && cursor < body.length) {
    cursor += delimiter.length;
    // Closing boundary: "--BOUNDARY--"
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      return null;
    }
    // Skip CRLF after the boundary line
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) {
      cursor += 2;
    }

    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headersEnd === -1) return null;

    const headersStr = body.slice(cursor, headersEnd).toString('utf8');
    const dataStart = headersEnd + 4;

    // Find next boundary to know where this part ends.
    const nextBoundary = body.indexOf(delimiter, dataStart);
    if (nextBoundary === -1) return null;

    // Trim the trailing CRLF that precedes the boundary.
    let dataEnd = nextBoundary;
    if (
      dataEnd - 2 >= dataStart &&
      body[dataEnd - 2] === 0x0d &&
      body[dataEnd - 1] === 0x0a
    ) {
      dataEnd -= 2;
    }

    let filename = null;
    let partContentType = null;
    for (const rawLine of headersStr.split('\r\n')) {
      const colonIdx = rawLine.indexOf(':');
      if (colonIdx === -1) continue;
      const name = rawLine.slice(0, colonIdx).trim().toLowerCase();
      const value = rawLine.slice(colonIdx + 1).trim();
      if (name === 'content-disposition') {
        const m = value.match(/filename="((?:[^"\\]|\\.)*)"/i);
        if (m) {
          // Unescape any backslash-escaped quotes
          filename = m[1].replace(/\\(.)/g, '$1');
        }
      } else if (name === 'content-type') {
        partContentType = value.toLowerCase();
      }
    }

    if (filename !== null) {
      return {
        filename,
        contentType: partContentType || 'application/octet-stream',
        data: body.slice(dataStart, dataEnd),
      };
    }

    cursor = nextBoundary;
    // CRLF intentionally not consumed here — the next iteration will.
    void CRLF;
  }
  return null;
}

/**
 * Strip dangerous components from an uploaded filename. We keep only the
 * basename, drop any leading dots, collapse `..` segments and limit length.
 * Empty / fully-stripped names get a generic fallback.
 */
function sanitizeFilename(rawName) {
  let name = String(rawName || '');
  // Drop any path component — take basename after the last separator
  const lastSep = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastSep !== -1) name = name.slice(lastSep + 1);
  // Remove any remaining path separators or .. segments defensively
  name = name.replace(/[/\\]/g, '');
  name = name.replace(/\.\.+/g, '.');
  // Remove leading dots so we don't produce ".hidden" files
  name = name.replace(/^\.+/, '');
  // Strip control chars and characters that are awkward in URLs
  name = name.replace(/[\x00-\x1f\x7f]/g, '');
  name = name.replace(/[\s]+/g, '-');
  // Limit length to keep pathnames reasonable
  if (name.length > 100) name = name.slice(-100);
  if (!name) name = 'upload';
  return name;
}

export default async function handler(req, res) {
  // CORS handled by vercel.json
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error('[UploadPhoto] BLOB_READ_WRITE_TOKEN not configured');
    return res.status(500).json({ error: 'Upload service not configured' });
  }

  const contentType = req.headers && (req.headers['content-type'] || req.headers['Content-Type']);
  const boundary = parseBoundary(contentType);
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data with a boundary' });
  }

  let body;
  try {
    body = await readRawBody(req);
  } catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      return res.status(413).json({ error: 'File too large (max 5 MB)' });
    }
    console.error('[UploadPhoto] Failed to read request body:', err);
    return res.status(400).json({ error: 'Could not read request body' });
  }

  const part = parseFirstFilePart(body, boundary);
  if (!part || !part.data || part.data.length === 0) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  if (part.data.length > MAX_FILE_SIZE) {
    return res.status(413).json({ error: 'File too large (max 5 MB)' });
  }

  const mime = (part.contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    return res.status(415).json({ error: 'Unsupported file type (allowed: jpeg, png, webp)' });
  }

  const safeName = sanitizeFilename(part.filename);
  const randomPrefix = randomBytes(8).toString('hex');
  const pathname = `warranty/${randomPrefix}-${safeName}`;

  try {
    const result = await put(pathname, part.data, {
      access: 'public',
      contentType: mime,
      // We already prepend our own random prefix, so disable the SDK's suffix.
      addRandomSuffix: false,
      token,
    });
    return res.status(200).json({ url: result.url });
  } catch (err) {
    console.error('[UploadPhoto] Vercel Blob put failed:', err);
    return res.status(502).json({ error: 'Failed to store uploaded file' });
  }
}
