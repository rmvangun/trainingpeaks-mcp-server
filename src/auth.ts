import fs from "fs";
import os from "os";
import path from "path";
import axios from "axios";

export interface TokenResponse {
  success: boolean;
  token: {
    access_token: string;
    expires_in: number;
  };
  athleteId: number;
  userId: number;
  username: string;
}

export interface UserProfile {
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
  settings: {
    account: {
      isPremium: boolean;
    };
  };
}

const BASE_URL = "https://tpapi.trainingpeaks.com";

/**
 * Where the session cookie lives on disk.
 *
 * A file rather than an environment variable, so the cookie can be replaced
 * while the server is running: the next call re-reads it. An env-var-only
 * cookie means every expiry needs an MCP config edit and a restart of the
 * host app, which is fatal for unattended scheduled runs.
 */
export const COOKIE_FILE =
  process.env.TP_COOKIE_FILE ??
  path.join(os.homedir(), ".config", "trainingpeaks-mcp", "cookie");

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let cachedAthleteId: number | null = null;

export function clearTokenCache(): void {
  cachedToken = null;
  cachedAthleteId = null;
}

function readCookieFile(): string | null {
  try {
    const raw = fs.readFileSync(COOKIE_FILE, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * File wins over the environment variable, so refreshing the file is enough
 * even when a stale value is still exported in the host process.
 */
function getAuthCookie(): string {
  const fromFile = readCookieFile();
  if (fromFile) return fromFile;

  const fromEnv = process.env.TP_AUTH_COOKIE?.trim();
  if (fromEnv) return fromEnv;

  throw new Error(
    `No TrainingPeaks session cookie found. Write the Production_tpAuth cookie value to ${COOKIE_FILE} ` +
      `(or set TP_AUTH_COOKIE). Get it from DevTools > Application > Cookies on trainingpeaks.com while logged in.`
  );
}

export async function getToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  const cookie = getAuthCookie();

  const response = await axios.get<TokenResponse>(`${BASE_URL}/users/v3/token`, {
    headers: {
      Cookie: `Production_tpAuth=${cookie}`,
    },
  });

  if (!response.data.success) {
    throw new Error(
      `Failed to exchange cookie for Bearer token — it is probably expired. Replace the value in ${COOKIE_FILE}.`
    );
  }

  cachedToken = {
    value: response.data.token.access_token,
    expiresAt: Date.now() + response.data.token.expires_in * 1000,
  };

  return cachedToken.value;
}

export async function getAthleteId(): Promise<number> {
  if (cachedAthleteId !== null) {
    return cachedAthleteId;
  }

  const token = await getToken();
  const response = await axios.get<{ user: UserProfile }>(`${BASE_URL}/users/v3/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  cachedAthleteId = response.data.user.userId;
  return cachedAthleteId;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}
