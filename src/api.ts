import axios from "axios";
import { authHeaders, clearTokenCache, COOKIE_FILE } from "./auth.js";

const BASE_URL = "https://tpapi.trainingpeaks.com";
export const STRENGTH_BASE_URL = "https://api.peakswaresb.com";

function isUnauthorized(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 401;
}

function handleAxiosError(err: unknown, method: string, path: string, baseUrl: string): never {
  if (axios.isAxiosError(err) && err.response) {
    if (err.response.status === 401) {
      clearTokenCache();
      throw new Error(
        `TrainingPeaks session expired (401). Write a fresh Production_tpAuth cookie to ${COOKIE_FILE}; ` +
          `the next call picks it up without restarting the server.`,
        { cause: err }
      );
    }
    const body =
      typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data);
    throw new Error(
      `HTTP ${err.response.status} from ${method.toUpperCase()} ${baseUrl}${path}: ${body}`,
      { cause: err }
    );
  }
  throw err;
}

async function request<T>(
  baseUrl: string,
  config: { method: "get" | "post" | "put" | "delete"; path: string; data?: unknown }
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = await authHeaders();
    try {
      const response = await axios.request<T>({
        method: config.method,
        url: `${baseUrl}${config.path}`,
        headers,
        data: config.data,
      });
      return response.data;
    } catch (err) {
      // A 401 can mean the cached bearer token went stale rather than that the
      // cookie is dead. Drop the cache, re-read the cookie file, try once more.
      if (isUnauthorized(err) && attempt === 0) {
        clearTokenCache();
        continue;
      }
      handleAxiosError(err, config.method, config.path, baseUrl);
    }
  }
  throw new Error("unreachable");
}

export async function api<T>(config: {
  method: "get" | "post" | "put" | "delete";
  path: string;
  data?: unknown;
}): Promise<T> {
  return request<T>(BASE_URL, config);
}

export async function strengthApi<T>(config: {
  method: "get" | "post" | "put" | "delete";
  path: string;
  data?: unknown;
}): Promise<T> {
  return request<T>(STRENGTH_BASE_URL, config);
}
