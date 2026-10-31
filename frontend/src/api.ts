import { demoGet, demoPost, demoPut } from "./demo";

/** Static GitHub Pages build: reads come from recorded responses, writes stay in memory (see demo.ts). */
export const DEMO = import.meta.env.VITE_DEMO === "1";

const TOKEN_KEY = "adproof.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the token lives only for this tab */
  }
}

/** Errors keep the server's structured detail (e.g. which findings block an approval). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

function headers(extra?: HeadersInit): HeadersInit {
  const token = getToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

async function parse<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = `请求失败（${res.status}）`;
  let detail: unknown;
  try {
    const body = await res.json();
    detail = body.detail;
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) message = body.detail.map((d: { msg: string }) => d.msg).join("；");
    else if (body.detail && typeof body.detail.message === "string") message = body.detail.message;
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event("adproof:logout"));
  }
  throw new ApiError(res.status, message, detail);
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: headers({ "Content-Type": "application/json" }),
  body: JSON.stringify(body ?? {}),
});

export const api = {
  get: <T,>(path: string) => (DEMO ? demoGet<T>(path) : fetch(path, { headers: headers() }).then((r) => parse<T>(r))),
  post: <T,>(path: string, body?: unknown) => (DEMO ? demoPost<T>(path, body) : fetch(path, json("POST", body)).then((r) => parse<T>(r))),
  put: <T,>(path: string, body: unknown) => (DEMO ? demoPut<T>(path) : fetch(path, json("PUT", body)).then((r) => parse<T>(r))),
};
