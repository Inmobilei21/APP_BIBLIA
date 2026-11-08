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
  const ROMAN = /^\s*(?:[IVX]{1,5})\.\s+\S/;   // «I. …», «II. …»: divisiones del propio texto

  const state = {
    books: [],              // [{ id, part, name, short, chapters }]
    texts: new Map(),       // "libro:cap" -> { name, blocks: [{t:'v',n,text}|{t:'h',text}|{t:'d',text}] }
    summary: {},            // "libro:cap" -> { name, verses: [n…], targets: ["5:t0"…] }
    comments: [], byRef: new Map(),
    posts: [], postsByRef: new Map(),
    book: 0, chapter: 1,
    active: null,           // id del elemento abierto («v12», «t5-0»)
    pendingOpen: null,      // { id, mode } para abrir tras navegar
    bookmark: null,         // { book, chapter, verse } — «Seguir leyendo»
  };
  // Clave de un comentario: versículo (tg '') o subtítulo/división antes del versículo v (tg 't0', 't1'…)
  const key = (b, c, v, tg = '') => `${b}:${c}:${v}:${tg}`;
  const bookOf = id => state.books.find(b => b.id === id);
  const refLabel = (b, c, v) => `${bookOf(b).short} ${c}:${v}`;

  // Subtítulos y divisiones: se identifican por el versículo siguiente y su orden
  function withTargets(blocks) {
    const out = []; let pending = [], last = 0;
    for (const b of blocks) {
      if (b.t === 'v') {
        pending.forEach((p, i) => out.push({ ...p, v: b.n, tg: `t${i}` }));
        pending = []; last = b.n; out.push({ ...b, v: b.n, tg: '' });
      } else pending.push(b);
    }
    pending.forEach((p, i) => out.push({ ...p, v: last + 1, tg: `t${i}` }));
    return out;
  }
  // ¿Sigue existiendo el texto al que apunta un comentario o mensaje?
  function alive(b, c, v, tg) {
    const s = state.summary[`${b}:${c}`];
    if (!s) return false;
    return tg ? s.targets.includes(`${v}:${tg}`) : s.verses.includes(v);
  }

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
    if (force || !state.texts.has(k)) state.texts.set(k, await api('GET', `/api/text/${b}/${c}`));
    return state.texts.get(k);
  }
  function group(list) {
    const m = new Map();
    for (const c of list) {
      const k = key(c.book, c.chapter, c.verse, c.target || '');
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
  // Cuadro de texto que crece al escribir, hasta unas 20 líneas visibles
  const FORM_BUTTONS = 64;   // alto aproximado de la fila de botones bajo el cuadro
  // Zona de la página que se ve realmente (descontando el teclado del móvil)
  function visibleArea() {
    const vv = window.visualViewport;
    return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: window.innerHeight };
  }
  function autosize(ta) {
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || 26;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2;
    let max = line * 20 + pad;
    // Mientras se escribe, el alto máximo queda fijado al colocar el cuadro (hueco visible sobre el teclado).
    // Así no cambia de tamaño si se arrastra la página.
    if (ta._cap) max = Math.min(max, ta._cap);
    ta.style.height = 'auto';
    const h = Math.min(ta.scrollHeight + 2, max);
    ta.style.height = h + 'px';
    ta.style.overflowY = ta.scrollHeight + 2 > max ? 'auto' : 'hidden';
  }
  document.addEventListener('input', e => { if (e.target.matches('textarea.grow')) autosize(e.target); });
  // Al abrir un cuadro de edición: el versículo arriba de la pantalla y el cuadro justo debajo,
  // todo por encima del teclado. Si el versículo es muy largo, se ve su final junto al cuadro.
  // Lo que mantiene colocado el cuadro que se está escribiendo; se detiene al cerrarlo o al abrir otro
  let stopPlacing = null;
  function stopEditing() {
    if (stopPlacing) { stopPlacing(); stopPlacing = null; }
    document.body.classList.remove('editing');
    document.querySelectorAll('.block.writing').forEach(x => x.classList.remove('writing'));
  }
  function editBelowVerse(ta) {
    stopEditing();
    const el = ta.closest('.block');
    const place = () => {
      if (!ta.isConnected || state.active !== el.id) { stopEditing(); return; }
      const header = $('.topbar').offsetHeight, vis = visibleArea();
      const line = parseFloat(getComputedStyle(ta).lineHeight) || 26;
      const minBox = line * 4 + 24;
      let delta = el.getBoundingClientRect().top - (Math.max(header, vis.top) + 8);
      const boxTop = ta.getBoundingClientRect().top - delta;
      const limit = vis.bottom - minBox - FORM_BUTTONS;
      if (boxTop > limit) delta += boxTop - limit;
      window.scrollBy(0, delta);
      const pad = parseFloat(getComputedStyle(ta).paddingTop) * 2 + 2;
      ta._cap = Math.max(line * 4 + pad, visibleArea().bottom - ta.getBoundingClientRect().top - FORM_BUTTONS);
      autosize(ta);
    };
    document.body.classList.add('editing');   // espacio extra al final para poder subir el versículo
    el.classList.add('writing');              // mientras se escribe, se ocultan las opciones y el comentario antiguo
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    place();
    ta.scrollTop = ta.scrollHeight;   // cursor visible al final del texto
    // El teclado del móvil tarda un momento en aparecer y mueve la página: se recoloca solo mientras aparece
    // (el primer segundo y medio). Después se deja libre para que puedas arrastrar la página como quieras.
    const timer = setTimeout(place, 350);
    const vv = window.visualViewport;
    const onResize = () => place();
    vv?.addEventListener('resize', onResize);
    const release = () => { clearTimeout(timer); vv?.removeEventListener('resize', onResize); };
    const releaseTimer = setTimeout(release, 1500);
    const stop = () => { release(); clearTimeout(releaseTimer); ta.removeEventListener('blur', stop); };
    ta.addEventListener('blur', stop);
    stopPlacing = () => { stop(); ta._cap = null; };
  }
  // Tras cerrar, que el principio del versículo quede a la vista
  function revealTop(el) {
    const header = $('.topbar').offsetHeight;
    const top = el.getBoundingClientRect().top;
    if (top < header + 4 || top > window.innerHeight * 0.6) window.scrollTo(0, window.scrollY + top - header - 12);
  }

  // ---------- Navegación ----------
  function parseHash() {
    const m = location.hash.match(/^#\/(\d+)\/(\d+)(?:\/(\d+))?/);
    if (!m) return null;
    const b = +m[1], c = +m[2];
    const book = bookOf(b);
    if (!book || c < 1 || c > book.chapters) return null;
    return { b, c, v: m[3] ? +m[3] : null };
  }
  // Cambia de capítulo sin crear historial: así Safari no tiene página «anterior»
  // y su gesto de volver atrás (deslizar desde el borde) no arrastra la app.
  function go(b, c, v) {
    const h = `#/${b}/${c}${v ? '/' + v : ''}`;
    if (location.hash !== h) history.replaceState(null, '', h);
    route();
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
    const target = state.pendingOpen ? document.getElementById(state.pendingOpen.id) : r.v ? document.getElementById(`v${r.v}`) : null;
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: changed ? 'auto' : 'smooth' });
      target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
      if (state.pendingOpen) openActions(target.id, state.pendingOpen.mode);
    }
    state.pendingOpen = null;
  }

  // ---------- Lector ----------
  const chapterDoc = () => state.texts.get(`${state.book}:${state.chapter}`) || { name: '', blocks: [] };
  const verseText = v => (chapterDoc().blocks.find(x => x.t === 'v' && x.n === v) || {}).text || '';

  async function renderChapter() {
    const { book: b, chapter: c } = state;
    const book = bookOf(b);
    const setTitle = name => {
      $('#chapterTitle').innerHTML = `<small>${esc(book.name)}</small>Capítulo ${c}${name ? `<span class="ch-name">${esc(name)}</span>` : ''}`;
    };
    setTitle(state.summary[`${b}:${c}`]?.name);
    document.title = `${book.short} ${c} · Evangelio`;
    const first = state.books[0], last = state.books[state.books.length - 1];
    for (const id of ['prevCh', 'prevCh2']) $('#' + id).disabled = b === first.id && c === 1;
    for (const id of ['nextCh', 'nextCh2']) $('#' + id).disabled = b === last.id && c === last.chapters;
    const wrap = $('#verses');
    wrap.innerHTML = '<p class="loading">Cargando…</p>';
    state.active = null;
    let doc;
    try { doc = await loadChapter(b, c); } catch { wrap.innerHTML = '<p class="loading">No se pudo cargar el texto. Revisa la conexión.</p>'; return; }
    if (state.book !== b || state.chapter !== c) return; // el usuario ya navegó a otro sitio
    setTitle(doc.name);
    $('#editChapterBtn').hidden = !doc.blocks.length;
    if (!doc.blocks.length) {
      wrap.innerHTML = `<div class="empty-chapter">
        <p>Este capítulo aún no tiene texto.</p>
        <button class="btn primary" data-act="add-text">Añadir el texto del capítulo</button>
      </div>`;
      return;
    }
    wrap.innerHTML = withTargets(doc.blocks).map(x => {
      if (x.t === 'v') return `
      <section class="verse block" id="v${x.n}" data-v="${x.n}" data-tg="" tabindex="0" aria-label="Versículo ${x.n}">
        ${ribbonHtml(b, c, x.n)}<span class="vnum">${x.n}</span><span class="vtext">${esc(x.text)}</span>${extrasHtml(b, c, x.n, '')}
      </section>`;
      const cls = x.t === 'd' ? 'division' : 'section-title';
      return `
      <div class="${cls} block" id="t${x.v}-${x.tg.slice(1)}" data-v="${x.v}" data-tg="${x.tg}" tabindex="0">
        <span class="btext">${esc(x.text)}</span>${extrasHtml(b, c, x.v, x.tg)}
      </div>`;
    }).join('');
  }
  // Punto en la esquina + comentario (oculto hasta pulsar)
  function extrasHtml(b, c, v, tg) {
    const list = state.byRef.get(key(b, c, v, tg)) || [];
    if (!list.length) return '';
    return `<span class="dot" title="Tiene comentario"></span>
      <div class="vcomment">${list.map(cm => `<p>${esc(cm.text)}</p>`).join('')}</div>`;
  }
  const infoOf = el => ({ v: +el.dataset.v, tg: el.dataset.tg || '' });
  function refreshExtras(el) {
    const { v, tg } = infoOf(el);
    el.querySelectorAll(':scope > .dot, :scope > .vcomment').forEach(x => x.remove());
    const actions = el.querySelector('.vactions');
    const tmp = document.createElement('div');
    tmp.innerHTML = extrasHtml(state.book, state.chapter, v, tg);
    [...tmp.childNodes].forEach(n => actions ? el.insertBefore(n, actions) : el.appendChild(n));
  }
  const commentOf = (v, tg) => (state.byRef.get(key(state.book, state.chapter, v, tg)) || [])[0];
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

  // ---------- Acciones de un versículo, subtítulo o división ----------
  function closeActions() {
    if (!state.active) return;
    const el = document.getElementById(state.active);
    state.active = null;
    stopEditing();
    if (!el) return;
    el.classList.remove('active');
    el.querySelector('.vactions')?.remove();
    revealTop(el);
  }
  function openActions(id, mode) {
    const el = document.getElementById(id); if (!el) return;
    if (state.active) {
      // Se cierra el que estaba abierto sin mover de sitio el que se acaba de tocar
      const before = el.getBoundingClientRect().top;
      const prev = document.getElementById(state.active);
      state.active = null;
      stopEditing();
      if (document.activeElement && prev?.contains(document.activeElement)) document.activeElement.blur();
      prev?.classList.remove('active'); prev?.querySelector('.vactions')?.remove();
      const shift = el.getBoundingClientRect().top - before;
      if (shift) window.scrollBy(0, shift);
    }
    const { v, tg } = infoOf(el);
    state.active = id;
    el.classList.add('active');
    const has = !!commentOf(v, tg);
    const commentBtn = `<button class="act" data-act="comment">${ICON.comment}${has ? 'Editar comentario' : 'Añadir comentario'}</button>`;
    const n = (state.postsByRef.get(key(state.book, state.chapter, v, '')) || []).length;
    const box = document.createElement('div');
    box.className = 'vactions';
    box.innerHTML = `
      <div class="actions">
        ${commentBtn}
        ${tg ? '' : `
        <button class="act" data-act="mark">${ICON.ribbon}${isMarked(v) ? 'Quitar marca' : 'Marcar aquí'}</button>
        <button class="act" data-act="edit-text">${ICON.text}Editar texto</button>
        <button class="act" data-act="share">${ICON.share}Compartir</button>
        <button class="act" data-act="forum">${ICON.forum}Discusión${n ? ` <span class="act-count">${n}</span>` : ''}</button>`}
      </div>
      <div class="slot"></div>`;
    el.appendChild(box);
    if (mode === 'comment') showCommentForm(box);
    if (mode === 'forum') showForum(box, v);
  }
  const activeEl = () => document.getElementById(state.active);

  function commentRow(existing) {
    return `${existing ? '<button class="btn ghost danger" data-act="delete">Eliminar</button><span class="grow"></span>' : ''}
      <button class="btn ghost" data-act="close">Cerrar</button>
      <button class="btn primary" data-act="save">Guardar</button>`;
  }
  function showCommentForm(box) {
    const { v, tg } = infoOf(activeEl());
    const existing = commentOf(v, tg);
    box.querySelector('.slot').innerHTML = `
      <div class="form">
        <textarea class="ctext grow" placeholder="Escribe aquí tu comentario…" aria-label="Comentario">${existing ? esc(existing.text) : ''}</textarea>
        <div class="form-row">${commentRow(existing)}</div>
      </div>`;
    editBelowVerse(box.querySelector('textarea'));
  }
  // Al guardar se cierra el cuadro de edición: queda el comentario y las opciones (con «Editar comentario»)
  async function saveComment(box) {
    const el = activeEl(); const { v, tg } = infoOf(el);
    const text = box.querySelector('.ctext').value.trim();
    const existing = commentOf(v, tg);
    if (!text) return existing ? deleteComment() : toast('Escribe un comentario');
    const btn = box.querySelector('[data-act="save"]'); btn.disabled = true;
    try {
      if (existing) {
        const upd = await api('PUT', `/api/comments/${existing.id}`, { text });
        state.comments = state.comments.map(c => c.id === upd.id ? upd : c);
      } else {
        state.comments.push(await api('POST', '/api/comments', { book: state.book, chapter: state.chapter, verse: v, target: tg, text }));
      }
      indexComments(); refreshExtras(el); renderCommentIndex();
      box.querySelector('[data-act="comment"]').lastChild.textContent = 'Editar comentario';
      box.querySelector('.slot').innerHTML = '';
      stopEditing();
      document.activeElement?.blur();
      revealTop(el);
      toast('Comentario guardado');
    } catch (e) {
      btn.disabled = false;
      toast('No se pudo guardar: ' + e.message);
    }
  }
  async function deleteComment() {
    const el = activeEl(); const { v, tg } = infoOf(el);
    const list = state.byRef.get(key(state.book, state.chapter, v, tg)) || [];
    if (!list.length || !confirm('¿Eliminar este comentario?')) return;
    try {
      for (const c of list) await api('DELETE', `/api/comments/${c.id}`);
      const ids = new Set(list.map(c => c.id));
      state.comments = state.comments.filter(c => !ids.has(c.id));
      indexComments(); refreshExtras(el); renderCommentIndex(); closeActions();
      toast('Comentario eliminado');
    } catch (e) { toast('No se pudo eliminar: ' + e.message); }
  }

  // Editar el texto de un solo versículo
  function showTextForm(box) {
    const { v } = infoOf(activeEl());
    box.querySelector('.slot').innerHTML = `
      <div class="form">
        <textarea class="ttext grow" aria-label="Texto del versículo">${esc(verseText(v))}</textarea>
        <p class="form-hint">Si aquí dentro hay varios versículos unidos, sepáralos en «Editar capítulo», al pie de la página.</p>
        <div class="form-row">
          <button class="btn ghost" data-act="close">Cerrar</button>
          <button class="btn primary" data-act="save-text">Guardar texto</button>
        </div>
      </div>`;
    editBelowVerse(box.querySelector('textarea'));
  }
  async function saveText(box) {
    const el = activeEl(); const { v } = infoOf(el);
    const text = box.querySelector('.ttext').value.trim();
    if (!text) return toast('El texto no puede quedar vacío');
    try {
      const upd = await api('PUT', `/api/text/${state.book}/${state.chapter}/${v}`, { text });
      const verse = chapterDoc().blocks.find(x => x.t === 'v' && x.n === v); if (verse) verse.text = upd.text;
      el.querySelector('.vtext').textContent = upd.text;
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
    const list = state.postsByRef.get(key(state.book, state.chapter, v, '')) || [];
    box.querySelector('.slot').innerHTML = `
      <div class="forum">
        <div class="forum-title">Discusión · ${esc(refLabel(state.book, state.chapter, v))}</div>
        <div class="posts">${postsHtml(list)}</div>
        <div class="form">
          <input class="pname" type="text" maxlength="40" placeholder="Tu nombre" aria-label="Tu nombre" value="${esc(store.get('name', ''))}">
          <textarea class="ptext grow" placeholder="Escribe tu mensaje…" aria-label="Mensaje"></textarea>
          <div class="form-row">
            <button class="btn ghost" data-act="close">Cerrar</button>
            <button class="btn primary" data-act="post">Publicar</button>
          </div>
        </div>
      </div>`;
    const posts = box.querySelector('.posts'); posts.scrollTop = posts.scrollHeight;
  }
  async function publish(box) {
    const el = activeEl(); const { v } = infoOf(el);
    const name = box.querySelector('.pname').value.trim();
    const text = box.querySelector('.ptext').value.trim();
    if (!name) return toast('Escribe tu nombre');
    if (!text) return toast('Escribe un mensaje');
    const btn = box.querySelector('[data-act="post"]'); btn.disabled = true;
    try {
      state.posts.push(await api('POST', '/api/posts', { book: state.book, chapter: state.chapter, verse: v, name, text }));
      store.set('name', name);
      indexPosts(); renderForumIndex();
      openActions(el.id, 'forum');
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
    const el = e.target.closest('.block'); if (!el) return;
    const box = e.target.closest('.vactions');
    if (!box) { state.active === el.id ? closeActions() : openActions(el.id); return; }
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const { v } = infoOf(el);
    const act = btn.dataset.act;
    if (act === 'comment') showCommentForm(box);
    else if (act === 'forum') showForum(box, v);
    else if (act === 'share') share(v);
    else if (act === 'mark') toggleMark(v);
    else if (act === 'edit-text') showTextForm(box);
    else if (act === 'close') closeActions();
    else if (act === 'save') saveComment(box);
    else if (act === 'save-text') saveText(box);
    else if (act === 'delete') deleteComment();
    else if (act === 'post') publish(box);
  });
  $('#verses').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('block')) {
      e.preventDefault(); state.active === e.target.id ? closeActions() : openActions(e.target.id);
    }
  });

  // ---------- Editor del capítulo completo ----------
  const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
  // Convierte el texto pegado en bloques:
  //  · línea que empieza por «#»          → subtítulo propio
  //  · línea que empieza por «I.», «II.»… → división del texto (no se marca como versículo)
  //  · línea que empieza por un número    → versículo con ese número (se admiten saltos)
  //  · dentro de una línea, el número siguiente (n+1) también abre versículo
  function parseChapter(raw) {
    const blocks = []; let cur = null;
    const clean = s => s.replace(/\s+/g, ' ').trim();
    const startVerse = n => { cur = { t: 'v', n, text: '' }; blocks.push(cur); };
    const lines = raw.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, d => SUP[d]).split(/\r?\n/);
    // agrupar líneas de texto seguidas en «tramos» separados por subtítulos y divisiones
    const items = []; let run = null;
    for (const line of lines) {
      const h = line.match(/^\s*#+\s*(.*)$/);
      if (h) { run = null; if (clean(h[1])) items.push({ t: 'h', text: clean(h[1]) }); continue; }
      if (ROMAN.test(line)) { run = null; items.push({ t: 'd', text: clean(line) }); continue; }
      if (!line.trim()) continue;
      if (!run) { run = { t: 'run', lines: [] }; items.push(run); }
      run.lines.push(line);
    }
    const NUM = n => new RegExp(`(^|[\\s.,;:!?»”"'’)\\]—–\\-])(${n})(?!\\d)[ \\t]*`, 'g');
    const occurrences = (text, n, from) => {
      const re = NUM(n); re.lastIndex = from; const out = []; let m;
      while ((m = re.exec(text))) {
        const at = m.index + m[1].length;
        out.push({ at, end: m.index + m[0].length, lineStart: at === 0 || /\n[ \t]*$/.test(text.slice(0, at)) });
        re.lastIndex = at + 1;
      }
      return out;
    };
    for (const it of items) {
      if (it.t !== 'run') { blocks.push(it); continue; }
      const text = it.lines.join('\n');
      let pos = 0;
      for (;;) {
        // siguiente línea que empieza por un número mayor que el actual
        const lsRe = /(^|\n)[ \t]*(\d{1,3})(?!\d)[ \t]*/g; lsRe.lastIndex = pos;
        let L = null, m;
        while ((m = lsRe.exec(text))) {
          const at = m.index + m[1].length;
          if (at >= pos && (!cur || +m[2] > cur.n)) { L = { n: +m[2], at, end: m.index + m[0].length }; break; }
          lsRe.lastIndex = m.index + 1;
        }
        if (!cur) {
          if (L && !text.slice(pos, L.at).trim()) { startVerse(L.n); pos = L.end; }
          else startVerse(1);   // texto sin número al principio: versículo 1
          continue;
        }
        const limit = L ? L.at : text.length;
        const inline = occurrences(text, cur.n + 1, pos).filter(o => o.at < limit && !o.lineStart);
        let pick = null, n = cur.n + 1;
        if (L && L.n === cur.n + 1) pick = L;
        else if (inline.length) {
          // si el número aparece varias veces antes del siguiente, se toma el último
          const next = occurrences(text, cur.n + 2, inline[0].end)[0];
          const cands = inline.filter(o => !next || o.at < next.at);
          pick = cands[cands.length - 1];
        } else if (L) { pick = L; n = L.n; }
        if (!pick) break;
        cur.text += ' ' + text.slice(pos, pick.at);
        startVerse(n); pos = pick.end;
      }
      cur.text += ' ' + text.slice(pos);
    }
    blocks.forEach(b => { b.text = clean(b.text); });
    return blocks;
  }
  const serialize = blocks => blocks.map(b => b.t === 'h' ? `# ${b.text}` : b.t === 'd' ? b.text : `${b.n} ${b.text}`).join('\n');
  function editorStatus() {
    const blocks = parseChapter($('#editorText').value);
    const st = $('#editorStatus');
    if (!$('#editorText').value.trim()) { st.innerHTML = ''; st.className = 'editor-status'; return blocks; }
    const verses = blocks.filter(b => b.t === 'v');
    const heads = blocks.filter(b => b.t === 'h').length, divs = blocks.filter(b => b.t === 'd').length;
    const empty = verses.filter(v => !v.text).map(v => v.n);
    const gaps = [];
    for (let i = 1; i < verses.length; i++) for (let n = verses[i - 1].n + 1; n < verses[i].n; n++) gaps.push(n);
    // versículos que parecen contener el siguiente número (posible unión)
    const joined = verses.filter(v => new RegExp(`(^|\\s)${v.n + 1}(?!\\d)\\s`).test(v.text) && !verses.some(w => w.n === v.n + 1)).map(v => v.n);
    const parts = [];
    parts.push(verses.length ? `${verses.length} versículos (del ${verses[0].n} al ${verses[verses.length - 1].n})` : 'ningún versículo');
    if (heads) parts.push(`${heads} subtítulo${heads > 1 ? 's' : ''}`);
    if (divs) parts.push(`${divs} división${divs > 1 ? 'es' : ''}`);
    let html = `Se detectan ${parts.join(', ')}.`;
    if (gaps.length) html += `<br>Faltan los números: ${gaps.slice(0, 15).join(', ')}${gaps.length > 15 ? '…' : ''}.`;
    if (joined.length) html += `<br>Puede que estén unidos al siguiente: ${joined.join(', ')}. Pon el número siguiente al principio de una línea nueva.`;
    if (empty.length) html += `<br>Versículos sin texto: ${empty.join(', ')}.`;
    st.className = 'editor-status' + (empty.length ? ' warn' : (gaps.length || joined.length) ? ' info' : '');
    st.innerHTML = html;
    return blocks;
  }
  function openEditor() {
    closeActions();
    const doc = chapterDoc();
    $('#editorTitle').textContent = `${bookOf(state.book).short} ${state.chapter} · texto del capítulo`;
    $('#editorName').value = doc.name || '';
    $('#editorText').value = serialize(doc.blocks);
    editorStatus();
    $('#editorModal').hidden = false; lockScroll('editor');
  }
  function closeEditor() { $('#editorModal').hidden = true; unlockScroll('editor'); }
  async function saveEditor() {
    const blocks = editorStatus();
    if (blocks.some(b => b.t === 'v' && !b.text)) return toast('Hay versículos sin texto. Revisa la numeración.');
    const prev = chapterDoc();
    if (!blocks.length && prev.blocks.length && !confirm('El capítulo quedará vacío. ¿Seguro?')) return;
    // ¿Quedan comentarios o mensajes de textos que desaparecen?
    const verses = new Set(blocks.filter(b => b.t === 'v').map(b => b.n));
    const tks = new Set(withTargets(blocks).filter(b => b.tg).map(b => `${b.v}:${b.tg}`));
    const here = x => x.book === state.book && x.chapter === state.chapter;
    const orphanC = state.comments.filter(x => here(x) && !(x.target ? tks.has(`${x.verse}:${x.target}`) : verses.has(x.verse))).length;
    const orphanP = state.posts.filter(x => here(x) && !verses.has(x.verse)).length;
    let purge = false;
    if (orphanC + orphanP) {
      const what = [orphanC && `${orphanC} comentario${orphanC > 1 ? 's' : ''}`, orphanP && `${orphanP} mensaje${orphanP > 1 ? 's' : ''} de discusión`].filter(Boolean).join(' y ');
      purge = confirm(`Hay ${what} de textos que ya no existen en este capítulo.\n\nAceptar: eliminarlos.\nCancelar: conservarlos ocultos.`);
    }
    const btn = $('#editorSave'); btn.disabled = true;
    try {
      const res = await api('PUT', `/api/text/${state.book}/${state.chapter}`, { name: $('#editorName').value.trim(), blocks, purge });
      state.texts.set(`${state.book}:${state.chapter}`, { name: res.name, blocks: res.blocks });
      if (purge) await loadAll();
      else state.summary[`${state.book}:${state.chapter}`] = {
        name: res.name, verses: res.blocks.filter(b => b.t === 'v').map(b => b.n),
        targets: withTargets(res.blocks).filter(b => b.tg).map(b => `${b.v}:${b.tg}`),
      };
      closeEditor();
      const y = window.scrollY; await renderChapter(); refreshRibbons(); window.scrollTo(0, y);
      renderCommentIndex(); renderForumIndex();
      toast(res.purged ? `Texto guardado · ${res.purged} elemento${res.purged > 1 ? 's' : ''} eliminado${res.purged > 1 ? 's' : ''}` : 'Texto del capítulo guardado');
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
      if (!$('#claudeModal').hidden) closeClaude();
      else if (!$('#editorModal').hidden) closeEditor();
      else if (drawer.classList.contains('open')) closeDrawer();
      else closeActions();
    }
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  // Libros desplegables: Evangelio según Lucas / Hechos de los apóstoles → capítulos (con su nombre)
  const openBooks = new Set();
  function renderBookList() {
    const withComments = new Set(state.comments.filter(c => alive(c.book, c.chapter, c.verse, c.target)).map(c => `${c.book}:${c.chapter}`));
    $('#bookList').innerHTML = state.books.map(b => {
      const open = openBooks.has(b.id);
      return `<button class="book-head${b.id === state.book ? ' current' : ''}" data-book="${b.id}" aria-expanded="${open}">
          <span><span class="book-part">Parte ${esc(b.part)}</span><span class="book-name">${esc(b.name)}</span></span><span class="chev"></span>
        </button>
        ${open ? `<div class="chapter-grid">${Array.from({ length: b.chapters }, (_, i) => {
          const c = i + 1, k = `${b.id}:${c}`, s = state.summary[k];
          const hasText = s && s.verses.length;
          const cls = [b.id === state.book && c === state.chapter ? 'current' : '', hasText ? '' : 'no-text', withComments.has(k) ? 'has-c' : ''].join(' ').trim();
          return `<button data-b="${b.id}" data-c="${c}" class="${cls}" title="${s && s.name ? esc(s.name) : hasText ? `Capítulo ${c}` : 'Sin texto todavía'}">${c}</button>`;
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

  // Índices desplegables: Libro → Capítulo:Versículo (o subtítulo) → contenido. Solo textos que existen.
  function makeIndex({ el, countEl, byRef, emptyText, refLabelText, body, gotoMode, gotoText }) {
    const open = { books: new Set(), refs: new Set() };
    const parse = k => { const [b, c, v, tg] = k.split(':'); return { b: +b, c: +c, v: +v, tg: tg || '' }; };
    function render() {
      const entries = [...byRef()].filter(([k]) => { const r = parse(k); return bookOf(r.b) && alive(r.b, r.c, r.v, r.tg); });
      const total = entries.reduce((s, [, l]) => s + l.length, 0);
      countEl.textContent = total;
      if (!total) { el.innerHTML = `<div class="empty">${emptyText}</div>`; return; }
      const groups = new Map();
      for (const e of entries) {
        const b = parse(e[0]).b;
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(e);
      }
      // orden de lectura: capítulo, versículo, y los subtítulos antes de su versículo
      const ord = r => [r.c, r.v, r.tg ? +r.tg.slice(1) : 99];
      const cmp = (a, b) => { const x = ord(parse(a[0])), y = ord(parse(b[0])); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
      let html = '';
      for (const b of [...groups.keys()].sort((x, y) => x - y)) {
        const refs = groups.get(b).sort(cmp);
        const bOpen = open.books.has(b);
        html += `<button class="idx-book" data-ib="${b}" aria-expanded="${bOpen}">${esc(bookOf(b).name)}<span class="count">${refs.length}</span><span class="chev"></span></button>`;
        if (!bOpen) continue;
        html += '<div class="idx-refs">';
        for (const [k, list] of refs) {
          const r = parse(k);
          const doc = state.texts.get(`${r.b}:${r.c}`);
          const blk = doc && withTargets(doc.blocks).find(x => x.v === r.v && x.tg === r.tg);
          const rOpen = open.refs.has(k);
          html += `<button class="idx-ref" data-ir="${k}" aria-expanded="${rOpen}">${refLabelText(r, list, blk)}<span class="chev"></span></button>`;
          if (rOpen) {
            html += `<div class="idx-body">
              ${blk ? `<p class="idx-verse">«${esc(blk.text)}»</p>` : ''}
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
        const r = parse(t.dataset.goto);
        closeDrawer();
        state.pendingOpen = { id: r.tg ? `t${r.v}-${r.tg.slice(1)}` : `v${r.v}`, mode: gotoMode };
        go(r.b, r.c, r.tg ? null : r.v); return;
      }
      if (t.dataset.ib) {
        const b = +t.dataset.ib;
        open.books.has(b) ? open.books.delete(b) : open.books.add(b);
      } else {
        const k = t.dataset.ir;
        if (open.refs.has(k)) open.refs.delete(k);
        else { open.refs.add(k); const r = parse(k); try { await loadChapter(r.b, r.c); } catch { /* se muestra sin texto */ } }
      }
      render();
    });
    // al cargar capítulos, los subtítulos del índice pueden mostrar su texto
    return render;
  }
  const renderCommentIndex = makeIndex({
    el: $('#commentIndex'), countEl: $('#commentTotal'), byRef: () => state.byRef,
    emptyText: 'Aún no hay comentarios. Pulsa cualquier versículo o subtítulo para añadir uno.',
    refLabelText: (r, list, blk) => r.tg ? `Subtítulo · cap. ${r.c}${blk ? `<span class="idx-sub">${esc(blk.text)}</span>` : ''}` : `Versículo ${r.c}:${r.v}`,
    body: list => list.map(cm => `<div class="idx-comment">${esc(cm.text)}</div>`).join(''),
    gotoMode: null, gotoText: 'Ir al texto',
  });
  const renderForumIndex = makeIndex({
    el: $('#forumIndex'), countEl: $('#forumTotal'), byRef: () => state.postsByRef,
    emptyText: 'Aún no hay discusiones. Pulsa un versículo y elige «Discusión» para empezar una.',
    refLabelText: (r, list) => `Versículo ${r.c}:${r.v}<span class="count">${list.length} mensaje${list.length > 1 ? 's' : ''}</span>`,
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

  // ---------- Peticiones de cambios a Claude ----------
  const STATUS = { pending: 'Pendiente', working: 'En curso', done: 'Hecho', rejected: 'No realizado' };
  const pinApi = (method, url, body) => fetch(url, {
    method, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Token': store.get('pin', '') },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const data = r.status === 204 ? null : await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((data && data.error) || 'Error ' + r.status); e.status = r.status; throw e; }
    return data;
  });
  async function loadProposals() {
    try {
      const list = await pinApi('GET', '/api/proposals');
      $('#claudePinBox').hidden = true; $('#claudeMain').hidden = false;
      $('#claudeList').innerHTML = list.length ? list.map(p => `
        <div class="claude-item">
          <div class="claude-meta"><span class="claude-status ${p.status}">${STATUS[p.status] || p.status}</span><span>${fmtDate(p.createdAt)}</span></div>
          <div class="claude-text">${esc(p.text)}</div>
          ${p.reply ? `<div class="claude-reply"><b>Claude:</b> ${esc(p.reply)}</div>` : ''}
        </div>`).join('') : '<p class="empty">Aún no has pedido ningún cambio.</p>';
      return true;
    } catch (e) {
      if (e.status === 401) { $('#claudeMain').hidden = true; $('#claudePinBox').hidden = false; $('#claudePin').focus(); }
      else toast(e.message);
      return false;
    }
  }
  $('#claudeBtn').addEventListener('click', () => {
    closeDrawer(); $('#claudeModal').hidden = false; lockScroll('claude');
    $('#claudeMain').hidden = $('#claudePinBox').hidden = true;
    loadProposals();
  });
  const closeClaude = () => { $('#claudeModal').hidden = true; unlockScroll('claude'); };
  $('#claudeClose').addEventListener('click', closeClaude);
  $('#claudePinOk').addEventListener('click', async () => {
    store.set('pin', $('#claudePin').value.trim());
    if (!(await loadProposals())) toast('PIN incorrecto');
  });
  $('#claudePin').addEventListener('keydown', e => { if (e.key === 'Enter') $('#claudePinOk').click(); });
  $('#claudeSend').addEventListener('click', async () => {
    const text = $('#claudeText').value.trim();
    if (!text) return toast('Escribe lo que quieres cambiar');
    const btn = $('#claudeSend'); btn.disabled = true;
    try {
      await pinApi('POST', '/api/proposals', { text });
      $('#claudeText').value = ''; autosize($('#claudeText'));
      await loadProposals();
      toast('Enviado. Claude se pone a ello ahora mismo.');
    } catch (e) { toast('No se pudo enviar: ' + e.message); }
    btn.disabled = false;
  });

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
