// Convierte la Reina-Valera 1909 (dominio público) en un archivo JSON por libro.
// Uso: node scripts/build-bible.js scripts/SpaRV.json
const fs = require('fs');
const path = require('path');

const NAMES = [
  ['Génesis','Gn'],['Éxodo','Ex'],['Levítico','Lv'],['Números','Nm'],['Deuteronomio','Dt'],
  ['Josué','Jos'],['Jueces','Jue'],['Rut','Rt'],['1 Samuel','1 S'],['2 Samuel','2 S'],
  ['1 Reyes','1 R'],['2 Reyes','2 R'],['1 Crónicas','1 Cr'],['2 Crónicas','2 Cr'],['Esdras','Esd'],
  ['Nehemías','Neh'],['Ester','Est'],['Job','Job'],['Salmos','Sal'],['Proverbios','Pr'],
  ['Eclesiastés','Ec'],['Cantares','Cnt'],['Isaías','Is'],['Jeremías','Jer'],['Lamentaciones','Lm'],
  ['Ezequiel','Ez'],['Daniel','Dn'],['Oseas','Os'],['Joel','Jl'],['Amós','Am'],
  ['Abdías','Abd'],['Jonás','Jon'],['Miqueas','Mi'],['Nahúm','Nah'],['Habacuc','Hab'],
  ['Sofonías','Sof'],['Hageo','Hag'],['Zacarías','Zac'],['Malaquías','Mal'],
  ['Mateo','Mt'],['Marcos','Mr'],['Lucas','Lc'],['Juan','Jn'],['Hechos','Hch'],
  ['Romanos','Ro'],['1 Corintios','1 Co'],['2 Corintios','2 Co'],['Gálatas','Gá'],['Efesios','Ef'],
  ['Filipenses','Fil'],['Colosenses','Col'],['1 Tesalonicenses','1 Ts'],['2 Tesalonicenses','2 Ts'],
  ['1 Timoteo','1 Ti'],['2 Timoteo','2 Ti'],['Tito','Tit'],['Filemón','Flm'],['Hebreos','He'],
  ['Santiago','Stg'],['1 Pedro','1 P'],['2 Pedro','2 P'],['1 Juan','1 Jn'],['2 Juan','2 Jn'],
  ['3 Juan','3 Jn'],['Judas','Jud'],['Apocalipsis','Ap'],
];

const src = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, 'SpaRV.json'), 'utf8'));
const out = path.join(__dirname, '..', 'public', 'data');
fs.mkdirSync(path.join(out, 'books'), { recursive: true });

if (src.books.length !== 66) throw new Error('Se esperaban 66 libros');
const index = src.books.map((b, i) => {
  const id = i + 1;
  const chapters = b.chapters.map(c => c.verses.map(v => v.text.trim()));
  fs.writeFileSync(path.join(out, 'books', `${String(id).padStart(2, '0')}.json`), JSON.stringify(chapters));
  return {
    id, name: NAMES[i][0], abbr: NAMES[i][1],
    testament: id <= 39 ? 'AT' : 'NT',
    chapters: chapters.map(c => c.length),
  };
});
fs.writeFileSync(path.join(out, 'index.json'),
  JSON.stringify({ translation: 'Reina-Valera 1909', books: index }));
console.log('OK:', index.length, 'libros,', index.reduce((s, b) => s + b.chapters.reduce((a, n) => a + n, 0), 0), 'versículos');
