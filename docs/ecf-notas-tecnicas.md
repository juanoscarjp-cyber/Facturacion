# Facturación electrónica (e-CF) — notas técnicas

Resumen de la documentación oficial de la DGII consultada el 13-10-2026
(https://dgii.gov.do → Facturación Electrónica → Documentación sobre e-CF):
"Descripción Técnica Servicios DGII" y "Servicios Emisores Electrónicos" (act. 02-01-2026),
"Firmado de e-CF", "Formato e-CF v1.0", "Informe Técnico e-CF v1.0" (act. 23-03-2026),
XSD e-CF 31–47 v1.0 (31/32 act. 16-10-2025, 33/34 act. 01-04-2026), RFCE 32 v1.0.

## Ambientes
| Ambiente | Base e-CF | Base facturas consumo (FC) |
|---|---|---|
| Pre-certificación | https://ecf.dgii.gov.do/testecf | https://fc.dgii.gov.do/testecf |
| Certificación | https://ecf.dgii.gov.do/certecf | https://fc.dgii.gov.do/certecf |
| Producción | https://ecf.dgii.gov.do/ecf | https://fc.dgii.gov.do/ecf |

En TesteCF cada contribuyente habilitado tiene secuencias 1–10,000,000 por tipo (E32: 1–50,000,000),
vencen 31-12-2028 (E32 y E34 sin vencimiento). Los envíos se guardan 60 días.

## Servicios usados
- Semilla: `GET {base}/autenticacion/api/autenticacion/semilla` → XML `SemillaModel{valor,fecha}`.
- Token: `POST {base}/autenticacion/api/autenticacion/validarsemilla` multipart campo `xml` (semilla firmada) → `{token, expira, expedido}`. Dura 1 hora. Header `Authorization: Bearer {token}`.
- Envío e-CF: `POST {base}/recepcion/api/facturaselectronicas` multipart `xml` → `{trackId, error, mensaje}`.
- Envío RFCE (E32 < RD$250,000): `POST {fc}/recepcionfc/api/recepcion/ecf` multipart `xml` → `{codigo, estado, mensajes[], encf, secuenciaUtilizada}`.
- Resultado: `GET {base}/consultaresultado/api/consultas/estado?trackid=` → `{trackId, codigo, estado, rnc, encf, secuenciaUtilizada, fechaRecepcion, mensajes[]}`.
  Códigos: 0 No encontrado, 1 Aceptado, 2 Rechazado, 3 En Proceso, 4 Aceptado Condicional.
- Timbre QR: `{base}/consultatimbre?rncemisor&rnccomprador&encf&fechaemision&montototal&fechafirma&codigoseguridad`
  y para RFCE `{fc}/consultatimbrefc?rncemisor&encf&montototal&codigoseguridad`.
- Nombre de archivo: `RNCEmisor + e-NCF + .xml`.

## Firma (XMLDSig enveloped)
- C14N inclusivo `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`, `rsa-sha256`, digest `xmlenc#sha256`,
  `Reference URI=""` con transform `enveloped-signature`, `KeyInfo/X509Data/X509Certificate`.
- `Signature` es el último hijo del elemento raíz (después de `FechaHoraFirma`). Sin espacios en blanco; no alterar tras firmar.
- `FechaHoraFirma`: `dd-MM-yyyy HH:mm:ss` hora GMT-4.
- Código de seguridad: primeros 6 caracteres del `SignatureValue`.
- El campo SN del certificado debe ser el RNC/cédula del titular; el titular debe estar delegado para el RNC emisor.

## Reglas de contenido
- No incluir etiquetas vacías. Escapar `& < > " '` en textos.
- Montos: hasta 16 enteros y 2 decimales, redondeo half-up; tolerancia ±1 por línea y global = nº de líneas.
- `IndicadorFacturacion`: 1=18%, 2=16%, 3=0%, 4=Exento, 0=No facturable.
- Propina legal = impuesto adicional código `001` (10%), en ítems (`TablaImpuestoAdicional`) y en `Totales/ImpuestosAdicionales` con `OtrosImpuestosAdicionales`.
- `MontoTotal = MontoGravadoTotal + MontoExento + TotalITBIS + MontoImpuestoAdicional`.
- `TipoPago`: 1 contado, 2 crédito, 3 gratuito. `FormaPago`: 1 efectivo, 2 cheque/transferencia, 3 tarjeta, 4 crédito, 5 bonos, 6 permuta, 7 nota de crédito, 8 otras.
- E34: `IndicadorNotaCredito` 0 si el e-CF afectado tiene ≤ 30 días, 1 si > 30; `InformacionReferencia` obligatoria
  (`CodigoModificacion` 1 anula, 2 corrige texto, 3 corrige montos, 4 reemplazo contingencia, 5 referencia factura consumo).
- E44 (régimen especial): totales solo exentos.

## Representación impresa
Tipo de e-CF en palabras, e-NCF, vencimiento de la secuencia, datos de emisor y comprador, detalle con ITBIS por línea,
totales, QR abajo a la izquierda (≥ 22×22 mm), "Código de Seguridad" y "Fecha de Firma Digital" bajo el QR.

## Implementación en este proyecto
- `src/ecf.js`: construcción del XML según el orden del XSD, C14N, firma, cliente DGII.
- `src/worker.js`: rutas `/api/ecf/*`; la clave privada se guarda cifrada (AES-GCM con el secreto `ECF_MASTER_KEY` del Worker).
- `supabase/ecf.sql`: tabla `ecf_config` y tipos E en secuencias.
