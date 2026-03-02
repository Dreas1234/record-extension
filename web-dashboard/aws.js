/**
 * web-dashboard/aws.js
 * AWS utilities for the standalone web dashboard.
 *   - SigV4 request signing via WebCrypto (GET + PUT)
 *   - Cognito Identity Pool → temporary AWS credentials
 *   - S3 ListObjectsV2 and GetObject
 *
 * No AWS SDK, no Chrome APIs. Runs in modern browsers.
 *
 * Required S3 bucket CORS (set by admin):
 *   AllowedOrigins: ["https://your-dashboard-domain.com"]
 *   AllowedMethods: ["GET", "PUT"]
 *   AllowedHeaders: ["*", "Authorization", "x-amz-*", "Content-Type"]
 *   ExposedHeaders: []
 */

import { CONFIG } from './config.js';

// ─── SigV4 utilities ──────────────────────────────────────────────────────────

const _enc = new TextEncoder();

// SHA-256 of empty string — used as payload hash for GET requests
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function _sha256hex(data) {
  const input = typeof data === 'string' ? _enc.encode(data) : data;
  const buf = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _hmac(key, data) {
  const keyBuf  = (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) ? key : _enc.encode(key);
  const dataBuf = typeof data === 'string' ? _enc.encode(data) : data;
  const k = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, dataBuf);
}

function _hexOf(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _derivedSigningKey(secretKey, dateStamp, region, service) {
  const kDate    = await _hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion  = await _hmac(kDate, region);
  const kService = await _hmac(kRegion, service);
  return _hmac(kService, 'aws4_request');
}

/**
 * Build canonical query string per SigV4 spec.
 * Sorts parameters alphabetically, URI-encodes keys and values.
 */
function _canonicalQuery(urlObj) {
  const params = [...urlObj.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k).replace(/%20/g, '+'), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return params.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Build SigV4 Authorization + date headers for an S3 request.
 *
 * @param {object} opts
 * @param {string} opts.method         HTTP verb
 * @param {string} opts.url            Full S3 URL
 * @param {object} opts.credentials    { accessKeyId, secretAccessKey, sessionToken }
 * @param {string} opts.region
 * @param {string} [opts.payloadHash]  Hex SHA-256 of body; defaults to EMPTY_HASH (for GETs)
 * @param {object} [opts.extraHeaders] Additional headers to sign
 * @returns {Promise<object>}  Headers object to merge into fetch call
 */
async function _buildS3AuthHeaders({ method, url, credentials, region, payloadHash = EMPTY_HASH, extraHeaders = {} }) {
  const now = new Date();
  const amzDate   = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const urlObj = new URL(url);
  const host   = urlObj.hostname;
  const path   = urlObj.pathname;
  const query  = _canonicalQuery(urlObj);

  const rawHeaders = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };
  const sortedKeys       = Object.keys(rawHeaders).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${rawHeaders[k]}`).join('\n') + '\n';
  const signedHeaders    = sortedKeys.join(';');

  const canonicalRequest = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign    = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await _sha256hex(canonicalRequest)].join('\n');

  const sigKey    = await _derivedSigningKey(credentials.secretAccessKey, dateStamp, region, 's3');
  const signature = _hexOf(await _hmac(sigKey, stringToSign));

  return {
    'Authorization':         `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date':            amzDate,
    'x-amz-content-sha256':  payloadHash,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    ...extraHeaders,
  };
}

// ─── Cognito Identity Pool credentials ────────────────────────────────────────

let _credCache = null;

/**
 * Exchange a Cognito IdToken for temporary AWS credentials via Identity Pool.
 * Results are cached in memory for the page session.
 *
 * @param {string} idToken  Cognito User Pool IdToken from auth.js session.
 * @returns {Promise<{ accessKeyId, secretAccessKey, sessionToken, expiry }>}
 */
