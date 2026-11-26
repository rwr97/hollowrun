export const MAX_APP_ID = 0xFFFFFFFF;
export const MAX_IDLE_SESSIONS = 32;

const MAX_GAME_NAME_LENGTH = 120;
const BLOCKED_IDLE_APP_IDS = new Set([480]);

export function isPlaceholderGameName(value, appId) {
  const name = typeof value === 'string' ? value.trim() : '';
  const normalizedAppId = Number(appId);
  if (!name) return true;

  // Steam occasionally exposes an internal key such as "appid_730" in
  // local library metadata. It is not a usable title and must not take
  // precedence over appinfo.vdf or Steam Store metadata.
  return Number.isSafeInteger(normalizedAppId)
    && new RegExp(`^(?:steam[\\s_-]*)?app[\\s_-]*id[\\s_-]*${normalizedAppId}$`, 'i').test(name);
}

export function parseAppId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (typeof normalized === 'string' && !/^\d+$/.test(normalized)) return null;

  const appId = Number(normalized);
  return Number.isSafeInteger(appId) && appId > 0 && appId <= MAX_APP_ID ? appId : null;
}

export function parseIdleAppId(value) {
  const appId = parseAppId(value);
  return appId !== null && !BLOCKED_IDLE_APP_IDS.has(appId) ? appId : null;
}

export function normalizeGameName(value, appId) {
  if (typeof value !== 'string') return `AppID ${appId}`;
  const name = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, MAX_GAME_NAME_LENGTH);
  return isPlaceholderGameName(name, appId) ? `AppID ${appId}` : name;
}
