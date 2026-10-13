// Worker de Cloudflare: sirve la app (carpeta web/) y expone:
//   /api/rnc      consulta el RNC/cédula en la página pública de la DGII
//   /api/ecf/*    facturación electrónica (firma y envío de e-CF a la DGII)
import {
  construirECF, construirRFCE, calcularECF, signTree, importPrivateKey, obtenerToken, enviarECF, enviarRFCE,
  consultarResultado, urlTimbre, fechaHoraRD, b64, unb64, LIMITE_RFCE, AMBIENTES, parseXml, construirDesdeFila, ESQUEMAS, ESQUEMA_ACECF, enviarACECF,
} from './ecf.js';

const SB_URL = 'https://gwvqpnmwqvqrmsbpwmhj.supabase.co';
const SB_KEY = 'sb_publishable_JG_uubMg9brkjoIz7x-Xmw_uCyvz3F6';
const DGII_URL = 'https://dgii.gov.do/app/WebApps/ConsultasWeb2/ConsultasWeb/consultas/rnc.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CAMPOS = {
  'cedula/rnc': 'rnc',
  'nombre/razon social': 'razonSocial',
  'nombre comercial': 'nombreComercial',
  'categoria': 'categoria',
  'regimen de pagos': 'regimen',
  'estado': 'estado',
  'actividad economica': 'actividad',
  'administracion local': 'administracion',
  'facturador electronico': 'facturadorElectronico',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rnc') return consultarRNC(url, ctx);
    if (url.pathname.startsWith('/api/ecf/')) {
      try {
        if (request.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);
        const jwt = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!jwt) return json({ ok: false, error: 'Debes iniciar sesión.' }, 401);
        const body = await request.json().catch(() => ({}));
        const ruta = url.pathname.slice('/api/ecf/'.length);
        if (ruta === 'certificado') return json(await guardarCertificado(env, jwt, body));
        if (ruta === 'emitir') return json(await emitirECF(env, jwt, body));
        if (ruta === 'consultar') return json(await consultarECF(env, jwt, body));
        if (ruta === 'firmar') return json(await firmarXmlLibre(env, jwt, body));
        if (ruta === 'set') return json(await procesarSet(env, jwt, body));
        return json({ ok: false, error: 'Ruta no encontrada' }, 404);
      } catch (err) {
        return json({ ok: false, error: String(err && err.message || err) }, 400);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- Facturación electrónica ---------------- */

// Acceso a Supabase con el token del usuario: las políticas RLS deciden qué puede leer o escribir.
async function sb(jwt, path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, authorization: `Bearer ${jwt}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error((d && (d.message || d.error_description || d.error)) || `Supabase HTTP ${r.status}`);
  return d;
}
const uno = rows => (Array.isArray(rows) ? rows[0] : rows);

async function claveMaestra(env) {
  if (!env.ECF_MASTER_KEY) throw new Error('Falta configurar el secreto ECF_MASTER_KEY en Cloudflare (Worker → Settings → Variables and Secrets).');
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.ECF_MASTER_KEY));
  return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function guardarCertificado(env, jwt, { empresaId, ambiente, pkcs8, cert, info }) {
  if (!empresaId) throw new Error('Falta la empresa.');
  if (ambiente && !AMBIENTES[ambiente]) throw new Error('Ambiente inválido.');
  const fila = { empresa_id: empresaId };
  if (ambiente) fila.ambiente = ambiente;
  if (pkcs8 && cert) {
    await importPrivateKey(pkcs8); // valida que la clave sea utilizable
    const key = await claveMaestra(env);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrip = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(pkcs8));
    Object.assign(fila, { cert_b64: cert, key_enc: b64(encrip), key_iv: b64(iv), cert_info: info || {} });
  }
  const r = await sb(jwt, 'ecf_config?on_conflict=empresa_id', {
    method: 'POST', body: JSON.stringify(fila),
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
  });
  const c = uno(r);
  if (!c) throw new Error('No tienes permiso para configurar esta empresa.');
  return { ok: true, ambiente: c.ambiente, certInfo: c.cert_info };
}

async function firmante(env, jwt, empresaId) {
  const c = uno(await sb(jwt, `ecf_config?empresa_id=eq.${empresaId}&select=*`));
  if (!c || !c.key_enc) throw new Error('La empresa no tiene certificado digital cargado (Empresas → Facturación electrónica).');
  const key = await claveMaestra(env);
  let pkcs8;
  try {
    pkcs8 = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(c.key_iv) }, key, unb64(c.key_enc)));
  } catch { throw new Error('No se pudo descifrar el certificado. ¿Cambió el secreto ECF_MASTER_KEY? Vuelve a cargar el certificado.'); }
  return { ambiente: c.ambiente, privateKey: await importPrivateKey(pkcs8), cert: c.cert_b64, certRnc: (c.cert_info && c.cert_info.sn) || '' };
}

const facturaDeFila = r => ({ pagos: [], items: [], ...(r.data || {}), id: r.id, numero: r.numero, tipo: r.tipo, ncf: r.ncf || '', fecha: (r.data && r.data.fecha) || r.fecha });

// Guarda data.ecf en la factura sin pisar cambios concurrentes.
async function guardarEstado(jwt, id, ecf) {
  for (let i = 0; i < 3; i++) {
    const row = uno(await sb(jwt, `facturas?id=eq.${id}&select=data,updated_at`));
    const data = { ...(row.data || {}), ecf: { ...((row.data || {}).ecf || {}), ...ecf } };
    const upd = await sb(jwt, `facturas?id=eq.${id}&updated_at=eq.${encodeURIComponent(row.updated_at)}`, {
      method: 'PATCH', body: JSON.stringify({ data }), headers: { prefer: 'return=representation' },
    });
    if (upd && upd.length) return data.ecf;
  }
  throw new Error('No se pudo guardar el estado del e-CF (la factura cambió). Consulta el estado de nuevo.');
}

const ESTADOS = { 0: 'No encontrado', 1: 'Aceptado', 2: 'Rechazado', 3: 'En Proceso', 4: 'Aceptado Condicional' };
const mensajes = d => (d.mensajes || [])
  .map(m => (typeof m === 'string' ? m : (m && m.valor ? (m.codigo !== undefined && m.codigo !== '' ? `${m.codigo}: ${m.valor}` : m.valor) : '')))
  .filter(Boolean);

async function emitirECF(env, jwt, { facturaId }) {
  const row = uno(await sb(jwt, `facturas?id=eq.${facturaId}&select=*`));
  if (!row) throw new Error('Factura no encontrada.');
  const factura = facturaDeFila(row);
  if (!/^E\d\d$/.test(factura.tipo)) throw new Error('Este comprobante no es electrónico.');
  if (factura.estado === 'anulada') throw new Error('El comprobante está anulado.');
  const prev = factura.ecf || {};
  if (['Aceptado', 'Aceptado Condicional', 'En Proceso'].includes(prev.estado)) throw new Error(`Este e-CF ya fue enviado (estado: ${prev.estado}).`);
  if (prev.estado === 'Rechazado' && prev.secuenciaUtilizada) throw new Error('La DGII rechazó este e-CF y su e-NCF ya no se puede reutilizar. Emite un comprobante nuevo.');

  const [emp, seq] = await Promise.all([
    sb(jwt, `empresas?id=eq.${row.empresa_id}&select=*`).then(uno),
    sb(jwt, `secuencias?empresa_id=eq.${row.empresa_id}&tipo=eq.${factura.tipo}&select=*`).then(uno),
  ]);
  const empresa = { ...(emp.data || {}), nombre: emp.nombre };
  let original = null;
  if (factura.tipo === 'E34' || factura.tipo === 'E33') {
    const o = uno(await sb(jwt, `facturas?id=eq.${factura.facturaAfectadaId}&select=*`));
    if (!o) throw new Error('No se encontró la factura que afecta la nota.');
    const of = facturaDeFila(o);
    if (!of.ncf) throw new Error('La factura afectada no tiene NCF.');
    original = { ncf: of.ncf, fecha: of.fecha, total: calcularECF(of).total };
  }
  const ids = [...new Set((factura.items || []).map(i => i.productoId).filter(Boolean))];
  const tiposProducto = {};
  if (ids.length) (await sb(jwt, `productos?id=in.(${ids.join(',')})&select=id,data`)).forEach(p => { tiposProducto[p.id] = p.data && p.data.tipo; });

  const s = await firmante(env, jwt, row.empresa_id);
  const fechaFirma = fechaHoraRD();
  const { root, calc, tipo, data } = construirECF({ factura, empresa, original, vencimientoSecuencia: seq && seq.vence, tiposProducto, fechaHoraFirma: fechaFirma });
  const { xml, signatureValue } = await signTree(root, s.privateKey, s.cert);
  const codigoSeguridad = signatureValue.slice(0, 6);
  const rncEmisor = String(empresa.rnc || '').replace(/\D/g, '');
  const fileName = `${rncEmisor}${factura.ncf}.xml`;
  const token = await obtenerToken(s.ambiente, s.privateKey, s.cert, rncEmisor);
  const rfce = tipo === 32 && calc.total < LIMITE_RFCE;
  const rncComprador = String((factura.cliente || {}).rnc || '').replace(/\D/g, '');
  const base = {
    ambiente: s.ambiente, codigoSeguridad, fechaFirma, xml, rfce, enviado: new Date().toISOString(), error: '',
    montoTotal: calc.total.toFixed(2),
    qr: urlTimbre({
      ambiente: s.ambiente, rncEmisor, rncComprador: [9, 11].includes(rncComprador.length) ? rncComprador : '', encf: factura.ncf,
      fechaEmision: factura.fecha.split('-').reverse().join('-'), montoTotal: calc.total.toFixed(2), fechaFirma, codigoSeguridad, rfce,
    }),
  };

  let res, xmlRfce;
  // Si el envío falla, se guardan igual los XML firmados (sin estado) para poder revisarlos y reenviar.
  const fallo = async err => {
    await guardarEstado(jwt, facturaId, { ...base, xmlRfce, estado: '', error: String(err.message || err) }).catch(() => { });
    throw err;
  };
  if (rfce) {
    const rf = construirRFCE({ ecfData: data, codigoSeguridad });
    const firmado = await signTree(rf, s.privateKey, s.cert);
    xmlRfce = firmado.xml;
    const d = await enviarRFCE(s.ambiente, token, firmado.xml, fileName).catch(fallo);
    res = { ...base, xmlRfce: firmado.xml, codigo: d.codigo, estado: d.estado || ESTADOS[d.codigo] || 'Desconocido', mensajes: mensajes(d), secuenciaUtilizada: d.secuenciaUtilizada !== false };
  } else {
    const d = await enviarECF(s.ambiente, token, xml, fileName).catch(fallo);
    res = { ...base, trackId: d.trackId, estado: 'En Proceso', codigo: 3, mensajes: [] };
    for (const espera of [400, 900, 1500, 2500]) {
      await new Promise(r => setTimeout(r, espera));
      const q = await consultarResultado(s.ambiente, token, d.trackId).catch(() => null);
      if (q && q.codigo !== 3 && q.codigo !== 0) {
        Object.assign(res, { codigo: q.codigo, estado: q.estado || ESTADOS[q.codigo], mensajes: mensajes(q), secuenciaUtilizada: q.secuenciaUtilizada !== false, fechaRecepcion: q.fechaRecepcion });
        break;
      }
    }
  }
  const ecf = await guardarEstado(jwt, facturaId, res);
  return { ok: true, ecf };
}

// Set de pruebas de certificación: genera el XML desde la fila del Excel de la DGII, lo firma y lo envía.
//   accion: 'ecf' (firmar + enviar a recepción), 'firmar' (solo firmar), 'rfce' (resumen de consumo), 'consultar' (trackId)
async function procesarSet(env, jwt, { empresaId, ambiente = 'certecf', accion, fila, codigoSeguridad, trackId }) {
  if (!AMBIENTES[ambiente]) throw new Error('Ambiente inválido.');
  const s = await firmante(env, jwt, empresaId);
  const token = await obtenerToken(ambiente, s.privateKey, s.cert, 'empresa:' + empresaId);
  const resumen = q => ({ trackId: q.trackId, codigo: q.codigo, estado: q.estado || ESTADOS[q.codigo], mensajes: mensajes(q), secuenciaUtilizada: q.secuenciaUtilizada });
  if (accion === 'consultar') return { ok: true, ...resumen(await consultarResultado(ambiente, token, trackId)) };
  if (accion === 'acecf') {
    // El XSD exige el monto con exactamente 2 decimales; Excel lo entrega como número (18283 → 18283.00).
    const f = { ...fila, MontoTotal: Number(String(fila.MontoTotal).replace(/,/g, '')).toFixed(2), FechaHoraAprobacionComercial: fila.FechaHoraAprobacionComercial || fechaHoraRD() };
    if (!f.eNCF || !f.RNCComprador) throw new Error('Fila de aprobación comercial incompleta.');
    const { xml } = await signTree(construirDesdeFila(ESQUEMA_ACECF, f), s.privateKey, s.cert);
    const d = await enviarACECF(ambiente, token, xml, String(f.RNCComprador).trim() + String(f.eNCF).trim() + '.xml');
    const msgs = [].concat(d.mensaje || []).filter(Boolean);
    return { ok: true, xml, codigo: d.codigo, estado: d.estado || '', mensajes: msgs };
  }
  if (!fila || !fila.ENCF || !fila.RNCEmisor) throw new Error('Fila del set incompleta (falta ENCF o RNCEmisor).');
  const encf = String(fila.ENCF).trim(), fileName = String(fila.RNCEmisor).trim() + encf + '.xml';
  if (accion === 'rfce') {
    if (!codigoSeguridad) throw new Error('Falta el código de seguridad del e-CF completo.');
    const { xml } = await signTree(construirDesdeFila(ESQUEMAS.RFCE, { ...fila, CodigoSeguridadeCF: codigoSeguridad }), s.privateKey, s.cert);
    const d = await enviarRFCE(ambiente, token, xml, fileName);
    return { ok: true, xmlRfce: xml, codigo: d.codigo, estado: d.estado || ESTADOS[d.codigo], mensajes: mensajes(d), secuenciaUtilizada: d.secuenciaUtilizada };
  }
  const esquema = ESQUEMAS[String(fila.TipoeCF).trim()];
  if (!esquema) throw new Error('Tipo de e-CF no soportado: ' + fila.TipoeCF);
  const fechaFirma = fechaHoraRD();
  const { xml, signatureValue } = await signTree(construirDesdeFila(esquema, { ...fila, FechaHoraFirma: fechaFirma }), s.privateKey, s.cert);
  const base = { ok: true, xml, codigoSeguridad: signatureValue.slice(0, 6), fechaFirma };
  if (accion === 'firmar') return base;
  const d = await enviarECF(ambiente, token, xml, fileName);
  let res = { ...base, trackId: d.trackId, codigo: 3, estado: 'En Proceso', mensajes: [] };
  for (const espera of [500, 1000, 1500, 2500]) {
    await new Promise(r => setTimeout(r, espera));
    const q = await consultarResultado(ambiente, token, d.trackId).catch(() => null);
    if (q && q.codigo !== 3 && q.codigo !== 0) { res = { ...res, ...resumen(q), trackId: d.trackId }; break; }
  }
  return res;
}

// Firma con el certificado de la empresa un XML cualquiera (p. ej. los que pide la DGII en la postulación).
async function firmarXmlLibre(env, jwt, { empresaId, xml }) {
  if (!empresaId || !xml) throw new Error('Falta la empresa o el XML.');
  if (xml.length > 2e6) throw new Error('El XML es demasiado grande.');
  const s = await firmante(env, jwt, empresaId);
  const root = parseXml(xml);
  if (!root) throw new Error('El archivo no es un XML válido.');
  if ((root.c || []).some(n => /(^|:)Signature$/.test(n.n || ''))) throw new Error('Este XML ya está firmado.');
  const { xml: firmado } = await signTree(root, s.privateKey, s.cert);
  return { ok: true, xml: firmado };
}

async function consultarECF(env, jwt, { facturaId }) {
  const row = uno(await sb(jwt, `facturas?id=eq.${facturaId}&select=*`));
  if (!row) throw new Error('Factura no encontrada.');
  const prev = (row.data && row.data.ecf) || {};
  if (!prev.trackId) throw new Error(prev.rfce ? 'Las facturas de consumo menores a RD$250,000 se validan al enviarse; no tienen trackId.' : 'Este e-CF aún no se ha enviado.');
  const s = await firmante(env, jwt, row.empresa_id);
  const emp = uno(await sb(jwt, `empresas?id=eq.${row.empresa_id}&select=data`));
  const token = await obtenerToken(prev.ambiente || s.ambiente, s.privateKey, s.cert, String((emp.data || {}).rnc || '').replace(/\D/g, ''));
  const q = await consultarResultado(prev.ambiente || s.ambiente, token, prev.trackId);
  const ecf = await guardarEstado(jwt, facturaId, {
    codigo: q.codigo, estado: q.estado || ESTADOS[q.codigo], mensajes: mensajes(q),
    secuenciaUtilizada: q.secuenciaUtilizada !== false, fechaRecepcion: q.fechaRecepcion, consultado: new Date().toISOString(),
  });
  return { ok: true, ecf };
}


function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  });
}

async function consultarRNC(url, ctx) {
  const rnc = (url.searchParams.get('rnc') || '').replace(/\D/g, '');
  if (rnc.length !== 9 && rnc.length !== 11) return json({ ok: false, error: 'El RNC debe tener 9 dígitos o la cédula 11.' }, 400);

  const cacheKey = new Request(`https://cache.local/rnc/${rnc}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    // 1) Obtener el formulario (ViewState y cookies de sesión)
    const r1 = await fetch(DGII_URL, { headers: { 'user-agent': UA } });
    const html1 = await r1.text();
    const cookies = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || ''])
      .map(c => c.split(';')[0]).filter(Boolean).join('; ');
    const hidden = name => {
      const m = html1.match(new RegExp(`id="${name}" value="([^"]*)"`));
      return m ? decode(m[1]) : '';
    };

    // 2) Enviar la búsqueda por RNC (postback de ASP.NET)
    const body = new URLSearchParams({
      __EVENTTARGET: 'ctl00$cphMain$btnBuscarPorRNC',
      __EVENTARGUMENT: '',
      __VIEWSTATE: hidden('__VIEWSTATE'),
      __VIEWSTATEGENERATOR: hidden('__VIEWSTATEGENERATOR'),
      __EVENTVALIDATION: hidden('__EVENTVALIDATION'),
      'ctl00$cphMain$txtRNCCedula': rnc,
      'ctl00$cphMain$txtRazonSocial': '',
      'ctl00$cphMain$hidActiveTab': '',
    });
    const r2 = await fetch(DGII_URL, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, referer: DGII_URL, ...(cookies ? { cookie: cookies } : {}) },
    });
    const html = await r2.text();

    const datos = {};
    const t = html.indexOf('cphMain_dvDatosContribuyentes');
    if (t >= 0) {
      const tabla = html.slice(t, html.indexOf('</table>', t));
      for (const m of tabla.matchAll(/<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
        const k = CAMPOS[norm(clean(m[1]))];
        if (k) datos[k] = clean(m[2]);
      }
    }
    let res;
    if (datos.razonSocial) {
      res = { ok: true, ...datos, rnc };
    } else {
      const info = html.match(/id="cphMain_lblInformacion"[^>]*>([\s\S]*?)<\/span>/);
      const msg = info ? clean(info[1]) : '';
      res = { ok: false, rnc, error: msg || 'El RNC/cédula no se encuentra inscrito en la DGII.' };
    }
    const resp = json(res, 200, { 'cache-control': `public, max-age=${res.ok ? 43200 : 600}` });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (err) {
    return json({ ok: false, error: 'No se pudo consultar la DGII en este momento. Intenta de nuevo.' }, 502);
  }
}

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const clean = s => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
