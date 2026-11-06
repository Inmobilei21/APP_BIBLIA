(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento local */ } },
  };
  const ICON = {
    comment: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
    forum: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };

  const state = {
    books: [],
    cache: new Map(),       // id de libro -> capítulos (array de arrays de textos)
    comments: [],
    byRef: new Map(),       // "libro:cap:vers" -> [comentarios]
    posts: [],
    postsByRef: new Map(),  // "libro:cap:vers" -> [mensajes de discusión]
    book: 1, chapter: 1,
    active: null,           // versículo con las acciones abiertas
    pendingOpen: null,      // { v, mode } para abrir tras navegar
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
  function group(list) {
    const m = new Map();
    for (const c of list) {
      const k = key(c.book, c.chapter, c.verse);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(c);
    }
    return m;
  }
  const indexComments = () => { state.byRef = group(state.comments); };
  const indexPosts = () => { state.postsByRef = group(state.posts); };
  async function loadAll() {
    const [c, p] = await Promise.allSettled([api('GET', '/api/comments'), api('GET', '/api/posts')]);
    state.comments = c.status === 'fulfilled' ? c.value : [];
    state.posts = p.status === 'fulfilled' ? p.value : [];
    if (c.status === 'rejected' || p.status === 'rejected') toast('No se pudieron cargar los comentarios');
    indexComments(); indexPosts();
  }

  // ---------- Utilidades de interfaz ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  const fmtDate = iso => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtText = t => esc(t);

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
    let r = parseHash() || store.get('last', { b: 1, c: 1 });
    if (!bookOf(r.b) || r.c > bookOf(r.b).chapters.length) r = { b: 1, c: 1 };
    const changed = r.b !== state.book || r.c !== state.chapter || !$('#verses').children.length;
    state.book = r.b; state.chapter = r.c;
    store.set('last', { b: r.b, c: r.c });
    if (changed) { await renderChapter(); window.scrollTo(0, 0); }
    if (r.v) {
      const el = document.getElementById(`v${r.v}`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: changed ? 'auto' : 'smooth' });
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        if (state.pendingOpen && state.pendingOpen.v === r.v) openActions(r.v, state.pendingOpen.mode);
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
        <span class="vnum">${i + 1}</span><span class="vtext">${esc(t)}</span>${extrasHtml(b, c, i + 1)}
      </section>`).join('');
  }
  // Punto + comentario visible justo debajo del texto
  function extrasHtml(b, c, v) {
    const list = state.byRef.get(key(b, c, v)) || [];
    if (!list.length) return '';
    return `<span class="dot" title="Tiene comentario"></span>
      <div class="vcomment">${list.map(cm => `<p>${fmtText(cm.text)}</p>`).join('')}</div>`;
  }
  function refreshVerse(v) {
    const el = document.getElementById(`v${v}`); if (!el) return;
    el.querySelectorAll('.dot, .vcomment').forEach(x => x.remove());
    const actions = el.querySelector('.vactions');
    const tmp = document.createElement('div');
    tmp.innerHTML = extrasHtml(state.book, state.chapter, v);
    [...tmp.childNodes].forEach(n => actions ? el.insertBefore(n, actions) : el.appendChild(n));
  }
  const verseText = v => state.cache.get(state.book)[state.chapter - 1][v - 1];
  const commentOf = v => (state.byRef.get(key(state.book, state.chapter, v)) || [])[0];

  function closeActions() {
    if (!state.active) return;
    const el = document.getElementById(`v${state.active}`);
    el?.classList.remove('active');
    el?.querySelector('.vactions')?.remove();
    state.active = null;
  }
  // Acciones discretas debajo del versículo (y de su comentario, si lo hay)
  function openActions(v, mode) {
    closeActions();
    const el = document.getElementById(`v${v}`); if (!el) return;
    state.active = v;
    el.classList.add('active');
    const has = !!commentOf(v);
    const n = (state.postsByRef.get(key(state.book, state.chapter, v)) || []).length;
    const box = document.createElement('div');
    box.className = 'vactions';
    box.innerHTML = `
      <div class="actions">
        <button class="act" data-act="comment">${ICON.comment}${has ? 'Editar' : 'Añadir comentario'}</button>
        <button class="act" data-act="share">${ICON.share}Compartir</button>
        <button class="act" data-act="forum">${ICON.forum}Discusión${n ? ` <span class="act-count">${n}</span>` : ''}</button>
      </div>
      <div class="slot"></div>`;
    el.appendChild(box);
    if (mode === 'comment') showCommentForm(box);
    if (mode === 'forum') showForum(box, v);
  }

  function showCommentForm(box) {
    const existing = commentOf(state.active);
    box.querySelector('.slot').innerHTML = `
      <div class="form">
        <textarea class="ctext" placeholder="Escribe aquí tu comentario…" aria-label="Comentario">${existing ? esc(existing.text) : ''}</textarea>
        <div class="form-row">
          ${existing ? '<button class="btn ghost danger" data-act="delete">Eliminar</button><span class="grow"></span>' : ''}
          <button class="btn ghost" data-act="cancel">Cancelar</button>
          <button class="btn primary" data-act="save">Guardar</button>
        </div>
      </div>`;
    const ta = box.querySelector('textarea');
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  async function saveComment(box) {
    const v = state.active;
    const text = box.querySelector('.ctext').value.trim();
    const existing = commentOf(v);
    if (!text) return existing ? deleteComment(box) : toast('Escribe un comentario');
    const btn = box.querySelector('[data-act="save"]'); btn.disabled = true;
    try {
      if (existing) {
        const upd = await api('PUT', `/api/comments/${existing.id}`, { text });
        state.comments = state.comments.map(c => c.id === upd.id ? upd : c);
      } else {
        state.comments.push(await api('POST', '/api/comments', { book: state.book, chapter: state.chapter, verse: v, text }));
      }
      indexComments(); refreshVerse(v); renderCommentIndex(); closeActions();
      toast('Comentario guardado');
    } catch (e) {
      btn.disabled = false;
      toast('No se pudo guardar: ' + e.message);
    }
  }

  async function deleteComment() {
    const v = state.active;
    const list = state.byRef.get(key(state.book, state.chapter, v)) || [];
    if (!list.length || !confirm('¿Eliminar el comentario de este versículo?')) return;
    try {
      for (const c of list) await api('DELETE', `/api/comments/${c.id}`);
      const ids = new Set(list.map(c => c.id));
      state.comments = state.comments.filter(c => !ids.has(c.id));
      indexComments(); refreshVerse(v); renderCommentIndex(); closeActions();
      toast('Comentario eliminado');
    } catch (e) { toast('No se pudo eliminar: ' + e.message); }
  }

  // ---------- Discusión (foro por versículo) ----------
  function postsHtml(list) {
    if (!list.length) return '<p class="empty">Todavía no hay mensajes. Empieza la discusión.</p>';
    return list.map(p => `
      <div class="post">
        <div class="post-meta"><b>${esc(p.name)}</b><span>${fmtDate(p.createdAt)}</span></div>
        <div class="post-text">${fmtText(p.text)}</div>
      </div>`).join('');
  }
  function showForum(box, v) {
    const list = state.postsByRef.get(key(state.book, state.chapter, v)) || [];
    box.querySelector('.slot').innerHTML = `
      <div class="forum">
        <div class="forum-title">Discusión · ${esc(refLabel(state.book, state.chapter, v))}</div>
        <div class="posts">${postsHtml(list)}</div>
        <div class="form">
          <input class="pname" type="text" maxlength="40" placeholder="Tu nombre" aria-label="Tu nombre" value="${esc(store.get('name', ''))}">
          <textarea class="ptext" placeholder="Escribe tu mensaje…" aria-label="Mensaje"></textarea>
          <div class="form-row">
            <button class="btn ghost" data-act="cancel">Cerrar</button>
            <button class="btn primary" data-act="post">Publicar</button>
          </div>
        </div>
      </div>`;
    const posts = box.querySelector('.posts'); posts.scrollTop = posts.scrollHeight;
  }
  async function publish(box) {
    const v = state.active;
    const name = box.querySelector('.pname').value.trim();
    const text = box.querySelector('.ptext').value.trim();
    if (!name) return toast('Escribe tu nombre');
    if (!text) return toast('Escribe un mensaje');
    const btn = box.querySelector('[data-act="post"]'); btn.disabled = true;
    try {
      state.posts.push(await api('POST', '/api/posts', { book: state.book, chapter: state.chapter, verse: v, name, text }));
      store.set('name', name);
      indexPosts(); renderForumIndex();
      openActions(v, 'forum');
      toast('Mensaje publicado');
    } catch (e) {
      btn.disabled = false;
      toast('No se pudo publicar: ' + e.message);
    }
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

  $('#verses').addEventListener('click', e => {
    const verse = e.target.closest('.verse'); if (!verse) return;
    const v = +verse.dataset.v;
    const box = e.target.closest('.vactions');
    if (!box) { state.active === v ? closeActions() : openActions(v); return; }
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'comment') showCommentForm(box);
    else if (act === 'forum') showForum(box, v);
    else if (act === 'share') share(v);
    else if (act === 'cancel') box.querySelector('.slot').innerHTML = '';
    else if (act === 'save') saveComment(box);
    else if (act === 'delete') deleteComment(box);
    else if (act === 'post') publish(box);
  });
  $('#verses').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('verse')) {
      e.preventDefault(); const v = +e.target.dataset.v; state.active === v ? closeActions() : openActions(v);
    }
  });

  // ---------- Menú lateral ----------
  const drawer = $('#drawer'), scrim = $('#scrim');
  const SECTIONS = ['bibleNav', 'commentIndex', 'forumIndex'];
  function openDrawer(section) {
    renderBookList();
    if (section) for (const id of SECTIONS) setSection(id, id === section);
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
  // Acordeón: abrir una sección cierra las demás
  drawer.querySelectorAll('.section-toggle').forEach(t => t.addEventListener('click', () => {
    const open = t.getAttribute('aria-expanded') !== 'true';
    for (const id of SECTIONS) setSection(id, false);
    setSection(t.dataset.target, open);
  }));
  $('#menuBtn').addEventListener('click', () => openDrawer());
  $('#closeDrawer').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  $('#chapterTitle').addEventListener('click', () => { expandedBook = state.book; openDrawer('bibleNav'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { drawer.classList.contains('open') ? closeDrawer() : closeActions(); }
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  let expandedBook = null;
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function renderBookList() {
    const q = norm($('#bookFilter').value.trim());
    const withComments = new Set(state.comments.map(c => `${c.book}:${c.chapter}`));
    let html = '';
    for (const t of ['AT', 'NT']) {
      const books = state.books.filter(b => b.testament === t && (!q || norm(b.name).includes(q)));
      if (!books.length) continue;
      html += `<div class="testament">${t === 'AT' ? 'Antiguo Testamento' : 'Nuevo Testamento'}</div>`;
      for (const b of books) {
        const open = expandedBook === b.id;
        html += `<button class="book-btn${b.id === state.book ? ' current' : ''}" data-book="${b.id}" aria-expanded="${open}">${esc(b.name)}<span class="chev"></span></button>`;
        if (open) html += `<div class="chapter-grid">${b.chapters.map((_, i) =>
          `<button data-b="${b.id}" data-c="${i + 1}" class="${b.id === state.book && i + 1 === state.chapter ? 'current' : ''}${withComments.has(`${b.id}:${i + 1}`) ? ' has-c' : ''}">${i + 1}</button>`).join('')}</div>`;
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
      if (bookOf(id).chapters.length === 1) { closeDrawer(); go(id, 1); return; }
      expandedBook = expandedBook === id ? null : id;
      renderBookList();
    }
  });

  // Índices desplegables: Libro → Capítulo:Versículo → contenido
  function makeIndex({ el, countEl, byRef, emptyText, refLabelText, body, gotoMode, gotoText }) {
    const open = { books: new Set(), refs: new Set() };
    function render() {
      const total = [...byRef()].reduce((s, [, l]) => s + l.length, 0);
      countEl.textContent = total;
      if (!total) { el.innerHTML = `<div class="empty">${emptyText}</div>`; return; }
      const groups = new Map();
      for (const [k, list] of byRef()) {
        const b = +k.split(':')[0];
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push([k, list]);
      }
      const cmp = (a, b) => { const [, c1, v1] = a[0].split(':').map(Number), [, c2, v2] = b[0].split(':').map(Number); return c1 - c2 || v1 - v2; };
      let html = '';
      for (const b of [...groups.keys()].sort((x, y) => x - y)) {
        const refs = groups.get(b).sort(cmp);
        const bOpen = open.books.has(b);
        html += `<button class="idx-book" data-ib="${b}" aria-expanded="${bOpen}">${esc(bookOf(b).name)}<span class="count">${refs.length}</span><span class="chev"></span></button>`;
        if (!bOpen) continue;
        html += '<div class="idx-refs">';
        for (const [k, list] of refs) {
          const [, c, v] = k.split(':').map(Number);
          const rOpen = open.refs.has(k);
          html += `<button class="idx-ref" data-ir="${k}" aria-expanded="${rOpen}">${refLabelText(c, v, list)}<span class="chev"></span></button>`;
          if (rOpen) {
            const txt = state.cache.get(b)?.[c - 1]?.[v - 1];
            html += `<div class="idx-body">
              ${txt ? `<p class="idx-verse">«${esc(txt)}»</p>` : ''}
              ${body(list)}
              <p class="idx-go-row"><button class="idx-go" data-goto="${k}">${gotoText} ›</button></p>
            </div>`;
          }
        }
        html += '</div>';
      }
      el.innerHTML = html;
    }
    el.addEventListener('click', async e => {
      const t = e.target.closest('[data-ib],[data-ir],[data-goto]'); if (!t) return;
      if (t.dataset.goto) {
        const [b, c, v] = t.dataset.goto.split(':').map(Number);
        closeDrawer(); state.pendingOpen = { v, mode: gotoMode }; go(b, c, v); return;
      }
      if (t.dataset.ib) {
        const b = +t.dataset.ib;
        open.books.has(b) ? open.books.delete(b) : open.books.add(b);
      } else {
        const k = t.dataset.ir;
        if (open.refs.has(k)) open.refs.delete(k);
        else { open.refs.add(k); try { await loadBook(+k.split(':')[0]); } catch { /* se muestra sin texto */ } }
      }
      render();
    });
    return render;
  }
  const renderCommentIndex = makeIndex({
    el: $('#commentIndex'), countEl: $('#commentTotal'), byRef: () => state.byRef,
    emptyText: 'Aún no hay comentarios. Pulsa cualquier versículo para añadir uno.',
    refLabelText: (c, v) => `Versículo ${c}:${v}`,
    body: list => list.map(cm => `<div class="idx-comment">${fmtText(cm.text)}</div>`).join(''),
    gotoMode: null, gotoText: 'Ir al versículo',
  });
  const renderForumIndex = makeIndex({
    el: $('#forumIndex'), countEl: $('#forumTotal'), byRef: () => state.postsByRef,
    emptyText: 'Aún no hay discusiones. Pulsa un versículo y elige «Discusión» para empezar una.',
    refLabelText: (c, v, list) => `Versículo ${c}:${v}<span class="count">${list.length} mensaje${list.length > 1 ? 's' : ''}</span>`,
    body: list => {
      const last = list[list.length - 1];
      return `<p class="idx-last">Último mensaje de <b>${esc(last.name)}</b> · ${fmtDate(last.createdAt)}</p>`;
    },
    gotoMode: 'forum', gotoText: 'Abrir discusión',
  });

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
    await Promise.all([loadAll(), route()]);
    // mostrar comentarios cuando lleguen
    $('#verses').querySelectorAll('.verse').forEach(el => refreshVerse(+el.dataset.v));
    renderCommentIndex(); renderForumIndex();
  })();
})();
