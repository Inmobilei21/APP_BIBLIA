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
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    forum: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };
  const ROMAN = /^\s*(?:[IVX]{1,5})\.\s+\S/;   // «I. …», «II. …»: divisiones del propio texto

  const state = {
    books: [],              // [{ id, part, name, short, chapters }]
    topics: [],             // [{ id, title }]
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
  // Los temas funcionan como un libro de un solo capítulo con id 1000 + n
  const TOPIC_BASE = 1000;
  const isTopic = id => id > TOPIC_BASE;
  const topicBook = t => ({ id: TOPIC_BASE + t.id, topicId: t.id, topic: true, part: '', name: t.title, short: t.title, chapters: 1 });
  const bookOf = id => state.books.find(b => b.id === id) ||
    (isTopic(id) ? (t => t && topicBook(t))(state.topics.find(t => TOPIC_BASE + t.id === id)) : undefined);
  const refLabel = (b, c, v) => isTopic(b) ? `${bookOf(b)?.short || 'Tema'}` : `${bookOf(b).short} ${c}:${v}`;
  const mnorm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const byTitle = (a, b) => a.title.localeCompare(b.title, 'es');
  // Menciones «/[Tema]» dentro de un comentario → enlace al tema
  function mentionHtml(text, plain) {
    return esc(text).replace(/\/\[([^\]]+)\]/g, (m, title) => {
      const t = state.topics.find(x => esc(x.title).toLowerCase() === title.toLowerCase());
      if (!t) return m;
      return plain ? `<span class="mention">${esc(t.title)}</span>`
        : `<a class="mention" href="#/${TOPIC_BASE + t.id}/1" data-topic="${t.id}">${esc(t.title)}</a>`;
    });
  }
  const mentions = (text, t) => text.toLowerCase().includes(`/[${t.title.toLowerCase()}]`);

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
    const [c, p, bm, sm, tp] = await Promise.allSettled([
      api('GET', '/api/comments'), api('GET', '/api/posts'), api('GET', '/api/bookmark'), api('GET', '/api/text-summary'), api('GET', '/api/topics')]);
    state.topics = tp.status === 'fulfilled' ? tp.value : state.topics;
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
    return route();
  }
  // Capítulo anterior (-1) o siguiente (+1); null si no hay más
  function neighbour(dir) {
    if (isTopic(state.book)) return null;   // los temas no tienen capítulo anterior ni siguiente
    const bi0 = state.books.findIndex(b => b.id === state.book);
    let bi = bi0, c = state.chapter + dir;
    if (c < 1) { if (bi === 0) return null; bi--; c = state.books[bi].chapters; }
    else if (c > state.books[bi].chapters) { if (bi === state.books.length - 1) return null; bi++; c = 1; }
    return { b: state.books[bi].id, c };
  }
  function step(dir) {
    const n = neighbour(dir);
    return n ? go(n.b, n.c) : Promise.resolve();
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
    const setTitle = name => { $('#chapterTitle').innerHTML = titleHtml(book, c, name); };
    setTitle(state.summary[`${b}:${c}`]?.name);
    document.title = book.topic ? `${book.name} · Evangelio` : `${book.short} ${c} · Evangelio`;
    $('#editChapterBtn').textContent = book.topic ? 'Editar tema' : 'Editar capítulo';
    $('#pdfChapterBtn').textContent = book.topic ? 'Exportar tema en PDF' : 'Exportar capítulo en PDF';
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
        <p>${book.topic ? 'Este tema aún no tiene contenido.' : 'Este capítulo aún no tiene texto.'}</p>
        <button class="btn primary" data-act="add-text">${book.topic ? 'Añadir contenido' : 'Añadir el texto del capítulo'}</button>
      </div>${book.topic ? mentionsHtml(book) : ''}`;
      return;
    }
    wrap.innerHTML = blocksHtml(b, c, doc);
    if (book.topic) wrap.insertAdjacentHTML('beforeend', mentionsHtml(book));
    // se cargan ya los capítulos de al lado, para que pasar la página sea inmediato
    for (const d of [-1, 1]) { const n = neighbour(d); if (n) loadChapter(n.b, n.c).catch(() => {}); }
  }
  function titleHtml(book, c, name) {
    return book.topic
      ? `<small>Tema</small>${esc(book.name)}`
      : `<small>${esc(book.name)}</small>Capítulo ${c}${name ? `<span class="ch-name">${esc(name)}</span>` : ''}`;
  }
  // Texto del capítulo (limit: solo los primeros bloques, para dibujar una hoja por adelantado)
  function blocksHtml(b, c, doc, limit) {
    const book = bookOf(b);
    const list = withTargets(doc.blocks);
    return (limit ? list.slice(0, limit) : list).map(x => {
      if (x.t === 'v') return `
      <section class="verse block${book.topic ? ' para' : ''}" id="v${x.n}" data-v="${x.n}" data-tg="" tabindex="0" aria-label="${book.topic ? 'Párrafo' : 'Versículo ' + x.n}">
        ${ribbonHtml(b, c, x.n)}${book.topic ? '' : `<span class="vnum">${x.n}</span>`}<span class="vtext">${esc(x.text)}</span>${extrasHtml(b, c, x.n, '')}
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
      <div class="vcomment">${list.map(cm => `<p>${mentionHtml(cm.text)}</p>`).join('')}</div>`;
  }
  // Apartado «Menciones» de un tema: comentarios que lo mencionan con «/[Tema]»
  function mentionsHtml(book) {
    const t = state.topics.find(x => x.id === book.topicId); if (!t) return '';
    const list = state.comments.filter(c => mentions(c.text, t) && alive(c.book, c.chapter, c.verse, c.target || '') && bookOf(c.book))
      .sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse);
    const where = c => isTopic(c.book) ? `Tema · ${bookOf(c.book).name}` : c.target ? `${bookOf(c.book).short} ${c.chapter} · subtítulo` : `${bookOf(c.book).short} ${c.chapter}:${c.verse}`;
    return `<section class="mentions">
      <h3>Menciones <span class="count">${list.length}</span></h3>
      ${list.length ? list.map(c => `
        <button class="mention-item" data-goto="${c.book}:${c.chapter}:${c.verse}:${c.target || ''}">
          <span class="mention-ref">${esc(where(c))}</span>
          <span class="mention-text">${mentionHtml(c.text, true)}</span>
        </button>`).join('') : '<p class="empty">Aún no hay comentarios que mencionen este tema. Al escribir un comentario, escribe «/» y elige el tema.</p>'}
    </section>`;
  }
  function gotoRef(k, mode) {
    const [b, c, v, tg] = k.split(':'); const B = +b, C = +c, V = +v;
    state.pendingOpen = { id: tg ? `t${V}-${tg.slice(1)}` : `v${V}`, mode };
    return go(B, C, tg ? null : V);
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
        ${has ? `<button class="act act-danger" data-act="delete">${ICON.trash}Eliminar comentario</button>` : ''}
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
        <textarea class="ctext grow" placeholder="Escribe aquí tu comentario… (escribe / para mencionar un tema)" aria-label="Comentario">${existing ? esc(existing.text) : ''}</textarea>
        <div class="mention-menu" hidden></div>
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
      const cbtn = box.querySelector('[data-act="comment"]');
      cbtn.lastChild.textContent = 'Editar comentario';
      if (!box.querySelector('.actions [data-act="delete"]'))
        cbtn.insertAdjacentHTML('afterend', `<button class="act act-danger" data-act="delete">${ICON.trash}Eliminar comentario</button>`);
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
        <div class="post-meta"><b>${esc(p.name)}</b><span>${fmtDate(p.createdAt)}</span>
          <button class="post-del" data-act="del-post" data-id="${p.id}" aria-label="Eliminar mensaje" title="Eliminar mensaje">${ICON.trash}</button></div>
        <div class="post-text">${esc(p.text)}</div>
      </div>`).join('');
  }
  function showForum(box, v) {
    const list = state.postsByRef.get(key(state.book, state.chapter, v, '')) || [];
    box.querySelector('.slot').innerHTML = `
      <div class="forum">
        <div class="forum-title">Discusión · ${esc(refLabel(state.book, state.chapter, v))}
          ${list.length ? '<button class="forum-del" data-act="del-forum">Eliminar discusión</button>' : ''}</div>
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
  // Borrar un mensaje o toda la discusión de un versículo: solo el dueño, con el PIN
  async function ownerFetch(method, url) {
    for (let i = 0; i < 2; i++) {
      let pin = store.get('pin', '');
      if (!pin) { pin = (prompt('Escribe el PIN para eliminar') || '').trim(); if (!pin) return false; store.set('pin', pin); }
      const r = await fetch(url, { method, headers: { 'X-Owner-Token': pin } });
      if (r.ok) return true;
      if (r.status === 401) { store.set('pin', ''); toast('PIN incorrecto'); continue; }
      throw new Error('Error ' + r.status);
    }
    return false;
  }
  async function deletePosts(v, id) {
    if (!confirm(id ? '¿Eliminar este mensaje?' : '¿Eliminar toda la discusión de este versículo?')) return;
    try {
      const ok = await ownerFetch('DELETE', id ? `/api/posts/${id}` : `/api/posts?book=${state.book}&chapter=${state.chapter}&verse=${v}`);
      if (!ok) return;
      state.posts = state.posts.filter(p => id ? p.id !== id : !(p.book === state.book && p.chapter === state.chapter && p.verse === v));
      indexPosts(); renderForumIndex();
      openActions(state.active, 'forum');
      toast(id ? 'Mensaje eliminado' : 'Discusión eliminada');
    } catch (e) { toast('No se pudo eliminar: ' + e.message); }
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
    const mi = e.target.closest('.mention-item');
    if (mi) { gotoRef(mi.dataset.goto); return; }
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
    else if (act === 'del-post') deletePosts(v, btn.dataset.id);
    else if (act === 'del-forum') deletePosts(v, null);
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
  // Temas: cada línea es un párrafo. El número del principio (si lo tiene) lo identifica y conserva sus comentarios;
  // los párrafos nuevos, sin número, reciben uno libre.
  function parseTopic(raw) {
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const used = new Set(), out = [];
    for (const l of lines) { const m = l.match(/^(\d{1,3})\s+\S/); if (m && !l.startsWith('#')) used.add(+m[1]); }
    let next = 1; const free = () => { while (used.has(next)) next++; used.add(next); return next; };
    const seen = new Set();
    for (const l of lines) {
      const h = l.match(/^#+\s*(.*)$/);
      if (h) { if (h[1].trim()) out.push({ t: 'h', text: h[1].replace(/\s+/g, ' ').trim() }); continue; }
      const m = l.match(/^(\d{1,3})\s+(.*)$/);
      if (m && !seen.has(+m[1])) { seen.add(+m[1]); out.push({ t: 'v', n: +m[1], text: m[2].replace(/\s+/g, ' ').trim() }); }
      else out.push({ t: 'v', n: free(), text: l.replace(/\s+/g, ' ') });
    }
    return out;
  }
  const editingTopic = () => isTopic(state.book);
  function editorStatus() {
    const st = $('#editorStatus');
    if (editingTopic()) {
      const blocks = parseTopic($('#editorText').value);
      const paras = blocks.filter(b => b.t === 'v').length, heads = blocks.length - paras;
      st.className = 'editor-status';
      st.textContent = blocks.length ? `${paras} párrafo${paras === 1 ? '' : 's'}${heads ? ` y ${heads} subtítulo${heads > 1 ? 's' : ''}` : ''}.` : '';
      return blocks;
    }
    const blocks = parseChapter($('#editorText').value);
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
    const topic = editingTopic(), book = bookOf(state.book);
    $('#editorTitle').textContent = topic ? 'Contenido del tema' : `${book.short} ${state.chapter} · texto del capítulo`;
    $('#editorNameLabel').innerHTML = topic ? 'Nombre del tema' : 'Nombre del capítulo <span>(opcional)</span>';
    $('#editorName').value = topic ? book.name : (doc.name || '');
    $('#editorHelpTopic').hidden = !topic; $('#editorHelpBook').hidden = topic;
    $('#editorDelete').hidden = !topic;
    $('#editorText').value = serialize(doc.blocks);
    editorStatus();
    $('#editorModal').hidden = false; lockScroll('editor');
  }
  function closeEditor() { $('#editorModal').hidden = true; unlockScroll('editor'); }
  async function saveEditor() {
    const blocks = editorStatus();
    if (blocks.some(b => b.t === 'v' && !b.text)) return toast('Hay versículos sin texto. Revisa la numeración.');
    // Tema: si cambia el nombre, se renombra (y se actualizan sus menciones)
    if (editingTopic()) {
      const book = bookOf(state.book), title = $('#editorName').value.trim();
      if (!title) return toast('Escribe el nombre del tema');
      if (title !== book.name) {
        try { await api('PUT', `/api/topics/${book.topicId}`, { title }); await loadAll(); }
        catch (e) { return toast('No se pudo renombrar: ' + e.message); }
      }
    }
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
      const res = await api('PUT', `/api/text/${state.book}/${state.chapter}`, { name: editingTopic() ? '' : $('#editorName').value.trim(), blocks, purge });
      state.texts.set(`${state.book}:${state.chapter}`, { name: res.name, blocks: res.blocks });
      if (purge) await loadAll();
      else state.summary[`${state.book}:${state.chapter}`] = {
        name: res.name, verses: res.blocks.filter(b => b.t === 'v').map(b => b.n),
        targets: withTargets(res.blocks).filter(b => b.tg).map(b => `${b.v}:${b.tg}`),
      };
      closeEditor();
      const y = window.scrollY; await renderChapter(); refreshRibbons(); window.scrollTo(0, y);
      renderCommentIndex(); renderForumIndex(); renderTopicList();
      toast(res.purged ? `Texto guardado · ${res.purged} elemento${res.purged > 1 ? 's' : ''} eliminado${res.purged > 1 ? 's' : ''}` : 'Texto del capítulo guardado');
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
    btn.disabled = false;
  }
  $('#editorText').addEventListener('input', editorStatus);
  $('#editorSave').addEventListener('click', saveEditor);
  $('#editorCancel').addEventListener('click', closeEditor);
  $('#editorClose').addEventListener('click', closeEditor);
  $('#editChapterBtn').addEventListener('click', openEditor);
  $('#editorDelete').addEventListener('click', async () => {
    const book = bookOf(state.book);
    if (!confirm(`¿Eliminar el tema «${book.name}» con todo su contenido, comentarios y discusión?\n\nLas menciones en otros comentarios quedarán como texto.`)) return;
    try {
      if (!(await ownerFetch('DELETE', `/api/topics/${book.topicId}`))) return;
      closeEditor(); await loadAll();
      renderTopicList(); renderCommentIndex(); renderForumIndex(); refreshRibbons();
      go(state.books[0].id, 1); toast('Tema eliminado');
    } catch (e) { toast('No se pudo eliminar: ' + e.message); }
  });

  // ---------- Menú de menciones al escribir «/» en un comentario ----------
  function mentionQuery(ta) {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/(^|\s)\/([^\s\/\[\]]*)$/);
    return m ? { q: m[2], start: before.length - m[2].length - 1 } : null;
  }
  function mentionCheck(ta) {
    const menu = ta.parentElement.querySelector('.mention-menu'); if (!menu) return;
    const mq = mentionQuery(ta);
    if (!mq) { menu.hidden = true; return; }
    const q = mnorm(mq.q);
    const list = state.topics.filter(t => mnorm(t.title).includes(q)).sort(byTitle).slice(0, 8);
    menu.innerHTML = list.length
      ? list.map(t => `<button type="button" data-mention="${t.id}">${esc(t.title)}</button>`).join('')
      : `<p class="empty">${state.topics.length ? 'Ningún tema coincide.' : 'Aún no hay temas. Créalos en el menú, en «Temas».'}</p>`;
    menu.hidden = false;
  }
  document.addEventListener('input', e => { if (e.target.matches('textarea.ctext')) mentionCheck(e.target); });
  document.addEventListener('keyup', e => { if (e.target.matches('textarea.ctext') && /Arrow|Home|End/.test(e.key)) mentionCheck(e.target); });
  // pointerdown + preventDefault: elegir sin que el cuadro pierda el foco (ni se cierre el teclado)
  document.addEventListener('pointerdown', e => { if (e.target.closest('[data-mention]')) e.preventDefault(); });
  document.addEventListener('click', e => {
    const opt = e.target.closest('[data-mention]'); if (!opt) return;
    e.stopPropagation();
    const ta = opt.closest('.form').querySelector('textarea.ctext');
    const t = state.topics.find(x => x.id === +opt.dataset.mention), mq = mentionQuery(ta);
    if (!t || !mq) return;
    const ins = `/[${t.title}] `;
    ta.value = ta.value.slice(0, mq.start) + ins + ta.value.slice(ta.selectionStart);
    const pos = mq.start + ins.length;
    ta.focus(); ta.setSelectionRange(pos, pos); autosize(ta);
    opt.closest('.mention-menu').hidden = true;
  }, true);
  // Enlaces a temas dentro de comentarios (en el texto o en los índices)
  document.addEventListener('click', e => {
    const a = e.target.closest('a.mention'); if (!a) return;
    e.preventDefault(); e.stopPropagation();
    closeDrawer(); closeActions();
    go(TOPIC_BASE + +a.dataset.topic, 1);
  }, true);

  // ---------- Menú lateral ----------
  const drawer = $('#drawer'), scrim = $('#scrim');
  const SECTIONS = ['bibleNav', 'topicNav', 'commentIndex', 'forumIndex'];
  function openDrawer(section) {
    renderBookList(); renderTopicList();
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

  // Gestos horizontales, como en un libro:
  //  · deslizar a la izquierda → la hoja actual se levanta por la derecha y gira sobre el lomo, descubriendo la siguiente;
  //  · deslizar a la derecha → la hoja anterior viene desde la izquierda y cae sobre la actual;
  //  · con el menú abierto, deslizar a la izquierda lo cierra.
  // Las hojas son copias ligeras (solo lo que se ve) en una capa encima; el capítulo real solo cambia al terminar.
  (() => {
    const reader = $('#reader');
    let sx = 0, sy = 0, dir = null, mode = null, w = 0, dx = 0, dy = 0, t0 = 0, busy = false;
    let vx = 0, vy = 0, lastX = 0, lastY = 0, lastT = 0;   // velocidad del dedo
    let flip = null, raf = 0;
    const blocked = el => el.closest('input, textarea, .modal-scrim, .chapter-grid, .vactions, .mention-menu') ||
      document.querySelector('.modal-scrim:not([hidden])') || document.body.classList.contains('editing');
    const headerH = () => $('.topbar').offsetHeight;

    // Copia de lo que se ve ahora de la página (sin los bloques que quedan fuera de la pantalla)
    function currentPage() {
      const rect = reader.getBoundingClientRect(), top = headerH();
      const clone = reader.cloneNode(true);
      clone.removeAttribute('id');
      const live = [...$('#verses').children], copy = [...clone.querySelector('.verses').children];
      let first = live.findIndex(el => el.getBoundingClientRect().bottom > top);
      const last = live.findIndex(el => el.getBoundingClientRect().top > window.innerHeight);
      if (last > -1) copy.slice(last + 1).forEach(el => el.remove());
      if (first > 0) {
        const spacer = document.createElement('div');
        spacer.style.height = (live[first].getBoundingClientRect().top - live[0].getBoundingClientRect().top) + 'px';
        copy.slice(0, first).forEach(el => el.remove());
        clone.querySelector('.verses').prepend(spacer);
      }
      clone.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
      clone.querySelectorAll('.vactions').forEach(x => x.remove());
      clone.querySelectorAll('.active').forEach(x => x.classList.remove('active'));
      return place(clone, rect.left, rect.top - top, rect.width);
    }
    // Hoja del capítulo de destino, tal como se verá al llegar (desde el principio)
    function targetPage(n) {
      const book = bookOf(n.b), doc = state.texts.get(`${n.b}:${n.c}`) || { name: '', blocks: [] };
      const rect = reader.getBoundingClientRect(), top = headerH();
      const clone = reader.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelector('.chapter-title').innerHTML = titleHtml(book, n.c, doc.name);
      clone.querySelector('.verses').innerHTML = doc.blocks.length ? blocksHtml(n.b, n.c, doc, 25)
        : `<div class="empty-chapter"><p>${book.topic ? 'Este tema aún no tiene contenido.' : 'Este capítulo aún no tiene texto.'}</p></div>`;
      clone.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
      const docTop = rect.top + window.scrollY;   // posición del lector con la página arriba del todo
      return place(clone, rect.left, docTop - top, rect.width);
    }
    function place(clone, left, top, width) {
      clone.style.cssText = `position:absolute; left:${left}px; top:${top}px; width:${width}px; margin:0; transform:none; opacity:1; transition:none;`;
      const page = document.createElement('div');
      page.className = 'leaf-page';
      page.append(clone);
      return page;
    }
    // ---- Pasar página doblando la esquina, como en Apple Books ----
    // La hoja se dobla por una línea (el pliegue) que sigue al dedo: la parte del lomo sigue plana,
    // la parte doblada se refleja sobre el pliegue y muestra el dorso (papel con el texto en espejo, tenue).
    // Hacia delante se descubre debajo la página siguiente; hacia atrás, la anterior se desdobla sobre la actual.
    const el = (cls, parent) => { const d = document.createElement('div'); d.className = cls; if (parent) parent.append(d); return d; };
    async function startFlip(d) {
      const n = neighbour(d);
      if (!state.texts.has(`${n.b}:${n.c}`)) { try { await loadChapter(n.b, n.c); } catch { /* se dibuja vacía */ } }
      if (flip !== 'starting') return;   // el dedo ya se soltó: no se dibuja nada
      const top = headerH();
      const stage = el('curl-stage'); stage.style.top = top + 'px';
      const page = () => d > 0 ? currentPage() : targetPage(n);
      if (d > 0) { const under = targetPage(n); under.classList.add('leaf-under'); stage.append(under); }
      const underShade = el('curl-strip curl-under-shade', stage);
      const front = el('curl-front', stage); front.append(page());
      const frontShade = el('curl-strip curl-front-shade', front);
      const flapWrap = el('curl-flap-wrap', stage);
      const back = el('curl-back', flapWrap); back.append(page());
      el('curl-paper', back);
      const backShade = el('curl-strip curl-back-shade', back);
      document.body.append(stage);
      document.body.classList.add('flipping');
      const W = window.innerWidth, H = window.innerHeight - top;
      flip = { stage, front, frontShade, back, backShade, underShade, d, n, p: 0, tilt: 0, tiltK: 1, y0: Math.min(H - 1, Math.max(1, sy - top)), W, H };
      render(progress());
    }
    // Recorta un polígono convexo con el semiplano s(x) >= 0
    function clipPoly(pts, s) {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], sa = s(a), sb = s(b);
        if (sa >= 0) out.push(a);
        if ((sa >= 0) !== (sb >= 0)) { const t = sa / (sa - sb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      return out;
    }
    const poly = pts => pts.length > 2 ? `polygon(${pts.map(p => `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`).join(',')})` : 'polygon(0 0,0 0,0 0)';
    // Coloca una franja de sombra a lo largo del pliegue, hacia el lado n (+1) o el contrario (-1)
    function strip(elm, M, nx, ny, side, opacity) {
      const phi = Math.atan2(-nx, ny) * 180 / Math.PI;
      elm.style.transform = `translate(${M[0]}px, ${M[1]}px) rotate(${phi}deg) translate(-50%, ${side > 0 ? 0 : -100}%)`;
      elm.style.opacity = String(opacity);
    }
    // p: avance de la acción (0 = como al empezar, 1 = página pasada)
    function render(p) {
      if (!flip || flip === 'starting') return;
      const f = flip; p = Math.max(0, Math.min(1, p)); f.p = p;
      const fold = f.d > 0 ? p : 1 - p;                 // cuánto está doblada la hoja que se mueve
      const { W, H, y0 } = f;
      const G = [W, y0];                                  // punto de la hoja que «agarra» el dedo
      const F = [W - 2 * W * fold, y0 + f.tilt * f.tiltK * Math.min(1, fold * 4)];   // dónde está ese punto ahora
      const gx = G[0] - F[0], gy = G[1] - F[1], len = Math.hypot(gx, gy);
      const rect = [[0, 0], [W, 0], [W, H], [0, H]];
      if (len < 0.5) {   // sin doblar
        f.front.style.clipPath = 'none'; f.back.style.clipPath = poly([]);
        [f.underShade, f.frontShade, f.backShade].forEach(x => { x.style.opacity = '0'; });
        return;
      }
      const nx = gx / len, ny = gy / len, M = [(G[0] + F[0]) / 2, (G[1] + F[1]) / 2], k = M[0] * nx + M[1] * ny;
      const sd = q => q[0] * nx + q[1] * ny - k;          // distancia con signo al pliegue (positiva hacia G)
      f.front.style.clipPath = poly(clipPoly(rect, q => -sd(q)));
      f.back.style.clipPath = poly(clipPoly(rect, sd));
      // reflejo sobre el pliegue: x' = x - 2·s(x)·n
      const a = 1 - 2 * nx * nx, b = -2 * nx * ny, d = 1 - 2 * ny * ny;
      f.back.style.transform = `matrix(${a},${b},${b},${d},${2 * k * nx},${2 * k * ny})`;
      const curl = Math.min(1, Math.sin(Math.PI * Math.min(1, fold)) * 1.6 + 0.15);   // intensidad de las sombras
      strip(f.underShade, M, nx, ny, +1, curl * 0.9);    // sombra sobre la página que se descubre
      strip(f.frontShade, M, nx, ny, -1, curl * 0.7);    // la hoja se oscurece un poco junto al pliegue
      strip(f.backShade, M, nx, ny, +1, curl);           // curvatura del dorso
    }
    const progress = () => Math.max(0, (flip && flip.d > 0 ? -dx : dx) * 0.95 / w);
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (flip && flip !== 'starting') { flip.tilt = Math.max(-flip.H * 0.4, Math.min(flip.H * 0.4, dy * 1.1)); render(progress()); }
      });
    };

    // Animación hasta el final (p = 1) o de vuelta (p = 0), con la velocidad del dedo; la hoja se endereza
    function animateTo(target) {
      return new Promise(done => {
        const from = flip.p, dist = Math.abs(target - from), k0 = flip.tiltK;
        const speed = Math.min(3.2, Math.max(1.3, Math.abs(vx) * 2));   // fracción de hoja por segundo
        const dur = Math.max(200, Math.min(560, (dist / speed) * 1000));
        const start = performance.now();
        const ease = t => 1 - Math.pow(1 - t, 3);
        const tick = now => {
          const t = Math.min(1, (now - start) / dur), e = ease(t);
          flip.tiltK = k0 * (1 - e);
          render(from + (target - from) * e);
          if (t < 1) requestAnimationFrame(tick); else done();
        };
        requestAnimationFrame(tick);
      });
    }

    // Los movimientos se escuchan en el elemento tocado
    let target = null;
    const detach = () => {
      if (!target) return;
      target.removeEventListener('touchmove', move); target.removeEventListener('touchend', end); target.removeEventListener('touchcancel', end);
      target = null;
    };
    document.addEventListener('touchstart', e => {
      detach();
      // seguridad: si un paso de página anterior quedó a medias, se limpia para no bloquear el desplazamiento
      if (!flip && !busy) {
        document.body.classList.remove('flipping');
        document.querySelectorAll('.curl-stage').forEach(x => x.remove());
      }
      if (busy || e.touches.length !== 1 || blocked(e.target)) { dir = 'none'; return; }
      sx = lastX = e.touches[0].clientX; sy = lastY = e.touches[0].clientY; t0 = lastT = performance.now();
      dir = null; dx = 0; dy = 0; vx = 0; vy = 0;
      mode = drawer.classList.contains('open') ? 'drawer' : 'chapter';
      w = mode === 'drawer' ? drawer.offsetWidth : window.innerWidth;
      target = e.target;
      // no pasivo: así se puede impedir que el iPhone desplace la página mientras se pasa la hoja
      target.addEventListener('touchmove', move, { passive: false });
      target.addEventListener('touchend', end); target.addEventListener('touchcancel', end);
    }, { passive: true });
    function move(e) {
      if (dir === 'none') return;
      const tx = e.touches[0].clientX, ty = e.touches[0].clientY, x = tx - sx, y = ty - sy;
      // Solo cuando ya está claro que el gesto es horizontal (pasar página) se impide desplazar la página.
      // Antes de decidirlo nunca: si no, el iPhone cancelaría el desplazamiento normal hacia arriba o abajo.
      if (e.cancelable && (dir === 'h' || dir === 'v')) e.preventDefault();
      const now = performance.now();
      if (now > lastT) {
        vx = vx * 0.6 + ((tx - lastX) / (now - lastT)) * 0.4 / (w / 1000);
        vy = vy * 0.6 + ((ty - lastY) / (now - lastT)) * 0.4;
        lastX = tx; lastT = now;
      }
      // Desplazamiento hecho por la app (gesto que empezó como pasar página y resultó ser vertical)
      if (dir === 'v') { window.scrollBy(0, lastY - ty); lastY = ty; return; }
      lastY = ty;
      if (dir === 'h' && mode === 'chapter' && Math.abs(y) > Math.abs(x) && Math.abs(y) > 16 &&
          (!flip || flip === 'starting' || flip.p < 0.12)) {
        // Red de seguridad: era un desplazamiento con el pulgar en arco, no un paso de página.
        // Se cancela la hoja y la propia app desplaza la página con el dedo.
        abortFlip();
        dir = 'v'; window.scrollBy(0, -y); return;
      }
      if (!dir) {
        // Solo cuenta como pasar página un gesto claramente horizontal (menos de unos 25° de inclinación);
        // un desplazamiento con el pulgar en arco ya no se confunde.
        if (Math.hypot(x, y) < 12) return;
        dir = Math.abs(x) > Math.abs(y) * 2.1 && (mode === 'chapter' || x < 0) ? 'h' : 'none';
        if (dir !== 'h') { detach(); return; }   // desplazamiento normal: se deja de escuchar el gesto
        if (e.cancelable) e.preventDefault();
        if (mode === 'drawer') drawer.style.transition = 'none';
        else if (neighbour(x < 0 ? 1 : -1)) { busy = true; flip = 'starting'; startFlip(x < 0 ? 1 : -1).catch(() => { flip = null; busy = false; }); }
        else { reader.style.transition = 'none'; reader.style.willChange = 'transform'; }
      }
      dx = x; dy = y;
      if (mode === 'drawer') {
        const off = Math.min(0, dx);
        drawer.style.transform = `translateX(${off}px)`;
        scrim.style.opacity = String(Math.max(0, 1 + off / w));
      } else if (flip && flip !== 'starting') schedule();
      else if (!flip) reader.style.transform = `translateX(${dx / 4}px)`;   // no hay más capítulos: el texto se resiste
    }
    function abortFlip() {
      if (flip && flip !== 'starting') { flip.stage.remove(); document.body.classList.remove('flipping'); }
      cancelAnimationFrame(raf); raf = 0;
      flip = null; busy = false;
      reader.style.transition = ''; reader.style.transform = ''; reader.style.willChange = '';
    }
    // Inercia al soltar un desplazamiento hecho por la app, como el del propio iPhone
    let glide = 0;
    function momentum(v) {   // v: px/ms del dedo (positivo = hacia abajo)
      cancelAnimationFrame(glide);
      let last = performance.now();
      const step = now => {
        const dt = Math.min(40, now - last); last = now;
        window.scrollBy(0, -v * dt);
        v *= Math.pow(0.95, dt / 16);
        if (Math.abs(v) > 0.02) glide = requestAnimationFrame(step);
      };
      if (Math.abs(v) > 0.05) glide = requestAnimationFrame(step);
    }
    document.addEventListener('touchstart', () => cancelAnimationFrame(glide), { passive: true });
    async function end() {
      detach();
      if (dir === 'v') { dir = null; momentum(vy); return; }
      if (dir !== 'h') { dir = null; return; }
      dir = null;
      if (mode === 'drawer') {
        const fast = dx / Math.max(1, performance.now() - t0) < -0.5;
        const close = dx < -w / 3 || (fast && dx < -30);
        drawer.style.transition = ''; drawer.style.transform = ''; scrim.style.opacity = '';
        if (close) closeDrawer();
        return;
      }
      if (!flip) {
        reader.style.transition = 'transform .25s cubic-bezier(.2,.8,.3,1)'; reader.style.transform = '';
        setTimeout(() => { reader.style.transition = ''; reader.style.willChange = ''; }, 260);
        return;
      }
      // si la hoja aún se estaba preparando, se espera un instante
      for (let i = 0; i < 40 && flip === 'starting'; i++) await new Promise(r => setTimeout(r, 15));
      if (!flip || flip === 'starting') { flip = null; busy = false; return; }
      cancelAnimationFrame(raf); raf = 0;
      const f = flip;
      const towards = f.d > 0 ? -vx : vx;   // velocidad en el sentido de pasar la hoja
      const commit = f.p > 0.3 || (towards > 0.6 && f.p > 0.04);
      try {
        if (commit) {
          await animateTo(1);
          await go(f.n.b, f.n.c);   // el capítulo real queda igual que la hoja que se ve
          window.scrollTo(0, 0);
        } else {
          await animateTo(0);
        }
      } finally {
        f.stage.remove(); flip = null; busy = false;
        document.body.classList.remove('flipping');
      }
    }
  })();

  // ---------- Botón para bajar al final (abajo, en el centro) ----------
  // Siempre apunta hacia el final; desaparece al llegar al final del capítulo.
  (() => {
    const btn = $('#scrollBtn');
    // ligero mientras se desplaza: el alto de la página se mide solo cuando cambia, y como mucho una vez por fotograma
    let pageH = 0, queued = false;
    const measure = () => { pageH = document.documentElement.scrollHeight; };
    const apply = () => {
      queued = false;
      const max = pageH - window.innerHeight;
      const hide = max < 200 || window.scrollY >= max - 40 ||
        document.body.classList.contains('scroll-locked') || document.body.classList.contains('flipping');
      if (btn.hidden !== hide) btn.hidden = hide;
    };
    const update = () => { if (!queued) { queued = true; requestAnimationFrame(apply); } };
    const remeasure = () => { measure(); update(); };
    btn.addEventListener('click', () => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', remeasure);
    new MutationObserver(remeasure).observe($('#verses'), { childList: true, subtree: true });
    new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    remeasure();
  })();

  // ---------- Guardar un archivo eligiendo dónde ----------
  // Ordenador (Chrome/Edge): ventana para elegir carpeta. iPhone/Android: menú de compartir («Guardar en Archivos»).
  // Si no hay ninguna de las dos, se descarga.
  async function saveFile(file) {
    if (window.showSaveFilePicker) {
      const ext = file.name.split('.').pop();
      const handle = await window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: ext.toUpperCase(), accept: { [file.type]: ['.' + ext] } }] });
      const w = await handle.createWritable(); await w.write(file); await w.close();
      return 'Guardado.';
    }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      return 'Listo.';
    }
    const a = document.createElement('a');
    // en la descarga directa, nombre sin tildes (algunos navegadores lo cambian por «download»)
    a.href = URL.createObjectURL(file); a.download = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return 'Descargado: ' + file.name;
  }
  const fileName = s => s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();

  // ---------- Exportar el capítulo (o el tema) en PDF, con el aspecto de la app ----------
  let jsPDFReady = null;
  const loadJsPDF = () => jsPDFReady || (jsPDFReady = new Promise((ok, ko) => {
    const sc = document.createElement('script'); sc.src = '/vendor/jspdf.umd.min.js';
    sc.onload = () => ok(window.jspdf.jsPDF); sc.onerror = () => { jsPDFReady = null; ko(new Error('No se pudo cargar el generador de PDF')); };
    document.head.appendChild(sc);
  }));
  let pdfFile = null;
  function pdfLabel() {
    const book = bookOf(state.book), doc = chapterDoc();
    return book.topic ? book.name : `${book.short} ${state.chapter}${doc.name ? ' - ' + doc.name : ''}`;
  }
  // Guarda el archivo y, si se ha guardado, cierra la ventana. Si se cancela o el móvil pide otro toque,
  // la ventana se queda con «Guardar en…» para intentarlo de nuevo.
  async function saveAndClose(file, { close, st, retry, done }) {
    try {
      await saveFile(file);
      close(); toast(done);
    } catch (e) {
      retry.hidden = false;
      if (e.name === 'AbortError') { st.className = 'editor-status'; st.textContent = 'No se ha guardado. Pulsa «Guardar en…» para intentarlo de nuevo.'; }
      else if (e.name === 'NotAllowedError') { st.className = 'editor-status'; st.textContent = 'Listo. Pulsa «Guardar en…» para elegir dónde guardarlo.'; }
      else { st.className = 'editor-status warn'; st.textContent = 'No se pudo guardar: ' + e.message; }
    }
  }
  $('#pdfChapterBtn').addEventListener('click', () => {
    closeActions();
    pdfFile = null;
    loadJsPDF().catch(() => {});   // se prepara ya el generador, para guardar al primer toque
    const hasComments = state.comments.some(c => c.book === state.book && c.chapter === state.chapter);
    $('#pdfName').textContent = pdfLabel() + '.pdf';
    $('#pdfCommentsRow').hidden = !hasComments;
    $('#pdfMake').hidden = false; $('#pdfSave').hidden = true;
    $('#pdfStatus').textContent = ''; $('#pdfStatus').className = 'editor-status';
    $('#pdfModal').hidden = false; lockScroll('pdf');
  });
  const closePdf = () => { $('#pdfModal').hidden = true; unlockScroll('pdf'); };
  $('#pdfClose').addEventListener('click', closePdf);
  $('#pdfComments').addEventListener('change', () => { pdfFile = null; $('#pdfMake').hidden = false; $('#pdfSave').hidden = true; $('#pdfStatus').textContent = ''; });
  const pdfOpts = () => ({ close: closePdf, st: $('#pdfStatus'), retry: $('#pdfSave'), done: 'PDF guardado' });
  // «Guardar PDF»: crea el PDF y abre en el mismo toque las opciones para guardarlo
  $('#pdfMake').addEventListener('click', async () => {
    const st = $('#pdfStatus'); st.className = 'editor-status';
    try {
      // con el generador ya cargado todo ocurre en el mismo toque (el iPhone lo exige para abrir «Compartir»)
      const JsPDF = window.jspdf?.jsPDF || (st.textContent = 'Preparando…', await loadJsPDF());
      const blob = buildPdf(JsPDF, !$('#pdfCommentsRow').hidden && $('#pdfComments').checked);
      pdfFile = new File([blob], fileName(pdfLabel()) + '.pdf', { type: 'application/pdf' });
      st.textContent = '';
      $('#pdfMake').hidden = true;
      await saveAndClose(pdfFile, pdfOpts());
    } catch (e) { st.className = 'editor-status warn'; st.textContent = 'No se pudo crear el PDF: ' + e.message; }
  });
  $('#pdfSave').addEventListener('click', () => { if (pdfFile) saveAndClose(pdfFile, pdfOpts()); });

  // Maqueta del PDF: A4, Helvetica, cabecera centrada, números de versículo en dorado, subtítulos y divisiones,
  // comentarios en cursiva con la línea dorada, y pie con el nombre y el número de página.
  function buildPdf(JsPDF, withComments) {
    const pdf = new JsPDF({ unit: 'pt', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
    const M = 58, TOP = 64, BOTTOM = 70, CW = W - 2 * M;
    const GOLD = [176, 138, 46], DEEP = [138, 106, 28], INK = [43, 36, 23], SOFT = [110, 98, 80], LIGHT = [232, 211, 154];
    const book = bookOf(state.book), doc = chapterDoc();
    let y = TOP;
    const color = c => pdf.setTextColor(...c);
    const font = (style, size) => { pdf.setFont('helvetica', style); pdf.setFontSize(size); };
    const ensure = h => { if (y + h > H - BOTTOM) { pdf.addPage(); y = TOP; } };
    const plain = t => String(t).replace(/\/\[([^\]]+)\]/g, '$1');
    // reparte el texto en líneas; la primera puede empezar más a la derecha (tras el número)
    function wrap(text, first, width) {
      const words = String(text).split(/\s+/).filter(Boolean), lines = []; let line = '', max = first;
      for (const wd of words) {
        const test = line ? line + ' ' + wd : wd;
        if (pdf.getTextWidth(test) > max && line) { lines.push(line); line = wd; max = width; }
        else line = test;
      }
      if (line) lines.push(line);
      return lines;
    }
    // Cabecera
    font('normal', 8.5); color(SOFT);
    pdf.text((book.topic ? 'TEMA' : book.name.toUpperCase()).split('').join(' ').replace(/ {3}/g, '  '), W / 2, y, { align: 'center' });
    y += 30; font('normal', 26); color(GOLD);
    for (const l of wrap(book.topic ? book.name : `Capítulo ${state.chapter}`, CW, CW)) { pdf.text(l, W / 2, y, { align: 'center' }); y += 30; }
    if (!book.topic && doc.name) { y -= 8; font('normal', 12); color(SOFT); for (const l of wrap(doc.name, CW, CW)) { pdf.text(l, W / 2, y, { align: 'center' }); y += 16; } }
    // adorno: línea · cruz · línea
    y += 6; pdf.setDrawColor(...LIGHT); pdf.setLineWidth(0.8);
    pdf.line(W / 2 - 90, y, W / 2 - 14, y); pdf.line(W / 2 + 14, y, W / 2 + 90, y);
    pdf.setDrawColor(...GOLD); pdf.setLineWidth(2); pdf.line(W / 2, y - 7, W / 2, y + 7); pdf.line(W / 2 - 5, y - 2, W / 2 + 5, y - 2);
    y += 30;
    const commentsOf = (v, tg) => withComments ? (state.byRef.get(key(state.book, state.chapter, v, tg)) || []) : [];
    function comments(list) {
      for (const c of list) {
        font('italic', 10); const lines = wrap(plain(c.text), CW - 22, CW - 22);
        for (let i = 0; i < lines.length; i++) {
          ensure(14); color(SOFT); pdf.text(lines[i], M + 22, y);
          pdf.setDrawColor(...GOLD); pdf.setLineWidth(1.5); pdf.line(M + 12, y - 10, M + 12, y + 4);
          y += 14;
        }
        y += 4;
      }
    }
    for (const x of withTargets(doc.blocks)) {
      if (x.t === 'd') {
        y += 10; font('bold', 10.5); color(DEEP);
        const lines = wrap(x.text.toUpperCase(), CW - 40, CW - 40);
        ensure(lines.length * 15 + 30);
        for (const l of lines) { pdf.text(l, W / 2, y, { align: 'center', charSpace: 0.6 }); y += 15; }
        y += 8; comments(commentsOf(x.v, x.tg));
      } else if (x.t === 'h') {
        y += 8; font('bold', 13); color(DEEP);
        const lines = wrap(x.text, CW, CW);
        ensure(lines.length * 17 + 30);
        for (const l of lines) { pdf.text(l, M, y); y += 17; }
        y += 2; comments(commentsOf(x.v, x.tg));
      } else {
        font('normal', 11.5);
        const num = book.topic ? '' : String(x.n);
        font('bold', 7.5); const nw = num ? pdf.getTextWidth(num) + 4 : 0;
        font('normal', 11.5);
        const lines = wrap(x.text, CW - nw, CW);
        for (let i = 0; i < lines.length; i++) {
          ensure(16.5);
          if (i === 0 && num) { font('bold', 7.5); color(GOLD); pdf.text(num, M, y - 3.5); font('normal', 11.5); }
          color(INK); pdf.text(lines[i], M + (i === 0 ? nw : 0), y);
          y += 16.5;
        }
        y += 5; comments(commentsOf(x.v, ''));
      }
    }
    // Pie de página
    const pages = pdf.getNumberOfPages(), label = pdfLabel();
    for (let i = 1; i <= pages; i++) {
      pdf.setPage(i); font('normal', 8); color(SOFT);
      pdf.setDrawColor(...LIGHT); pdf.setLineWidth(0.6); pdf.line(M, H - 44, W - M, H - 44);
      pdf.text(label, M, H - 30);
      pdf.text(`${i} / ${pages}`, W - M, H - 30, { align: 'right' });
    }
    return pdf.output('blob');
  }

  // ---------- Copia de seguridad en Excel ----------
  // Se prepara al abrir la ventana; al pulsar el botón salen directamente las opciones para guardarla.
  let backupFile = null, backupLoading = null;
  function prepareBackup() {
    backupFile = null;
    const st = $('#backupStatus');
    st.className = 'editor-status'; st.textContent = 'Preparando la copia…';
    backupLoading = (async () => {
      const r = await fetch('/api/backup.xlsx', { cache: 'no-store', headers: { 'X-Owner-Token': store.get('pin', '') } });
      if (r.status === 401) { $('#backupPinBox').hidden = false; throw new Error('PIN incorrecto'); }
      if (!r.ok) throw new Error('Error ' + r.status);
      const blob = await r.blob();
      const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'evangelio-copia.xlsx';
      backupFile = new File([blob], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      st.textContent = 'Copia lista.';
      return backupFile;
    })();
    backupLoading.catch(e => { st.className = 'editor-status warn'; st.textContent = 'No se pudo preparar la copia: ' + e.message; });
    return backupLoading;
  }
  $('#backupBtn').addEventListener('click', () => {
    closeDrawer();
    const hasPin = !!store.get('pin', '');
    $('#backupPinBox').hidden = hasPin;
    $('#backupStatus').textContent = ''; $('#backupStatus').className = 'editor-status';
    $('#backupDo').hidden = false; $('#backupSave').hidden = true;
    $('#backupModal').hidden = false; lockScroll('backup');
    backupFile = null; backupLoading = null;
    if (hasPin) prepareBackup();
  });
  const closeBackup = () => { $('#backupModal').hidden = true; unlockScroll('backup'); };
  $('#backupClose').addEventListener('click', closeBackup);
  const backupOpts = () => ({ close: closeBackup, st: $('#backupStatus'), retry: $('#backupSave'), done: 'Copia guardada' });
  $('#backupDo').addEventListener('click', async () => {
    if (!$('#backupPinBox').hidden) { store.set('pin', $('#backupPin').value.trim()); backupFile = null; backupLoading = null; }
    // ya preparada: se guarda en el mismo toque
    if (backupFile) { $('#backupDo').hidden = true; return saveAndClose(backupFile, backupOpts()); }
    const btn = $('#backupDo'); btn.disabled = true;
    try {
      const file = await (backupLoading || prepareBackup());
      btn.hidden = true;
      await saveAndClose(file, backupOpts());
    } catch { /* el mensaje ya está en pantalla */ }
    btn.disabled = false;
  });
  $('#backupSave').addEventListener('click', () => { if (backupFile) saveAndClose(backupFile, backupOpts()); });

  $('#chapterTitle').addEventListener('click', () => { openBooks.add(state.book); openDrawer('bibleNav'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#pdfModal').hidden) closePdf();
      else if (!$('#backupModal').hidden) closeBackup();
      else if (!$('#claudeModal').hidden) closeClaude();
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
  function renderTopicList() {
    $('#topicTotal').textContent = state.topics.length;
    $('#topicList').innerHTML = state.topics.length ? [...state.topics].sort(byTitle).map(t => {
      const n = state.comments.filter(c => mentions(c.text, t)).length;
      return `<button class="topic-row${TOPIC_BASE + t.id === state.book ? ' current' : ''}" data-topic-open="${t.id}">
        <span>${esc(t.title)}</span>${n ? `<span class="count" title="Menciones">${n}</span>` : ''}</button>`;
    }).join('') : '<div class="empty">Aún no hay temas. Crea el primero.</div>';
  }
  $('#topicList').addEventListener('click', e => {
    const b = e.target.closest('[data-topic-open]'); if (!b) return;
    closeDrawer(); go(TOPIC_BASE + +b.dataset.topicOpen, 1);
  });
  $('#newTopicBtn').addEventListener('click', async () => {
    const title = (prompt('Nombre del nuevo tema (por ejemplo: Infierno)') || '').trim();
    if (!title) return;
    try {
      const t = await api('POST', '/api/topics', { title });
      state.topics.push(t); renderTopicList();
      closeDrawer(); await go(TOPIC_BASE + t.id, 1);
      openEditor();
    } catch (e) { toast('No se pudo crear: ' + e.message); }
  });
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
    refLabelText: (r, list, blk) => isTopic(r.b)
      ? `${r.tg ? 'Subtítulo' : 'Párrafo'}${blk ? `<span class="idx-sub">${esc(blk.text.slice(0, 70))}${blk.text.length > 70 ? '…' : ''}</span>` : ''}`
      : r.tg ? `Subtítulo · cap. ${r.c}${blk ? `<span class="idx-sub">${esc(blk.text)}</span>` : ''}` : `Versículo ${r.c}:${r.v}`,
    body: list => list.map(cm => `<div class="idx-comment">${mentionHtml(cm.text)}</div>`).join(''),
    gotoMode: null, gotoText: 'Ir al texto',
  });
  const renderForumIndex = makeIndex({
    el: $('#forumIndex'), countEl: $('#forumTotal'), byRef: () => state.postsByRef,
    emptyText: 'Aún no hay discusiones. Pulsa un versículo y elige «Discusión» para empezar una.',
    refLabelText: (r, list) => `${isTopic(r.b) ? 'Párrafo' : `Versículo ${r.c}:${r.v}`}<span class="count">${list.length} mensaje${list.length > 1 ? 's' : ''}</span>`,
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

  window.addEventListener('hashchange', route);

  // ---------- Encabezado fijo arriba ----------
  // El contenido empieza justo debajo del encabezado (su alto cambia con la muesca del iPhone)
  const fitHeader = () => { document.body.style.paddingTop = $('.topbar').offsetHeight + 'px'; };
  fitHeader();
  window.addEventListener('resize', fitHeader);

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
    renderCommentIndex(); renderForumIndex(); renderTopicList(); refreshRibbons();
    initNews();
  })();
})();
