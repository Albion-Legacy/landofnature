import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "@/lib/supabase/config";

/**
 * Acciones de Albion Assistant sobre Land of Nature (solo lectura).
 * Siempre tras `albionAuthorized`. Cliente de servicio SIN caché de Next.
 */
type Params = Record<string, unknown>;

export const MANIFEST = [
  { name: "resumen", mode: "read", description: "Panorama: pedidos por estado y facturado del periodo, solicitudes de cuenta pendientes, mensajes sin atender y stock agotado/bajo.", params: { periodo: "hoy | ayer | semana | mes | año | YYYY-MM-DD..YYYY-MM-DD (por defecto mes)" } },
  { name: "pedidos_recientes", mode: "read", description: "Últimos pedidos con cliente, importe, pago y estado.", params: { limite: "máx. 30 (por defecto 10)", estado: "pending_payment | paid | confirmed | preparing | processing | shipped | cancelled" } },
  { name: "pedido", mode: "read", description: "Detalle de un pedido: artículos, dirección, envío y seguimiento.", params: { numero: "número de pedido (order_no)" } },
  { name: "pendientes_de_enviar", mode: "read", description: "Pedidos cobrados o confirmados que aún no se han enviado.", params: {} },
  { name: "solicitudes_cuenta", mode: "read", description: "Solicitudes de cuenta profesional (B2B).", params: { estado: "pending | approved (por defecto pending)", limite: "por defecto 20" } },
  { name: "mensajes", mode: "read", description: "Mensajes recibidos por el formulario de contacto.", params: { estado: "new (por defecto) | todos", limite: "por defecto 20" } },
  { name: "stock", mode: "read", description: "Stock de productos activos. Busca por nombre/SKU.", params: { buscar: "texto (opcional)", solo_bajo: "true para ver solo agotados o bajo umbral", limite: "por defecto 40" } },
  { name: "facturas", mode: "read", description: "Últimas facturas emitidas (numeración nativa) y su estado de cobro.", params: { limite: "por defecto 10", estado: "opcional, p. ej. paid" } },
  { name: "ventas_historicas", mode: "read", description: "Facturación histórica (ERP anterior) agregada por año o por mes de un año.", params: { anio: "p. ej. 2024 (opcional; sin él, resumen por año)" } },
];

const TZ = "Europe/Madrid";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const ymd = (d: Date) => dayFmt.format(d);
function madridMidnight(day: string): string {
  const offH = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date(`${day}T12:00:00Z`))) - 12;
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - offH * 3600_000).toISOString();
}
function rango(periodo: unknown) {
  const p = String(periodo || "mes").toLowerCase().trim();
  const hoy = ymd(new Date());
  const add = (day: string, k: number) => ymd(new Date(new Date(`${day}T12:00:00Z`).getTime() + k * 86400_000));
  if (p === "hoy") return { desde: madridMidnight(hoy), hasta: madridMidnight(add(hoy, 1)), etiqueta: `hoy (${hoy})` };
  if (p === "ayer") return { desde: madridMidnight(add(hoy, -1)), hasta: madridMidnight(hoy), etiqueta: `ayer (${add(hoy, -1)})` };
  if (p === "semana") return { desde: madridMidnight(add(hoy, -6)), hasta: madridMidnight(add(hoy, 1)), etiqueta: "últimos 7 días" };
  if (p === "año" || p === "ano") return { desde: madridMidnight(`${hoy.slice(0, 4)}-01-01`), hasta: madridMidnight(add(hoy, 1)), etiqueta: `año ${hoy.slice(0, 4)}` };
  const m = p.match(/^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/);
  if (m) return { desde: madridMidnight(m[1]), hasta: madridMidnight(add(m[2] || m[1], 1)), etiqueta: m[2] ? `${m[1]} a ${m[2]}` : m[1] };
  return { desde: madridMidnight(`${hoy.slice(0, 7)}-01`), hasta: madridMidnight(add(hoy, 1)), etiqueta: `mes en curso (${hoy.slice(0, 7)})` };
}

const n = (v: unknown) => Number(v ?? 0);
const money = (v: number) => Math.round(v * 100) / 100;
const lim = (v: unknown, def: number, max: number) => Math.min(Math.max(Number(v) || def, 1), max);
const ORDER_COLS = "order_no, status, type, name, email, phone, payment_method, total, created_at, paid_at, shipped_at, city, carrier_name, tracking_number";

function db() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false },
    global: { fetch: (url, opts) => fetch(url, { ...opts, cache: "no-store" }) },
  });
}

