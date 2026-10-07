-- Albion Connect: avisos proactivos hacia Albion Assistant (WhatsApp del propietario).
-- El secreto compartido vive en public.app_config (clave 'albion_connect_token', solo service_role/definer) y NO en este repo.
-- Un vigilante (pg_cron, cada minuto) avisa de pedidos, solicitudes de cuenta, mensajes y stock.
-- Nunca rompe la operación original: todo error se traga.

create table if not exists public.albion_sent (
  ref text primary key,
  sent_at timestamptz not null default now()
);
alter table public.albion_sent enable row level security;

create table if not exists public.albion_stock_seen (
  product_id uuid primary key,
  level text not null check (level in ('agotado','bajo')),
  seen_at timestamptz not null default now()
);
alter table public.albion_stock_seen enable row level security;

create or replace function public.albion_notify(p_kind text, p_event text, p_ref text, p_text text, p_severity text default 'info')
returns void language plpgsql security definer set search_path = public as $$
declare t text; u text;
begin
  select value into t from public.app_config where key = 'albion_connect_token';
  select value into u from public.app_config where key = 'albion_panel_url';
  if t is null or t = '' then return; end if;
  perform net.http_post(
    url := coalesce(nullif(u, ''), 'https://app.albionassistant.com') || '/api/apps/notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || t),
    body := jsonb_build_object('kind', p_kind, 'event', p_event, 'ref', p_ref, 'text', p_text, 'severity', p_severity)
  );
exception when others then
  null;
end $$;

-- Avisa una sola vez por referencia.
create or replace function public.albion_notify_once(p_kind text, p_event text, p_ref text, p_text text, p_severity text default 'info')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.albion_sent(ref) values (p_ref) on conflict do nothing;
  if found then
    perform public.albion_notify(p_kind, p_event, p_ref, p_text, p_severity);
  end if;
exception when others then
  null;
end $$;

create or replace function public.albion_watch()
returns void language plpgsql security definer set search_path = public as $$
declare
  first_run boolean;
  r record;
  lst text;
  n int;
  n_pend_acc int; n_new_msg int; n_out int; n_low int;
