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
 *   Body fields:
 *     - <file>            the photo (any field name with a filename)
 *     - turnstile_token   Cloudflare Turnstile token (REQUIRED)
 *
 * Response: { url: "https://blob.vercel-storage.com/warranty/<random>-<filename>" }
 *
 * Security:
 *   - Cloudflare Turnstile token is verified against the
 *     `TURNSTILE_SECRET_KEY` server-side secret BEFORE any blob upload.
 *     Without a valid token the request is rejected with 403, which
 *     prevents anonymous scripts from filling Vercel Blob storage.
 *   - EXIF metadata (including GPS coordinates) is stripped from every
 *     image using `sharp(...).rotate()` before storage. `.rotate()` applies
 *     EXIF orientation and then drops all metadata.
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
 *   - TURNSTILE_SECRET_KEY  — used to verify the Turnstile token
 */

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { put } from '@vercel/blob';
import sharp from 'sharp';

// 5 MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// A modest cushion above MAX_FILE_SIZE to allow for the multipart envelope
// (headers + boundaries + the turnstile_token field) while still rejecting
// obviously oversized payloads before parsing them. Keeps the parser bounded.
const MAX_BODY_SIZE = MAX_FILE_SIZE + 32 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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
 * Walk a multipart/form-data body and return all parts.
 *
 * Each part is { name, filename, contentType, data }. `filename` is null for
 * plain form fields, which lets the handler distinguish the file from the
 * `turnstile_token` field. Returns [] if the body is malformed.
 */
function parseMultipartParts(body, boundary) {
  const parts = [];
  const delimiter = Buffer.from(`--${boundary}`);

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return parts;

  while (cursor !== -1 && cursor < body.length) {
    cursor += delimiter.length;
    // Closing boundary: "--BOUNDARY--"
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      break;
    }
    // Skip CRLF after the boundary line
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) {
      cursor += 2;
    }

    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headersEnd === -1) break;

    const headersStr = body.slice(cursor, headersEnd).toString('utf8');
    const dataStart = headersEnd + 4;

    // Find next boundary to know where this part ends.
    const nextBoundary = body.indexOf(delimiter, dataStart);
    if (nextBoundary === -1) break;

    // Trim the trailing CRLF that precedes the boundary.
    let dataEnd = nextBoundary;
    if (
      dataEnd - 2 >= dataStart &&
      body[dataEnd - 2] === 0x0d &&
      body[dataEnd - 1] === 0x0a
    ) {
      dataEnd -= 2;
    }

    let name = null;
    let filename = null;
    let partContentType = null;
    for (const rawLine of headersStr.split('\r\n')) {
      const colonIdx = rawLine.indexOf(':');
      if (colonIdx === -1) continue;
      const headerName = rawLine.slice(0, colonIdx).trim().toLowerCase();
      const value = rawLine.slice(colonIdx + 1).trim();
      if (headerName === 'content-disposition') {
        const nameMatch = value.match(/name="((?:[^"\\]|\\.)*)"/i);
        if (nameMatch) name = nameMatch[1].replace(/\\(.)/g, '$1');
        const fnMatch = value.match(/filename="((?:[^"\\]|\\.)*)"/i);
        if (fnMatch) filename = fnMatch[1].replace(/\\(.)/g, '$1');
      } else if (headerName === 'content-type') {
        partContentType = value.toLowerCase();
      }
    }

    parts.push({
      name,
      filename,
      contentType: partContentType,
      data: body.slice(dataStart, dataEnd),
    });

    cursor = nextBoundary;
  }
  return parts;
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

/**
 * Verify the Cloudflare Turnstile token with Cloudflare's siteverify API.
 * Matches the JSON-POST pattern used elsewhere in this codebase. Returns
 * `true` only on an explicit `{ success: true }` response. Any timeout,
 * network error, or non-2xx is treated as failure (fail-closed).
 */
