-- =====================================================================
-- Facturación RD — registro de intentos de recepción de e-CF (/fe/*)
-- Ejecutar DESPUÉS de ecf4.sql: Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin perder datos.
-- =====================================================================

-- Cada llamada a los servicios receptores queda anotada, se haya aceptado o rechazado el comprobante,
-- para saber si los proveedores están enviando y por qué no aparece un e-CF.
-- Las filas sin empresa (RNC comprador que no corresponde a ninguna) solo se ven con la clave de servicio.
create table if not exists public.ecf_recepcion_log (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid references public.empresas(id) on delete cascade,
  recibido_at   timestamptz not null default now(),
  ruta          text,
  ip            text,
  rnc_emisor    text,
  razon_social_emisor text,
  rnc_comprador text,
  encf          text,
  tipo          text,
  monto_total   numeric(18,2),
  resultado     text not null,   -- aceptado | duplicado | firma_invalida | rnc_no_corresponde | token_invalido | xml_invalido | error
  motivo        text,
  xml           text
);
create index if not exists ecf_recepcion_log_empresa_idx on public.ecf_recepcion_log(empresa_id, recibido_at desc);
create index if not exists ecf_recepcion_log_fecha_idx on public.ecf_recepcion_log(recibido_at desc);

alter table public.ecf_recepcion_log enable row level security;
drop policy if exists ecf_recepcion_log_select on public.ecf_recepcion_log;
create policy ecf_recepcion_log_select on public.ecf_recepcion_log for select to authenticated using (empresa_id is not null and public.es_miembro(empresa_id));
grant select on public.ecf_recepcion_log to authenticated;
