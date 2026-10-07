import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { avisarAlbion } from "@/lib/albion/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/albion-alertas — vigilante de Land of Nature (cada 5 min, Vercel Cron).
 * Sin estado propio: el receptor (Albion Assistant) descarta los avisos repetidos por `ref`.
 *  - Pedidos, solicitudes de cuenta y mensajes: lo creado/cobrado en los últimos 30 min.
 *  - Stock: un aviso cada vez que cambia el conjunto de productos agotados / con stock bajo.
 *  - Una sola vez: resumen del estado actual (pendientes acumulados).
 * Sin CRON_SECRET no se ejecuta nada (no falla abierto).
 */
const corto = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const eur = (v: unknown) => `${Math.round(Number(v ?? 0) * 100) / 100} €`;

export async function GET(req: Request) {
  const secreto = (process.env.CRON_SECRET ?? "").trim();
  if (!secreto) return NextResponse.json({ error: "CRON_SECRET sin configurar" }, { status: 503 });
  if (!same(req.headers.get("authorization") ?? "", `Bearer ${secreto}`)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return NextResponse.json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY" }, { status: 503 });

  const s = createClient(SUPABASE_URL, key, { auth: { persistSession: false }, global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) } });
  const desde = new Date(Date.now() - 30 * 60_000).toISOString();
  let enviados = 0;
  const ok = async (p: Promise<boolean>) => { if (await p) enviados++; };

  // Pedidos (transferencia/domiciliación al crearse; tarjeta al cobrarse).
  const { data: ords } = await s.from("orders")
    .select("order_no, name, email, type, status, payment_method, total, created_at, paid_at")
    .or(`created_at.gte.${desde},paid_at.gte.${desde}`).limit(50);
  for (const o of ords ?? []) {
    const cliente = o.name || o.email;
    if (o.status !== "cancelled" && (o.payment_method !== "card" || o.paid_at)) {
      await ok(avisarAlbion({ kind: "order", event: "pedido_nuevo", ref: `pedido:${o.order_no}:nuevo`,
        text: `Pedido nuevo #${o.order_no} · ${eur(o.total)} · ${cliente} (${o.type}) · pago: ${o.payment_method}${o.paid_at ? " · COBRADO" : ""}` }));
    }
  }

  // Solicitudes de cuenta profesional ya confirmadas por correo.
  const { data: accs } = await s.from("account_requests")
    .select("id, company, contact_name, business_type, email").eq("status", "pending").gte("created_at", desde).limit(30);
  for (const a of accs ?? []) {
    await ok(avisarAlbion({ kind: "alert", event: "solicitud_cuenta", ref: `cuenta:${a.id}`,
      text: `Nueva solicitud de cuenta profesional: ${a.company || "—"} (${a.contact_name || "—"}, ${a.business_type || "—"}) · ${a.email}` }));
  }

  // Mensajes del formulario de contacto.
  const { data: msgs } = await s.from("contact_messages")
    .select("id, name, email, subject, message").eq("status", "new").gte("created_at", desde).limit(30);
  for (const m of msgs ?? []) {
    await ok(avisarAlbion({ kind: "alert", event: "mensaje_contacto", ref: `msg:${m.id}`,
      text: `Mensaje nuevo de ${m.name || "—"} (${m.email})${m.subject ? ` · ${m.subject}` : ""}: ${String(m.message).slice(0, 220)}` }));
  }

  // Stock: aviso cuando cambia el conjunto de agotados / bajos.
  const { data: prods } = await s.from("products").select("name, size, stock, low_stock_threshold").eq("active", true).eq("archived", false).limit(5000);
  const agot = (prods ?? []).filter((p) => Number(p.stock ?? 0) <= 0);
  const bajo = (prods ?? []).filter((p) => Number(p.stock ?? 0) > 0 && Number(p.stock) <= Number(p.low_stock_threshold ?? 0));
  const lista = (l: typeof agot, conStock: boolean) => l.slice(0, 12).map((p) => `${p.name}${p.size ? ` (${p.size})` : ""}${conStock ? ` [${p.stock}]` : ""}`).join("; ") + (l.length > 12 ? `… y ${l.length - 12} más` : "");
  if (agot.length) await ok(avisarAlbion({ kind: "stock", event: "stock_agotado", severity: "critical",
    ref: `agotado:${corto(agot.map((p) => `${p.name}|${p.size}`).sort().join("#"))}`, text: `${agot.length} producto(s) AGOTADO(S): ${lista(agot, false)}` }));
  if (bajo.length) await ok(avisarAlbion({ kind: "stock", event: "stock_bajo", severity: "warning",
    ref: `bajo:${corto(bajo.map((p) => `${p.name}|${p.size}`).sort().join("#"))}`, text: `Stock bajo en ${bajo.length} producto(s): ${lista(bajo, true)}` }));

  // Una sola vez: lo que ya estaba pendiente cuando se activó el enlace.
  const [{ count: nAcc }, { count: nMsg }] = await Promise.all([
    s.from("account_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    s.from("contact_messages").select("id", { count: "exact", head: true }).eq("status", "new"),
  ]);
  await ok(avisarAlbion({ kind: "alert", event: "resumen_inicial", ref: "resumen-inicial",
    text: `Conectada. Pendientes acumulados: ${nAcc ?? 0} solicitud(es) de cuenta profesional y ${nMsg ?? 0} mensaje(s) de contacto sin atender. Pídeme "solicitudes de cuenta" o "mensajes" cuando quieras verlos.` }));

  return NextResponse.json({ ok: true, avisos_enviados: enviados });
}
