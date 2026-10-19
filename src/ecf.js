// Facturación electrónica DGII (e-CF): construcción del XML, canonicalización C14N,
// firma XMLDSig (RSA-SHA256) y cliente de los servicios web de la DGII.
// Funciona en Cloudflare Workers y en el navegador (solo usa WebCrypto y fetch).
// Referencia: docs/ecf-notas-tecnicas.md
import { ESQUEMAS } from './ecf-esquemas.js';
export { ESQUEMAS };

/* ---------------------------------------------------------------------------
   Orden de los elementos según los XSD oficiales v1.0 (solo los campos que usamos).
   "Nombre!" = obligatorio. [nombre, hijos] = elemento compuesto.
   --------------------------------------------------------------------------- */
const IDDOC_PAGO = ['TipoIngresos!', 'TipoPago!', 'FechaLimitePago', 'TerminoPago', ['TablaFormasPago', [['FormaDePago!', ['FormaPago!', 'MontoPago!']]]]];
const EMISOR = ['Emisor!', ['RNCEmisor!', 'RazonSocialEmisor!', 'NombreComercial', 'DireccionEmisor!', ['TablaTelefonoEmisor', ['TelefonoEmisor!']], 'CorreoEmisor', 'WebSite', 'ActividadEconomica', 'NumeroFacturaInterna', 'FechaEmision!']];
const COMPRADOR = req => [req ? 'Comprador!' : 'Comprador', [req ? 'RNCComprador!' : 'RNCComprador', req ? 'RazonSocialComprador!' : 'RazonSocialComprador', 'CorreoComprador', 'DireccionComprador']];
const TOTALES_GRAV = ['MontoGravadoTotal', 'MontoGravadoI1', 'MontoGravadoI2', 'MontoGravadoI3', 'MontoExento', 'ITBIS1', 'ITBIS2', 'ITBIS3', 'TotalITBIS', 'TotalITBIS1', 'TotalITBIS2', 'TotalITBIS3'];
const IMP_ADIC = ['MontoImpuestoAdicional', ['ImpuestosAdicionales', [['ImpuestoAdicional!', ['TipoImpuesto!', 'TasaImpuestoAdicional!', 'OtrosImpuestosAdicionales']]]]];
const ITEMS = ['DetallesItems!', [['Item!', ['NumeroLinea!', ['TablaCodigosItem', [['CodigosItem!', ['TipoCodigo!', 'CodigoItem!']]]], 'IndicadorFacturacion!', 'NombreItem!', 'IndicadorBienoServicio!', 'DescripcionItem', 'CantidadItem!', 'PrecioUnitarioItem!', 'DescuentoMonto', ['TablaSubDescuento', [['SubDescuento!', ['TipoSubDescuento!', 'SubDescuentoPorcentaje', 'MontoSubDescuento']]]], ['TablaImpuestoAdicional', [['ImpuestoAdicional!', ['TipoImpuesto!']]]], 'MontoItem!']]]];
const REF_OPC = ['InformacionReferencia', ['NCFModificado', 'FechaNCFModificado', 'CodigoModificacion']];
const REF_OBL = ['InformacionReferencia!', ['NCFModificado!', 'FechaNCFModificado!', 'CodigoModificacion!', 'RazonModificacion']];

const ecf = (iddoc, comprador, totales, ref) => ['ECF!', [['Encabezado!', ['Version!', ['IdDoc!', iddoc], EMISOR, comprador, ['Totales!', totales]]], ITEMS, ref, 'FechaHoraFirma!']];

export const SKELETONS = {
  31: ecf(['TipoeCF!', 'eNCF!', 'FechaVencimientoSecuencia!', 'IndicadorMontoGravado', ...IDDOC_PAGO], COMPRADOR(true), [...TOTALES_GRAV, ...IMP_ADIC, 'MontoTotal!'], REF_OPC),
  32: ecf(['TipoeCF!', 'eNCF!', 'IndicadorMontoGravado', ...IDDOC_PAGO], ['Comprador!', COMPRADOR(false)[1]], [...TOTALES_GRAV, ...IMP_ADIC, 'MontoTotal!'], REF_OPC),
  33: ecf(['TipoeCF!', 'eNCF!', 'FechaVencimientoSecuencia!', 'IndicadorMontoGravado', 'TipoIngresos', 'TipoPago!', 'FechaLimitePago', 'TerminoPago', ['TablaFormasPago', [['FormaDePago!', ['FormaPago!', 'MontoPago!']]]]], COMPRADOR(false), [...TOTALES_GRAV, ...IMP_ADIC, 'MontoTotal!'], REF_OBL),
  34: ecf(['TipoeCF!', 'eNCF!', 'IndicadorNotaCredito!', 'IndicadorMontoGravado', 'TipoIngresos', 'TipoPago!', 'FechaLimitePago'], COMPRADOR(false),
    [...TOTALES_GRAV, 'MontoImpuestoAdicional', ['ImpuestosAdicionales', [['ImpuestoAdicional!', ['TipoImpuesto', 'TasaImpuestoAdicional', 'OtrosImpuestosAdicionales']]]], 'MontoTotal!'], REF_OBL),
  44: ecf(['TipoeCF!', 'eNCF!', 'FechaVencimientoSecuencia!', ...IDDOC_PAGO],
    ['Comprador!', ['RNCComprador', 'RazonSocialComprador!', 'CorreoComprador', 'DireccionComprador']],
    ['MontoExento', 'MontoImpuestoAdicional', ['ImpuestosAdicionales', [['ImpuestoAdicional!', ['TipoImpuesto!', 'TasaImpuestoAdicional!', 'OtrosImpuestosAdicionales!']]]], 'MontoTotal!'], REF_OPC),
  45: ecf(['TipoeCF!', 'eNCF!', 'FechaVencimientoSecuencia!', 'IndicadorMontoGravado', ...IDDOC_PAGO], COMPRADOR(true), [...TOTALES_GRAV, ...IMP_ADIC, 'MontoTotal!'], REF_OPC),
  RFCE: ['RFCE!', [['Encabezado!', ['Version!',
    ['IdDoc!', ['TipoeCF!', 'eNCF!', 'TipoIngresos!', 'TipoPago!', ['TablaFormasPago', [['FormaDePago', ['FormaPago', 'MontoPago']]]]]],
    ['Emisor!', ['RNCEmisor!', 'RazonSocialEmisor!', 'FechaEmision!']],
    ['Comprador!', ['RNCComprador', 'RazonSocialComprador']],
    ['Totales!', ['MontoGravadoTotal', 'MontoGravadoI1', 'MontoGravadoI2', 'MontoGravadoI3', 'MontoExento', 'TotalITBIS', 'TotalITBIS1', 'TotalITBIS2', 'TotalITBIS3', 'MontoImpuestoAdicional',
      ['ImpuestosAdicionales', [['ImpuestoAdicional', ['TipoImpuesto', 'OtrosImpuestosAdicionales']]]], 'MontoTotal!']],
    'CodigoSeguridadeCF!']]]],
};

