(() => {
  'use strict';

  const AUTHORS = ['MMF', 'LFD'];
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento local */ } },
  };
  const ICON = {
    comment: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M12 9v6M9 12h6"/></svg>',
    share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
    pdf: '<svg viewBox="0 0 24 24"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>',
  };

  const state = {
    books: [],
    cache: new Map(),       // id de libro -> capítulos (array de arrays de textos)
    comments: [],
    byRef: new Map(),       // "libro:cap:vers" -> [comentarios]
    book: 1, chapter: 1,
    active: null,           // versículo con el panel abierto
  };
  const key = (b, c, v) => `${b}:${c}:${v}`;
  const bookOf = id => state.books[id - 1];
  const refLabel = (b, c, v) => `${bookOf(b).name} ${c}:${v}`;

  // ---------- Datos ----------
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      let msg = 'Error ' + r.status;
      try { msg = (await r.json()).error || msg; } catch { /* sin cuerpo */ }
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }
  async function loadBook(id) {
    if (!state.cache.has(id)) {
      const r = await fetch(`/data/books/${String(id).padStart(2, '0')}.json`);
      if (!r.ok) throw new Error('No se pudo cargar el libro');
      state.cache.set(id, await r.json());
    }
    return state.cache.get(id);
  }
  function indexComments() {
    state.byRef.clear();
    for (const c of state.comments) {
      const k = key(c.book, c.chapter, c.verse);
      if (!state.byRef.has(k)) state.byRef.set(k, []);
      state.byRef.get(k).push(c);
    }
  }
  async function loadComments() {
    try {
      state.comments = await api('GET', '/api/comments');
    } catch (e) {
      toast('No se pudieron cargar los comentarios');
      state.comments = [];
    }
    indexComments();
  }

  // ---------- Utilidades de interfaz ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  const fmtDate = iso => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ---------- Navegación ----------
  function parseHash() {
    const m = location.hash.match(/^#\/(\d+)\/(\d+)(?:\/(\d+))?/);
    if (!m) return null;
    const b = +m[1], c = +m[2], v = m[3] ? +m[3] : null;
    const book = bookOf(b);
    if (!book || c < 1 || c > book.chapters.length) return null;
    return { b, c, v: v && v <= book.chapters[c - 1] ? v : null };
  }
  function go(b, c, v) {
    const h = `#/${b}/${c}${v ? '/' + v : ''}`;
    if (location.hash === h) route(); else location.hash = h;
  }
  function step(dir) {
    let b = state.book, c = state.chapter + dir;
    if (c < 1) { if (b === 1) return; b--; c = bookOf(b).chapters.length; }
    else if (c > bookOf(b).chapters.length) { if (b === 66) return; b++; c = 1; }
    go(b, c);
  }
  async function route() {
    const r = parseHash() || store.get('last', { b: 1, c: 1 });
    const changed = r.b !== state.book || r.c !== state.chapter || !$('#verses').children.length;
    state.book = r.b; state.chapter = r.c;
    store.set('last', { b: r.b, c: r.c });
    if (changed) { await renderChapter(); window.scrollTo(0, 0); }
    if (r.v) {
      const el = document.getElementById(`v${r.v}`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: changed ? 'auto' : 'smooth' });
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        if (state.pendingOpen === r.v) openPanel(r.v);
      }
    }
    state.pendingOpen = null;
  }

  // ---------- Lector ----------
  async function renderChapter() {
    const { book: b, chapter: c } = state;
    const book = bookOf(b);
    $('#chapterTitle').textContent = `${book.name} ${c}`;
    document.title = `${book.name} ${c} · Santa Biblia`;
    for (const id of ['prevCh', 'prevCh2']) $('#' + id).disabled = b === 1 && c === 1;
    for (const id of ['nextCh', 'nextCh2']) $('#' + id).disabled = b === 66 && c === book.chapters.length;
    const wrap = $('#verses');
    wrap.innerHTML = '<p class="loading">Cargando…</p>';
    state.active = null;
    let chapters;
    try { chapters = await loadBook(b); } catch { wrap.innerHTML = '<p class="loading">No se pudo cargar el texto. Revisa la conexión.</p>'; return; }
    if (state.book !== b || state.chapter !== c) return; // el usuario ya navegó a otro sitio
    wrap.innerHTML = chapters[c - 1].map((t, i) => `
      <section class="verse" id="v${i + 1}" data-v="${i + 1}" tabindex="0" aria-label="Versículo ${i + 1}">
        <span class="vnum">${i + 1}</span><span class="vtext">${esc(t)}</span>${dotHtml(b, c, i + 1)}
      </section>`).join('');
  }
  function dotHtml(b, c, v) {
    const n = (state.byRef.get(key(b, c, v)) || []).length;
    return n ? `<span class="dot" title="${n} comentario${n > 1 ? 's' : ''}">${n > 1 ? n : '!'}</span>` : '';
  }
  function refreshDot(v) {
    const el = document.getElementById(`v${v}`); if (!el) return;
    el.querySelector('.dot')?.remove();
    el.insertAdjacentHTML('beforeend', dotHtml(state.book, state.chapter, v));
  }
  const verseText = v => bookOf(state.book) && state.cache.get(state.book)[state.chapter - 1][v - 1];

  function closePanel() {
    if (!state.active) return;
    const el = document.getElementById(`v${state.active}`);
    el?.classList.remove('active');
    el?.querySelector('.panel')?.remove();
    state.active = null;
  }
  function openPanel(v, { form = false } = {}) {
    closePanel();
    const el = document.getElementById(`v${v}`); if (!el) return;
    state.active = v;
    el.classList.add('active');
    const list = state.byRef.get(key(state.book, state.chapter, v)) || [];
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="actions">
        <button class="btn primary" data-act="add">${ICON.comment} Añadir comentario</button>
        <button class="btn" data-act="share">${ICON.share} Compartir</button>
        <button class="btn" data-act="pdf">${ICON.pdf} Imprimir PDF</button>
      </div>
      <div class="form-slot"></div>
      ${list.length ? `<div class="comments">${list.map(commentHtml).join('')}</div>` : ''}`;
    el.appendChild(panel);
    if (form) showForm(panel);
  }
  function commentHtml(c) {
    return `<div class="comment" data-id="${c.id}">
      <div class="comment-meta"><span class="author-tag ${esc(c.author)}">${esc(c.author)}</span>
        <span>${fmtDate(c.createdAt)}</span>${c.updatedAt ? '<span>· editado</span>' : ''}</div>
      <div class="comment-text">${esc(c.text)}</div>
      <div class="comment-tools">
        <button class="btn small ghost" data-act="edit">Editar</button>
        <button class="btn small danger" data-act="del">Borrar</button>
      </div>
    </div>`;
  }
  function showForm(panel, editing) {
    const slot = panel.querySelector('.form-slot');
    let author = editing ? editing.author : store.get('author', null);
    slot.innerHTML = `
      <div class="form">
        <label>¿Quién comenta?</label>
        <div class="authors" role="group" aria-label="Autor">
          ${AUTHORS.map(a => `<button type="button" class="author-opt" data-author="${a}" aria-pressed="${a === author}">${a}</button>`).join('')}
        </div>
        <label for="ctext">${editing ? 'Editar comentario' : 'Comentario'}</label>
        <textarea id="ctext" placeholder="Escribe aquí tu comentario…">${editing ? esc(editing.text) : ''}</textarea>
        <div class="form-row">
          <button class="btn ghost" data-act="cancel">Cancelar</button>
          <button class="btn primary" data-act="save">Guardar</button>
        </div>
      </div>`;
    const form = slot.firstElementChild;
    form.dataset.editId = editing ? editing.id : '';
    form.querySelectorAll('.author-opt').forEach(b => b.addEventListener('click', () => {
      author = b.dataset.author;
      form.querySelectorAll('.author-opt').forEach(x => x.setAttribute('aria-pressed', x === b));
    }));
    form.getAuthor = () => author;
    const ta = form.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  async function saveForm(panel) {
    const form = panel.querySelector('.form');
    const author = form.getAuthor();
    const text = form.querySelector('textarea').value.trim();
    if (!author) return toast('Elige quién hace el comentario (MMF o LFD)');
    if (!text) return toast('Escribe un comentario');
    const v = state.active;
    const btn = form.querySelector('[data-act="save"]'); btn.disabled = true;
    try {
      if (form.dataset.editId) {
        const upd = await api('PUT', `/api/comments/${form.dataset.editId}`, { author, text });
        state.comments = state.comments.map(c => c.id === upd.id ? upd : c);
      } else {
        const c = await api('POST', '/api/comments', { book: state.book, chapter: state.chapter, verse: v, author, text });
        state.comments.push(c);
      }
      store.set('author', author);
      indexComments(); refreshDot(v); renderCommentIndex();
      openPanel(v);
      toast('Comentario guardado');
    } catch (e) {
      btn.disabled = false;
      toast('No se pudo guardar: ' + e.message);
    }
  }

  async function deleteComment(id) {
    if (!confirm('¿Borrar este comentario?')) return;
    try {
      await api('DELETE', `/api/comments/${id}`);
      state.comments = state.comments.filter(c => c.id !== id);
      const v = state.active;
      indexComments(); refreshDot(v); renderCommentIndex(); openPanel(v);
      toast('Comentario borrado');
    } catch (e) { toast('No se pudo borrar: ' + e.message); }
  }

  async function share(v) {
    const ref = refLabel(state.book, state.chapter, v);
    const url = `${location.origin}/#/${state.book}/${state.chapter}/${v}`;
    const text = `«${verseText(v)}»\n— ${ref} (RV1909)`;
    try {
      if (navigator.share) { await navigator.share({ title: ref, text, url }); return; }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Versículo copiado al portapapeles');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      prompt('Copia el texto para compartir:', `${text}\n${url}`);
    }
  }

  function printVerse(v) {
    const ref = refLabel(state.book, state.chapter, v);
    const list = state.byRef.get(key(state.book, state.chapter, v)) || [];
    $('#printArea').innerHTML = `
      <div class="pa-head"><img src="/icons/icon-192.png" alt=""><div><h1>${esc(ref)}</h1><small>Santa Biblia · Reina-Valera 1909</small></div></div>
      <p class="pa-text"><b>${v}</b> ${esc(verseText(v))}</p>
      ${list.length ? `<div class="pa-comments"><h2>Comentarios</h2>${list.map(c => `
        <div class="pa-comment"><div class="pa-meta"><b>${esc(c.author)}</b> · ${fmtDate(c.createdAt)}</div>
        <div class="comment-text">${esc(c.text)}</div></div>`).join('')}</div>` : ''}
      <div class="pa-foot">Impreso el ${fmtDate(new Date().toISOString())}</div>`;
    const prevTitle = document.title;
    document.title = ref.replace(/[:\s]+/g, '_');   // nombre sugerido del PDF
    document.body.classList.add('print-verse');
    const done = () => { document.body.classList.remove('print-verse'); document.title = prevTitle; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    // Esperar a que cargue el logo antes de abrir el diálogo de impresión
    const img = $('#printArea img');
    const go = () => { window.print(); setTimeout(done, 1000); };
    img.complete ? go() : (img.onload = img.onerror = go);
  }

  $('#verses').addEventListener('click', e => {
    const verse = e.target.closest('.verse'); if (!verse) return;
    const v = +verse.dataset.v;
    const panel = e.target.closest('.panel');
    if (!panel) { state.active === v ? closePanel() : openPanel(v); return; }
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'add') showForm(panel);
    else if (act === 'cancel') panel.querySelector('.form-slot').innerHTML = '';
    else if (act === 'save') saveForm(panel);
    else if (act === 'share') share(v);
    else if (act === 'pdf') printVerse(v);
    else if (act === 'edit') showForm(panel, state.comments.find(c => c.id === btn.closest('.comment').dataset.id));
    else if (act === 'del') deleteComment(btn.closest('.comment').dataset.id);
  });
  $('#verses').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('verse')) {
      e.preventDefault(); const v = +e.target.dataset.v; state.active === v ? closePanel() : openPanel(v);
    }
  });

  // ---------- Menú lateral ----------
  const drawer = $('#drawer'), scrim = $('#scrim');
  function openDrawer(section) {
    renderBookList();
    if (section) for (const id of ['bibleNav', 'commentIndex']) setSection(id, id === section);
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    scrim.hidden = false; $('#menuBtn').setAttribute('aria-expanded', 'true');
    if (section === 'bibleNav') $(`#bookList [data-book="${state.book}"]`)?.scrollIntoView({ block: 'center' });
  }
  function closeDrawer() {
    drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
    scrim.hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false');
  }
  function setSection(id, open) {
    const t = drawer.querySelector(`[data-target="${id}"]`);
    t.setAttribute('aria-expanded', open); $('#' + id).hidden = !open;
  }
  // Acordeón: abrir una sección cierra la otra
  drawer.querySelectorAll('.section-toggle').forEach(t => t.addEventListener('click', () => {
    const open = t.getAttribute('aria-expanded') !== 'true';
    drawer.querySelectorAll('.section-toggle').forEach(o => setSection(o.dataset.target, false));
    setSection(t.dataset.target, open);
  }));
  $('#menuBtn').addEventListener('click', () => openDrawer());
  $('#closeDrawer').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  $('#chapterTitle').addEventListener('click', () => { expandedBook = state.book; openDrawer('bibleNav'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { drawer.classList.contains('open') ? closeDrawer() : closePanel(); }
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  let expandedBook = null;
  function renderBookList() {
    const q = $('#bookFilter').value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const counts = new Map();
    for (const c of state.comments) counts.set(`${c.book}:${c.chapter}`, 1);
    let html = '';
    for (const t of ['AT', 'NT']) {
      const books = state.books.filter(b => b.testament === t &&
        (!q || b.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q)));
      if (!books.length) continue;
      html += `<div class="testament">${t === 'AT' ? 'Antiguo Testamento' : 'Nuevo Testamento'}</div>`;
      for (const b of books) {
        const open = expandedBook === b.id;
        html += `<button class="book-btn${b.id === state.book ? ' current' : ''}" data-book="${b.id}" aria-expanded="${open}">${esc(b.name)}<span class="chev"></span></button>`;
        if (open) html += `<div class="chapter-grid">${b.chapters.map((_, i) =>
          `<button data-b="${b.id}" data-c="${i + 1}" class="${b.id === state.book && i + 1 === state.chapter ? 'current' : ''}${counts.has(`${b.id}:${i + 1}`) ? ' has-c' : ''}">${i + 1}</button>`).join('')}</div>`;
      }
    }
    $('#bookList').innerHTML = html || '<div class="empty">Ningún libro coincide.</div>';
  }
  $('#bookFilter').addEventListener('input', renderBookList);
  $('#bookList').addEventListener('click', e => {
    const ch = e.target.closest('[data-c]');
    if (ch) { closeDrawer(); go(+ch.dataset.b, +ch.dataset.c); return; }
    const bk = e.target.closest('[data-book]');
    if (bk) {
      const id = +bk.dataset.book;
      const b = bookOf(id);
      if (b.chapters.length === 1) { closeDrawer(); go(id, 1); return; }
      expandedBook = expandedBook === id ? null : id;
      renderBookList();
    }
  });

  // Índice de comentarios: Libro → Capítulo:Versículo → comentarios
  const openIdx = { books: new Set(), refs: new Set() };
  function renderCommentIndex() {
    $('#commentTotal').textContent = state.comments.length;
    const el = $('#commentIndex');
    if (!state.comments.length) {
      el.innerHTML = '<div class="empty">Aún no hay comentarios. Pulsa cualquier versículo para añadir uno.</div>';
      return;
    }
    const groups = new Map();
    for (const [k, list] of state.byRef) {
      const [b] = k.split(':').map(Number);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push([k, list]);
    }
    const sortRef = (a, b) => { const [, c1, v1] = a[0].split(':').map(Number), [, c2, v2] = b[0].split(':').map(Number); return c1 - c2 || v1 - v2; };
    let html = '';
    for (const b of [...groups.keys()].sort((x, y) => x - y)) {
      const refs = groups.get(b).sort(sortRef);
      const total = refs.reduce((s, [, l]) => s + l.length, 0);
      const bOpen = openIdx.books.has(b);
      html += `<button class="idx-book" data-ib="${b}" aria-expanded="${bOpen}">${esc(bookOf(b).name)}<span class="count">${total}</span><span class="chev"></span></button>`;
      if (!bOpen) continue;
      html += '<div class="idx-refs">';
      for (const [k, list] of refs) {
        const [, c, v] = k.split(':').map(Number);
        const rOpen = openIdx.refs.has(k);
        html += `<button class="idx-ref" data-ir="${k}" aria-expanded="${rOpen}">Versículo ${c}:${v}<span class="count">${list.length}</span><span class="chev"></span></button>`;
        if (rOpen) {
          const txt = state.cache.get(b)?.[c - 1]?.[v - 1];
          html += `<div class="idx-comments">
            ${txt ? `<p class="idx-verse">«${esc(txt)}»</p>` : ''}
            <div class="comments" style="margin-top:0">${list.map(cm => `
              <div class="comment"><div class="comment-meta"><span class="author-tag ${esc(cm.author)}">${esc(cm.author)}</span><span>${fmtDate(cm.createdAt)}</span></div>
              <div class="comment-text">${esc(cm.text)}</div></div>`).join('')}</div>
            <p style="margin:8px 0 0"><button class="idx-go" data-goto="${k}">Ir al versículo ›</button></p>
          </div>`;
        }
      }
      html += '</div>';
    }
    el.innerHTML = html;
  }
  $('#commentIndex').addEventListener('click', async e => {
    const t = e.target.closest('[data-ib],[data-ir],[data-goto]'); if (!t) return;
    if (t.dataset.goto) {
      const [b, c, v] = t.dataset.goto.split(':').map(Number);
      closeDrawer(); goAndOpen(b, c, v); return;
    }
    if (t.dataset.ib) {
      const b = +t.dataset.ib;
      openIdx.books.has(b) ? openIdx.books.delete(b) : openIdx.books.add(b);
    } else {
      const k = t.dataset.ir;
      if (openIdx.refs.has(k)) openIdx.refs.delete(k);
      else { openIdx.refs.add(k); try { await loadBook(+k.split(':')[0]); } catch { /* se muestra sin texto */ } }
    }
    renderCommentIndex();
  });
  function goAndOpen(b, c, v) { state.pendingOpen = v; go(b, c, v); }

  for (const [id, d] of [['prevCh', -1], ['prevCh2', -1], ['nextCh', 1], ['nextCh2', 1]])
    $('#' + id).addEventListener('click', () => step(d));
  window.addEventListener('hashchange', route);

  // ---------- Inicio ----------
  (async () => {
    try {
      const idx = await (await fetch('/data/index.json')).json();
      state.books = idx.books;
    } catch {
      $('#verses').innerHTML = '<p class="loading">No se pudo cargar la Biblia.</p>';
      return;
    }
    state.book = 0;
    await Promise.all([loadComments(), route()]);
    // refrescar puntos verdes cuando lleguen los comentarios
    $('#verses').querySelectorAll('.verse').forEach(el => refreshDot(+el.dataset.v));
    renderCommentIndex();
  })();
})();
