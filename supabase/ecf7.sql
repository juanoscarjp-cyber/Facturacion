-- =====================================================================
-- Facturación RD — facturas en BORRADOR (sin NCF, no se envían a la DGII)
-- Ejecutar en Supabase → SQL Editor → New query → Run. Se puede volver a ejecutar.
-- Requiere haber ejecutado antes ecf5.sql.
-- =====================================================================

-- Cualquier miembro puede guardar un borrador (sin NCF). Los comprobantes reales siguen
-- emitiéndose solo con la función emitir_factura().
drop policy if exists facturas_insert on public.facturas;
create policy facturas_insert on public.facturas for insert to authenticated with check (
  public.es_admin(empresa_id)
  or (public.es_miembro(empresa_id) and data->>'estado' = 'borrador' and coalesce(ncf, '') = '')
);

-- Borrar: dueño/administrador (salvo e-CF aceptados en producción) y cualquier miembro sus borradores
drop policy if exists facturas_delete on public.facturas;
create policy facturas_delete on public.facturas for delete to authenticated using (
  (public.es_miembro(empresa_id) and data->>'estado' = 'borrador' and coalesce(ncf, '') = '')
  or (
    public.es_admin(empresa_id)
    and not (
      coalesce(data->'ecf'->>'ambiente', '') = 'ecf'
      and coalesce(data->'ecf'->>'trackId', '') <> ''
      and coalesce(data->'ecf'->>'estado', '') in ('Aceptado', 'Aceptado Condicional')
    )
  )
);
grant delete on public.facturas to authenticated;

-- Un borrador puede cambiar de tipo de comprobante; un comprobante emitido no.
create or replace function public.tg_facturas_inmutables() returns trigger
language plpgsql as $$
begin
  if coalesce(old.data->>'estado', '') = 'borrador' and coalesce(old.ncf, '') = '' then
    if coalesce(new.ncf, '') <> '' or new.empresa_id <> old.empresa_id then
      raise exception 'Un borrador se emite con emitir_factura(), no editándolo';
    end if;
  elsif new.empresa_id <> old.empresa_id or new.numero <> old.numero or new.tipo <> old.tipo
     or coalesce(new.ncf, '') <> coalesce(old.ncf, '') then
    raise exception 'No se puede cambiar el número, tipo ni NCF de un comprobante emitido';
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := clock_timestamp();
  return new;
end $$;
