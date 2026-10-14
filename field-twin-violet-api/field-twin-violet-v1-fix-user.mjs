// Field Twin Violet v1
// Sets a known password on a Supabase user and marks the email confirmed, creating the user if missing.
// Usage: node field-twin-violet-v1-fix-user.mjs keys.json email password
import fs from "node:fs";

const [keysFile, email, password] = process.argv.slice(2);
const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
fs.unlinkSync(keysFile);
const k = keys.find((x) => x.name === "service_role" && x.api_key) || keys.find((x) => x.type === "secret" && x.api_key);
if (!k) throw new Error("no service key in the key list");
const key = k.api_key;
const base = "https://zasyjjoypkpvyqdueums.supabase.co/auth/v1/admin";
const headers = { apikey: key, "Content-Type": "application/json" };
if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;

async function call(path, method = "GET", body) {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} answered ${r.status} ${JSON.stringify(j)}`);
  return j;
}

let user = null;
for (let page = 1; !user; page++) {
  const j = await call(`/users?page=${page}&per_page=200`);
  const list = j.users || [];
  user = list.find((u) => String(u.email || "").toLowerCase() === email.toLowerCase()) || null;
  if (list.length < 200) break;
}
if (user) {
  await call(`/users/${user.id}`, "PUT", { password, email_confirm: true });
  console.log(`Account ${email} now has the new password and is confirmed.`);
} else {
  await call("/users", "POST", { email, password, email_confirm: true });
  console.log(`Account ${email} created with the new password and confirmed.`);
}
