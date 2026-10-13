-- =====================================================================
-- Facturación RD — Fase 1 de facturación electrónica (e-CF)
-- Ejecutar DESPUÉS de schema.sql: Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin perder datos.
-- =====================================================================

-- Tipos e-CF en las secuencias (e-NCF)
alter table public.secuencias drop constraint if exists secuencias_tipo_check;
alter table public.secuencias add constraint secuencias_tipo_check
  check (tipo in ('B01','B02','B14','B15','B04','E31','E32','E33','E34','E44','E45'));

-- Configuración de facturación electrónica por empresa.
-- La clave privada del certificado se guarda cifrada (AES-GCM) con un secreto que solo conoce el Worker.
create table if not exists public.ecf_config (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  ambiente   text not null default 'testecf' check (ambiente in ('testecf','certecf','ecf')),
  cert_b64   text,
  key_enc    text,
  key_iv     text,
  cert_info  jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists ecf_config_updated_at on public.ecf_config;
create trigger ecf_config_updated_at before update on public.ecf_config for each row execute function public.tg_updated_at();

alter table public.ecf_config enable row level security;
drop policy if exists ecf_config_select on public.ecf_config;
drop policy if exists ecf_config_insert on public.ecf_config;
drop policy if exists ecf_config_update on public.ecf_config;
drop policy if exists ecf_config_delete on public.ecf_config;
create policy ecf_config_select on public.ecf_config for select to authenticated using (public.es_miembro(empresa_id));
create policy ecf_config_insert on public.ecf_config for insert to authenticated with check (public.es_admin(empresa_id));
create policy ecf_config_update on public.ecf_config for update to authenticated using (public.es_admin(empresa_id)) with check (public.es_admin(empresa_id));
create policy ecf_config_delete on public.ecf_config for delete to authenticated using (public.es_admin(empresa_id));
grant select, insert, update, delete on public.ecf_config to authenticated;

-- Emisión: acepta tipos e-CF. El e-NCF lleva 10 dígitos (E310000000001); el NCF tradicional, 8.
create or replace function public.emitir_factura(p_empresa uuid, p_tipo text, p_data jsonb)
returns public.facturas language plpgsql security definer set search_path = public as $$
declare
  s public.secuencias%rowtype;
  n bigint; k int; dig int;
  v_ncf text := ''; v_vence date; v_num text; v_pref text;
  r public.facturas%rowtype;
begin
  if not public.es_miembro(p_empresa) then raise exception 'No tienes acceso a esta empresa'; end if;
  if p_tipo not in ('B01','B02','B14','B15','B04','E31','E32','E33','E34','E44','E45','NONE') then
    raise exception 'Tipo de comprobante inválido: %', p_tipo;
  end if;

  if p_tipo <> 'NONE' then
    select * into s from public.secuencias where empresa_id = p_empresa and tipo = p_tipo for update;
    if not found or not s.activo then
      raise exception 'No hay secuencia activa para %. Configúrala en Empresas.', p_tipo;
    end if;
    if s.vence is not null and s.vence < (now() at time zone 'America/Santo_Domingo')::date then
      raise exception 'La secuencia % venció el %. Actualízala en Empresas.', p_tipo, to_char(s.vence, 'DD/MM/YYYY');
    end if;
    n := greatest(s.actual + 1, s.desde);
    if s.hasta is not null and n > s.hasta then
      raise exception 'La secuencia % está agotada (hasta %). Solicita una nueva a la DGII.', p_tipo, s.hasta;
    end if;
    update public.secuencias set actual = n where empresa_id = p_empresa and tipo = p_tipo;
    dig := case when left(p_tipo, 1) = 'E' then 10 else 8 end;
    if length(n::text) > dig then raise exception 'La secuencia % excede % dígitos', p_tipo, dig; end if;
    v_ncf := p_tipo || lpad(n::text, dig, '0');
    v_vence := s.vence;
  end if;

  if p_tipo in ('B04','E34') then
    update public.empresas set proximo_nc = proximo_nc + 1 where id = p_empresa returning proximo_nc - 1 into k;
    v_num := 'NC-' || lpad(k::text, greatest(4, length(k::text)), '0');
  else
    update public.empresas set proximo_numero = proximo_numero + 1 where id = p_empresa
      returning proximo_numero - 1, coalesce(nullif(data->>'prefijo', ''), 'INV') into k, v_pref;
    v_num := v_pref || '-' || lpad(k::text, greatest(4, length(k::text)), '0');
  end if;

  insert into public.facturas(empresa_id, numero, tipo, ncf, fecha, data, created_by)
  values (
    p_empresa, v_num, p_tipo, nullif(v_ncf, ''),
    coalesce(nullif(p_data->>'fecha', '')::date, current_date),
    coalesce(p_data, '{}'::jsonb) || jsonb_build_object('numero', v_num, 'tipo', p_tipo, 'ncf', v_ncf,
                                                        'ncfVence', coalesce(to_char(v_vence, 'YYYY-MM-DD'), '')),
    auth.uid()
  ) returning * into r;
  return r;
end $$;

revoke execute on function public.emitir_factura(uuid, text, jsonb) from public, anon;
grant  execute on function public.emitir_factura(uuid, text, jsonb) to authenticated;
