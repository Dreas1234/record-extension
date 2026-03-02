/**
 * aws/s3-uploader.js
 * Upload audio blobs and transcript JSON to AWS S3.
 *
 * Authentication: Cognito Identity Pool (federated identity).
 *   - User signs in via Cognito User Pool (Prompt A) → stores IdToken.
 *   - This module exchanges the IdToken for temporary AWS credentials via GetId
 *     + GetCredentialsForIdentity, then signs S3 PUTs with SigV4 using WebCrypto.
 *   - No AWS SDK required — works in both MV3 service worker and popup context.
 *
 * Required S3 bucket CORS configuration (set by admin):
 *   AllowedOrigins: ["chrome-extension://<extension-id>"]
 *   AllowedMethods: ["PUT"]
 *   AllowedHeaders: ["*"]
 *   ExposedHeaders: []
 */

// ─── SigV4 helpers ────────────────────────────────────────────────────────────

const _enc = new TextEncoder();

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
 * Build SigV4 Authorization + date + checksum headers for an S3 PUT.
 * Uses UNSIGNED-PAYLOAD to avoid hashing large audio files in memory.
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.url          Full S3 URL (virtual-hosted style)
 * @param {object} opts.credentials  { accessKeyId, secretAccessKey, sessionToken }
 * @param {string} opts.region
 * @param {object} [opts.extraHeaders]  Additional headers to sign (e.g. content-type, x-amz-meta-*)
 * @returns {Promise<object>}  Headers to merge into the fetch call.
 */
async function _buildS3AuthHeaders({ method, url, credentials, region, extraHeaders = {} }) {
  const now = new Date();
  // Format: "20240115T123456Z"
  const amzDate   = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);  // "20240115"
  const UNSIGNED  = 'UNSIGNED-PAYLOAD';

  const urlObj = new URL(url);
  const host   = urlObj.hostname;
  const path   = urlObj.pathname;  // Already properly encoded by URL constructor

  // Build the set of headers to sign (all keys lowercased, sorted)
  const rawHeaders = {
    host,
    'x-amz-content-sha256': UNSIGNED,
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };
  const sortedKeys = Object.keys(rawHeaders).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${rawHeaders[k]}`).join('\n') + '\n';
  const signedHeaders    = sortedKeys.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    '',  // no query string for our PUTs
    canonicalHeaders,
    signedHeaders,
    UNSIGNED,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await _sha256hex(canonicalRequest),
  ].join('\n');

  const sigKey    = await _derivedSigningKey(credentials.secretAccessKey, dateStamp, region, 's3');
  const signature = _hexOf(await _hmac(sigKey, stringToSign));

  return {
    'Authorization':         `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date':            amzDate,
    'x-amz-content-sha256':  UNSIGNED,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    ...extraHeaders,
  };
}

// ─── Cognito Identity Pool credentials ────────────────────────────────────────

/**
 * Exchange a Cognito User Pool IdToken for temporary AWS credentials via
 * Cognito Identity Pool. Credentials are cached in chrome.storage.session for
 * ~55 minutes (Cognito issues them for 1 hour).
 *
 * @returns {Promise<{ accessKeyId, secretAccessKey, sessionToken, expiry }>}
 */
export async function getAWSCredentials() {
  // Return cached credentials if still fresh (5-minute safety buffer)
  const { awsCredentials } = await chrome.storage.session.get({ awsCredentials: null });
  if (awsCredentials && awsCredentials.expiry > Date.now() + 5 * 60 * 1000) {
    return awsCredentials;
  }

  const config = await chrome.storage.local.get({
    cognitoRegion:         '',
    cognitoUserPoolId:     '',
    cognitoIdentityPoolId: '',
    cognitoIdToken:        null,
  });

  if (!config.cognitoRegion || !config.cognitoUserPoolId || !config.cognitoIdentityPoolId) {
    throw new Error('AWS not configured. Set Cognito Region, User Pool ID, and Identity Pool ID in Settings.');
  }
  if (!config.cognitoIdToken) {
    throw new Error('Not signed in. Please log in before uploading.');
  }

  const endpoint = `https://cognito-identity.${config.cognitoRegion}.amazonaws.com/`;
  const loginKey = `cognito-idp.${config.cognitoRegion}.amazonaws.com/${config.cognitoUserPoolId}`;
  const logins   = { [loginKey]: config.cognitoIdToken };

  // Step 1: GetId — resolve federated identity ID for this user
  const idResp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityService.GetId',
    },
    body: JSON.stringify({ IdentityPoolId: config.cognitoIdentityPoolId, Logins: logins }),
  });
  if (!idResp.ok) {
    const err = await idResp.json().catch(() => ({}));
    throw new Error(err.message || `GetId failed (${idResp.status})`);
  }
  const { IdentityId } = await idResp.json();

  // Step 2: GetCredentialsForIdentity — get temporary STS credentials
  const credsResp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
    },
    body: JSON.stringify({ IdentityId, Logins: logins }),
  });
  if (!credsResp.ok) {
    const err = await credsResp.json().catch(() => ({}));
    throw new Error(err.message || `GetCredentialsForIdentity failed (${credsResp.status})`);
  }
  const { Credentials } = await credsResp.json();

  const creds = {
    accessKeyId:     Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,      // Note: Cognito returns "SecretKey" not "SecretAccessKey"
    sessionToken:    Credentials.SessionToken,
    expiry:          new Date(Credentials.Expiration).getTime(),
  };

  await chrome.storage.session.set({ awsCredentials: creds });
  return creds;
}