export async function runAction(action: string, p: Params): Promise<unknown> {
  const s = db();

  if (action === "resumen") {
    const r = rango(p.periodo);
    const [ord, acc, msg, prod] = await Promise.all([
      s.from("orders").select("status, total").gte("created_at", r.desde).lt("created_at", r.hasta).limit(5000),
      s.from("account_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
      s.from("contact_messages").select("id", { count: "exact", head: true }).eq("status", "new"),
      s.from("products").select("stock, low_stock_threshold").eq("active", true).eq("archived", false).limit(5000),
    ]);
    const porEstado: Record<string, { pedidos: number; total: number }> = {};
    for (const o of ord.data ?? []) { const c = (porEstado[o.status] ??= { pedidos: 0, total: 0 }); c.pedidos++; c.total += n(o.total); }
    for (const c of Object.values(porEstado)) c.total = money(c.total);
    const facturado = ["paid", "confirmed", "preparing", "processing", "shipped"].reduce((t, k) => t + (porEstado[k]?.total ?? 0), 0);
    const pr = prod.data ?? [];
    return {
      ok: true, periodo: r.etiqueta, pedidos_por_estado: porEstado, facturado_cobrado_eur: money(facturado),
      solicitudes_cuenta_pendientes: acc.count ?? 0, mensajes_sin_atender: msg.count ?? 0,
      productos_agotados: pr.filter((x) => n(x.stock) <= 0).length,
      productos_stock_bajo: pr.filter((x) => n(x.stock) > 0 && n(x.stock) <= n(x.low_stock_threshold)).length,
    };
  }

  if (action === "pedidos_recientes") {
    let q = s.from("orders").select(ORDER_COLS).order("created_at", { ascending: false }).limit(lim(p.limite, 10, 30));
    if (typeof p.estado === "string" && p.estado) q = q.eq("status", p.estado);
    const { data, error } = await q;
    if (error) throw error;
    return { ok: true, pedidos: data };
  }

  if (action === "pedido") {
    const no = Number(String(p.numero ?? "").replace(/\D/g, ""));
    if (!no) return { ok: false, error: "Falta el número de pedido (numero)." };
    const { data: o, error } = await s.from("orders")
      .select(`${ORDER_COLS}, id, address, postal_code, province, country, shipping, vat, subtotal, cif, carrier, tracking_url, order_items(name_snapshot, size_snapshot, sku_snapshot, qty, unit_price)`)
      .eq("order_no", no).maybeSingle();
    if (error) throw error;
    if (!o) return { ok: false, error: `No encuentro el pedido ${no}.` };
    const { id: _omit, ...pedido } = o as Record<string, unknown>;
    return { ok: true, pedido };
  }

  if (action === "pendientes_de_enviar") {
    const { data, error } = await s.from("orders").select(ORDER_COLS)
      .in("status", ["paid", "confirmed", "preparing", "processing"]).order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    const ahora = Date.now();
    return { ok: true, total: data?.length ?? 0, pedidos: (data ?? []).map((o) => ({ ...o, horas_desde_el_pedido: Math.round((ahora - new Date(o.created_at).getTime()) / 3600_000) })) };
  }

  if (action === "solicitudes_cuenta") {
    const { data, error } = await s.from("account_requests")
      .select("contact_name, company, cif, business_type, email, phone, message, status, created_at, email_verified")
      .eq("status", String(p.estado || "pending")).order("created_at", { ascending: false }).limit(lim(p.limite, 20, 50));
    if (error) throw error;
    return { ok: true, solicitudes: data };
  }

  if (action === "mensajes") {
    let q = s.from("contact_messages").select("name, email, phone, subject, message, status, created_at").order("created_at", { ascending: false }).limit(lim(p.limite, 20, 50));
    if (p.estado !== "todos") q = q.eq("status", "new");
    const { data, error } = await q;
    if (error) throw error;
    return { ok: true, mensajes: data };
  }

  if (action === "stock") {
    let q = s.from("products").select("name, brand, size, sku, stock, low_stock_threshold, public_price")
      .eq("active", true).eq("archived", false).order("stock", { ascending: true }).limit(lim(p.limite, 40, 100));
    const buscar = String(p.buscar || "").trim().replace(/[%,()]/g, " ");
    if (buscar) q = q.or(`name.ilike.%${buscar}%,sku.ilike.%${buscar}%,brand.ilike.%${buscar}%`);
    const { data, error } = await q;
    if (error) throw error;
    let rows = data ?? [];
    if (p.solo_bajo === true || p.solo_bajo === "true") rows = rows.filter((x) => n(x.stock) <= n(x.low_stock_threshold));
    return { ok: true, agotados: rows.filter((x) => n(x.stock) <= 0).length, productos: rows };
  }

  if (action === "facturas") {
    let q = s.from("native_invoices").select("numero, kind, status, issue_date, customer_name, total, fecha_pago").order("issue_date", { ascending: false }).limit(lim(p.limite, 10, 40));
    if (typeof p.estado === "string" && p.estado) q = q.eq("status", p.estado);
    const { data, error } = await q;
    if (error) throw error;
    return { ok: true, facturas: data };
  }

  if (action === "ventas_historicas") {
    const { data, error } = await s.from("erp_invoices_sale").select("fecha, total, base_imponible").limit(20000);
    if (error) throw error;
    const anio = String(p.anio || "");
    const acc = new Map<string, { facturas: number; total: number; base: number }>();
    for (const f of data ?? []) {
      const y = String(f.fecha ?? "").slice(0, 4);
      if (!y || (anio && y !== anio)) continue;
      const k = anio ? String(f.fecha).slice(0, 7) : y;
      const c = acc.get(k) ?? { facturas: 0, total: 0, base: 0 };
      c.facturas++; c.total += n(f.total); c.base += n(f.base_imponible); acc.set(k, c);
    }
    return { ok: true, nota: "Histórico del ERP anterior (euros, IVA incluido en total).", periodos: [...acc.entries()].sort().map(([k, c]) => ({ periodo: k, facturas: c.facturas, total: money(c.total), base_imponible: money(c.base) })) };
  }

  return { ok: false, error: `Acción desconocida: ${action}` };
}
