// Field Twin Violet API v1
// BLUE PHONE: archive copy of every photo in Dropbox, using a long lived refresh token.
const KEY = process.env.DROPBOX_APP_KEY;
const SECRET = process.env.DROPBOX_APP_SECRET;
const REFRESH = process.env.DROPBOX_REFRESH_TOKEN;
const ROOT = (process.env.DROPBOX_ROOT || "/Field Twin Violet").replace(/\/+$/, "");

let token = null;
let expiresAt = 0;

export function dropboxReady() {
  return Boolean(KEY && SECRET && REFRESH);
}

async function accessToken() {
  if (token && Date.now() < expiresAt - 60000) return token;
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: KEY, client_secret: SECRET }),
  });
  if (!r.ok) throw new Error(`dropbox token refresh failed with ${r.status}`);
  const j = await r.json();
  token = j.access_token;
  expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return token;
}

export async function archivePhoto(path, buffer) {
  const t = await accessToken();
  const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: `${ROOT}/${path}`, mode: "overwrite", mute: true }),
    },
    body: buffer,
  });
  if (!r.ok) throw new Error(`dropbox upload failed with ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
