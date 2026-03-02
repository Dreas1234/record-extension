/**
 * auth/cognito-client.js
 * AWS Cognito USER_PASSWORD_AUTH flow via direct REST calls.
 * No SDK required — works inside a Chrome extension service worker and popup.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function cognitoRequest(region, clientId, target, params) {
  const resp = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AmazonCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify({ ...params, ClientId: clientId }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(body.message || body.__type || `Cognito error ${resp.status}`);
  }
  return body;
}

function decodeJwtPayload(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

function extractUserInfo(idToken, email) {
  const p = decodeJwtPayload(idToken);
  const displayName = p.name || p.given_name || p['cognito:username'] || p.email || email;
  const username    = p['cognito:username'] || p.sub || email;
  return { displayName, username };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getAuthConfig() {
  return chrome.storage.local.get({ cognitoRegion: '', cognitoClientId: '' });
}

// ─── Sign in ──────────────────────────────────────────────────────────────────

export async function signIn(email, password) {
  const { cognitoRegion, cognitoClientId } = await getAuthConfig();
  if (!cognitoRegion || !cognitoClientId) {
    throw new Error('Cognito not configured. Set Region and Client ID in Settings.');
  }

  const data = await cognitoRequest(cognitoRegion, cognitoClientId, 'InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });

  const { IdToken, AccessToken, RefreshToken, ExpiresIn } = data.AuthenticationResult;
  const { displayName, username } = extractUserInfo(IdToken, email);
  const expiry = Date.now() + ExpiresIn * 1000;

  await chrome.storage.local.set({
    cognitoIdToken:      IdToken,
    cognitoAccessToken:  AccessToken,
    cognitoRefreshToken: RefreshToken,
    cognitoExpiry:       expiry,
    cognitoUsername:     username,
    cognitoDisplayName:  displayName,
  });

  return { username, displayName };
}

// ─── Sign out ─────────────────────────────────────────────────────────────────

export async function signOut() {
  await chrome.storage.local.remove([
    'cognitoIdToken',
    'cognitoAccessToken',
    'cognitoRefreshToken',
    'cognitoExpiry',
    'cognitoUsername',
    'cognitoDisplayName',
  ]);
}

// ─── Get current session ──────────────────────────────────────────────────────

/**
 * Returns session object if logged in and token is valid, otherwise null.
 * Automatically refreshes an expired token if a refresh token exists.
 */
export async function getSession() {
  const stored = await chrome.storage.local.get({
    cognitoIdToken:      null,
    cognitoAccessToken:  null,
    cognitoRefreshToken: null,
    cognitoExpiry:       0,
    cognitoUsername:     null,
    cognitoDisplayName:  null,
  });

  if (!stored.cognitoIdToken) return null;

  // Token still valid (5-minute safety buffer)
  if (stored.cognitoExpiry > Date.now() + 5 * 60 * 1000) {
    return {
      idToken:     stored.cognitoIdToken,
      accessToken: stored.cognitoAccessToken,
      username:    stored.cognitoUsername,
      displayName: stored.cognitoDisplayName,
    };
  }

  // Try refreshing
  if (stored.cognitoRefreshToken) {
    try {
      return await _refreshSession(stored.cognitoRefreshToken);
    } catch {
      // Refresh failed — treat as logged out
    }
  }

  await signOut();
  return null;
}

// ─── Refresh (internal) ───────────────────────────────────────────────────────

async function _refreshSession(refreshToken) {
  const { cognitoRegion, cognitoClientId } = await getAuthConfig();

  const data = await cognitoRequest(cognitoRegion, cognitoClientId, 'InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });

  const { IdToken, AccessToken, ExpiresIn } = data.AuthenticationResult;
  const { displayName, username } = extractUserInfo(IdToken, '');
  const expiry = Date.now() + ExpiresIn * 1000;

  await chrome.storage.local.set({
    cognitoIdToken:     IdToken,
    cognitoAccessToken: AccessToken,
    cognitoExpiry:      expiry,
    cognitoUsername:    username,
    cognitoDisplayName: displayName,
  });

  return { idToken: IdToken, accessToken: AccessToken, username, displayName };
}
