// Utilidades compartidas por el servidor para los bloques de un capítulo.
// Un capítulo es una lista ordenada de bloques:
//   { t: 'v', n, text }  versículo
//   { t: 'h', text }     subtítulo (escrito por el propietario, con «#»)
//   { t: 'd', text }     división del propio evangelio («I. …», «II. …»)
// Los subtítulos y divisiones se identifican por el versículo que les sigue y su orden: «5:t0», «5:t1»…

// Líneas como «I. Nacimiento…», «II. …»: divisiones del propio texto
const ROMAN = /^(?:[IVX]{1,5})\.\s+\S/;

// Convierte el formato antiguo [{ n, text, title? }] en bloques
function normalize(list) {
  if (!Array.isArray(list)) return [];
  if (list.every(b => b && b.t)) return list;
  const out = [];
  for (const v of list) {
    if (v.title) for (const h of String(v.title).split(' · ')) {
      const text = h.trim();
      if (text) out.push({ t: ROMAN.test(text) ? 'd' : 'h', text });
    }
    out.push({ t: 'v', n: v.n, text: v.text });
  }
  return out;
}

// Claves de los bloques que no son versículos
function targets(blocks) {
  const keys = [];
  let pending = 0, last = 0;
  for (const b of blocks) {
    if (b.t === 'v') {
      for (let i = 0; i < pending; i++) keys.push(`${b.n}:t${i}`);
      pending = 0; last = b.n;
    } else pending++;
  }
  for (let i = 0; i < pending; i++) keys.push(`${last + 1}:t${i}`);
  return keys;
}

module.exports = { normalize, targets, ROMAN };
