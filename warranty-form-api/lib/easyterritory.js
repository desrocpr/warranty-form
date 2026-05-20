/**
 * EasyTerritory API client for territory-based calendar URL lookup.
 *
 * Authenticates via oitoken cookie, looks up territory by ZIP code,
 * and extracts the calendar URL from the territory's tag field.
 *
 * Uses Node's https module (not fetch) because EasyTerritory's redirects
 * downgrade HTTPS to HTTP, causing timeouts with standard fetch.
 *
 * Environment Variables:
 * - EASYTERRITORY_BASE_URL (e.g. https://apps.easyterritory.com)
 * - EASYTERRITORY_GUID
 * - EASYTERRITORY_INSTANCE_TYPE (default: APP)
 * - EASYTERRITORY_USERNAME
 * - EASYTERRITORY_PASSWORD
 * - EASYTERRITORY_PROJECT_ID
 * - RENOLUTION_EASYTERRITORY_PROJECT_ID (optional, for Renolution fallback)
 */
import https from 'https';

let token = null;
let tokenFetchedAt = 0;
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getConfig(projectIdOverride = null) {
  const baseUrl = process.env.EASYTERRITORY_BASE_URL;
  const guid = process.env.EASYTERRITORY_GUID;
  const instanceType = process.env.EASYTERRITORY_INSTANCE_TYPE || 'APP';
  const username = process.env.EASYTERRITORY_USERNAME;
  const password = process.env.EASYTERRITORY_PASSWORD;
  const projectId = projectIdOverride || process.env.EASYTERRITORY_PROJECT_ID;

  if (!baseUrl || !guid || !username || !password || !projectId) {
    throw new Error(
      'Missing EasyTerritory env vars. Required: EASYTERRITORY_BASE_URL, EASYTERRITORY_GUID, EASYTERRITORY_USERNAME, EASYTERRITORY_PASSWORD, EASYTERRITORY_PROJECT_ID'
    );
  }

  const restBase = `${baseUrl.replace(/\/$/, '')}/${guid}/${instanceType}/REST`;
  return { restBase, username, password, projectId };
}

/**
 * HTTPS request helper — forces port 443, follows redirects staying on HTTPS.
 */
function request(urlString, options = {}, depth = 0) {
  const url = new URL(urlString);
  const headers = {
    Accept: 'application/json',
    Host: url.hostname,
    ...options.headers,
  };

  if (token) {
    headers.Cookie = `oitoken=${token}`;
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          const result = { status: res.statusCode || 0, body: data };

          // Follow redirects, forcing HTTPS
          if (
            (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
            res.headers.location &&
            depth < 5
          ) {
            const loc = res.headers.location.replace(/^http:/, 'https:');
            const redirectUrl = loc.startsWith('https') ? loc : `https://${url.hostname}${loc}`;
            try {
              resolve(await request(redirectUrl, options, depth + 1));
            } catch (err) {
              reject(err);
            }
          } else {
            resolve(result);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`EasyTerritory request timeout: ${urlString}`));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Authenticate and store oitoken.
 */
async function login() {
  const { restBase, username, password } = getConfig();
  const url = `${restBase}/Login/Login`;
  const body = JSON.stringify({ username, password });

  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`EasyTerritory login failed (HTTP ${res.status})`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error(`EasyTerritory login: non-JSON response (HTTP ${res.status})`);
  }

  token = data.token || data.Token || data.oiToken || data.OIToken;
  tokenFetchedAt = Date.now();

  if (!token) {
    throw new Error('EasyTerritory login: no token in response');
  }

  return token;
}

/**
 * Authenticated GET request with auto-retry on 401.
 */
async function authenticatedRequest(url, retried = false) {
  if (!token || Date.now() - tokenFetchedAt > TOKEN_TTL_MS) await login();

  const res = await request(url);

  if (res.status === 401 && !retried) {
    await login();
    return authenticatedRequest(url, true);
  }

  return res;
}

/**
 * Look up the calendar URL for a given ZIP code.
 *
 * Calls the EasyTerritory territory endpoint with:
 *   ?territoryId={zip5}&omitWkt=true&omitMetadata=true
 *
 * Parses the calendar URL from the territory's `tag` field
 * (pipe-delimited: name|calendarUrl|phone|email).
 *
 * @param {string} zip - ZIP code (first 5 chars used)
 * @returns {Promise<string|null>} Calendar URL or null if not found
 */
export async function lookupCalendarUrl(zip, projectId = null) {
  const config = getConfig(projectId);
  const restBase = config.restBase;
  projectId = config.projectId;
  const zip5 = zip.replace(/\D/g, '').slice(0, 5).padStart(5, '0');

  const url = `${restBase}/ProjectMarkupPolygon/${projectId}/territory?territoryId=${zip5}&omitWkt=true&omitMetadata=true`;

  console.log(`[EasyTerritory] Looking up territory for ZIP: ${zip5}`);

  const res = await authenticatedRequest(url);

  if (res.status !== 200) {
    console.error(`[EasyTerritory] Territory lookup failed (HTTP ${res.status})`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    console.error(`[EasyTerritory] Non-JSON response (HTTP ${res.status}), body: ${res.body.slice(0, 100)}`);
    return null;
  }

  // Response may be a single object or an array
  const territory = Array.isArray(data) ? data[0] : data;

  if (!territory || !territory.tag) {
    console.warn(`[EasyTerritory] No territory found for ZIP: ${zip5}`);
    return null;
  }

  // tag is pipe-delimited; calendar URL position varies by project
  const parts = territory.tag.split('|');
  const calendarUrl = parts.map(p => p.trim()).find(p => p.startsWith('http')) || null;

  if (calendarUrl) {
    console.log(`[EasyTerritory] Found calendar URL for ZIP ${zip5}: ${calendarUrl}`);
  } else {
    console.warn(`[EasyTerritory] Territory found but no calendar URL in tag: ${territory.tag}`);
  }

  return calendarUrl;
}

/**
 * Look up the calendar URL using the Renolution EasyTerritory project.
 * Reads RENOLUTION_EASYTERRITORY_PROJECT_ID from environment.
 *
 * @param {string} zip - ZIP code
 * @returns {Promise<string|null>} Calendar URL or null if not found
 */
export async function lookupRenolutionCalendarUrl(zip) {
  const renolutionProjectId = process.env.RENOLUTION_EASYTERRITORY_PROJECT_ID;
  if (!renolutionProjectId) {
    console.warn('[EasyTerritory] RENOLUTION_EASYTERRITORY_PROJECT_ID not configured');
    return null;
  }
  return lookupCalendarUrl(zip, renolutionProjectId);
}
