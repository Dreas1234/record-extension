/**
 * web-dashboard/auth.js
 * Cognito USER_PASSWORD_AUTH flow for the standalone web dashboard.
 * Uses localStorage (no Chrome extension APIs).
 */

import { CONFIG } from './config.js';

const SESSION_KEY = 'mr_session';

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function cognitoPost(target, body) {
  const resp = await fetch(`https://cognito-idp.${CONFIG.AWS_REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AmazonCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify({ ...body, ClientId: CONFIG.COGNITO_CLIENT_ID }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.message || data.__type || `Auth error ${resp.status}`);
  return data;
}

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

function sessionFromResult(result, email, existing = {}) {
  const { IdToken, AccessToken, RefreshToken, ExpiresIn } = result;
  const p = decodeJwt(IdToken);
  return {
    idToken:      IdToken,
    accessToken:  AccessToken,
    refreshToken: RefreshToken ?? existing.refreshToken ?? null,
    expiry:       Date.now() + ExpiresIn * 1000,
    username:     p['cognito:username'] || p.sub || email || existing.username || '',
    displayName:  p.name || p.given_name || p['cognito:username'] || p.email || email || existing.displayName || '',
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function signIn(email, password) {
  const data = await cognitoPost('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const session = sessionFromResult(data.AuthenticationResult, email);
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Returns the active session, auto-refreshing if the token is close to expiry.
 * Returns null if the user is not logged in or the session cannot be refreshed.
 */
export async function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  let session;
  try { session = JSON.parse(raw); } catch { return null; }
  if (!session?.idToken) return null;

  // Still fresh (5-minute buffer)
  if (session.expiry > Date.now() + 5 * 60 * 1000) return session;

  // Attempt token refresh
  if (session.refreshToken) {
    try {
      const data = await cognitoPost('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: { REFRESH_TOKEN: session.refreshToken },
      });
      const refreshed = sessionFromResult(data.AuthenticationResult, session.username, session);
      localStorage.setItem(SESSION_KEY, JSON.stringify(refreshed));
      return refreshed;
    } catch {
      // Refresh failed — fall through to signOut
    }
  }

  signOut();
  return null;
}

/** Redirect to index.html if not logged in. Call at the top of protected pages. */
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    location.href = 'index.html';
    return null;
  }
  return session;
}