export const NOMBRES_ECF = {
  31: 'Factura de Crédito Fiscal Electrónica', 32: 'Factura de Consumo Electrónica', 33: 'Nota de Débito Electrónica',
  34: 'Nota de Crédito Electrónica', 44: 'Comprobante Electrónico para Regímenes Especiales', 45: 'Comprobante Electrónico Gubernamental',
};
export const LIMITE_RFCE = 250000;

/* ---------------------------------------------------------------------------
   Árbol XML mínimo: { n: nombre, a: [[atributo, valor]], c: [hijos] } o { t: texto }
   --------------------------------------------------------------------------- */
const E = (n, a = [], c = []) => ({ n, a, c });
const T = (n, t) => ({ n, a: [], c: [{ t: String(t) }] });

// Construye el árbol siguiendo el esqueleto: omite opcionales vacíos, exige obligatorios.
export function buildFromSkeleton(skel, data, path = '') {
  const [spec, kids] = Array.isArray(skel) ? skel : [skel, null];
  const req = spec.includes('!');
  const name = spec.replace(/[!*]/g, '');
  const val = data == null ? undefined : data[name];
  const here = path ? path + '/' + name : name;
  const vacio = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  if (vacio(val)) {
    if (req && !kids) throw new Error(`Falta el dato obligatorio ${here}`);
    if (req && kids) return [E(name, [], kids.flatMap(k => buildFromSkeleton(k, {}, here)))];
    return [];
  }
  if (!kids) return [T(name, val)];
  const list = Array.isArray(val) ? val : [val];
  return list.map(v => {
    const children = kids.flatMap(k => buildFromSkeleton(k, v, here));
    return E(name, [], children);
  }).filter(el => el.c.length || req);
}

const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const escAttr = escText;

// Serialización compacta (sin espacios entre etiquetas).
export function serialize(node, decl = true) {
  const out = n => {
    if (n.t !== undefined) return escText(n.t);
    return `<${n.n}${(n.a || []).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}>${(n.c || []).map(out).join('')}</${n.n}>`;
  };
  return (decl ? '<?xml version="1.0" encoding="utf-8"?>' : '') + out(node);
}

// Canonicalización XML inclusiva 1.0 (sin comentarios) de un elemento y su subárbol.
// `inScope` = declaraciones de namespace heredadas de los ancestros (prefijo '' = por defecto).
const c14nText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const c14nAttr = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
export function c14n(node, inScope = {}, rendered = {}) {
  if (node.t !== undefined) return c14nText(node.t);
  const own = {}, attrs = [];
  for (const [k, v] of node.a || []) {
    if (k === 'xmlns') own[''] = v;
    else if (k.startsWith('xmlns:')) own[k.slice(6)] = v;
    else attrs.push([k, v]);
  }
  const scope = { ...inScope, ...own };
  const ns = Object.entries(scope).filter(([p, u]) => rendered[p] !== u && !(p === '' && u === '' && rendered[''] === undefined));
  ns.sort((x, y) => (x[0] === '' ? -1 : y[0] === '' ? 1 : x[0] < y[0] ? -1 : 1));
  const newRendered = { ...rendered };
  ns.forEach(([p, u]) => { newRendered[p] = u; });
  attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return `<${node.n}${ns.map(([p, u]) => (p ? ` xmlns:${p}="${c14nAttr(u)}"` : ` xmlns="${c14nAttr(u)}"`)).join('')}${attrs.map(([k, v]) => ` ${k}="${c14nAttr(v)}"`).join('')}>`
    + (node.c || []).map(ch => c14n(ch, scope, newRendered)).join('') + `</${node.n}>`;
}

// Parser XML sencillo (para la semilla y respuestas). Descarta texto que solo contiene espacios.
export function parseXml(str) {
  str = String(str).replace(/^﻿/, '');
  const root = { c: [] }, stack = [root];
  const ent = s => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
  });
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(str))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.c.push({ t: m[1] });
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const a = [];
      for (const am of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a.push([am[1], ent(am[2] ?? am[3])]);
      const el = { n: m[3], a, c: [] };
      top.c.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined && m[6].trim()) top.c.push({ t: ent(m[6]) });
  }
  return root.c.find(x => x.n);
}
export const textOf = (node, name) => {
  const f = n => (n.n === name ? n : (n.c || []).map(f).find(Boolean));
  const el = f(node);
  return el ? (el.c || []).map(x => x.t || '').join('') : '';
};

