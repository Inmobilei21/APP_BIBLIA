(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento local */ } },
  };
  const ICON = {
    comment: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
    ribbon: '<svg viewBox="0 0 24 24" class="ribbon-ico"><path d="M7 1h10v22l-5-5.5L7 23z"/></svg>',
    forum: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };

  const state = {
    books: [],              // [{ id, part, name, short, chapters }]
    texts: new Map(),       // "libro:cap" -> [{ n, text, title? }]
    summary: {},            // "libro:cap" -> nº de versículos con texto
    comments: [], byRef: new Map(),
    posts: [], postsByRef: new Map(),
    book: 0, chapter: 1,
    active: null,           // versículo abierto
    pendingOpen: null,      // { v, mode } para abrir tras navegar
    bookmark: null,         // { book, chapter, verse } — «Seguir leyendo»
  };
  const key = (b, c, v) => `${b}:${c}:${v}`;
  const bookOf = id => state.books.find(b => b.id === id);
  const refLabel = (b, c, v) => `${bookOf(b).short} ${c}:${v}`;

  // ---------- Bloqueo del desplazamiento del fondo (menú y ventanas abiertas) ----------
  const locks = new Set(); let lockedY = 0;
  function lockScroll(reason) {
    if (!locks.size) {
      lockedY = window.scrollY;
      document.body.style.top = `-${lockedY}px`;
      document.body.classList.add('scroll-locked');
    }
    locks.add(reason);
  }
  function unlockScroll(reason) {
    if (!locks.delete(reason) || locks.size) return;
    document.body.classList.remove('scroll-locked');
    document.body.style.top = '';
    window.scrollTo(0, lockedY);
  }

  // ---------- Datos ----------
  async function api(method, url, body) {
    const r = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      let msg = 'Error ' + r.status;
      try { msg = (await r.json()).error || msg; } catch { /* sin cuerpo */ }
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }
  async function loadChapter(b, c, force) {
    const k = `${b}:${c}`;
    if (force || !state.texts.has(k)) state.texts.set(k, (await api('GET', `/api/text/${b}/${c}`)).verses);
    return state.texts.get(k);
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
    const [c, p, bm, sm] = await Promise.allSettled([
      api('GET', '/api/comments'), api('GET', '/api/posts'), api('GET', '/api/bookmark'), api('GET', '/api/text-summary')]);
    state.comments = c.status === 'fulfilled' ? c.value : [];
    state.posts = p.status === 'fulfilled' ? p.value : [];
    state.bookmark = bm.status === 'fulfilled' ? bm.value : null;
    state.summary = sm.status === 'fulfilled' ? sm.value : {};
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

  // ---------- Navegación ----------
  function parseHash() {
    const m = location.hash.match(/^#\/(\d+)\/(\d+)(?:\/(\d+))?/);
    if (!m) return null;
    const b = +m[1], c = +m[2];
    const book = bookOf(b);
    if (!book || c < 1 || c > book.chapters) return null;
    return { b, c, v: m[3] ? +m[3] : null };
  }
  function go(b, c, v) {
    const h = `#/${b}/${c}${v ? '/' + v : ''}`;
    if (location.hash === h) route(); else location.hash = h;
  }
  function step(dir) {
    const i = state.books.findIndex(b => b.id === state.book);
    let bi = i, c = state.chapter + dir;
    if (c < 1) { if (bi === 0) return; bi--; c = state.books[bi].chapters; }
    else if (c > state.books[bi].chapters) { if (bi === state.books.length - 1) return; bi++; c = 1; }
    go(state.books[bi].id, c);
  }
  async function route() {
    let r = parseHash() || store.get('last', null);
    if (!r || !bookOf(r.b) || r.c > bookOf(r.b).chapters) r = { b: state.books[0].id, c: 1 };
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
  const chapterVerses = () => state.texts.get(`${state.book}:${state.chapter}`) || [];
  const verseText = v => (chapterVerses().find(x => x.n === v) || {}).text || '';

  async function renderChapter() {
    const { book: b, chapter: c } = state;
    const book = bookOf(b);
    $('#chapterTitle').innerHTML = `<small>${esc(book.name)}</small>Capítulo ${c}`;
    document.title = `${book.short} ${c} · Evangelio`;
    const first = state.books[0], last = state.books[state.books.length - 1];
    for (const id of ['prevCh', 'prevCh2']) $('#' + id).disabled = b === first.id && c === 1;
    for (const id of ['nextCh', 'nextCh2']) $('#' + id).disabled = b === last.id && c === last.chapters;
    const wrap = $('#verses');
    wrap.innerHTML = '<p class="loading">Cargando…</p>';
    state.active = null;
    let verses;
    try { verses = await loadChapter(b, c); } catch { wrap.innerHTML = '<p class="loading">No se pudo cargar el texto. Revisa la conexión.</p>'; return; }
    if (state.book !== b || state.chapter !== c) return; // el usuario ya navegó a otro sitio
    $('#editChapterBtn').hidden = !verses.length;
    if (!verses.length) {
      wrap.innerHTML = `<div class="empty-chapter">
        <p>Este capítulo aún no tiene texto.</p>
        <button class="btn primary" data-act="add-text">Añadir el texto del capítulo</button>
      </div>`;
      return;
    }
    wrap.innerHTML = verses.map(v => `
      ${v.title ? `<h3 class="section-title">${esc(v.title)}</h3>` : ''}
      <section class="verse" id="v${v.n}" data-v="${v.n}" tabindex="0" aria-label="Versículo ${v.n}">
        ${ribbonHtml(b, c, v.n)}<span class="vnum">${v.n}</span><span class="vtext">${esc(v.text)}</span>${extrasHtml(b, c, v.n)}
      </section>`).join('');
  }
  // Punto en la esquina + comentario (oculto hasta pulsar el versículo)
  function extrasHtml(b, c, v) {
    const list = state.byRef.get(key(b, c, v)) || [];
    if (!list.length) return '';
    return `<span class="dot" title="Tiene comentario"></span>
      <div class="vcomment">${list.map(cm => `<p>${esc(cm.text)}</p>`).join('')}</div>`;
  }
  function refreshVerse(v) {
    const el = document.getElementById(`v${v}`); if (!el) return;
    el.querySelectorAll('.dot, .vcomment').forEach(x => x.remove());
    const actions = el.querySelector('.vactions');
    const tmp = document.createElement('div');
    tmp.innerHTML = extrasHtml(state.book, state.chapter, v);
    [...tmp.childNodes].forEach(n => actions ? el.insertBefore(n, actions) : el.appendChild(n));
  }
  const commentOf = v => (state.byRef.get(key(state.book, state.chapter, v)) || [])[0];
  const isMarked = v => { const bm = state.bookmark; return !!bm && bm.book === state.book && bm.chapter === state.chapter && bm.verse === v; };

  // ---------- Marcapáginas «Seguir leyendo» ----------
  function ribbonHtml(b, c, v) {
    const bm = state.bookmark;
    return bm && bm.book === b && bm.chapter === c && bm.verse === v
      ? `<span class="vribbon" title="Seguir leyendo aquí">${ICON.ribbon}</span>` : '';
  }
  function refreshRibbons() {
    document.querySelectorAll('.vribbon').forEach(x => x.remove());
    const bm = state.bookmark;
    if (bm && bm.book === state.book && bm.chapter === state.chapter)
      document.getElementById(`v${bm.verse}`)?.insertAdjacentHTML('afterbegin', ribbonHtml(bm.book, bm.chapter, bm.verse));
    renderContinue();
  }
  function renderContinue() {
    const bm = state.bookmark;
    $('#continueBtn').disabled = !bm || !bookOf(bm.book);
    $('#continueRef').textContent = bm && bookOf(bm.book) ? refLabel(bm.book, bm.chapter, bm.verse) : 'Aún no has marcado ningún versículo';
  }
  async function toggleMark(v) {
    try {
      if (isMarked(v)) {
        await api('DELETE', '/api/bookmark'); state.bookmark = null;
        toast('Marca quitada');
      } else {
        state.bookmark = await api('PUT', '/api/bookmark', { book: state.book, chapter: state.chapter, verse: v });
        toast('Marcado para seguir leyendo');
      }
      refreshRibbons(); closeActions();
    } catch (e) { toast('No se pudo guardar la marca: ' + e.message); }
  }

  // ---------- Acciones del versículo ----------
  function closeActions() {
    if (!state.active) return;
    const el = document.getElementById(`v${state.active}`);
    el?.classList.remove('active');
    el?.querySelector('.vactions')?.remove();
    state.active = null;
  }
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
        <button class="act" data-act="comment">${ICON.comment}${has ? 'Editar comentario' : 'Añadir comentario'}</button>
        <button class="act" data-act="mark">${ICON.ribbon}${isMarked(v) ? 'Quitar marca' : 'Marcar aquí'}</button>
        <button class="act" data-act="edit-text">${ICON.text}Editar texto</button>
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
    if (!text) return existing ? deleteComment() : toast('Escribe un comentario');
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

  // Editar el texto de un solo versículo
  function showTextForm(box) {
    box.querySelector('.slot').innerHTML = `
      <div class="form">
        <textarea class="ttext" aria-label="Texto del versículo">${esc(verseText(state.active))}</textarea>
        <div class="form-row">
          <button class="btn ghost" data-act="cancel">Cancelar</button>
          <button class="btn primary" data-act="save-text">Guardar texto</button>
        </div>
      </div>`;
    box.querySelector('textarea').focus();
  }
  async function saveText(box) {
    const v = state.active, text = box.querySelector('.ttext').value.trim();
    if (!text) return toast('El texto no puede quedar vacío');
    try {
      const upd = await api('PUT', `/api/text/${state.book}/${state.chapter}/${v}`, { text });
      const verse = chapterVerses().find(x => x.n === v); if (verse) verse.text = upd.text;
      document.querySelector(`#v${v} .vtext`).textContent = upd.text;
      closeActions(); toast('Texto guardado');
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  }

  // ---------- Discusión (foro por versículo) ----------
  function postsHtml(list) {
    if (!list.length) return '<p class="empty">Todavía no hay mensajes. Empieza la discusión.</p>';
    return list.map(p => `
      <div class="post">
        <div class="post-meta"><b>${esc(p.name)}</b><span>${fmtDate(p.createdAt)}</span></div>
        <div class="post-text">${esc(p.text)}</div>
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
    const text = `«${verseText(v)}»\n— ${ref}`;
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
    if (e.target.closest('[data-act="add-text"]')) { openEditor(); return; }
    const verse = e.target.closest('.verse'); if (!verse) return;
    const v = +verse.dataset.v;
    const box = e.target.closest('.vactions');
    if (!box) { state.active === v ? closeActions() : openActions(v); return; }
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'comment') showCommentForm(box);
    else if (act === 'forum') showForum(box, v);
    else if (act === 'share') share(v);
    else if (act === 'mark') toggleMark(v);
    else if (act === 'edit-text') showTextForm(box);
    else if (act === 'cancel') box.querySelector('.slot').innerHTML = '';
    else if (act === 'save') saveComment(box);
    else if (act === 'save-text') saveText(box);
    else if (act === 'delete') deleteComment();
    else if (act === 'post') publish(box);
  });
  $('#verses').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('verse')) {
      e.preventDefault(); const v = +e.target.dataset.v; state.active === v ? closeActions() : openActions(v);
    }
  });

  // ---------- Editor del capítulo completo ----------
  const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
  // Convierte el texto pegado en versículos. Cada versículo empieza por su número;
  // las líneas que empiezan por «#» son títulos de sección.
  function parseChapter(raw) {
    const titles = [];
    // Texto continuo; los títulos («# …») quedan como marcas \u0001n\u0001 en su sitio
    const stream = raw.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, d => SUP[d]).split(/\r?\n/).map(line => {
      const t = line.match(/^\s*#+\s*(.*)$/);
      if (!t) return line;
      titles.push(t[1].replace(/\s+/g, ' ').trim());
      return `\u0001${titles.length - 1}\u0001`;
    }).join('\n');
    const occurrences = (n, from) => {
      const re = new RegExp(`(^|[\\s.,;:!?»”"'’)\\]—–\\-\\u0001])(${n})(?!\\d)[ \\t]*`, 'g');
      re.lastIndex = from; const out = []; let m;
      while ((m = re.exec(stream))) {
        const at = m.index + m[1].length;
        out.push({ at, end: m.index + m[0].length, lineStart: at === 0 || /[\n\u0001]/.test(stream[at - 1]) });
        re.lastIndex = at + 1;
      }
      return out;
    };
    // Primer versículo: el número del principio, o el 1 si el texto empieza sin número
    const lead = stream.match(/^(?:\s|\u0001\d+\u0001)*/)[0].length;
    const m0 = stream.slice(lead).match(/^(\d{1,3})(?!\d)[ \t]*/);
    const starts = [m0 ? { n: +m0[1], at: lead, end: lead + m0[0].length } : { n: 1, at: lead, end: lead }];
    for (;;) {
      const cur = starts[starts.length - 1];
      const occ = occurrences(cur.n + 1, cur.end);
      if (!occ.length) break;
      // Si el número aparece varias veces antes del siguiente, se prefiere el que empieza línea; si no, el último
      const next = occurrences(cur.n + 2, occ[0].end)[0];
      const cands = occ.filter(o => !next || o.at < next.at);
      const pick = [...cands].reverse().find(o => o.lineStart) || cands[cands.length - 1];
      starts.push({ n: cur.n + 1, at: pick.at, end: pick.end });
    }
    const takeTitle = seg => { const ids = [...seg.matchAll(/\u0001(\d+)\u0001/g)].map(m => titles[+m[1]]).filter(Boolean); return ids.join(' · '); };
    const clean = s => s.replace(/\u0001\d+\u0001/g, ' ').replace(/\s+/g, ' ').trim();
    let pendingTitle = takeTitle(stream.slice(0, starts[0].at));
    if (!stream.trim()) return [];
    return starts.map((st, i) => {
      const seg = stream.slice(st.end, i + 1 < starts.length ? starts[i + 1].at : stream.length);
      const v = { n: st.n, text: clean(seg) };
      if (pendingTitle) v.title = pendingTitle;
      pendingTitle = takeTitle(seg);   // un título dentro del texto es el del versículo siguiente
      return v;
    });
  }
  const serialize = verses => verses.map(v => `${v.title ? `# ${v.title}\n` : ''}${v.n} ${v.text}`).join('\n');
  function editorStatus() {
    const verses = parseChapter($('#editorText').value);
    const st = $('#editorStatus');
    if (!$('#editorText').value.trim()) { st.textContent = ''; st.className = 'editor-status'; return verses; }
    const empty = verses.filter(v => !v.text).map(v => v.n);
    const titles = verses.filter(v => v.title).length;
    st.className = 'editor-status' + (empty.length ? ' warn' : '');
    st.textContent = verses.length
      ? `Se detectan ${verses.length} versículos (del ${verses[0].n} al ${verses[verses.length - 1].n})` +
        (titles ? ` y ${titles} título${titles > 1 ? 's' : ''}` : '') + '.' +
        (empty.length ? ` Hay versículos sin texto: ${empty.join(', ')}.` : '')
      : 'No se detecta ningún versículo.';
    return verses;
  }
  function openEditor() {
    closeActions();
    $('#editorTitle').textContent = `${bookOf(state.book).short} ${state.chapter} · texto del capítulo`;
    $('#editorText').value = serialize(chapterVerses());
    editorStatus();
    $('#editorModal').hidden = false; lockScroll('editor');
    $('#editorText').focus();
  }
  function closeEditor() { $('#editorModal').hidden = true; unlockScroll('editor'); }
  async function saveEditor() {
    const verses = editorStatus();
    if (verses.some(v => !v.text)) return toast('Hay versículos sin texto. Revisa la numeración.');
    const prev = chapterVerses();
    if (!verses.length && prev.length && !confirm('El capítulo quedará vacío. ¿Seguro?')) return;
    const btn = $('#editorSave'); btn.disabled = true;
    try {
      const res = await api('PUT', `/api/text/${state.book}/${state.chapter}`, { verses });
      state.texts.set(`${state.book}:${state.chapter}`, res.verses);
      const k = `${state.book}:${state.chapter}`;
      if (res.verses.length) state.summary[k] = res.verses.length; else delete state.summary[k];
      closeEditor();
      const y = window.scrollY; await renderChapter(); refreshRibbons(); window.scrollTo(0, y);
      toast('Texto del capítulo guardado');
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
    btn.disabled = false;
  }
  $('#editorText').addEventListener('input', editorStatus);
  $('#editorSave').addEventListener('click', saveEditor);
  $('#editorCancel').addEventListener('click', closeEditor);
  $('#editorClose').addEventListener('click', closeEditor);
  $('#editChapterBtn').addEventListener('click', openEditor);

  // ---------- Menú lateral ----------
  const drawer = $('#drawer'), scrim = $('#scrim');
  const SECTIONS = ['bibleNav', 'commentIndex', 'forumIndex'];
  function openDrawer(section) {
    renderBookList();
    if (section) for (const id of SECTIONS) setSection(id, id === section);
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    scrim.hidden = false; $('#menuBtn').setAttribute('aria-expanded', 'true');
    lockScroll('drawer');
  }
  function closeDrawer() {
    drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
    scrim.hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false');
    unlockScroll('drawer');
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
  $('#continueBtn').addEventListener('click', () => {
    const bm = state.bookmark; if (!bm) return;
    closeDrawer(); go(bm.book, bm.chapter, bm.verse);
  });
  $('#closeDrawer').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  // En iOS el gesto sobre la capa oscura podría mover el fondo: se bloquea
  scrim.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  // Gesto: deslizar a la derecha abre el menú; a la izquierda lo cierra. El menú sigue al dedo.
  (() => {
    let sx = 0, sy = 0, dir = null, startOpen = false, w = 0, dx = 0, t0 = 0;
    const blocked = el => el.closest('input, textarea, .modal-scrim, .chapter-grid') || document.querySelector('.modal-scrim:not([hidden])');
    document.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || blocked(e.target)) { dir = 'none'; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; t0 = Date.now();
      dir = null; dx = 0; startOpen = drawer.classList.contains('open'); w = drawer.offsetWidth;
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (dir === 'none') return;
      const x = e.touches[0].clientX - sx, y = e.touches[0].clientY - sy;
      if (!dir) {
        if (Math.abs(x) < 10 && Math.abs(y) < 10) return;
        // solo gestos claramente horizontales y en la dirección útil
        dir = Math.abs(x) > Math.abs(y) * 1.3 && (startOpen ? x < 0 : x > 0) ? 'h' : 'none';
        if (dir !== 'h') return;
        drawer.style.transition = 'none';
        scrim.hidden = false; scrim.style.animation = 'none';
      }
      dx = x;
      const off = startOpen ? Math.min(0, dx) : Math.min(0, -w + dx);   // desplazamiento del menú (0 = abierto)
      drawer.style.transform = `translateX(${off}px)`;
      scrim.style.opacity = String(Math.max(0, 1 + off / w));
    }, { passive: true });
    const end = () => {
      if (dir !== 'h') { dir = null; return; }
      dir = null;
      const fast = Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.5;   // gesto rápido (px/ms)
      const open = startOpen ? !(dx < -w / 3 || (fast && dx < -30)) : (dx > w / 3 || (fast && dx > 30));
      drawer.style.transition = ''; drawer.style.transform = '';
      scrim.style.opacity = ''; scrim.style.animation = '';
      open ? openDrawer() : closeDrawer();
    };
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
  })();
  $('#chapterTitle').addEventListener('click', () => { openBooks.add(state.book); openDrawer('bibleNav'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#editorModal').hidden) closeEditor();
      else if (drawer.classList.contains('open')) closeDrawer();
      else closeActions();
    }
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  // Libros desplegables: Evangelio según Lucas / Hechos de los apóstoles → capítulos
  const openBooks = new Set();
  function renderBookList() {
    const withComments = new Set(state.comments.map(c => `${c.book}:${c.chapter}`));
    $('#bookList').innerHTML = state.books.map(b => {
      const open = openBooks.has(b.id);
      return `<button class="book-head${b.id === state.book ? ' current' : ''}" data-book="${b.id}" aria-expanded="${open}">
          <span><span class="book-part">Parte ${esc(b.part)}</span><span class="book-name">${esc(b.name)}</span></span><span class="chev"></span>
        </button>
        ${open ? `<div class="chapter-grid">${Array.from({ length: b.chapters }, (_, i) => {
          const c = i + 1, k = `${b.id}:${c}`;
          const cls = [b.id === state.book && c === state.chapter ? 'current' : '', state.summary[k] ? '' : 'no-text', withComments.has(k) ? 'has-c' : ''].join(' ').trim();
          return `<button data-b="${b.id}" data-c="${c}" class="${cls}" title="${state.summary[k] ? `${state.summary[k]} versículos` : 'Sin texto todavía'}">${c}</button>`;
        }).join('')}</div>` : ''}`;
    }).join('');
  }
  $('#bookList').addEventListener('click', e => {
    const ch = e.target.closest('[data-c]');
    if (ch) { closeDrawer(); go(+ch.dataset.b, +ch.dataset.c); return; }
    const bk = e.target.closest('[data-book]');
    if (bk) {
      const id = +bk.dataset.book;
      openBooks.has(id) ? openBooks.delete(id) : openBooks.add(id);
      renderBookList();
    }
  });

  // Índices desplegables: Libro → Capítulo:Versículo → contenido
  function makeIndex({ el, countEl, byRef, emptyText, refLabelText, body, gotoMode, gotoText }) {
    const open = { books: new Set(), refs: new Set() };
    function render() {
      const entries = [...byRef()].filter(([k]) => bookOf(+k.split(':')[0]));
      const total = entries.reduce((s, [, l]) => s + l.length, 0);
      countEl.textContent = total;
      if (!total) { el.innerHTML = `<div class="empty">${emptyText}</div>`; return; }
      const groups = new Map();
      for (const [k, list] of entries) {
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
            const txt = (state.texts.get(`${b}:${c}`) || []).find(x => x.n === v)?.text;
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
        else { open.refs.add(k); const [b, c] = k.split(':').map(Number); try { await loadChapter(b, c); } catch { /* se muestra sin texto */ } }
      }
      render();
    });
    return render;
  }
  const renderCommentIndex = makeIndex({
    el: $('#commentIndex'), countEl: $('#commentTotal'), byRef: () => state.byRef,
    emptyText: 'Aún no hay comentarios. Pulsa cualquier versículo para añadir uno.',
    refLabelText: (c, v) => `Versículo ${c}:${v}`,
    body: list => list.map(cm => `<div class="idx-comment">${esc(cm.text)}</div>`).join(''),
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

  // ---------- Novedades y avisos de actualización ----------
  const cmpVer = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  };
  let loadedVersion = null, changelog = [];
  async function fetchChangelog() {
    const r = await fetch('/changelog.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('sin novedades');
    return (await r.json()).versions || [];
  }
  const fmtDay = d => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  function showNews(versions, title) {
    if (!versions.length) return;
    $('#newsTitle').textContent = title;
    $('#newsBody').innerHTML = versions.map(v => `
      <section class="news-version">
        <h3>Versión ${esc(v.version)} <span>${esc(fmtDay(v.date))}</span></h3>
        <ul>${v.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      </section>`).join('');
    $('#newsModal').hidden = false; lockScroll('news');
  }
  function closeNews() {
    $('#newsModal').hidden = true; unlockScroll('news');
    if (loadedVersion) store.set('seenVersion', loadedVersion);
  }
  $('#newsClose').addEventListener('click', closeNews);
  $('#newsOk').addEventListener('click', closeNews);
  $('#newsModal').addEventListener('click', e => { if (e.target.id === 'newsModal') closeNews(); });
  $('#newsBtn').addEventListener('click', () => { closeDrawer(); showNews(changelog, 'Historial de novedades'); });
  $('#updateBtn').addEventListener('click', () => location.reload());

  async function initNews() {
    try { changelog = await fetchChangelog(); } catch { return; }
    if (!changelog.length) return;
    loadedVersion = changelog[0].version;
    $('#appVersion').textContent = 'v' + loadedVersion;
    const seen = store.get('seenVersion', null);
    // Mostrar lo nuevo desde la última versión vista (la primera vez, solo la última versión)
    const fresh = seen ? changelog.filter(v => cmpVer(v.version, seen) > 0) : changelog.slice(0, 1);
    if (fresh.length) showNews(fresh, fresh.length > 1 ? 'Novedades desde tu última visita' : 'Novedades de esta versión');
    // Con la app abierta: comprobar de vez en cuando si se ha publicado otra versión
    const check = async () => {
      try {
        const latest = (await fetchChangelog())[0];
        if (latest && cmpVer(latest.version, loadedVersion) > 0) $('#updateBar').hidden = false;
      } catch { /* sin conexión */ }
    };
    setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }

  for (const [id, d] of [['prevCh', -1], ['prevCh2', -1], ['nextCh', 1], ['nextCh2', 1]])
    $('#' + id).addEventListener('click', () => step(d));
  window.addEventListener('hashchange', route);

  // ---------- Inicio ----------
  (async () => {
    try {
      state.books = (await (await fetch('/books.json', { cache: 'no-store' })).json()).books;
    } catch {
      $('#verses').innerHTML = '<p class="loading">No se pudo cargar la app.</p>';
      return;
    }
    await loadAll();
    await route();
    renderCommentIndex(); renderForumIndex(); refreshRibbons();
    initNews();
  })();
})();
