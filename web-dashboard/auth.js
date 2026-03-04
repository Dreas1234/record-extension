/**
 * web-dashboard/auth.js
 * Authentication via backend API. Session stored in sessionStorage.
 */

import CONFIG from './config.js';

const SESSION_KEY = 'meetrecord_session';

/**
 * Authenticate against the backend API.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ token, expiresAt, userId, displayName }>}
 */
export async function signIn(username, password) {
  let resp;
  try {
    resp = await fetch(`${CONFIG.apiBaseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }

  if (resp.status === 401) {
    throw new Error('Invalid email or password.');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Sign-in failed (${resp.status})`);
  }

  const data = await resp.json();
  const session = {
    token: data.token,
    expiresAt: data.expiresAt,
    userId: data.userId,
    displayName: data.displayName,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/** Clear session. */
export function signOut() {
  sessionStorage.removeItem(SESSION_KEY);
}

/**
 * Return the current session if valid, or null.
 * Async so callers can use .then() or await uniformly.
 */
export async function getSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    if (!session.token || !session.expiresAt || session.expiresAt < Date.now()) {
      signOut();
      return null;
    }
    return session;
  } catch {
    signOut();
    return null;
  }
}

/**
 * Auth guard — returns session or redirects to login.
 */
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    location.href = 'index.html';
    return null;
  }
  return session;
}

/**
 * Authenticated fetch wrapper. Adds Bearer token and handles 401/403.
 * @param {string} path  API path (e.g. '/recordings/list')
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const session = await getSession();
  if (!session) {
    signOut();
    location.href = 'index.html';
    throw new Error('Not authenticated');
  }

  const resp = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.token}`,
      ...options.headers,
    },
  });

  if (resp.status === 401 || resp.status === 403) {
    signOut();
    location.href = 'index.html';
    throw new Error('Session expired');
  }

  return resp;
}