async function verifyTurnstile(token, secret) {
  if (!token || !secret) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
    });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => ({}));
    return !!data.success;
  } catch (err) {
    console.error('[UploadPhoto] Turnstile verification error:', err && err.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Strip EXIF (including GPS) and other metadata from the uploaded image.
 *
 * `sharp(buffer).rotate()` applies the EXIF Orientation tag and then drops
 * all metadata in the output. The image is re-encoded in its original
 * format to preserve the user's chosen MIME type.
 *
 * On any sharp failure we fall through and re-throw so the handler can
 * return a 502 — uploading the raw (still-EXIF-laden) buffer would defeat
 * the privacy guarantee.
 */
async function stripImageMetadata(buffer, mime) {
  const pipeline = sharp(buffer).rotate();
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return pipeline.jpeg().toBuffer();
    case 'image/png':
      return pipeline.png().toBuffer();
    case 'image/webp':
      return pipeline.webp().toBuffer();
    default:
      // Should not be reachable — MIME is already allow-list checked.
      return pipeline.toBuffer();
  }
}

export default async function handler(req, res) {
  // CORS handled by vercel.json
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    console.error('[UploadPhoto] BLOB_READ_WRITE_TOKEN not configured');
    return res.status(500).json({ error: 'Upload service not configured' });
  }

  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (!turnstileSecret) {
    console.error('[UploadPhoto] TURNSTILE_SECRET_KEY not configured');
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

  const parts = parseMultipartParts(body, boundary);

  // Pick the first part with a filename as the uploaded photo; collect
  // plain form fields (the Turnstile token in particular) by name.
  let filePart = null;
  const fields = Object.create(null);
  for (const part of parts) {
    if (part.filename != null) {
      if (filePart === null) filePart = part;
    } else if (part.name != null) {
      fields[part.name] = part.data.toString('utf8');
    }
  }

  // -------------------------------------------------------------------------
  // Turnstile verification — runs BEFORE any blob storage interaction.
  // Without this, the endpoint is publicly callable and a trivial script can
  // fill Vercel Blob storage in minutes. See PR review on MOS-205.
  // -------------------------------------------------------------------------
  const turnstileToken = (fields.turnstile_token || '').trim();
  if (!turnstileToken) {
    return res.status(403).json({ error: 'Security verification is required' });
  }
  const turnstileOk = await verifyTurnstile(turnstileToken, turnstileSecret);
  if (!turnstileOk) {
    return res.status(403).json({ error: 'Security verification failed' });
  }

  if (!filePart || !filePart.data || filePart.data.length === 0) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  if (filePart.data.length > MAX_FILE_SIZE) {
    return res.status(413).json({ error: 'File too large (max 5 MB)' });
  }

  const mime = (filePart.contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    return res.status(415).json({ error: 'Unsupported file type (allowed: jpeg, png, webp)' });
  }

  // Strip EXIF metadata (including GPS) before persisting. Customer photos
  // commonly carry location data — we never want that uploaded.
  let cleanedBuffer;
  try {
    cleanedBuffer = await stripImageMetadata(filePart.data, mime);
  } catch (err) {
    console.error('[UploadPhoto] Failed to strip image metadata:', err && err.message);
    return res.status(415).json({ error: 'Could not process image (file may be corrupted)' });
  }

  const safeName = sanitizeFilename(filePart.filename);
  const randomPrefix = randomBytes(8).toString('hex');
  const pathname = `warranty/${randomPrefix}-${safeName}`;

  try {
    const result = await put(pathname, cleanedBuffer, {
      access: 'public',
      contentType: mime,
      // We already prepend our own random prefix, so disable the SDK's suffix.
      addRandomSuffix: false,
      token: blobToken,
    });
    return res.status(200).json({ url: result.url });
  } catch (err) {
    console.error('[UploadPhoto] Vercel Blob put failed:', err);
    return res.status(502).json({ error: 'Failed to store uploaded file' });
  }
}
