// Server-side client for the engine's internal API.
import "server-only";

const url = process.env.ENGINE_PUBLIC_URL ?? "http://localhost:4000";
const key = process.env.ENGINE_INTERNAL_KEY ?? "";

export async function engine<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${url}/internal${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-engine-key": key, ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`engine ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
