-- =====================================================================
-- Facturación RD — esquema para Supabase
-- Pegar completo en: Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin perder datos.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tablas ----------
create table if not exists public.empresas (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null,
  data           jsonb not null default '{}'::jsonb,
  proximo_numero int  not null default 1,
  proximo_nc     int  not null default 1,
  created_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);

create table if not exists public.miembros (
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text,
  rol        text not null default 'usuario' check (rol in ('dueno','admin','usuario')),
  created_at timestamptz not null default now(),
  primary key (empresa_id, user_id)
);

create table if not exists public.invitaciones (
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  email        text not null,
  rol          text not null default 'usuario' check (rol in ('admin','usuario')),
  invitado_por uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  primary key (empresa_id, email)
);

create table if not exists public.secuencias (
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  tipo       text not null check (tipo in ('B01','B02','B14','B15','B04')),
  activo     boolean not null default false,
  desde      bigint  not null default 1,
  hasta      bigint,
  actual     bigint  not null default 0,
  vence      date,
  primary key (empresa_id, tipo)
);

create table if not exists public.clientes (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.productos (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.facturas (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  numero     text not null,
  tipo       text not null,
  ncf        text,
  fecha      date not null default current_date,
  data       jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists miembros_user_idx      on public.miembros(user_id);
create index if not exists clientes_empresa_idx   on public.clientes(empresa_id);
create index if not exists productos_empresa_idx  on public.productos(empresa_id);
create index if not exists facturas_empresa_idx   on public.facturas(empresa_id, fecha desc);
create unique index if not exists facturas_empresa_numero_key on public.facturas(empresa_id, numero);
create unique index if not exists facturas_empresa_ncf_key    on public.facturas(empresa_id, ncf) where ncf is not null and ncf <> '';

-- ---------- Funciones auxiliares de permisos ----------
create or replace function public.es_miembro(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.miembros m where m.empresa_id = e and m.user_id = auth.uid());
$$;

create or replace function public.es_admin(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.miembros m where m.empresa_id = e and m.user_id = auth.uid() and m.rol in ('dueno','admin'));
$$;

create or replace function public.es_dueno(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.miembros m where m.empresa_id = e and m.user_id = auth.uid() and m.rol = 'dueno');
$$;

-- ---------- Triggers ----------
create or replace function public.tg_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists clientes_updated_at on public.clientes;
create trigger clientes_updated_at before update on public.clientes for each row execute function public.tg_updated_at();
drop trigger if exists productos_updated_at on public.productos;
create trigger productos_updated_at before update on public.productos for each row execute function public.tg_updated_at();

-- Un comprobante emitido no puede cambiar de número, tipo, NCF ni empresa.
create or replace function public.tg_facturas_inmutables() returns trigger
language plpgsql as $$
begin
  if new.empresa_id <> old.empresa_id or new.numero <> old.numero or new.tipo <> old.tipo
     or coalesce(new.ncf, '') <> coalesce(old.ncf, '') then
    raise exception 'No se puede cambiar el número, tipo ni NCF de un comprobante emitido';
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists facturas_inmutables on public.facturas;
create trigger facturas_inmutables before update on public.facturas for each row execute function public.tg_facturas_inmutables();

-- ---------- Seguridad por filas (RLS) ----------
alter table public.empresas     enable row level security;
alter table public.miembros     enable row level security;
alter table public.invitaciones enable row level security;
alter table public.secuencias   enable row level security;
alter table public.clientes     enable row level security;
alter table public.productos    enable row level security;
alter table public.facturas     enable row level security;

-- empresas (se crean solo con la función crear_empresa)
drop policy if exists empresas_select on public.empresas;
drop policy if exists empresas_update on public.empresas;
drop policy if exists empresas_delete on public.empresas;
create policy empresas_select on public.empresas for select to authenticated using (public.es_miembro(id));
create policy empresas_update on public.empresas for update to authenticated using (public.es_admin(id)) with check (public.es_admin(id));
create policy empresas_delete on public.empresas for delete to authenticated using (public.es_dueno(id));

-- miembros
drop policy if exists miembros_select on public.miembros;
drop policy if exists miembros_update on public.miembros;
drop policy if exists miembros_delete on public.miembros;
create policy miembros_select on public.miembros for select to authenticated using (public.es_miembro(empresa_id));
create policy miembros_update on public.miembros for update to authenticated
  using (public.es_admin(empresa_id) and rol <> 'dueno')
  with check (public.es_admin(empresa_id) and rol in ('admin','usuario'));
create policy miembros_delete on public.miembros for delete to authenticated
  using ((public.es_admin(empresa_id) or user_id = auth.uid()) and rol <> 'dueno');

-- invitaciones
drop policy if exists invitaciones_select on public.invitaciones;
drop policy if exists invitaciones_insert on public.invitaciones;
drop policy if exists invitaciones_delete on public.invitaciones;
create policy invitaciones_select on public.invitaciones for select to authenticated using (public.es_admin(empresa_id));
create policy invitaciones_insert on public.invitaciones for insert to authenticated with check (public.es_admin(empresa_id));
create policy invitaciones_delete on public.invitaciones for delete to authenticated using (public.es_admin(empresa_id));

-- secuencias NCF
drop policy if exists secuencias_select on public.secuencias;
drop policy if exists secuencias_insert on public.secuencias;
drop policy if exists secuencias_update on public.secuencias;
create policy secuencias_select on public.secuencias for select to authenticated using (public.es_miembro(empresa_id));
create policy secuencias_insert on public.secuencias for insert to authenticated with check (public.es_admin(empresa_id));
create policy secuencias_update on public.secuencias for update to authenticated using (public.es_admin(empresa_id)) with check (public.es_admin(empresa_id));

-- clientes y productos: cualquier miembro
drop policy if exists clientes_all on public.clientes;
create policy clientes_all on public.clientes for all to authenticated using (public.es_miembro(empresa_id)) with check (public.es_miembro(empresa_id));
drop policy if exists productos_all on public.productos;
create policy productos_all on public.productos for all to authenticated using (public.es_miembro(empresa_id)) with check (public.es_miembro(empresa_id));

-- facturas: se emiten con emitir_factura(); los miembros pueden registrar pagos/anular (update).
-- Insert directo solo para administradores (importar respaldos). No se permite borrar.
drop policy if exists facturas_select on public.facturas;
drop policy if exists facturas_update on public.facturas;
drop policy if exists facturas_insert on public.facturas;
create policy facturas_select on public.facturas for select to authenticated using (public.es_miembro(empresa_id));
create policy facturas_update on public.facturas for update to authenticated using (public.es_miembro(empresa_id)) with check (public.es_miembro(empresa_id));
create policy facturas_insert on public.facturas for insert to authenticated with check (public.es_admin(empresa_id));

-- ---------- Funciones (RPC) ----------
create or replace function public.crear_empresa(p_nombre text, p_data jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid; v_email text;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesión'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'El nombre de la empresa es obligatorio'; end if;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.empresas(nombre, data, created_by) values (trim(p_nombre), coalesce(p_data, '{}'::jsonb), auth.uid()) returning id into v;
  insert into public.miembros(empresa_id, user_id, email, rol) values (v, auth.uid(), v_email, 'dueno');
  return v;
end $$;

-- Une al usuario a las empresas que lo invitaron (solo con email confirmado).
create or replace function public.aceptar_invitaciones()
returns int language plpgsql security definer set search_path = public as $$
declare v_email text; v_conf timestamptz; n int;
begin
  if auth.uid() is null then return 0; end if;
  select lower(email), email_confirmed_at into v_email, v_conf from auth.users where id = auth.uid();
  if v_email is null or v_conf is null then return 0; end if;
  insert into public.miembros(empresa_id, user_id, email, rol)
    select i.empresa_id, auth.uid(), v_email, i.rol from public.invitaciones i where lower(i.email) = v_email
    on conflict (empresa_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.invitaciones where lower(email) = v_email;
  return n;
end $$;

-- Emite un comprobante: asigna NCF y número de forma atómica (sin duplicados entre usuarios).
create or replace function public.emitir_factura(p_empresa uuid, p_tipo text, p_data jsonb)
returns public.facturas language plpgsql security definer set search_path = public as $$
declare
  s public.secuencias%rowtype;
  n bigint; k int;
  v_ncf text := ''; v_vence date; v_num text; v_pref text;
  r public.facturas%rowtype;
begin
  if not public.es_miembro(p_empresa) then raise exception 'No tienes acceso a esta empresa'; end if;
  if p_tipo not in ('B01','B02','B14','B15','B04','NONE') then raise exception 'Tipo de comprobante inválido: %', p_tipo; end if;

  if p_tipo <> 'NONE' then
    select * into s from public.secuencias where empresa_id = p_empresa and tipo = p_tipo for update;
    if not found or not s.activo then
      raise exception 'No hay secuencia NCF activa para %. Configúrala en Empresas.', p_tipo;
    end if;
    if s.vence is not null and s.vence < (now() at time zone 'America/Santo_Domingo')::date then
      raise exception 'La secuencia % venció el %. Actualízala en Empresas.', p_tipo, to_char(s.vence, 'DD/MM/YYYY');
    end if;
    n := greatest(s.actual + 1, s.desde);
    if s.hasta is not null and n > s.hasta then
      raise exception 'La secuencia % está agotada (hasta %). Solicita una nueva a la DGII.', p_tipo, s.hasta;
    end if;
    update public.secuencias set actual = n where empresa_id = p_empresa and tipo = p_tipo;
    v_ncf := p_tipo || lpad(n::text, greatest(8, length(n::text)), '0');
    v_vence := s.vence;
  end if;

  if p_tipo = 'B04' then
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

revoke execute on function public.crear_empresa(text, jsonb)         from public, anon;
revoke execute on function public.aceptar_invitaciones()             from public, anon;
revoke execute on function public.emitir_factura(uuid, text, jsonb)  from public, anon;
grant  execute on function public.crear_empresa(text, jsonb)         to authenticated;
grant  execute on function public.aceptar_invitaciones()             to authenticated;
grant  execute on function public.emitir_factura(uuid, text, jsonb)  to authenticated;

grant select, insert, update, delete on public.empresas, public.miembros, public.invitaciones,
  public.secuencias, public.clientes, public.productos, public.facturas to authenticated;

-- ---------- Tiempo real (cambios en vivo entre usuarios) ----------
do $$
declare t text;
begin
  foreach t in array array['facturas','clientes','productos','secuencias','empresas'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
