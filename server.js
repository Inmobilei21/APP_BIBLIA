const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const AUTHORS = ['MMF', 'LFD'];
const app = express();
app.use(express.json({ limit: '200kb' }));

// ---------- Almacenamiento: PostgreSQL si hay DATABASE_URL; si no, archivo JSON ----------
function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const ssl = /localhost|\.railway\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
    const row = r => ({ id: r.id, book: r.book, chapter: r.chapter, verse: r.verse, author: r.author,
      text: r.text, createdAt: r.created_at, updatedAt: r.updated_at });
    return {
      kind: 'postgres',
      async init() {
        await pool.query(`CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY, book INT NOT NULL, chapter INT NOT NULL, verse INT NOT NULL,
          author TEXT NOT NULL, text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ)`);
        await pool.query('CREATE INDEX IF NOT EXISTS comments_ref ON comments(book, chapter, verse)');
      },
      async list() {
        const { rows } = await pool.query('SELECT * FROM comments ORDER BY book, chapter, verse, created_at');
        return rows.map(row);
      },
      async create(c) {
        const { rows } = await pool.query(
          'INSERT INTO comments (id, book, chapter, verse, author, text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [crypto.randomUUID(), c.book, c.chapter, c.verse, c.author, c.text]);
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
  let items = [];
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(items, null, 1)); };
  return {
    kind: 'archivo ' + file,
    async init() { try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { items = []; } },
    async list() {
      return [...items].sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse
        || a.createdAt.localeCompare(b.createdAt));
    },
    async create(c) {
      const it = { id: crypto.randomUUID(), ...c, createdAt: new Date().toISOString(), updatedAt: null };
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
const bibleIndex = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data', 'index.json'), 'utf8'));
function validate(body, partial) {
  const author = String(body.author || '');
  const text = String(body.text || '').trim();
  if (!AUTHORS.includes(author)) return { error: 'Autor no válido' };
  if (!text) return { error: 'El comentario está vacío' };
  if (text.length > 20000) return { error: 'Comentario demasiado largo' };
  if (partial) return { author, text };
  const book = Number(body.book), chapter = Number(body.chapter), verse = Number(body.verse);
  const b = bibleIndex.books[book - 1];
  if (!b || !(chapter >= 1 && chapter <= b.chapters.length) || !(verse >= 1 && verse <= b.chapters[chapter - 1]))
    return { error: 'Referencia bíblica no válida' };
  return { book, chapter, verse, author, text };
}

// ---------- API ----------
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Error del servidor' }); });
app.get('/api/health', (req, res) => res.json({ ok: true, storage: store.kind.startsWith('archivo') ? 'file' : 'postgres' }));
app.get('/api/authors', (req, res) => res.json(AUTHORS));
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

app.use('/data', express.static(path.join(__dirname, 'public', 'data'), { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

store.init()
  .then(() => app.listen(PORT, () => console.log(`Biblia escuchando en :${PORT} (almacenamiento: ${store.kind})`)))
  .catch(e => { console.error('No se pudo iniciar el almacenamiento', e); process.exit(1); });
