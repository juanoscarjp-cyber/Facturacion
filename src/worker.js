// Worker de Cloudflare: sirve la app (carpeta web/) y expone /api/rnc,
// que consulta el RNC/cédula en la página pública de la DGII.
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
    return env.ASSETS.fetch(request);
  },
};

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
