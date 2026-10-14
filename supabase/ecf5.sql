-- =====================================================================
-- Facturación RD — borrar comprobantes (pruebas / errores)
-- Ejecutar en Supabase → SQL Editor → New query → Run. Se puede volver a ejecutar.
-- =====================================================================

-- El dueño o un administrador puede borrar documentos de su empresa,
-- EXCEPTO los e-CF que la propia app envió a la DGII en producción y fueron aceptados
-- (esos se corrigen con nota de crédito E34, nunca se borran).
drop policy if exists facturas_delete on public.facturas;
create policy facturas_delete on public.facturas for delete to authenticated using (
  public.es_admin(empresa_id)
  and not (
    coalesce(data->'ecf'->>'ambiente', '') = 'ecf'
    and coalesce(data->'ecf'->>'trackId', '') <> ''
    and coalesce(data->'ecf'->>'estado', '') in ('Aceptado', 'Aceptado Condicional')
  )
);
grant delete on public.facturas to authenticated;
