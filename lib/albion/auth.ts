import { timingSafeEqual } from "crypto";

/**
 * Albion Connect (secreto compartido, solo propietarios).
 * Albion Assistant llama a /api/albion/* con `Authorization: Bearer <ALBION_CONNECT_TOKEN>`.
 * Si la variable no existe, todo queda cerrado.
 */
export function albionAuthorized(req: Request): boolean {
  const expected = (process.env.ALBION_CONNECT_TOKEN ?? "").trim();
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
