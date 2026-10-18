// Checks the cookie file without printing the cookie or the bearer token.
import fs from "fs";
import path from "path";

const file =
  process.env.TP_COOKIE_FILE ?? path.join(import.meta.dirname, "..", ".cookie");

let cookie;
try {
  cookie = fs.readFileSync(file, "utf8").trim();
} catch {
  console.error(`No cookie file at ${file}. Run scripts/set-cookie.sh first.`);
  process.exit(1);
}
if (!cookie) {
  console.error(`${file} is empty.`);
  process.exit(1);
}

const tokenRes = await fetch("https://tpapi.trainingpeaks.com/users/v3/token", {
  headers: { Cookie: `Production_tpAuth=${cookie}` },
});
if (!tokenRes.ok) {
  console.error(`Token exchange failed: HTTP ${tokenRes.status}. The cookie is probably expired.`);
  process.exit(1);
}
const tokenBody = await tokenRes.json();
if (!tokenBody.success) {
  console.error("Token exchange returned success: false. The cookie is probably expired.");
  process.exit(1);
}

const token = tokenBody.token.access_token;
const expiresMin = Math.round(tokenBody.token.expires_in / 60);

const userRes = await fetch("https://tpapi.trainingpeaks.com/users/v3/user", {
  headers: { Authorization: `Bearer ${token}` },
});
const user = userRes.ok ? (await userRes.json()).user : null;

console.log("Cookie works.");
console.log(`  cookie file:  ${file} (${cookie.length} chars)`);
console.log(`  token ttl:    ${expiresMin} min (refreshed automatically)`);
if (user) {
  console.log(`  athlete id:   ${user.userId}`);
  console.log(`  account:      ${user.firstName} ${user.lastName}`);
  console.log(`  premium:      ${user.settings?.account?.isPremium === true}`);
}
