/**
 * utils/platform-detector.js
 * Platform detection by URL and DOM signals.
 */

export const PLATFORMS = Object.freeze({
  GOOGLE_MEET: 'google_meet',
  ZOOM: 'zoom',
  TEAMS: 'teams',
  UNKNOWN: null,
});

const URL_PATTERNS = [
  { pattern: /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/, platform: PLATFORMS.GOOGLE_MEET },
  { pattern: /^https:\/\/[\w-]+\.zoom\.us\/(wc|j)\/\d+/, platform: PLATFORMS.ZOOM },
  { pattern: /^https:\/\/teams\.(microsoft|live)\.com\//, platform: PLATFORMS.TEAMS },
];

/**
 * Detect platform from a URL string.
 * @param {string} url
 * @returns {string|null}
 */
export function detectPlatformFromUrl(url) {
  if (!url) return PLATFORMS.UNKNOWN;
  for (const { pattern, platform } of URL_PATTERNS) {
    if (pattern.test(url)) return platform;
  }
  return PLATFORMS.UNKNOWN;
}

/**
 * Detect platform from the current page's DOM (called from content scripts).
 * @returns {string|null}
 */
export function detectPlatformFromDom() {
  const url = window.location.href;
  const fromUrl = detectPlatformFromUrl(url);
  if (fromUrl) return fromUrl;

  // Fallback DOM fingerprinting
  if (document.querySelector('[data-meetingid], [data-call-id]')) return PLATFORMS.TEAMS;
  if (document.querySelector('#webclient, .meeting-client-inner')) return PLATFORMS.ZOOM;
  if (document.querySelector('[data-meeting-code]')) return PLATFORMS.GOOGLE_MEET;

  return PLATFORMS.UNKNOWN;
}

/**
 * Human-readable platform name.
 * @param {string|null} platform
 * @returns {string}
 */
export function getPlatformLabel(platform) {
  const labels = {
    [PLATFORMS.GOOGLE_MEET]: 'Google Meet',
    [PLATFORMS.ZOOM]: 'Zoom',
    [PLATFORMS.TEAMS]: 'Microsoft Teams',
  };
  return labels[platform] ?? 'Unknown Platform';
}
