const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { normalize, targets } = require('./lib-blocks');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// ---------- Almacenamiento: PostgreSQL si hay DATABASE_URL; si no, archivo JSON ----------
function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const ssl = /localhost|\.railway\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
    const row = r => ({ id: r.id, book: r.book, chapter: r.chapter, verse: r.verse, target: r.target || '', author: r.author,
      text: r.text, createdAt: r.created_at, updatedAt: r.updated_at });
    return {
      kind: 'postgres',
      async init() {
        await pool.query(`CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY, book INT NOT NULL, chapter INT NOT NULL, verse INT NOT NULL,
          author TEXT NOT NULL, text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ)`);
        await pool.query('CREATE INDEX IF NOT EXISTS comments_ref ON comments(book, chapter, verse)');
        await pool.query(`CREATE TABLE IF NOT EXISTS posts (
          id TEXT PRIMARY KEY, book INT NOT NULL, chapter INT NOT NULL, verse INT NOT NULL,
          name TEXT NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query('CREATE INDEX IF NOT EXISTS posts_ref ON posts(book, chapter, verse)');
        await pool.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
        await pool.query(`CREATE TABLE IF NOT EXISTS texts (
          book INT NOT NULL, chapter INT NOT NULL, verses JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (book, chapter))`);
        await pool.query('ALTER TABLE texts ADD COLUMN IF NOT EXISTS name TEXT');
        await pool.query("ALTER TABLE comments ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT ''");
      },
      async getText(b, c) {
        const { rows } = await pool.query('SELECT verses, name FROM texts WHERE book=$1 AND chapter=$2', [b, c]);
        return rows[0] ? { name: rows[0].name || '', blocks: normalize(rows[0].verses) } : { name: '', blocks: [] };
      },
      async setText(b, c, doc) {
        await pool.query(`INSERT INTO texts (book, chapter, verses, name) VALUES ($1,$2,$3,$4)
          ON CONFLICT (book, chapter) DO UPDATE SET verses = EXCLUDED.verses, name = EXCLUDED.name, updated_at = now()`,
          [b, c, JSON.stringify(doc.blocks), doc.name || null]);
      },
      async allTexts() {
        const { rows } = await pool.query('SELECT book, chapter, verses, name FROM texts');
        return rows.map(r => ({ book: r.book, chapter: r.chapter, name: r.name || '', blocks: normalize(r.verses) }));
      },
      async deleteComments(ids) { if (ids.length) await pool.query('DELETE FROM comments WHERE id = ANY($1)', [ids]); },
      async deletePosts(ids) { if (ids.length) await pool.query('DELETE FROM posts WHERE id = ANY($1)', [ids]); },
      async deleteSetting(k) { await pool.query('DELETE FROM settings WHERE key=$1', [k]); },
      async listProposals() {
        await pool.query(`CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ)`);
        const { rows } = await pool.query('SELECT * FROM proposals ORDER BY created_at DESC');
        return rows.map(r => ({ id: r.id, text: r.text, status: r.status, reply: r.reply || '', createdAt: r.created_at, updatedAt: r.updated_at }));
      },
      async createProposal(text) {
        await this.listProposals();   // asegura la tabla
        const { rows: [r] } = await pool.query('INSERT INTO proposals (id, text) VALUES ($1,$2) RETURNING *', [crypto.randomUUID(), text]);
        return { id: r.id, text: r.text, status: r.status, reply: '', createdAt: r.created_at, updatedAt: null };
      },
      async updateProposal(id, status, reply) {
        const { rows: [r] } = await pool.query(
          'UPDATE proposals SET status=$2, reply=COALESCE($3, reply), updated_at=now() WHERE id=$1 RETURNING *', [id, status, reply]);
        return r ? { id: r.id, text: r.text, status: r.status, reply: r.reply || '', createdAt: r.created_at, updatedAt: r.updated_at } : null;
      },
      async getSetting(k) {
        const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [k]);
        return rows[0] ? rows[0].value : null;
      },
      async setSetting(k, v) {
        await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [k, JSON.stringify(v)]);
      },
      async listPosts() {
        const { rows } = await pool.query('SELECT * FROM posts ORDER BY book, chapter, verse, created_at');
        return rows.map(r => ({ id: r.id, book: r.book, chapter: r.chapter, verse: r.verse, name: r.name, text: r.text, createdAt: r.created_at }));
      },
      async createPost(p) {
        const { rows: [r] } = await pool.query(
          'INSERT INTO posts (id, book, chapter, verse, name, text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [crypto.randomUUID(), p.book, p.chapter, p.verse, p.name, p.text]);
        return { id: r.id, book: r.book, chapter: r.chapter, verse: r.verse, name: r.name, text: r.text, createdAt: r.created_at };
      },
      async list() {
        const { rows } = await pool.query('SELECT * FROM comments ORDER BY book, chapter, verse, created_at');
        return rows.map(row);
      },
      async create(c) {
        const { rows } = await pool.query(
          'INSERT INTO comments (id, book, chapter, verse, target, author, text) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [crypto.randomUUID(), c.book, c.chapter, c.verse, c.target, c.author, c.text]);
        return row(rows[0]);
      },
      async update(id, c) {
        const { rows } = await pool.query(
          'UPDATE comments SET text=$2, author=$3, updated_at=now() WHERE id=$1 RETURNING *', [id, c.text, c.author]);
        return rows[0] ? row(rows[0]) : null;
      },
      async remove(id) {
        const r = await pool.query('DELETE FROM comments WHERE id=$1', [id]);
        return r.rowCount > 0;
      },
    };
  }
  const file = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'comments.json');
  const postsFile = path.join(path.dirname(file), 'posts.json');
  const settingsFile = path.join(path.dirname(file), 'settings.json');
  const textsFile = path.join(path.dirname(file), 'texts.json');
  let items = [], posts = [], settings = {}, texts = {}, proposals = null;
  const proposalsFile = path.join(path.dirname(file), 'proposals.json');
  const loadProposals = () => { if (!proposals) { try { proposals = JSON.parse(fs.readFileSync(proposalsFile, 'utf8')); } catch { proposals = []; } } return proposals; };
  const saveProposals = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(proposalsFile, JSON.stringify(proposals, null, 1)); };
  const saveTexts = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(textsFile, JSON.stringify(texts)); };
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(items, null, 1)); };
  const savePosts = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(postsFile, JSON.stringify(posts, null, 1)); };
  return {
    kind: 'archivo ' + file,
    async init() {
      try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { items = []; }
      try { posts = JSON.parse(fs.readFileSync(postsFile, 'utf8')); } catch { posts = []; }
      try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { settings = {}; }
      try { texts = JSON.parse(fs.readFileSync(textsFile, 'utf8')); } catch { texts = {}; }
    },
    async getText(b, c) {
      const d = texts[`${b}:${c}`];
      if (!d) return { name: '', blocks: [] };
      return Array.isArray(d) ? { name: '', blocks: normalize(d) } : { name: d.name || '', blocks: normalize(d.blocks) };
    },
    async setText(b, c, doc) { texts[`${b}:${c}`] = { name: doc.name || '', blocks: doc.blocks }; saveTexts(); },
    async allTexts() {
      return Object.keys(texts).map(k => { const [book, chapter] = k.split(':').map(Number); return { book, chapter, ...this.getTextSync(book, chapter) }; });
    },
    getTextSync(b, c) {
      const d = texts[`${b}:${c}`];
      return Array.isArray(d) ? { name: '', blocks: normalize(d) } : { name: d.name || '', blocks: normalize(d.blocks) };
    },
    async listProposals() { return [...loadProposals()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    async createProposal(text) {
      const it = { id: crypto.randomUUID(), text, status: 'pending', reply: '', createdAt: new Date().toISOString(), updatedAt: null };
      loadProposals().push(it); saveProposals(); return it;
    },
    async updateProposal(id, status, reply) {
      const it = loadProposals().find(x => x.id === id); if (!it) return null;
      Object.assign(it, { status, updatedAt: new Date().toISOString() }); if (reply != null) it.reply = reply;
      saveProposals(); return it;
    },
    async deleteComments(ids) { const s = new Set(ids); items = items.filter(x => !s.has(x.id)); save(); },
    async deletePosts(ids) { const s = new Set(ids); posts = posts.filter(x => !s.has(x.id)); savePosts(); },
    async deleteSetting(k) {
      delete settings[k];
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings));
    },
    async getSetting(k) { return settings[k] ?? null; },
    async setSetting(k, v) {
      settings[k] = v;
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings));
    },
    async listPosts() { return [...posts]; },
    async createPost(p) {
      const it = { id: crypto.randomUUID(), ...p, createdAt: new Date().toISOString() };
      posts.push(it); savePosts(); return it;
    },
    async list() {
      return [...items].sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse
        || a.createdAt.localeCompare(b.createdAt));
    },
    async create(c) {
      const it = { id: crypto.randomUUID(), ...c, target: c.target || '', createdAt: new Date().toISOString(), updatedAt: null };
      items.push(it); save(); return it;
    },
    async update(id, c) {
      const it = items.find(x => x.id === id); if (!it) return null;
      Object.assign(it, { text: c.text, author: c.author, updatedAt: new Date().toISOString() }); save(); return it;
    },
    async remove(id) {
      const n = items.length; items = items.filter(x => x.id !== id); save(); return items.length < n;
    },
  };
}
const store = makeStore();

// ---------- Validación ----------
const BOOKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'books.json'), 'utf8')).books;
const MAX_VERSE = 500;
// ---------- Temas: cada tema es como un libro de un solo capítulo, con id 1000 + n ----------
const TOPIC_BASE = 1000;
let topics = [];   // [{ id, title, createdAt }], guardado en settings («topics»)
const topicOf = book => book > TOPIC_BASE ? topics.find(t => TOPIC_BASE + t.id === book) : null;
const saveTopics = () => store.setSetting('topics', topics);
function validRef(book, chapter, verse) {
  const b = BOOKS.find(x => x.id === book) || (topicOf(book) && { chapters: 1 });
  return !!b && Number.isInteger(chapter) && chapter >= 1 && chapter <= b.chapters
    && (verse === undefined || (Number.isInteger(verse) && verse >= 1 && verse <= MAX_VERSE));
}
function validate(body, partial) {
  const author = String(body.author || '').trim().slice(0, 60);
  const text = String(body.text || '').trim();
  if (!text) return { error: 'El texto está vacío' };
  if (text.length > 20000) return { error: 'Texto demasiado largo' };
  if (partial) return { author, text };
  const book = Number(body.book), chapter = Number(body.chapter), verse = Number(body.verse);
  if (!validRef(book, chapter, verse)) return { error: 'Referencia bíblica no válida' };
  const target = String(body.target || '');
  if (target && !/^t\d{1,2}$/.test(target)) return { error: 'Referencia no válida' };
  return { book, chapter, verse, target, author, text };
}

// ---------- API ----------
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Error del servidor' }); });
// ---------- Peticiones de cambios a Claude (PIN APP_PIN para el usuario, CLAUDE_TOKEN para Claude) ----------
const failures = new Map();   // ip -> { n, until }
function requirePin(req, res, next) {
  const pin = process.env.APP_PIN;
  if (!pin) return res.status(503).json({ error: 'Las peticiones aún no están configuradas' });
  const ip = req.ip, f = failures.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const same = (a, b) => !!a && !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  // PIN del usuario (desde la app) o clave propia de las sesiones automáticas de Claude (CLAUDE_TOKEN)
  const given = String(req.get('x-owner-token') || '').trim();
  const ok = same(given, pin) || same(String(req.get('x-claude-token') || '').trim(), process.env.CLAUDE_TOKEN || '');
  if (!ok) {
    const n = (f && f.until <= Date.now() ? 0 : (f ? f.n : 0)) + 1;
    failures.set(ip, { n, until: n >= 8 ? Date.now() + 15 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'PIN incorrecto' });
  }
  failures.delete(ip); next();
}
const STATUSES = ['pending', 'working', 'done', 'rejected'];
// Despierta a Claude al momento: llama al activador por API de la tarea de Claude Code
// (variables ROUTINE_FIRE_URL y ROUTINE_FIRE_TOKEN, que se obtienen en claude.ai/code/routines)
async function wakeClaude(p) {
  const url = process.env.ROUTINE_FIRE_URL, token = process.env.ROUTINE_FIRE_TOKEN;
  if (!url || !token) { console.warn('Petición guardada, pero falta ROUTINE_FIRE_URL / ROUTINE_FIRE_TOKEN para avisar a Claude'); return; }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: `Nueva petición en la app: ${p.id}` }),
    });
    if (!r.ok) console.error('Aviso a Claude fallido:', r.status, (await r.text()).slice(0, 300));
    else console.log('Claude avisado de la petición', p.id);
  } catch (e) { console.error('Aviso a Claude fallido:', e.message); }
}
app.get('/api/proposals', requirePin, wrap(async (req, res) => {
  const list = await store.listProposals();
  res.json(req.query.status ? list.filter(p => p.status === req.query.status) : list);
}));
app.post('/api/proposals', requirePin, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Escribe lo que quieres cambiar' });
  if (text.length > 5000) return res.status(400).json({ error: 'Texto demasiado largo' });
  const p = await store.createProposal(text);
  res.status(201).json(p);
  wakeClaude(p);   // sin esperar: el usuario no tiene que aguardar a la respuesta
}));
app.post('/api/proposals/:id/wake', requirePin, wrap(async (req, res) => {
  const p = (await store.listProposals()).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrada' });
  await wakeClaude(p); res.status(204).end();
}));
app.patch('/api/proposals/:id', requirePin, wrap(async (req, res) => {
  const status = String(req.body.status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estado no válido' });
  const reply = req.body.reply == null ? null : String(req.body.reply).slice(0, 5000);
  const it = await store.updateProposal(req.params.id, status, reply);
  it ? res.json(it) : res.status(404).json({ error: 'No encontrada' });
}));

// ---------- Copia de seguridad en Excel (protegida con el PIN) ----------
app.get('/api/backup.xlsx', requirePin, wrap(async (req, res) => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Evangelio'; wb.created = new Date();
  const GOLD = 'FFB08A2E', PALE = 'FFFAF4E3';
  const bookName = id => (BOOKS.find(b => b.id === id) || {}).name || (topicOf(id) ? `Tema: ${topicOf(id).title}` : `Libro ${id}`);
  const fmt = d => d ? new Date(d) : null;
  function sheet(name, columns, rows) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.addRows(rows);
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
    head.alignment = { vertical: 'middle' };
    ws.eachRow((row, i) => {
      if (i === 1) return;
      row.alignment = { vertical: 'top', wrapText: true };
      if (i % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE } };
    });
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  }
  const texts = (await store.allTexts()).sort((a, b) => a.book - b.book || a.chapter - b.chapter);
  // Texto: una fila por bloque, en el orden de lectura
  const TYPE = { v: 'Versículo', h: 'Subtítulo', d: 'División' };
  const textRows = [], verseText = new Map(), targetText = new Map();
  for (const d of texts) {
    let pending = [], last = 0;
    const flush = n => { pending.forEach((p, i) => targetText.set(`${d.book}:${d.chapter}:${n}:t${i}`, p.text)); pending = []; };
    for (const b of d.blocks) {
      textRows.push({ libro: bookName(d.book), capitulo: d.chapter, nombre: d.name || '', tipo: TYPE[b.t], vers: b.t === 'v' ? b.n : null, texto: b.text });
      if (b.t === 'v') { flush(b.n); last = b.n; verseText.set(`${d.book}:${d.chapter}:${b.n}`, b.text); }
      else pending.push(b);
    }
    flush(last + 1);
  }
  sheet('Texto', [
    { header: 'Libro', key: 'libro', width: 24 }, { header: 'Capítulo', key: 'capitulo', width: 10 },
    { header: 'Nombre del capítulo', key: 'nombre', width: 28 }, { header: 'Tipo', key: 'tipo', width: 12 },
    { header: 'Versículo', key: 'vers', width: 10 }, { header: 'Texto', key: 'texto', width: 90 },
  ], textRows);
  const comments = await store.list();
  sheet('Comentarios', [
    { header: 'Libro', key: 'libro', width: 24 }, { header: 'Capítulo', key: 'capitulo', width: 10 },
    { header: 'Versículo', key: 'vers', width: 10 }, { header: 'Sobre', key: 'sobre', width: 30 },
    { header: 'Texto comentado', key: 'texto', width: 60 }, { header: 'Comentario', key: 'comentario', width: 80 },
    { header: 'Creado', key: 'creado', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
    { header: 'Última edición', key: 'editado', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
  ], comments.map(c => {
    const t = c.target ? targetText.get(`${c.book}:${c.chapter}:${c.verse}:${c.target}`) : verseText.get(`${c.book}:${c.chapter}:${c.verse}`);
    return {
      libro: bookName(c.book), capitulo: c.chapter, vers: c.target ? null : c.verse,
      sobre: c.target ? `Subtítulo (antes del v. ${c.verse})` : 'Versículo',
      texto: t || '(texto ya no existe)', comentario: c.text, creado: fmt(c.createdAt), editado: fmt(c.updatedAt),
    };
  }));
  sheet('Discusión', [
    { header: 'Libro', key: 'libro', width: 24 }, { header: 'Capítulo', key: 'capitulo', width: 10 },
    { header: 'Versículo', key: 'vers', width: 10 }, { header: 'Nombre', key: 'nombre', width: 18 },
    { header: 'Mensaje', key: 'texto', width: 80 }, { header: 'Fecha', key: 'fecha', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
  ], (await store.listPosts()).map(p => ({ libro: bookName(p.book), capitulo: p.chapter, vers: p.verse, nombre: p.name, texto: p.text, fecha: fmt(p.createdAt) })));
  const bm = await store.getSetting('bookmark');
  sheet('Marca', [
    { header: 'Libro', key: 'libro', width: 24 }, { header: 'Capítulo', key: 'capitulo', width: 10 },
    { header: 'Versículo', key: 'vers', width: 10 }, { header: 'Guardada', key: 'fecha', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
  ], bm ? [{ libro: bookName(bm.book), capitulo: bm.chapter, vers: bm.verse, fecha: fmt(bm.savedAt) }] : []);
  const ST = { pending: 'Pendiente', working: 'En curso', done: 'Hecho', rejected: 'No realizado' };
  sheet('Peticiones a Claude', [
    { header: 'Fecha', key: 'fecha', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } }, { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Petición', key: 'texto', width: 70 }, { header: 'Respuesta de Claude', key: 'resp', width: 70 },
  ], (await store.listProposals()).map(p => ({ fecha: fmt(p.createdAt), estado: ST[p.status] || p.status, texto: p.text, resp: p.reply || '' })));
  const info = wb.addWorksheet('Información');
  info.columns = [{ width: 28 }, { width: 60 }];
  info.addRows([
    ['Copia de seguridad de', 'Evangelio (Lucas · Hechos de los apóstoles)'],
    ['Fecha de la copia', new Date()],
    ['Versículos con texto', textRows.filter(r => r.tipo === 'Versículo').length],
    ['Comentarios', comments.length],
  ]);
  info.getColumn(1).font = { bold: true, color: { argb: GOLD } };
  info.getCell('B2').numFmt = 'dd/mm/yyyy hh:mm';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="evangelio-copia-${stamp}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  await wb.xlsx.write(res);
  res.end();
}));

// ---------- Temas ----------
const cleanTitle = t => String(t || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
app.get('/api/topics', (req, res) => res.json(topics));
app.post('/api/topics', wrap(async (req, res) => {
  const title = cleanTitle(req.body.title);
  if (!title) return res.status(400).json({ error: 'Escribe el nombre del tema' });
  if (topics.some(t => t.title.toLowerCase() === title.toLowerCase())) return res.status(400).json({ error: 'Ya existe un tema con ese nombre' });
  const t = { id: topics.reduce((m, x) => Math.max(m, x.id), 0) + 1, title, createdAt: new Date().toISOString() };
  topics.push(t); await saveTopics();
  res.status(201).json(t);
}));
// Renombrar: también se actualizan las menciones «/[Tema]» de los comentarios
app.put('/api/topics/:id', wrap(async (req, res) => {
  const t = topics.find(x => x.id === Number(req.params.id)); if (!t) return res.status(404).json({ error: 'No existe' });
  const title = cleanTitle(req.body.title);
  if (!title) return res.status(400).json({ error: 'Escribe el nombre del tema' });
  if (topics.some(x => x !== t && x.title.toLowerCase() === title.toLowerCase())) return res.status(400).json({ error: 'Ya existe un tema con ese nombre' });
  const old = t.title; t.title = title; await saveTopics();
  if (old !== title) {
    const re = new RegExp('/\\[' + old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'gi');
    for (const c of await store.list()) if (re.test(c.text)) { re.lastIndex = 0; await store.update(c.id, { text: c.text.replace(re, `/[${title}]`), author: c.author || '' }); }
  }
  res.json(t);
}));
app.delete('/api/topics/:id', requirePin, wrap(async (req, res) => {
  const t = topics.find(x => x.id === Number(req.params.id)); if (!t) return res.status(404).json({ error: 'No existe' });
  const book = TOPIC_BASE + t.id;
  await store.setText(book, 1, { name: '', blocks: [] });
  await store.deleteComments((await store.list()).filter(c => c.book === book).map(c => c.id));
  await store.deletePosts((await store.listPosts()).filter(p => p.book === book).map(p => p.id));
  const bm = await store.getSetting('bookmark'); if (bm && bm.book === book) await store.deleteSetting('bookmark');
  topics = topics.filter(x => x !== t); await saveTopics();
  res.status(204).end();
}));

// ---------- Borrar mensajes de la discusión (solo el dueño, con PIN) ----------
app.delete('/api/posts/:id', requirePin, wrap(async (req, res) => {
  const p = (await store.listPosts()).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  await store.deletePosts([p.id]); res.status(204).end();
}));
app.delete('/api/posts', requirePin, wrap(async (req, res) => {
  const b = Number(req.query.book), c = Number(req.query.chapter), v = Number(req.query.verse);
  const ids = (await store.listPosts()).filter(x => x.book === b && x.chapter === c && x.verse === v).map(x => x.id);
  await store.deletePosts(ids); res.json({ deleted: ids.length });
}));

app.get('/api/health', (req, res) => res.json({ ok: true, storage: store.kind.startsWith('archivo') ? 'file' : 'postgres' }));
// Marcapáginas «Seguir leyendo»: solo hay uno; el nuevo sustituye al anterior
app.get('/api/bookmark', wrap(async (req, res) => res.json(await store.getSetting('bookmark'))));
app.put('/api/bookmark', wrap(async (req, res) => {
  const book = Number(req.body.book), chapter = Number(req.body.chapter), verse = Number(req.body.verse);
  if (!validRef(book, chapter, verse)) return res.status(400).json({ error: 'Referencia bíblica no válida' });
  const bm = { book, chapter, verse, savedAt: new Date().toISOString() };
  await store.setSetting('bookmark', bm);
  res.json(bm);
}));
app.delete('/api/bookmark', wrap(async (req, res) => { await store.deleteSetting('bookmark'); res.status(204).end(); }));

// ---------- Texto de los libros (lo escribe el propietario) ----------
function cleanBlocks(list) {
  if (!Array.isArray(list) || list.length > MAX_VERSE * 2) return null;
  const seen = new Set(), out = [];
  for (const b of list) {
    const t = b && b.t, text = String((b && b.text) || '').trim();
    if (!text || text.length > 5000 || !['v', 'h', 'd'].includes(t)) return null;
    if (t === 'v') {
      const n = Number(b.n);
      if (!Number.isInteger(n) || n < 1 || n > MAX_VERSE || seen.has(n)) return null;
      seen.add(n); out.push({ t, n, text });
    } else {
      if (text.length > 300) return null;
      out.push({ t, text });
    }
  }
  return out;
}
const refParams = req => ({ b: Number(req.params.b), c: Number(req.params.c) });
// Qué existe en cada capítulo: versículos, subtítulos/divisiones y nombre
app.get('/api/text-summary', wrap(async (req, res) => {
  const out = {};
  for (const d of await store.allTexts()) {
    if (!d.blocks.length && !d.name) continue;
    out[`${d.book}:${d.chapter}`] = { name: d.name, verses: d.blocks.filter(x => x.t === 'v').map(x => x.n), targets: targets(d.blocks) };
  }
  res.json(out);
}));
app.get('/api/text/:b/:c', wrap(async (req, res) => {
  const { b, c } = refParams(req); if (!validRef(b, c)) return res.status(404).json({ error: 'No existe' });
  res.json(await store.getText(b, c));
}));
app.put('/api/text/:b/:c', wrap(async (req, res) => {
  const { b, c } = refParams(req); if (!validRef(b, c)) return res.status(404).json({ error: 'No existe' });
  const blocks = cleanBlocks(req.body.blocks);
  if (!blocks) return res.status(400).json({ error: 'Texto no válido: revisa la numeración de los versículos' });
  const name = String(req.body.name || '').trim().slice(0, 150);
  await store.setText(b, c, { name, blocks });
  // Opcional: borrar comentarios y mensajes de textos que ya no existen en este capítulo
  let purged = 0;
  if (req.body.purge) {
    const verses = new Set(blocks.filter(x => x.t === 'v').map(x => x.n)), tks = new Set(targets(blocks));
    const alive = x => x.target ? tks.has(`${x.verse}:${x.target}`) : verses.has(x.verse);
    const here = x => x.book === b && x.chapter === c;
    const dc = (await store.list()).filter(x => here(x) && !alive(x)).map(x => x.id);
    const dp = (await store.listPosts()).filter(x => here(x) && !verses.has(x.verse)).map(x => x.id);
    await store.deleteComments(dc); await store.deletePosts(dp);
    const bm = await store.getSetting('bookmark');
    if (bm && bm.book === b && bm.chapter === c && !verses.has(bm.verse)) await store.deleteSetting('bookmark');
    purged = dc.length + dp.length;
  }
  res.json({ name, blocks, purged });
}));
app.put('/api/text/:b/:c/:n', wrap(async (req, res) => {
  const { b, c } = refParams(req), n = Number(req.params.n);
  if (!validRef(b, c, n)) return res.status(404).json({ error: 'No existe' });
  const text = String(req.body.text || '').trim();
  if (!text || text.length > 5000) return res.status(400).json({ error: 'El texto está vacío' });
  const doc = await store.getText(b, c);
  const v = doc.blocks.find(x => x.t === 'v' && x.n === n); if (!v) return res.status(404).json({ error: 'Versículo no encontrado' });
  v.text = text;
  await store.setText(b, c, doc);
  res.json(v);
}));
app.get('/api/posts', wrap(async (req, res) => res.json(await store.listPosts())));
app.post('/api/posts', wrap(async (req, res) => {
  const v = validate(req.body, false); if (v.error) return res.status(400).json(v);
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Escribe tu nombre' });
  res.status(201).json(await store.createPost({ book: v.book, chapter: v.chapter, verse: v.verse, name, text: v.text }));
}));
app.get('/api/comments', wrap(async (req, res) => res.json(await store.list())));
app.post('/api/comments', wrap(async (req, res) => {
  const v = validate(req.body, false); if (v.error) return res.status(400).json(v);
  res.status(201).json(await store.create(v));
}));
app.put('/api/comments/:id', wrap(async (req, res) => {
  const v = validate(req.body, true); if (v.error) return res.status(400).json(v);
  const it = await store.update(req.params.id, v); it ? res.json(it) : res.status(404).json({ error: 'No encontrado' });
}));
app.delete('/api/comments/:id', wrap(async (req, res) => {
  (await store.remove(req.params.id)) ? res.status(204).end() : res.status(404).json({ error: 'No encontrado' });
}));

// Sin caché para la app en sí: así cada actualización llega al momento
// Librería para crear los PDF en el propio móvil
app.get('/vendor/jspdf.umd.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

store.init()
  .then(async () => { topics = (await store.getSetting('topics')) || []; })
  .then(() => app.listen(PORT, () => console.log(`Evangelio escuchando en :${PORT} (almacenamiento: ${store.kind})`)))
  .catch(e => { console.error('No se pudo iniciar el almacenamiento', e); process.exit(1); });
