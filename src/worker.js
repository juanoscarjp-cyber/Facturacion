// Worker de Cloudflare: sirve la app (carpeta web/) y expone:
//   /api/rnc      consulta el RNC/cédula en la página pública de la DGII
//   /api/ecf/*    facturación electrónica (firma y envío de e-CF a la DGII)
import {
  construirECF, construirRFCE, calcularECF, signTree, importPrivateKey, obtenerToken, enviarECF, enviarRFCE,
  consultarResultado, urlTimbre, fechaHoraRD, b64, unb64, LIMITE_RFCE, AMBIENTES, parseXml, construirDesdeFila, ESQUEMAS, ESQUEMA_ACECF, enviarACECF,
  verificarFirma, texto, construirARECF, construirACECF, serialize,
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
    // Servicios de emisor/receptor electrónico que la DGII y otros contribuyentes invocan (no distinguen mayúsculas)
    const ruta = url.pathname.toLowerCase().replace(/\/+$/, '');
    if (ruta.includes('/fe/')) {
      try {
        if (ruta.endsWith('/fe/autenticacion/api/semilla') && request.method === 'GET') return await feSemilla(env);
        if (ruta.endsWith('/fe/autenticacion/api/validacioncertificado') && request.method === 'POST') return await feValidarCertificado(env, request);
        if (ruta.endsWith('/fe/recepcion/api/ecf') && request.method === 'POST') return await feRecepcion(env, request);
        if (ruta.endsWith('/fe/aprobacioncomercial/api/ecf') && request.method === 'POST') return await feAprobacionComercial(env, request);
        return json({ mensaje: 'Recurso no encontrado' }, 404);
      } catch (err) {
        console.log('FE error', request.method, url.pathname, String(err && err.message || err));
        return json({ mensaje: String(err && err.message || err) }, err && err.status || 400);
      }
    }
    if (url.pathname === '/api/invitar') {
      try {
        if (request.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);
        const jwt = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!jwt) return json({ ok: false, error: 'Debes iniciar sesión.' }, 401);
        return json(await invitarUsuario(env, jwt, await request.json().catch(() => ({})), url.origin + '/'));
      } catch (err) {
        return json({ ok: false, error: String(err && err.message || err) }, 400);
      }
    }
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
        if (ruta === 'aprobar') return json(await aprobarRecibido(env, jwt, body));
        return json({ ok: false, error: 'Ruta no encontrada' }, 404);
      } catch (err) {
        return json({ ok: false, error: String(err && err.message || err) }, 400);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- Servicios receptores /fe/* ---------------- */

// Acceso de servicio a Supabase (sin usuario): necesario porque la DGII llama sin sesión.
async function sbAdmin(env, path, opts = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) throw Object.assign(new Error('Servicio no configurado (falta SUPABASE_SERVICE_KEY).'), { status: 503 });
  const auth = key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {};
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts, headers: { apikey: key, ...auth, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error((d && (d.message || d.error)) || `Supabase HTTP ${r.status}`);
  return d;
}
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(env, texto) {
  if (!env.ECF_MASTER_KEY) throw new Error('Servicio no configurado.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ECF_MASTER_KEY + '|fe-receptor'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(texto)));
}
const xmlResp = (xml, status = 200) => new Response(xml, { status, headers: { 'content-type': 'application/xml; charset=utf-8' } });
const fechaUniversal = d => d.toISOString().slice(0, 19) + 'Z';
const soloDigitos = v => String(v || '').replace(/\D/g, '');

async function leerXmlEntrante(request) {
  const tipo = request.headers.get('content-type') || '';
  if (tipo.includes('multipart/form-data')) {
    const fd = await request.formData();
    const f = fd.get('xml') || [...fd.values()][0];
    if (!f) throw new Error('Falta el archivo xml.');
    return typeof f === 'string' ? f : await f.text();
  }
  return await request.text();
}

// Autenticación: semilla con valor firmado (HMAC) y vigencia de 10 minutos
async function feSemilla(env) {
  const t = Date.now(), rnd = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const valor = `${t}.${rnd}.${await hmac(env, `${t}.${rnd}`)}`;
  const fecha = new Date(t - 4 * 3600e3).toISOString().replace('Z', '-04:00');
  return xmlResp(`<?xml version="1.0" encoding="utf-8"?><SemillaModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><valor>${valor}</valor><fecha>${fecha}</fecha></SemillaModel>`);
}
async function feValidarCertificado(env, request) {
  const v = await verificarFirma(await leerXmlEntrante(request));
  if (!v.ok) throw new Error('La firma del archivo no es válida: ' + v.motivo);
  const [t, rnd, firma] = texto(v.root, 'valor').split('.');
  if (!t || firma !== await hmac(env, `${t}.${rnd}`)) throw new Error('Semilla no válida.');
  if (Date.now() - Number(t) > 10 * 60e3) throw new Error('La semilla expiró. Solicite una nueva.');
  const ahora = new Date(), expira = new Date(ahora.getTime() + 3600e3);
  const carga = b64url(new TextEncoder().encode(JSON.stringify({ sub: v.sn || '', exp: expira.getTime() })));
  const token = `${carga}.${await hmac(env, carga)}`;
  if ((request.headers.get('accept') || '').includes('xml'))
    return xmlResp(`<?xml version="1.0" encoding="utf-8"?><RespuestaAutenticacion><token>${token}</token><expira>${fechaUniversal(expira)}</expira><expedido>${fechaUniversal(ahora)}</expedido></RespuestaAutenticacion>`);
  return json({ token, expira: fechaUniversal(expira), expedido: fechaUniversal(ahora) });
}
// El token es opcional según la DGII; si se envía, debe ser válido.
async function feVerificarToken(env, request) {
  const h = request.headers.get('authorization') || '';
  if (!h) return;
  const [carga, firma] = h.replace(/^Bearer\s+/i, '').split('.');
  let exp = 0;
  try { exp = JSON.parse(new TextDecoder().decode(unb64(carga.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((carga.length + 3) % 4)))).exp; } catch { }
  if (!carga || firma !== await hmac(env, carga) || exp < Date.now()) throw Object.assign(new Error('Token inválido o expirado.'), { status: 401 });
}

async function empresaPorRnc(env, rnc) {
  if (!/^\d{9}(\d{2})?$/.test(rnc)) return null;
  return uno(await sbAdmin(env, `empresas?select=id,nombre,data&data->>rnc=eq.${rnc}&limit=1`));
}
async function firmanteServicio(env, empresaId) {
  const c = uno(await sbAdmin(env, `ecf_config?empresa_id=eq.${empresaId}&select=*`));
  if (!c || !c.key_enc) return null;
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.ECF_MASTER_KEY));
  const key = await crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['decrypt']);
  const pkcs8 = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(c.key_iv) }, key, unb64(c.key_enc)));
  return { privateKey: await importPrivateKey(pkcs8), cert: c.cert_b64 };
}

