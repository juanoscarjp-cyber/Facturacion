  -- =====================================================================
  -- Facturación RD — módulo de Compras y Gastos (formato 606)
  -- Ejecutar en Supabase → SQL Editor → New query → Run. Se puede volver a ejecutar sin perder datos.
  -- =====================================================================
  
  create table if not exists public.gastos (
    id            uuid primary key default gen_random_uuid(),
    empresa_id    uuid not null references public.empresas(id) on delete cascade,
    fecha         date not null default current_date,
    rnc_proveedor text not null default '',
    ncf           text not null default '',
    data          jsonb not null default '{}'::jsonb,
    created_by    uuid default auth.uid(),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
  );
  create index if not exists gastos_empresa_idx on public.gastos(empresa_id, fecha desc);
  -- Un mismo NCF de un proveedor no se registra dos veces
  create unique index if not exists gastos_empresa_ncf_key on public.gastos(empresa_id, rnc_proveedor, ncf) where ncf <> '';
  
  drop trigger if exists gastos_updated_at on public.gastos;
  create trigger gastos_updated_at before update on public.gastos for each row execute function public.tg_updated_at();
  
  alter table public.gastos enable row level security;
  drop policy if exists gastos_select on public.gastos;
  drop policy if exists gastos_insert on public.gastos;
  drop policy if exists gastos_update on public.gastos;
  drop policy if exists gastos_delete on public.gastos;
  create policy gastos_select on public.gastos for select to authenticated using (public.es_miembro(empresa_id));
  create policy gastos_insert on public.gastos for insert to authenticated with check (public.es_miembro(empresa_id));
  create policy gastos_update on public.gastos for update to authenticated using (public.es_miembro(empresa_id)) with check (public.es_miembro(empresa_id));
  create policy gastos_delete on public.gastos for delete to authenticated using (public.es_admin(empresa_id));
  grant select, insert, update, delete on public.gastos to authenticated;
  
  do $$ begin
    begin execute 'alter publication supabase_realtime add table public.gastos'; exception when duplicate_object then null; end;
  end $$;
