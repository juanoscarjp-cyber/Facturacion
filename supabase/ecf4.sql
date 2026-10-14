-- =====================================================================
-- Facturación RD — comprobantes electrónicos RECIBIDOS (servicios receptores /fe/*)
-- Ejecutar DESPUÉS de ecf3.sql: Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin perder datos.
-- =====================================================================

-- e-CF que otros contribuyentes (o la DGII en certificación) envían a tus empresas.
-- Los inserta el Worker con la clave de servicio; los miembros de la empresa los ven y aprueban.
create table if not exists public.ecf_recibidos (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references public.empresas(id) on delete cascade,
  rnc_emisor          text not null,
  razon_social_emisor text,
  encf                text not null,
  tipo                text,
  fecha_emision       text,
  monto_total         numeric(18,2),
  total_itbis         numeric(18,2),
  xml                 text not null,
  firma_valida        boolean not null default false,
  acuse_estado        int,
  acuse_motivo        int,
  aprobacion          jsonb not null default '{}'::jsonb,
  recibido_at         timestamptz not null default now(),
  unique (empresa_id, rnc_emisor, encf)
);
create index if not exists ecf_recibidos_empresa_idx on public.ecf_recibidos(empresa_id, recibido_at desc);

alter table public.ecf_recibidos enable row level security;
drop policy if exists ecf_recibidos_select on public.ecf_recibidos;
drop policy if exists ecf_recibidos_update on public.ecf_recibidos;
create policy ecf_recibidos_select on public.ecf_recibidos for select to authenticated using (public.es_miembro(empresa_id));
create policy ecf_recibidos_update on public.ecf_recibidos for update to authenticated using (public.es_miembro(empresa_id)) with check (public.es_miembro(empresa_id));
grant select, update on public.ecf_recibidos to authenticated;

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.ecf_recibidos'; exception when duplicate_object then null; end;
end $$;