// Recepción de e-CF: guarda el comprobante y responde un acuse de recibo (ARECF) firmado por el receptor.
async function feRecepcion(env, request) {
  await feVerificarToken(env, request);
  const xml = await leerXmlEntrante(request);
  const v = await verificarFirma(xml);
  if (!v.root || !/(^|:)ECF$/.test(v.root.n || '')) throw new Error('El archivo no es un e-CF válido.');
  const rncEmisor = soloDigitos(texto(v.root, 'RNCEmisor')), rncComprador = soloDigitos(texto(v.root, 'RNCComprador')), encf = texto(v.root, 'eNCF').trim();
  if (!rncEmisor || !encf) throw new Error('El e-CF no tiene RNCEmisor o eNCF.');
  const emp = await empresaPorRnc(env, rncComprador);
  let motivo = null;
  if (!v.ok) motivo = 2;                 // Error de firma digital
  else if (!emp) motivo = 4;             // RNC comprador no corresponde
  else {
    const previo = uno(await sbAdmin(env, `ecf_recibidos?select=id&empresa_id=eq.${emp.id}&rnc_emisor=eq.${rncEmisor}&encf=eq.${encodeURIComponent(encf)}&limit=1`));
    if (previo) motivo = 3;              // Envío duplicado
  }
  if (emp && v.ok && motivo === null) {
    const n = x => { const s = texto(v.root, x); return s ? Number(s) : null; };
    await sbAdmin(env, 'ecf_recibidos', {
      method: 'POST', headers: { prefer: 'return=minimal' },
      body: JSON.stringify({
        empresa_id: emp.id, rnc_emisor: rncEmisor, razon_social_emisor: texto(v.root, 'RazonSocialEmisor'), encf,
        tipo: texto(v.root, 'TipoeCF'), fecha_emision: texto(v.root, 'FechaEmision'), monto_total: n('MontoTotal'), total_itbis: n('TotalITBIS'),
        xml, firma_valida: true, acuse_estado: 0,
      }),
    });
  }
  const acuse = construirARECF({
    rncEmisor, rncComprador: rncComprador || '000000000', encf, recibido: motivo === null, motivo: motivo ?? undefined, fechaHora: fechaHoraRD(),
  });
  const s = emp ? await firmanteServicio(env, emp.id).catch(() => null) : null;
  if (s) return xmlResp((await signTree(acuse, s.privateKey, s.cert)).xml);
  return xmlResp(serialize(acuse));
}