// ─── S3 PUT (single object) ───────────────────────────────────────────────────

/**
 * PUT a single object to S3 using SigV4 auth.
 *
 * @param {object} opts
 * @param {string}      opts.region
 * @param {string}      opts.bucket
 * @param {string}      opts.key           S3 object key (path)
 * @param {ArrayBuffer|Uint8Array} opts.body
 * @param {string}      opts.contentType
 * @param {object}      [opts.metadata]    Plain string key-value pairs → x-amz-meta-* headers
 * @returns {Promise<string>}  Public-style S3 URL (not necessarily public — depends on bucket policy)
 */
async function putS3Object({ region, bucket, key, body, contentType, metadata = {} }) {
  const credentials = await getAWSCredentials();

  // Encode each path segment; join with / (do not encode the slashes)
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  // Sanitize metadata: S3 metadata values must be US-ASCII printable
  const metaHeaders = Object.fromEntries(
    Object.entries(metadata)
      .map(([k, v]) => [`x-amz-meta-${k.toLowerCase().replace(/[^a-z0-9-]/g, '')}`,
                        String(v).replace(/[^\x20-\x7E]/g, '').slice(0, 256)])
  );

  const authHeaders = await _buildS3AuthHeaders({
    method: 'PUT',
    url,
    credentials,
    region,
    extraHeaders: { 'content-type': contentType, ...metaHeaders },
  });

  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, ...metaHeaders, ...authHeaders },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`S3 PUT failed (${resp.status}) for key "${key}": ${text}`);
  }

  return url;
}

// ─── Public upload entry point ────────────────────────────────────────────────

/**
 * Upload a recording's audio blob and transcript JSON to S3.
 *
 * S3 layout:
 *   recordings/{userId}/{recordingId}.webm   — audio blob
 *   transcripts/{recordingId}.json           — metadata + segments
 *
 * @param {object} recording  Full recording object from IndexedDB (must include .blob).
 * @param {string} userId     Cognito username of the uploader.
 * @returns {Promise<{ audioUrl: string, transcriptUrl: string }>}
 */
export async function uploadRecordingToS3(recording, userId) {
  const { s3Bucket, cognitoRegion } = await chrome.storage.local.get({
    s3Bucket:      '',
    cognitoRegion: '',
  });

  if (!s3Bucket || !cognitoRegion) {
    throw new Error('S3 Bucket Name and AWS Region must be configured in Settings.');
  }

  const ext        = recording.mimeType?.includes('webm') ? 'webm' : 'mp4';
  const audioKey   = `recordings/${userId}/${recording.id}.${ext}`;
  const transcriptKey = `transcripts/${recording.id}.json`;

  const metadata = {
    userid:   userId,
    label:    (recording.label || recording.title || '').slice(0, 200),
    date:     new Date(recording.startTime).toISOString(),
    duration: String(Math.round((recording.duration ?? 0) / 1000)),
    platform: recording.platform ?? '',
  };

  // 1. Upload audio
  const audioBuffer = await recording.blob.arrayBuffer();
  const audioUrl = await putS3Object({
    region:      cognitoRegion,
    bucket:      s3Bucket,
    key:         audioKey,
    body:        audioBuffer,
    contentType: recording.mimeType || 'video/webm',
    metadata,
  });

  // 2. Upload transcript JSON
  const transcriptJson = JSON.stringify({
    recordingId:  recording.id,
    userId,
    uploadedBy:   userId,
    uploadedAt:   new Date().toISOString(),
    label:        recording.label || recording.title || '',
    meetingTitle: recording.meetingTitle ?? '',
    date:         new Date(recording.startTime).toISOString(),
    duration:     recording.duration ?? 0,
    platform:     recording.platform ?? '',
    segments:     recording.segments ?? [],
    transcript:   recording.transcript ?? '',
  }, null, 2);

  const transcriptUrl = await putS3Object({
    region:      cognitoRegion,
    bucket:      s3Bucket,
    key:         transcriptKey,
    body:        _enc.encode(transcriptJson),
    contentType: 'application/json',
    metadata:    { userid: userId, recordingid: recording.id },
  });

  return { audioUrl, transcriptUrl };
}