begin
  -- Solo actúa cuando el propietario ha enlazado la app en Albion Assistant (interruptor 'albion_armed').
  if coalesce((select value from public.app_config where key = 'albion_armed'), '') <> '1' then return; end if;
  first_run := not exists (select 1 from public.albion_sent);

  -- Pedidos: nuevo (transferencia/domiciliación al crearse; tarjeta al cobrarse) y pagado.
  for r in
    select order_no, name, email, status, payment_method, total, paid_at, type
      from public.orders where created_at > now() - interval '3 days'
  loop
    if first_run then
      insert into public.albion_sent(ref) values ('pedido:' || r.order_no || ':nuevo'), ('pedido:' || r.order_no || ':pagado') on conflict do nothing;
      continue;
    end if;
    if (r.payment_method <> 'card' or r.paid_at is not null or r.status in ('paid','confirmed','preparing','processing','shipped'))
       and r.status <> 'cancelled' then
      perform public.albion_notify_once('order', 'pedido_nuevo', 'pedido:' || r.order_no || ':nuevo',
        format('Pedido nuevo #%s · %s € · %s (%s) · pago: %s', r.order_no, round(r.total, 2), coalesce(nullif(r.name, ''), r.email), r.type, r.payment_method));
    end if;
    if r.paid_at is not null and r.payment_method = 'card' then
      perform public.albion_notify_once('order', 'pedido_pagado', 'pedido:' || r.order_no || ':pagado',
        format('Pedido #%s COBRADO · %s € · %s', r.order_no, round(r.total, 2), coalesce(nullif(r.name, ''), r.email)));
    end if;
  end loop;

  -- Solicitudes de cuenta profesional ya verificadas por correo.
  for r in
    select id, company, contact_name, business_type, email from public.account_requests
     where status = 'pending' and created_at > now() - interval '14 days'
  loop
    if first_run then
      insert into public.albion_sent(ref) values ('cuenta:' || r.id) on conflict do nothing;
      continue;
    end if;
    perform public.albion_notify_once('alert', 'solicitud_cuenta', 'cuenta:' || r.id,
      format('Nueva solicitud de cuenta profesional: %s (%s, %s) · %s', coalesce(r.company, '—'), coalesce(r.contact_name, '—'), coalesce(r.business_type, '—'), r.email));
  end loop;

  -- Mensajes del formulario de contacto.
  for r in
    select id, name, email, subject, message from public.contact_messages
     where status = 'new' and created_at > now() - interval '14 days'
  loop
    if first_run then
      insert into public.albion_sent(ref) values ('msg:' || r.id) on conflict do nothing;
      continue;
    end if;
    perform public.albion_notify_once('alert', 'mensaje_contacto', 'msg:' || r.id,
      format('Mensaje nuevo de %s (%s)%s: %s', coalesce(nullif(r.name, ''), '—'), r.email, coalesce(' · ' || nullif(r.subject, ''), ''), left(r.message, 220)));
  end loop;

  -- Stock: avisa de lo que ENTRA en agotado/bajo (agrupado). La primera vez, resumen del estado actual.
  select count(*) into n_out from public.products where active and not coalesce(archived, false) and coalesce(stock, 0) <= 0;
  select count(*) into n_low from public.products where active and not coalesce(archived, false) and coalesce(stock, 0) > 0 and stock <= coalesce(low_stock_threshold, 0);

  if first_run then
    insert into public.albion_stock_seen(product_id, level)
      select id, case when coalesce(stock, 0) <= 0 then 'agotado' else 'bajo' end
        from public.products
       where active and not coalesce(archived, false) and coalesce(stock, 0) <= coalesce(low_stock_threshold, 0)
      on conflict (product_id) do update set level = excluded.level;
    select count(*) into n_pend_acc from public.account_requests where status = 'pending';
    select count(*) into n_new_msg from public.contact_messages where status = 'new';
    perform public.albion_notify('alert', 'albion_conectado', 'inicio:' || to_char(now(), 'YYYYMMDDHH24MI'),
      format('Conectado. Estado actual: %s solicitud(es) de cuenta pendientes, %s mensaje(s) de contacto sin atender, %s producto(s) agotados y %s con stock bajo.', n_pend_acc, n_new_msg, n_out, n_low));
    return;
  end if;

  -- Productos que ya no están bajos: se olvidan (para avisar si vuelven a bajar).
  delete from public.albion_stock_seen s
   using public.products p
   where p.id = s.product_id
     and (not p.active or coalesce(p.archived, false) or coalesce(p.stock, 0) > coalesce(p.low_stock_threshold, 0));

  for r in
    select 'agotado'::text as lvl, string_agg(x.name || ' (' || coalesce(x.size, '') || ')', '; ' order by x.name) as names, count(*) as c
      from (select p.id, p.name, p.size from public.products p
             where p.active and not coalesce(p.archived, false) and coalesce(p.stock, 0) <= 0
               and not exists (select 1 from public.albion_stock_seen s where s.product_id = p.id and s.level = 'agotado') limit 12) x
    union all
    select 'bajo', string_agg(x.name || ' (' || x.stock || ')', '; ' order by x.name), count(*)
      from (select p.id, p.name, p.stock from public.products p
             where p.active and not coalesce(p.archived, false) and coalesce(p.stock, 0) > 0 and p.stock <= coalesce(p.low_stock_threshold, 0)
               and not exists (select 1 from public.albion_stock_seen s where s.product_id = p.id) limit 12) x
  loop
    if r.c > 0 then
      perform public.albion_notify('stock', 'stock_' || r.lvl, 'stock:' || r.lvl || ':' || md5(r.names || clock_timestamp()::text),
        format('%s: %s%s', case r.lvl when 'agotado' then 'AGOTADO' else 'Stock bajo' end, r.names, case when r.c >= 12 then '… (y posiblemente más)' else '' end),
        case r.lvl when 'agotado' then 'critical' else 'warning' end);
    end if;
  end loop;

  insert into public.albion_stock_seen(product_id, level)
    select id, case when coalesce(stock, 0) <= 0 then 'agotado' else 'bajo' end
      from public.products
     where active and not coalesce(archived, false) and coalesce(stock, 0) <= coalesce(low_stock_threshold, 0)
    on conflict (product_id) do update set level = excluded.level;
end $$;

revoke all on function public.albion_notify(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.albion_notify_once(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.albion_watch() from public, anon, authenticated;