// Aprobación comercial recibida sobre un e-CF que emitimos.
// Toda ACECF bien formada se acepta con HTTP 200 (lo exige la DGII); si la factura existe en la app, se anota en ella.
async function feAprobacionComercial(env, request) {
  await feVerificarToken(env, request);
  const xml = await leerXmlEntrante(request);
  const v = await verificarFirma(xml);
  if (!v.root || !/(^|:)ACECF$/.test(v.root.n || '')) {
    console.log('ACECF no válida', xml.slice(0, 300));
    throw new Error('El archivo no es una aprobación comercial (ACECF).');
  }
  const rncEmisor = soloDigitos(texto(v.root, 'RNCEmisor')), encf = texto(v.root, 'eNCF').trim();
  const aprobacion = {
    estado: texto(v.root, 'Estado') === '1' ? 'Aprobada' : 'Rechazada', motivo: texto(v.root, 'DetalleMotivoRechazo'),
    rncComprador: soloDigitos(texto(v.root, 'RNCComprador')), fecha: texto(v.root, 'FechaHoraAprobacionComercial'),
    recibida: new Date().toISOString(), firmaValida: v.ok, xml,
  };
  console.log('ACECF recibida', JSON.stringify({ rncEmisor, encf, estado: aprobacion.estado, firma: v.ok, motivoFirma: v.motivo }));
  try {
    const emp = await empresaPorRnc(env, rncEmisor);
    const f = emp && uno(await sbAdmin(env, `facturas?select=id,data&empresa_id=eq.${emp.id}&ncf=eq.${encodeURIComponent(encf)}&limit=1`));
    if (f) {
      const data = { ...(f.data || {}), ecf: { ...((f.data || {}).ecf || {}), aprobacionComercial: aprobacion } };
      await sbAdmin(env, `facturas?id=eq.${f.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ data }) });
    }
  } catch (e) { console.log('ACECF: no se pudo anotar en la factura', String(e.message || e)); }
  return json({ mensaje: 'Aprobación comercial recibida', estado: aprobacion.estado });
}

/* ---------------- Invitaciones al equipo ---------------- */

// Llamada a Supabase Auth con la clave de servicio (invitar usuarios requiere permisos de administrador).
async function authAdmin(env, path, body) {
  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('Falta configurar el secreto SUPABASE_SERVICE_KEY en Cloudflare (Worker → Settings → Variables and Secrets).');
  const auth = key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {};
  const r = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { apikey: key, ...auth, 'content-type': 'application/json' },
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { ok: r.ok, status: r.status, data: d, error: (d && (d.msg || d.message || d.error_description || d.error)) || `Supabase HTTP ${r.status}` };
}

// Registra la invitación y envía el correo. Si el email ya tiene cuenta, le manda un enlace para entrar.
async function invitarUsuario(env, jwt, { empresaId, email, rol }, redirectTo) {
  email = String(email || '').trim().toLowerCase();
  if (!empresaId) throw new Error('Falta la empresa.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Escribe un email válido.');
  if (!['admin', 'usuario'].includes(rol)) throw new Error('Rol inválido.');
  const ru = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, authorization: `Bearer ${jwt}` } });
  if (!ru.ok) throw new Error('Tu sesión venció. Vuelve a iniciar sesión.');
  const yo = await ru.json();
  if (!(await sb(jwt, 'rpc/es_admin', { method: 'POST', body: JSON.stringify({ e: empresaId }) }))) throw new Error('Solo el dueño o un administrador puede invitar.');

  await sbAdmin(env, 'invitaciones?on_conflict=empresa_id,email', {
    method: 'POST', body: JSON.stringify({ empresa_id: empresaId, email, rol, invitado_por: yo.id }),
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
  });

  const q = `?redirect_to=${encodeURIComponent(redirectTo)}`;
  const inv = await authAdmin(env, 'invite' + q, { email });
  if (inv.ok) return { ok: true, existente: false };
  // Ya tiene cuenta: le enviamos un enlace de acceso; al entrar se une a la empresa.
  if (inv.status === 422 || /already|registered|exists/i.test(inv.error)) {
    const otp = await authAdmin(env, 'otp' + q, { email, create_user: false });
    if (otp.ok) return { ok: true, existente: true };
    throw new Error('Invitación guardada, pero no se pudo enviar el correo: ' + otp.error);
  }
  throw new Error('Invitación guardada, pero no se pudo enviar el correo: ' + inv.error);
}

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

// Aprobación comercial (ACECF) de un e-CF recibido: se firma y se envía a la DGII y, si es posible, al emisor.
async function aprobarRecibido(env, jwt, { recibidoId, aprobado, motivo }) {
  const r = uno(await sb(jwt, `ecf_recibidos?id=eq.${recibidoId}&select=*`));
  if (!r) throw new Error('Comprobante recibido no encontrado.');
  if (!aprobado && !String(motivo || '').trim()) throw new Error('Indica el motivo del rechazo.');
  const root = parseXml(r.xml);
  const emp = uno(await sb(jwt, `empresas?id=eq.${r.empresa_id}&select=data`));
  const rncComprador = String((emp.data || {}).rnc || '').replace(/\D/g, '');
  const montoTotal = Number(texto(root, 'MontoTotal') || r.monto_total || 0).toFixed(2);
  const s = await firmante(env, jwt, r.empresa_id);
  const acecf = construirACECF({
    rncEmisor: r.rnc_emisor, encf: r.encf, fechaEmision: texto(root, 'FechaEmision'), montoTotal, rncComprador,
    aprobado: !!aprobado, motivo, fechaHora: fechaHoraRD(),
  });
  const { xml } = await signTree(acecf, s.privateKey, s.cert);
  const fileName = rncComprador + r.encf + '.xml';
  const token = await obtenerToken(s.ambiente, s.privateKey, s.cert, 'empresa:' + r.empresa_id);
  const d = await enviarACECF(s.ambiente, token, xml, fileName);
  const resultado = {
    estado: aprobado ? 'Aprobada' : 'Rechazada', motivo: aprobado ? '' : motivo, fecha: new Date().toISOString(), xml,
    dgii: { codigo: d.codigo, estado: d.estado || '', mensajes: [].concat(d.mensaje || []).filter(Boolean) },
  };
  // Envío al emisor según el directorio de la DGII (si el servicio está disponible en el ambiente)
  try {
    const dir = await fetch(`${AMBIENTES[s.ambiente].ecf}/consultadirectorio/api/consultas/obtenerdirectorioporrnc?RNC=${r.rnc_emisor}`, { headers: { accept: 'application/json', authorization: 'Bearer ' + token } });
    const lista = dir.ok ? await dir.json() : [];
    const url = (Array.isArray(lista) ? lista[0] : lista)?.urlAceptacion;
    if (url) {
      const fd = new FormData(); fd.append('xml', new Blob([xml], { type: 'text/xml' }), fileName);
      const re = await fetch(url.replace(/\/+$/, '') + (/\/fe\/aprobacioncomercial\/api\/ecf$/i.test(url) ? '' : '/fe/aprobacioncomercial/api/ecf'), { method: 'POST', body: fd });
      resultado.emisor = { url, status: re.status };
    }
  } catch (e) { resultado.emisor = { error: String(e.message || e) }; }
  await sb(jwt, `ecf_recibidos?id=eq.${recibidoId}`, { method: 'PATCH', body: JSON.stringify({ aprobacion: resultado }), headers: { prefer: 'return=minimal' } });
  return { ok: true, aprobacion: resultado };
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
