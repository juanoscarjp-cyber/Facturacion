// Validador XSD reducido (navegador) para los esquemas e-CF de la DGII:
// secuencias, minOccurs/maxOccurs, xs:any, enumeraciones, patrones, longitudes y dígitos.
export function validarXSD(xmlStr, xsdStr) {
  const errores = [];
  const xsd = new DOMParser().parseFromString(xsdStr, 'application/xml');
  const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
  if (doc.querySelector('parsererror')) return ['XML mal formado'];
  const schema = xsd.documentElement;
  const tipos = {};
  for (const t of schema.children) if (t.localName === 'simpleType' || t.localName === 'complexType') tipos[t.getAttribute('name')] = t;
  const kids = el => [...el.children];
  const occ = (p, a, d) => { const v = p.getAttribute(a); return v == null ? d : v === 'unbounded' ? Infinity : Number(v); };

  function facetas(simple, valor, ruta) {
    const r = kids(simple).find(c => c.localName === 'restriction');
    if (!r) return;
    const base = r.getAttribute('base') || '';
    if (tipos[base] && tipos[base].localName === 'simpleType') facetas(tipos[base], valor, ruta);
    const f = kids(r);
    const enums = f.filter(x => x.localName === 'enumeration').map(x => x.getAttribute('value'));
    if (enums.length && !enums.includes(valor)) errores.push(`${ruta}: "${valor}" no está en [${enums.slice(0, 8).join(', ')}${enums.length > 8 ? '…' : ''}]`);
    const pats = f.filter(x => x.localName === 'pattern').map(x => x.getAttribute('value'));
    if (pats.length && !pats.some(p => new RegExp('^(?:' + p + ')$').test(valor))) errores.push(`${ruta}: "${valor}" no cumple el patrón ${pats.join(' | ')}`);
    for (const x of f) {
      const v = x.getAttribute('value');
      if (x.localName === 'maxLength' && valor.length > +v) errores.push(`${ruta}: largo ${valor.length} > ${v}`);
      if (x.localName === 'minLength' && valor.length < +v) errores.push(`${ruta}: largo ${valor.length} < ${v}`);
      if (x.localName === 'minInclusive' && !(+valor >= +v)) errores.push(`${ruta}: ${valor} < ${v}`);
      if (x.localName === 'minExclusive' && !(+valor > +v)) errores.push(`${ruta}: ${valor} no es > ${v}`);
      if (x.localName === 'maxInclusive' && !(+valor <= +v)) errores.push(`${ruta}: ${valor} > ${v}`);
      if (x.localName === 'fractionDigits' && ((valor.split('.')[1] || '').length > +v)) errores.push(`${ruta}: más de ${v} decimales`);
      if (x.localName === 'totalDigits' && valor.replace(/[^0-9]/g, '').replace(/^0+/, '').length > +v) errores.push(`${ruta}: más de ${v} dígitos`);
    }
    if (/xs:(decimal|integer)$/.test(base) && !/^[+-]?\d+(\.\d+)?$/.test(valor)) errores.push(`${ruta}: "${valor}" no es numérico`);
    if (/xs:integer$/.test(base) && valor.includes('.')) errores.push(`${ruta}: "${valor}" no es entero`);
  }

  function validarElemento(inst, decl, ruta) {
    const tn = decl.getAttribute('type');
    const complejo = kids(decl).find(c => c.localName === 'complexType') || (tn && tipos[tn] && tipos[tn].localName === 'complexType' ? tipos[tn] : null);
    const simple = kids(decl).find(c => c.localName === 'simpleType') || (tn && tipos[tn] && tipos[tn].localName === 'simpleType' ? tipos[tn] : null);
    if (complejo) {
      const hijos = kids(inst);
      const i = particula(kids(complejo).find(c => ['sequence', 'choice', 'all'].includes(c.localName)), hijos, 0, ruta);
      if (i < hijos.length) errores.push(`${ruta}: elemento inesperado <${hijos[i].localName}>`);
    } else {
      const valor = inst.textContent;
      if (inst.children.length) errores.push(`${ruta}: se esperaba texto`);
      if (simple) facetas(simple, valor, ruta);
      else if (/xs:(decimal|integer)$/.test(tn || '') && !/^[+-]?\d+(\.\d+)?$/.test(valor)) errores.push(`${ruta}: "${valor}" no es numérico`);
    }
  }

  // Consume hijos desde i según la partícula; devuelve el nuevo índice.
  function particula(p, hijos, i, ruta) {
    if (!p) return i;
    if (p.localName === 'sequence') {
      for (const c of kids(p)) i = particula(c, hijos, i, ruta);
      return i;
    }
    if (p.localName === 'choice') {
      for (const c of kids(p)) { const j = particula(c, hijos, i, ruta); if (j > i) return j; }
      return i;
    }
    if (p.localName === 'any') {
      const min = occ(p, 'minOccurs', 1);
      if (i < hijos.length) return i + 1;
      if (min > 0) errores.push(`${ruta}: falta el elemento final (firma)`);
      return i;
    }
    if (p.localName === 'element') {
      const nombre = p.getAttribute('name'), min = occ(p, 'minOccurs', 1), max = occ(p, 'maxOccurs', 1);
      let n = 0;
      while (i < hijos.length && hijos[i].localName === nombre && n < max) { validarElemento(hijos[i], p, `${ruta}/${nombre}`); i++; n++; }
      if (n < min) errores.push(`${ruta}: falta <${nombre}> (obligatorio)`);
      return i;
    }
    return i;
  }

  const raiz = kids(schema).find(c => c.localName === 'element');
  if (doc.documentElement.localName !== raiz.getAttribute('name')) errores.push(`Raíz <${doc.documentElement.localName}> ≠ <${raiz.getAttribute('name')}>`);
  else validarElemento(doc.documentElement, raiz, raiz.getAttribute('name'));
  return errores;
}
