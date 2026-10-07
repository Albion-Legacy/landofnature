/**
 * Avisa a Albion Assistant (que lo reenvía por WhatsApp según las preferencias del dueño).
 * No lanza nunca. `ref` evita duplicados: el mismo (event, ref) no se vuelve a avisar.
 */
export async function avisarAlbion(a: {
  kind: "order" | "stock" | "alert";
  event: string;
  ref: string;
  text: string;
  severity?: "info" | "warning" | "critical";
}): Promise<boolean> {
  const token = (process.env.ALBION_CONNECT_TOKEN ?? "").trim();
  if (!token) return false;
  const base = (process.env.ALBION_PANEL_URL ?? "https://app.albionassistant.com").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/api/apps/notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: a.kind, event: a.event, ref: a.ref, text: a.text, severity: a.severity ?? "info" }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch (e) {
    console.error("[albion] aviso no enviado", a.event, a.ref, e);
    return false;
  }
}