export async function getAWSCredentials(idToken) {
  if (_credCache && _credCache.expiry > Date.now() + 5 * 60 * 1000) return _credCache;

  const endpoint = `https://cognito-identity.${CONFIG.AWS_REGION}.amazonaws.com/`;
  const loginKey = `cognito-idp.${CONFIG.AWS_REGION}.amazonaws.com/${CONFIG.COGNITO_USER_POOL_ID}`;
  const logins   = { [loginKey]: idToken };

  // Step 1: GetId
  const idResp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityService.GetId' },
    body: JSON.stringify({ IdentityPoolId: CONFIG.COGNITO_IDENTITY_POOL_ID, Logins: logins }),
  });
  if (!idResp.ok) {
    const err = await idResp.json().catch(() => ({}));
    throw new Error(err.message || `GetId failed (${idResp.status})`);
  }
  const { IdentityId } = await idResp.json();

  // Step 2: GetCredentialsForIdentity
  const credsResp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity' },
    body: JSON.stringify({ IdentityId, Logins: logins }),
  });
  if (!credsResp.ok) {
    const err = await credsResp.json().catch(() => ({}));
    throw new Error(err.message || `GetCredentialsForIdentity failed (${credsResp.status})`);
  }
  const { Credentials } = await credsResp.json();

  _credCache = {
    accessKeyId:     Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken:    Credentials.SessionToken,
    expiry:          new Date(Credentials.Expiration).getTime(),
  };
  return _credCache;
}

// ─── S3 operations ────────────────────────────────────────────────────────────

function s3BaseUrl() {
  return `https://${CONFIG.S3_BUCKET}.s3.${CONFIG.AWS_REGION}.amazonaws.com`;
}

/**
 * List all objects under the `transcripts/` prefix in S3.
 * Returns array of S3 object keys (strings).
 *
 * @param {object} credentials  From getAWSCredentials()
 * @returns {Promise<string[]>}
 */
export async function listTranscriptKeys(credentials) {
  const url = `${s3BaseUrl()}/?list-type=2&prefix=transcripts%2F&max-keys=1000`;
  const headers = await _buildS3AuthHeaders({ method: 'GET', url, credentials, region: CONFIG.AWS_REGION });

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`S3 ListObjects failed (${resp.status}): ${text}`);
  }

  const xml  = await resp.text();
  const doc  = new DOMParser().parseFromString(xml, 'application/xml');
  const keys = [...doc.getElementsByTagName('Contents')]
    .map(el => el.getElementsByTagName('Key')[0]?.textContent ?? '')
    .filter(k => k.endsWith('.json'));

  return keys;
}

/**
 * Fetch and parse a single transcript JSON from S3.
 *
 * @param {object} credentials  From getAWSCredentials()
 * @param {string} key          S3 object key, e.g. "transcripts/abc123.json"
 * @returns {Promise<object>}   Parsed transcript object
 */
export async function getTranscriptJson(credentials, key) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `${s3BaseUrl()}/${encodedKey}`;
  const headers = await _buildS3AuthHeaders({ method: 'GET', url, credentials, region: CONFIG.AWS_REGION });

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`S3 GetObject failed (${resp.status}) for "${key}": ${text}`);
  }
  return resp.json();
}

/**
 * Write an updated transcript object back to S3.
 * Used to persist speaker label corrections (and future edits).
 *
 * @param {object} credentials   From getAWSCredentials()
 * @param {string} recordingId   Recording ID (becomes the S3 key)
 * @param {object} data          Full transcript object to write
 * @returns {Promise<void>}
 */
export async function putTranscriptJson(credentials, recordingId, data) {
  const key        = `transcripts/${recordingId}.json`;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url        = `${s3BaseUrl()}/${encodedKey}`;
  const body       = JSON.stringify(data, null, 2);

  const headers = await _buildS3AuthHeaders({
    method:      'PUT',
    url,
    credentials,
    region:      CONFIG.AWS_REGION,
    payloadHash: 'UNSIGNED-PAYLOAD',
    extraHeaders: { 'content-type': 'application/json' },
  });

  const resp = await fetch(url, {
    method:  'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`S3 PUT failed (${resp.status}): ${text}`);
  }
}

/**
 * Fetch all transcript records, loading each JSON from S3.
 * Returns results sorted by date descending.
 *
 * @param {string} idToken  Cognito IdToken for credential exchange.
 * @returns {Promise<object[]>}
 */
export async function loadAllTranscripts(idToken) {
  const credentials = await getAWSCredentials(idToken);
  const keys        = await listTranscriptKeys(credentials);

  if (keys.length === 0) return [];

  const results = await Promise.allSettled(
    keys.map(key => getTranscriptJson(credentials, key))
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
