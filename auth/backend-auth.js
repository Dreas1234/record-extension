/**
 * auth/backend-auth.js
 * Authentication via the backend API — replaces direct Cognito calls.
 *
 * Backend contract:
 *   POST [apiBaseUrl]/auth/token
 *   Request:  { username, password }
 *   Response: { token, expiresAt, userId, displayName }
 */

// ─── Storage keys (auth session) ─────────────────────────────────────────────

const AUTH_KEYS = ['token', 'expiresAt', 'userId', 'displayName'];

// ─── signIn ──────────────────────────────────────────────────────────────────

/**
 * Authenticate against the backend API.
 * Stores session in chrome.storage.local on success.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ token, expiresAt, userId, displayName }>}
 * @throws {Error} NOT_CONFIGURED | INVALID_CREDENTIALS | NETWORK_ERROR
 */
export async function signIn(username, password) {
  const { apiBaseUrl } = await chrome.storage.local.get({ apiBaseUrl: '' });

  if (!apiBaseUrl) {
    throw new Error('NOT_CONFIGURED');
  }

  let resp;
  try {
    resp = await fetch(`${apiBaseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (resp.status === 401) {
    throw new Error('INVALID_CREDENTIALS');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Auth failed (${resp.status})`);
  }

  const data = await resp.json();
  const { token, expiresAt, userId, displayName } = data;

  await chrome.storage.local.set({ token, expiresAt, userId, displayName, apiBaseUrl });

  return { token, expiresAt, userId, displayName };
}

// ─── signOut ─────────────────────────────────────────────────────────────────

/**
 * Clear auth session. Keeps apiBaseUrl and assemblyAiApiKey (config survives logout).
 */
export async function signOut() {
  await chrome.storage.local.remove(AUTH_KEYS);
}

// ─── getSession ──────────────────────────────────────────────────────────────

/**
 * Returns the current session if a valid (non-expired) token is stored.
 *
 * @returns {Promise<{ token, expiresAt, displayName, userId, apiBaseUrl } | null>}
 */
export async function getSession() {
  const stored = await chrome.storage.local.get({
    token:       null,
    expiresAt:   null,
    displayName: null,
    userId:      null,
    apiBaseUrl:  '',
  });

  if (!stored.token || !stored.expiresAt || stored.expiresAt < Date.now()) {
    return null;
  }

  return {
    token:       stored.token,
    expiresAt:   stored.expiresAt,
    displayName: stored.displayName,
    userId:      stored.userId,
    apiBaseUrl:  stored.apiBaseUrl,
  };
}

// ─── getAuthConfig ───────────────────────────────────────────────────────────

/**
 * Returns backend + transcription config, or null if apiBaseUrl is not set.
 *
 * @returns {Promise<{ apiBaseUrl, assemblyAiKey } | null>}
 */
export async function getAuthConfig() {
  const stored = await chrome.storage.local.get({
    apiBaseUrl:      '',
    assemblyAiApiKey: '',
  });

  if (!stored.apiBaseUrl) {
    return null;
  }

  return {
    apiBaseUrl:   stored.apiBaseUrl,
    assemblyAiKey: stored.assemblyAiApiKey,
  };
}