/* ---------------------------------------------------------------------------
   Firma XMLDSig enveloped
   --------------------------------------------------------------------------- */
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const enc = new TextEncoder();
export const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function importPrivateKey(pkcs8b64) {
  return crypto.subtle.importKey('pkcs8', unb64(pkcs8b64), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// Firma el árbol `root` (lo modifica agregando <Signature> como último hijo) y devuelve el XML y el SignatureValue.
export async function signTree(root, privateKey, certB64) {
  const digest = b64(await crypto.subtle.digest('SHA-256', enc.encode(c14n(root))));
  const signedInfo = E('SignedInfo', [], [
    E('CanonicalizationMethod', [['Algorithm', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315']]),
    E('SignatureMethod', [['Algorithm', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256']]),
    E('Reference', [['URI', '']], [
      E('Transforms', [], [E('Transform', [['Algorithm', 'http://www.w3.org/2000/09/xmldsig#enveloped-signature']])]),
      E('DigestMethod', [['Algorithm', 'http://www.w3.org/2001/04/xmlenc#sha256']]),
      T('DigestValue', digest),
    ]),
  ]);
  // Namespaces visibles para SignedInfo: los del elemento raíz + el de xmldsig por defecto.
  const rootNs = {};
  for (const [k, v] of root.a || []) { if (k === 'xmlns') rootNs[''] = v; else if (k.startsWith('xmlns:')) rootNs[k.slice(6)] = v; }
  const canonSI = c14n(signedInfo, { ...rootNs, '': DS }, {});
  const sig = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(canonSI)));
  root.c.push(E('Signature', [['xmlns', DS]], [
    signedInfo, T('SignatureValue', sig),
    E('KeyInfo', [], [E('X509Data', [], [T('X509Certificate', certB64)])]),
  ]));
  return { xml: serialize(root), signatureValue: sig };
}

/* ---------------------------------------------------------------------------
   Set de pruebas de certificación DGII: cada fila del Excel trae los valores con el nombre
   del elemento XML y sus índices de repetición, p. ej. NombreItem[3], TipoCodigo[3][1].
   --------------------------------------------------------------------------- */
const vacioSet = v => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '#e';
export function construirDesdeFila(esqueleto, fila) {
  const valores = new Map();
  for (const [k, v] of Object.entries(fila || {})) if (!vacioSet(v)) valores.set(k.trim().toLowerCase(), String(v).trim());
  // Nombres que la fila usa con N índices, p. ej. "tipoimpuesto|2" por TipoImpuesto[1][2]
  const conIndices = new Set([...valores.keys()].map(k => { const m = /^([^\[]+)((?:\[\d+\])+)$/.exec(k); return m ? m[1] + '|' + (m[2].match(/\[/g) || []).length : ''; }));
  const leer = (nombre, idx) => {
    const claves = [nombre + idx.map(i => `[${i}]`).join('')];
    // Columna sin el último índice (p. ej. FormaPago en vez de FormaPago[1]) solo si el Excel no usa ese nombre con todos
    // sus índices: así TipoImpuesto[2][1] (impuesto del ítem 2) no toma el valor de TipoImpuesto[2] (impuesto de los totales).
    if (idx.length && idx[idx.length - 1] === 1 && !conIndices.has(nombre.toLowerCase() + '|' + idx.length)) claves.push(nombre + idx.slice(0, -1).map(i => `[${i}]`).join(''));
    for (const k of claves) { const v = valores.get(k.toLowerCase()); if (v !== undefined) return v; }
    return undefined;
  };
  const nodo = (s, idx, padre) => {
    const [spec, kids] = Array.isArray(s) ? s : [s, null];
    const req = spec.includes('!'), rep = spec.includes('*');
    const nombre = spec.replace(/[!*]/g, '');
    const columna = nombre === 'NumeroLinea' && padre === 'DescuentoORecargo' ? 'NumeroLineaDoR' : nombre;
    const conTexto = n => n.t !== undefined || (n.c || []).some(conTexto);
    const una = ix => {
      if (!kids) { const v = leer(columna, ix); return v === undefined ? null : T(nombre, v); }
      const hijos = kids.flatMap(k => nodo(k, ix, nombre));
      // Los compuestos obligatorios vacíos (p. ej. <Retencion/>) no cuentan como dato de esta repetición.
      return hijos.some(conTexto) ? E(nombre, [], hijos) : null;
    };
    if (rep) {
      const out = [];
      for (let k = 1; k <= 10000; k++) { const el = una([...idx, k]); if (!el) break; out.push(el); }
      return out;
    }
    const el = una(idx);
    if (el) return [el];
    return req && kids ? [E(nombre, [], [])] : [];
  };
  return nodo(esqueleto, [], '')[0];
}

/* ---------------------------------------------------------------------------
   Verificación de firmas de XML recibidos (e-CF de proveedores, ACECF, semillas)
   --------------------------------------------------------------------------- */
// Lectura mínima de DER/ASN.1 para obtener la clave pública (SPKI) y el SN (OID 2.5.4.5) de un certificado X.509.
function derLeer(buf, pos) {
  let len = buf[pos + 1], p = pos + 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[p++]; }
  return { tag: buf[pos], hdr: pos, start: p, end: p + len };
}
function derHijos(buf, nodo) { const out = []; for (let p = nodo.start; p < nodo.end;) { const c = derLeer(buf, p); out.push(c); p = c.end; } return out; }
export function datosCertificado(der) {
  const [tbs] = derHijos(der, derLeer(der, 0));
  let f = derHijos(der, tbs);
  if (f[0].tag === 0xa0) f = f.slice(1); // versión explícita
  const [, , , , subject, spki] = f;
  let sn = '';
  for (const rdn of derHijos(der, subject)) for (const atv of derHijos(der, rdn)) {
    const [oid, val] = derHijos(der, atv);
    if (oid.end - oid.start === 3 && der[oid.start] === 0x55 && der[oid.start + 1] === 4 && der[oid.start + 2] === 5) sn = new TextDecoder().decode(der.slice(val.start, val.end));
  }
  return { spki: der.slice(spki.hdr, spki.end), sn };
}
const nsDe = node => { const o = {}; for (const [k, v] of node.a || []) { if (k === 'xmlns') o[''] = v; else if (k.startsWith('xmlns:')) o[k.slice(6)] = v; } return o; };
const local = n => (n || '').replace(/^.*:/, '');
const hijo = (node, nombre) => (node.c || []).find(x => local(x.n) === nombre);
const buscar = (node, nombre) => (local(node.n) === nombre ? node : (node.c || []).map(c => (c.n ? buscar(c, nombre) : null)).find(Boolean));
// Texto de la primera aparición de un elemento (ignora prefijos de namespace)
export const texto = (node, nombre) => { const el = node && buscar(node, nombre); return el ? (el.c || []).map(x => x.t || '').join('') : ''; };

// Verifica una firma XMLDSig enveloped (Reference URI="", C14N inclusivo, RSA-SHA256).
export async function verificarFirma(xmlStr) {
  let root;
  try { root = parseXml(xmlStr); } catch { root = null; }
  if (!root) return { ok: false, motivo: 'XML mal formado' };
  const i = (root.c || []).findIndex(n => local(n.n) === 'Signature');
  if (i < 0) return { ok: false, motivo: 'El XML no está firmado', root };
  const sig = root.c[i], si = hijo(sig, 'SignedInfo');
  try {
    const digestEsperado = texto(si, 'DigestValue').replace(/\s/g, '');
    const sinFirma = { ...root, c: root.c.filter((_, j) => j !== i) };
    const digest = b64(await crypto.subtle.digest('SHA-256', enc.encode(c14n(sinFirma))));
    if (digest !== digestEsperado) return { ok: false, motivo: 'El contenido no coincide con la firma (DigestValue)', root };
    const canon = c14n(si, { ...nsDe(root), ...nsDe(sig) }, {});
    const valor = texto(sig, 'SignatureValue').replace(/\s/g, '');
    const certB64 = texto(sig, 'X509Certificate').replace(/\s/g, '');
    const { spki, sn } = datosCertificado(unb64(certB64));
    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(valor), enc.encode(canon));
    return { ok, motivo: ok ? '' : 'Firma digital inválida', sn, root, signatureValue: valor };
  } catch (e) {
    return { ok: false, motivo: 'No se pudo verificar la firma: ' + (e.message || e), root };
  }
}

// Acuse de recibo (ARECF) que responde el receptor
export function construirARECF({ rncEmisor, rncComprador, encf, recibido, motivo, fechaHora }) {
  const [root] = buildFromSkeleton(['ARECF!', [['DetalleAcusedeRecibo!', ['Version!', 'RNCEmisor!', 'RNCComprador!', 'eNCF!', 'Estado!', 'CodigoMotivoNoRecibido', 'FechaHoraAcuseRecibo!']]]], {
    ARECF: { DetalleAcusedeRecibo: { Version: '1.0', RNCEmisor: rncEmisor, RNCComprador: rncComprador, eNCF: encf, Estado: recibido ? 0 : 1, CodigoMotivoNoRecibido: recibido ? undefined : motivo, FechaHoraAcuseRecibo: fechaHora } },
  });
  return root;
}

// Aprobación comercial (ACECF) que emite el comprador sobre un e-CF recibido
export function construirACECF({ rncEmisor, encf, fechaEmision, montoTotal, rncComprador, aprobado, motivo, fechaHora }) {
  const [root] = buildFromSkeleton(['ACECF!', [['DetalleAprobacionComercial!', ['Version!', 'RNCEmisor!', 'eNCF!', 'FechaEmision!', 'MontoTotal!', 'RNCComprador!', 'Estado!', 'DetalleMotivoRechazo', 'FechaHoraAprobacionComercial!']]]], {
    ACECF: { DetalleAprobacionComercial: { Version: '1.0', RNCEmisor: rncEmisor, eNCF: encf, FechaEmision: fechaEmision, MontoTotal: montoTotal, RNCComprador: rncComprador, Estado: aprobado ? 1 : 2, DetalleMotivoRechazo: aprobado ? undefined : txt(motivo, 250), FechaHoraAprobacionComercial: fechaHora } },
  });
  return root;
}

// Anulación de un rango de e-NCF no utilizados (ANECF). desde/hasta: números de secuencia.
export function construirANECF({ rncEmisor, tipo, desde, hasta, fechaHora }) {
  const encf = n => 'E' + tipo + String(n).padStart(10, '0');
  const cantidad = String(hasta - desde + 1);
  const [root] = buildFromSkeleton(['ANECF!', [
    ['Encabezado!', ['Version!', 'RncEmisor!', 'CantidadeNCFAnulados!', 'FechaHoraAnulacioneNCF!']],
    ['DetalleAnulacion!', [['Anulacion!', ['NoLinea!', 'TipoeCF!', ['TablaRangoSecuenciasAnuladaseNCF!', [['Secuencias!', ['SecuenciaeNCFDesde!', 'SecuenciaeNCFHasta!']]]], 'CantidadeNCFAnulados!']]]],
  ]], {
    ANECF: {
      Encabezado: { Version: '1.0', RncEmisor: rncEmisor, CantidadeNCFAnulados: cantidad, FechaHoraAnulacioneNCF: fechaHora },
      DetalleAnulacion: { Anulacion: { NoLinea: 1, TipoeCF: tipo, TablaRangoSecuenciasAnuladaseNCF: { Secuencias: { SecuenciaeNCFDesde: encf(desde), SecuenciaeNCFHasta: encf(hasta) } }, CantidadeNCFAnulados: cantidad } },
    },
  });
  return root;
}

/* ---------------------------------------------------------------------------
   Formatos
   --------------------------------------------------------------------------- */
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
export const monto = n => r2(n).toFixed(2);
const precio = n => { const v = Math.round(num(n) * 10000) / 10000; const s = v.toFixed(4).replace(/0{1,2}$/, ''); return s; };
export const fechaDGII = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}-${m}-${y}`; };
export function fechaHoraRD(date = new Date()) {
  const d = new Date(date.getTime() - 4 * 3600e3);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
const digits = v => String(v || '').replace(/\D/g, '');
const txt = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : undefined; };
const telefono = v => { const d = digits(v); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : undefined; };
const correo = v => { const s = String(v || '').trim(); return /^\w+([-+.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*$/.test(s) && s.length <= 80 ? s : undefined; };
const FORMA_PAGO = { Efectivo: 1, Cheque: 2, Transferencia: 2, Tarjeta: 3, Otro: 8 };
const IND_FACT = { 18: 1, 16: 2 };
// Tipos que el contribuyente emite al COMPRAR o pagar (no son ventas)
export const TIPOS_EGRESO = [41, 43, 47];

/* ---------------------------------------------------------------------------
   Datos del e-CF a partir de una factura de la app
   factura: { tipo:'E31', ncf, fecha, items[], propina, condicion, vencimiento, pagos[], cliente{}, numero, notas,
              retencion: { itbis: %, isr: % } (E41/E47) }
   empresa: { rnc, razonSocial, nombre, direccion, telefono, email, web, actividad }
   --------------------------------------------------------------------------- */
export function calcularECF(factura) {
  const tipo = Number(String(factura.tipo || '').slice(1));
  const ret = factura.retencion || {};
  const pctItbisRet = tipo === 41 ? num(ret.itbis) : 0;
  const pctIsrRet = tipo === 41 || tipo === 47 ? num(ret.isr) : 0;
  const lineas = (factura.items || []).map((it, i) => {
    const cant = r2(num(it.cantidad));
    const bruto = r2(cant * num(it.precio));
    const desc = r2(bruto * num(it.descuento) / 100);
    const base = r2(bruto - desc);
    const tasa = num(it.itbis);
    // ITBIS 0%: en exportaciones (E46) es "tasa 3"; en los demás tipos se trata como exento.
    const ind = IND_FACT[tasa] ?? (tipo === 46 ? 3 : 4);
    const itbis = r2(base * tasa / 100);
    return { i: i + 1, it, cant, bruto, desc, base, tasa, itbis, ind, itbisRet: r2(itbis * pctItbisRet / 100), isrRet: r2(base * pctIsrRet / 100) };
  });
  const suma = (f, k = 'base') => r2(lineas.filter(f).reduce((s, l) => s + l[k], 0));
  const g1 = suma(l => l.ind === 1), g2 = suma(l => l.ind === 2), g3 = suma(l => l.ind === 3), ex = suma(l => l.ind === 4);
  const t1 = suma(l => l.ind === 1, 'itbis'), t2 = suma(l => l.ind === 2, 'itbis');
  const baseTotal = r2(lineas.reduce((s, l) => s + l.base, 0));
  const propina = factura.propina ? r2(baseTotal * 0.10) : 0;
  const total = r2(g1 + g2 + g3 + ex + t1 + t2 + propina);
  return {
    lineas, g1, g2, g3, ex, t1, t2, gravado: r2(g1 + g2 + g3), itbis: r2(t1 + t2), propina, total,
    itbisRetenido: suma(() => true, 'itbisRet'), isrRetenido: suma(() => true, 'isrRet'), pctItbisRet, pctIsrRet,
  };
}

export function datosECF({ factura, empresa, original, vencimientoSecuencia, tiposProducto = {}, fechaHoraFirma }) {
  const tipo = Number(String(factura.tipo).slice(1));
  if (!ESQUEMAS[tipo]) throw new Error(`Tipo de e-CF no soportado: ${factura.tipo}`);
  const c = calcularECF(factura);
  const cli = factura.cliente || {};
  const rncCli = digits(cli.rnc);
  const tieneRnc = rncCli.length === 9 || rncCli.length === 11;
  const idExt = !tieneRnc ? txt(cli.idExtranjero, 20) : undefined;
  if (!c.lineas.length) throw new Error('El comprobante no tiene ítems.');
  if (!txt(empresa.direccion, 100)) throw new Error('Falta la dirección de la empresa (Empresas → Editar).');
  if ([31, 41, 44, 45].includes(tipo) && !tieneRnc) throw new Error(tipo === 41 ? 'La factura de compras (E41) requiere el RNC o la cédula del proveedor.' : 'Este tipo de e-CF requiere un cliente con RNC o cédula.');
  if ([46, 47].includes(tipo) && !tieneRnc && !idExt) throw new Error('Indica el RNC/cédula o el identificador extranjero del ' + (tipo === 47 ? 'proveedor.' : 'cliente.'));
  if (tipo === 32 && c.total >= LIMITE_RFCE && !tieneRnc && !idExt) throw new Error('Las facturas de consumo de RD$250,000 o más requieren RNC o cédula del cliente.');
  if (tipo === 44 && c.lineas.some(l => l.ind !== 4)) throw new Error('El e-CF 44 (Régimen Especial) solo admite ítems exentos de ITBIS.');
  if (tipo === 46 && c.lineas.some(l => l.ind !== 3)) throw new Error('Las exportaciones (E46) llevan ITBIS 0%: pon todos los ítems en "Exento / 0%".');
  if (tipo === 47 && c.lineas.some(l => l.ind !== 4)) throw new Error('Los pagos al exterior (E47) no llevan ITBIS: pon todos los ítems en "Exento".');
  const conVence = tipo !== 32 && tipo !== 34;
  if (conVence && !vencimientoSecuencia) throw new Error('La secuencia e-NCF no tiene fecha de vencimiento (Empresas → Secuencias).');

  const credito = factura.condicion === 'credito' && ![33, 34, 43].includes(tipo);
  const iddoc = {
    TipoeCF: tipo,
    eNCF: factura.ncf,
    FechaVencimientoSecuencia: conVence ? fechaDGII(vencimientoSecuencia) : undefined,
    IndicadorMontoGravado: c.lineas.some(l => l.ind === 1 || l.ind === 2) ? 0 : undefined,
    TipoIngresos: '01',
    TipoPago: credito ? 2 : 1,
    FechaLimitePago: credito && factura.vencimiento ? fechaDGII(factura.vencimiento) : undefined,
  };
  if (![34, 43].includes(tipo)) {
    const formas = {};
    for (const p of factura.pagos || []) { const k = FORMA_PAGO[p.metodo] || 8; formas[k] = r2((formas[k] || 0) + num(p.monto)); }
    const pagado = r2(Object.values(formas).reduce((s, v) => s + v, 0));
    if (c.total - pagado > 0.004) formas[credito ? 4 : 1] = r2((formas[credito ? 4 : 1] || 0) + c.total - pagado);
    const lista = Object.entries(formas).filter(([, v]) => v > 0).slice(0, 7).map(([k, v]) => ({ FormaPago: k, MontoPago: monto(v) }));
    if (lista.length) iddoc.TablaFormasPago = { FormaDePago: lista };
  }
  if (tipo === 34) {
    const dias = Math.round((new Date(factura.fecha + 'T12:00:00') - new Date(original.fecha + 'T12:00:00')) / 864e5);
    iddoc.IndicadorNotaCredito = dias > 30 ? 1 : 0;
  }

  const emisor = {
    RNCEmisor: digits(empresa.rnc),
    RazonSocialEmisor: txt(empresa.razonSocial || empresa.nombre, 150),
    NombreComercial: empresa.razonSocial && empresa.nombre !== empresa.razonSocial ? txt(empresa.nombre, 150) : undefined,
    DireccionEmisor: txt(empresa.direccion, 100),
    TablaTelefonoEmisor: telefono(empresa.telefono) ? { TelefonoEmisor: telefono(empresa.telefono) } : undefined,
    CorreoEmisor: correo(empresa.email),
    WebSite: txt(empresa.web, 50),
    ActividadEconomica: txt(empresa.actividad, 100),
    NumeroFacturaInterna: txt(factura.numero, 20),
    FechaEmision: fechaDGII(factura.fecha),
  };
  // En E41 y E47 la sección "Comprador" contiene los datos del proveedor. E43 no lleva comprador.
  const identificado = tieneRnc || !!idExt;
  const comprador = tipo === 43 ? undefined : {
    RNCComprador: tieneRnc ? rncCli : undefined,
    IdentificadorExtranjero: idExt,
    RazonSocialComprador: identificado || tipo === 44 ? txt(cli.nombre, 150) : undefined,
    CorreoComprador: identificado ? correo(cli.email) : undefined,
    DireccionComprador: identificado ? txt(cli.direccion, 100) : undefined,
  };

  const hay = ind => c.lineas.some(l => l.ind === ind);
  const totales = tipo === 44 ? { MontoExento: monto(c.ex) } : {
    MontoGravadoTotal: hay(1) || hay(2) || hay(3) ? monto(c.gravado) : undefined,
    MontoGravadoI1: hay(1) ? monto(c.g1) : undefined,
    MontoGravadoI2: hay(2) ? monto(c.g2) : undefined,
    MontoGravadoI3: hay(3) ? monto(c.g3) : undefined,
    MontoExento: hay(4) ? monto(c.ex) : undefined,
    ITBIS1: hay(1) ? 18 : undefined,
    ITBIS2: hay(2) ? 16 : undefined,
    ITBIS3: hay(3) ? 0 : undefined,
    TotalITBIS: hay(1) || hay(2) || hay(3) ? monto(c.itbis) : undefined,
    TotalITBIS1: hay(1) ? monto(c.t1) : undefined,
    TotalITBIS2: hay(2) ? monto(c.t2) : undefined,
    TotalITBIS3: hay(3) ? monto(0) : undefined,
  };
  if (c.propina > 0) {
    totales.MontoImpuestoAdicional = monto(c.propina);
    totales.ImpuestosAdicionales = { ImpuestoAdicional: [{ TipoImpuesto: '001', TasaImpuestoAdicional: 10, OtrosImpuestosAdicionales: monto(c.propina) }] };
  }
  totales.MontoTotal = monto(c.total);
  if (tipo === 41) { totales.TotalITBISRetenido = monto(c.itbisRetenido); totales.TotalISRRetencion = monto(c.isrRetenido); }
  if (tipo === 47) totales.TotalISRRetencion = monto(c.isrRetenido);

  const items = c.lineas.map(l => {
    const it = l.it;
    const nombre = String(it.descripcion || '').trim();
    const tipoBS = (it.tipo || tiposProducto[it.productoId]) === 'servicio' ? 2 : 1;
    return {
      NumeroLinea: l.i,
      TablaCodigosItem: txt(it.sku, 35) ? { CodigosItem: [{ TipoCodigo: 'Interna', CodigoItem: txt(it.sku, 35) }] } : undefined,
      IndicadorFacturacion: l.ind,
      Retencion: tipo === 41 || tipo === 47 ? {
        IndicadorAgenteRetencionoPercepcion: 1,
        MontoITBISRetenido: tipo === 41 ? monto(l.itbisRet) : undefined,
        MontoISRRetenido: monto(l.isrRet),
      } : undefined,
      NombreItem: txt(nombre, 80),
      IndicadorBienoServicio: tipoBS,
      DescripcionItem: nombre.length > 80 ? txt(nombre, 1000) : undefined,
      CantidadItem: l.cant.toFixed(2),
      PrecioUnitarioItem: precio(it.precio),
      DescuentoMonto: l.desc > 0 ? monto(l.desc) : undefined,
      TablaSubDescuento: l.desc > 0 ? { SubDescuento: [{ TipoSubDescuento: '%', SubDescuentoPorcentaje: r2(num(it.descuento)).toFixed(2), MontoSubDescuento: monto(l.desc) }] } : undefined,
      TablaImpuestoAdicional: c.propina > 0 ? { ImpuestoAdicional: [{ TipoImpuesto: '001' }] } : undefined,
      MontoItem: monto(l.base),
    };
  });

  let ref;
  if (tipo === 34 || tipo === 33) {
    if (!original) throw new Error('Falta el comprobante que modifica la nota.');
    const totOrig = num(original.total);
    ref = {
      NCFModificado: original.ncf,
      FechaNCFModificado: fechaDGII(original.fecha),
      CodigoModificacion: tipo === 34 && Math.abs(totOrig - c.total) < 0.01 ? 1 : 3,
      RazonModificacion: txt(factura.notas, 90),
    };
  }

  const data = {
    Encabezado: { Version: '1.0', IdDoc: iddoc, Emisor: emisor, Comprador: comprador, Totales: totales },
    DetallesItems: { Item: items },
    InformacionReferencia: ref,
    FechaHoraFirma: fechaHoraFirma,
  };
  return { tipo, data, calc: c };
}

// El orden de los elementos sale de los esquemas completos generados desde los XSD oficiales.
export function construirECF(args) {
  const { tipo, data, calc } = datosECF(args);
  const [root] = buildFromSkeleton(ESQUEMAS[tipo], { ECF: data });
  return { tipo, root, calc, data };
}

export function construirRFCE({ ecfData, codigoSeguridad }) {
  const h = ecfData.Encabezado;
  const t = h.Totales;
  const data = {
    Encabezado: {
      Version: '1.0',
      IdDoc: { TipoeCF: 32, eNCF: h.IdDoc.eNCF, TipoIngresos: h.IdDoc.TipoIngresos, TipoPago: h.IdDoc.TipoPago, TablaFormasPago: h.IdDoc.TablaFormasPago },
      Emisor: { RNCEmisor: h.Emisor.RNCEmisor, RazonSocialEmisor: h.Emisor.RazonSocialEmisor, FechaEmision: h.Emisor.FechaEmision },
      Comprador: { RNCComprador: h.Comprador.RNCComprador, RazonSocialComprador: h.Comprador.RazonSocialComprador },
      Totales: {
        MontoGravadoTotal: t.MontoGravadoTotal, MontoGravadoI1: t.MontoGravadoI1, MontoGravadoI2: t.MontoGravadoI2, MontoExento: t.MontoExento,
        TotalITBIS: t.TotalITBIS, TotalITBIS1: t.TotalITBIS1, TotalITBIS2: t.TotalITBIS2,
        MontoImpuestoAdicional: t.MontoImpuestoAdicional,
        ImpuestosAdicionales: t.ImpuestosAdicionales ? { ImpuestoAdicional: t.ImpuestosAdicionales.ImpuestoAdicional.map(x => ({ TipoImpuesto: x.TipoImpuesto, OtrosImpuestosAdicionales: x.OtrosImpuestosAdicionales })) } : undefined,
        MontoTotal: t.MontoTotal,
      },
      CodigoSeguridadeCF: codigoSeguridad,
    },
  };
  const [root] = buildFromSkeleton(SKELETONS.RFCE, { RFCE: data });
  return root;
}

/* ---------------------------------------------------------------------------
   Cliente de servicios DGII
   --------------------------------------------------------------------------- */
export const AMBIENTES = {
  testecf: { nombre: 'Pre-certificación (TesteCF)', ecf: 'https://ecf.dgii.gov.do/testecf', fc: 'https://fc.dgii.gov.do/testecf' },
  certecf: { nombre: 'Certificación (CerteCF)', ecf: 'https://ecf.dgii.gov.do/certecf', fc: 'https://fc.dgii.gov.do/certecf' },
  ecf: { nombre: 'Producción', ecf: 'https://ecf.dgii.gov.do/ecf', fc: 'https://fc.dgii.gov.do/ecf' },
};

const UA = 'FacturacionRD/1.0 (+https://facturacion-rd.ipmplaza.workers.dev)';
async function leerRespuesta(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch {
    const limpio = t.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { raw: `HTTP ${r.status}${limpio ? ' · ' + limpio.slice(0, 300) : ''}` };
  }
}
// multipart/form-data armado a mano (cuerpo de tamaño fijo, sin chunked), campo "xml".
function multipart(xml, fileName, headers) {
  const boundary = '----FacturacionRD' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  const body = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="xml"; filename="${fileName}"\r\nContent-Type: text/xml\r\n\r\n`
    + xml + `\r\n--${boundary}--\r\n`);
  return { method: 'POST', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, body };
}

const tokens = new Map(); // caché por ambiente + RNC del certificado
export async function obtenerToken(ambiente, privateKey, certB64, cacheKey = '') {
  const key = ambiente + '|' + cacheKey;
  const hit = tokens.get(key);
  if (hit && hit.exp - Date.now() > 120e3) return hit.token;
  const base = AMBIENTES[ambiente].ecf + '/autenticacion/api/autenticacion';
  const r1 = await fetch(base + '/semilla', { headers: { 'user-agent': UA, accept: '*/*' } });
  if (!r1.ok) throw new Error(`DGII semilla: HTTP ${r1.status}`);
  const semilla = parseXml(await r1.text());
  if (!semilla) throw new Error('DGII: respuesta de semilla no válida');
  const { xml } = await signTree(semilla, privateKey, certB64);
  const r2_ = await fetch(base + '/validarsemilla', multipart(xml, 'semilla.xml', { 'user-agent': UA, accept: 'application/json' }));
  const d = await leerRespuesta(r2_);
  if (!r2_.ok || !d.token) throw new Error('DGII autenticación: ' + (d.mensaje || d.message || d.error || d.raw || `HTTP ${r2_.status}`));
  tokens.set(key, { token: d.token, exp: Date.parse(d.expira) || Date.now() + 50 * 60e3 });
  return d.token;
}

export async function enviarECF(ambiente, token, xml, fileName) {
  const r = await fetch(AMBIENTES[ambiente].ecf + '/recepcion/api/facturaselectronicas', multipart(xml, fileName, { 'user-agent': UA, accept: 'application/json', authorization: 'Bearer ' + token }));
  const d = await leerRespuesta(r);
  if (!r.ok || !d.trackId) throw new Error('DGII recepción: ' + ([d.error, d.mensaje, d.message, d.raw].filter(Boolean).join(' · ') || `HTTP ${r.status}`));
  return d;
}

export async function enviarRFCE(ambiente, token, xml, fileName) {
  const r = await fetch(AMBIENTES[ambiente].fc + '/recepcionfc/api/recepcion/ecf', multipart(xml, fileName, { 'user-agent': UA, accept: 'application/json', authorization: 'Bearer ' + token }));
  const d = await leerRespuesta(r);
  if (!r.ok && !d.estado) throw new Error('DGII recepción RFCE: ' + (d.mensaje || d.message || d.raw || `HTTP ${r.status}`));
  return d;
}

// Aprobación comercial (ACECF) hacia la DGII
export const ESQUEMA_ACECF = ['ACECF!', [['DetalleAprobacionComercial!', ['Version!', 'RNCEmisor!', 'eNCF!', 'FechaEmision!', 'MontoTotal!', 'RNCComprador!', 'Estado!', 'DetalleMotivoRechazo', 'FechaHoraAprobacionComercial!']]]];
export async function enviarACECF(ambiente, token, xml, fileName) {
  const r = await fetch(AMBIENTES[ambiente].ecf + '/aprobacioncomercial/api/aprobacioncomercial', multipart(xml, fileName, { 'user-agent': UA, accept: 'application/json', authorization: 'Bearer ' + token }));
  const d = await leerRespuesta(r);
  if (!r.ok && !d.estado) throw new Error('DGII aprobación comercial: ' + ([].concat(d.mensaje || []).join(' · ') || d.message || d.raw || `HTTP ${r.status}`));
  return d;
}

// Anulación de rangos de e-NCF (ANECF). Responde { rnc, codigo, nombre, mensajes }.
export async function enviarANECF(ambiente, token, xml, fileName) {
  const r = await fetch(AMBIENTES[ambiente].ecf + '/anulacionrangos/api/operaciones/anularrango', multipart(xml, fileName, { 'user-agent': UA, accept: 'application/json', authorization: 'Bearer ' + token }));
  const d = await leerRespuesta(r);
  const msgs = [].concat(d.mensajes || d.mensaje || []).map(m => (typeof m === 'string' ? m : (m && (m.valor || m.mensaje)) || '')).filter(Boolean);
  if (!r.ok) throw new Error('DGII anulación: ' + ([d.nombre, ...msgs, d.message, d.raw].filter(Boolean).join(' · ') || `HTTP ${r.status}`));
  return { ...d, mensajes: msgs };
}

export async function consultarResultado(ambiente, token, trackId) {
  const r = await fetch(AMBIENTES[ambiente].ecf + '/consultaresultado/api/consultas/estado?trackid=' + encodeURIComponent(trackId), {
    headers: { 'user-agent': UA, accept: 'application/json', authorization: 'Bearer ' + token },
  });
  const d = await leerRespuesta(r);
  if (!r.ok) throw new Error('DGII consulta: ' + (d.mensaje || d.message || d.raw || `HTTP ${r.status}`));
  return d;
}

// URL del código QR de la representación impresa
export function urlTimbre({ ambiente, rncEmisor, rncComprador, encf, fechaEmision, montoTotal, fechaFirma, codigoSeguridad, rfce }) {
  const e = encodeURIComponent;
  if (rfce) return `${AMBIENTES[ambiente].fc}/consultatimbrefc?rncemisor=${e(rncEmisor)}&encf=${e(encf)}&montototal=${e(montoTotal)}&codigoseguridad=${e(codigoSeguridad)}`;
  return `${AMBIENTES[ambiente].ecf}/consultatimbre?rncemisor=${e(rncEmisor)}${rncComprador ? `&rnccomprador=${e(rncComprador)}` : ''}&encf=${e(encf)}&fechaemision=${e(fechaEmision)}&montototal=${e(montoTotal)}&fechafirma=${e(fechaFirma).replace(/%3A/g, ':')}&codigoseguridad=${e(codigoSeguridad)}`;
}
