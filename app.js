/* KCET BioLab Copilot — offline lab-manual assistant (no server, no internet needed after first load) */
'use strict';
const NOT_FOUND = 'The answer is not specified in the manuals.';
const MIN_COV = 0.5, MIN_SCORE = 4.5;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

let DB = null, EXP = {}, COURSE = {}, IDX = null;

/* ------------------------------------------------------------------ text processing */
const STOP = new Set(('a an the is are was were be been being am do does did of in on at to for from by with and or not no ' +
  'what which who whom whose when where why how this that these those it its into than then there their them they we you your ' +
  'i me my our can could should would will shall may might must about as if so such any all each give tell explain describe ' +
  'define list name mention state write say please used use using need needed required require get make done ' +
  'experiment expt exp lab laboratory manual sir madam kindly').split(' '));
const KEEP_SHORT = new Set(['ph','uv','km','dna','rna','pcr','rbc','wbc','nm','od','kla','tlc','r']);
function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(sses|ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4 && !w.endsWith('eed')) return w.slice(0, -2).replace(/e$/, '');
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}
function tokens(text, keepStop) {
  const raw = String(text).toLowerCase().replace(/[’']/g, '').replace(/\bk\s*l\s*a\b/g, 'kla').match(/[a-z0-9α-ωµ]+(?:[.-][a-z0-9]+)*/g) || [];
  const out = [];
  for (let w of raw) {
    w = w.replace(/^[.-]+|[.-]+$/g, '');
    if (!w) continue;
    if (!keepStop && STOP.has(w)) continue;
    if (w.length < 2 && !KEEP_SHORT.has(w)) continue;
    out.push(stem(w));
    if (w.includes('-')) w.split('-').forEach(p => { if (p.length > 2 && !STOP.has(p)) out.push(stem(p)); });
  }
  return out;
}

/* ------------------------------------------------------------------ BM25 index */
function buildIndex(chunks) {
  const docs = [], df = new Map();
  let total = 0;
  chunks.forEach((c, i) => {
    const e = EXP[c.e] || {};
    const toks = tokens(c.t).concat(tokens(e.title || ''), tokens(e.title || ''), tokens(c.s));
    const tf = new Map();
    toks.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
    tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
    docs.push({ i, tf, len: toks.length, titleToks: new Set(tokens(e.title || '')) });
    total += toks.length;
  });
  return { docs, df, N: docs.length, avg: total / Math.max(1, docs.length) };
}
function idf(t) { const n = IDX.df.get(t) || 0; return Math.log(1 + (IDX.N - n + 0.5) / (n + 0.5)); }

const INTENTS = [
  { key: 'principle', re: /\b(principles?|why|theory|mechanism|basis|concept)\b/i, sec: /Principle|Theory|Introduction|Background/ },
  { key: 'aim', re: /\b(aim|objective|purpose|goal)\b/i, sec: /Aim|Objective/ },
  { key: 'materials', re: /\b(materials?|reagents?|apparatus|equipments?|chemicals?|requirements?|required|needed|glassware|instruments?)\b/i, sec: /Material|Reagent|Apparatus|Requirement|Chemical|Equipment|Glassware/ },
  { key: 'result', re: /\b(results?|inference|conclusion|outcome)\b/i, sec: /Result|Inference|Discussion/ },
  { key: 'calc', re: /\b(calculat\w*|formula|equation)\b/i, sec: /Calculation|Formula/ },
  { key: 'safety', re: /\b(safety|precautions?|hazard|rules?)\b/i, sec: /Precaution|Safety|Overview/ },
  { key: 'steps', re: /\b(how (to|do|is|are|can|should)|steps?|procedures?|protocols?|process|perform|carry out)\b/i, sec: /Procedure|Steps|Method|Protocol/ },
  { key: 'define', re: /^\s*(what (is|are)|define|meaning of|what do you mean by)\b/i, sec: /Principle|Introduction|Theory|Background|Overview|Aim/ }
];

const INTENT_WORDS = new Set(['step','procedur','protocol','principl','aim','objectiv','purpos','material','reagent','apparatu',
  'equipment','chemical','requir','requirement','need','result','calculat','calculation','formula','proces','perform','theory','concept']);
function search(query, course) {
  const q = tokens(query).filter(t => !INTENT_WORDS.has(t));
  const uq = Array.from(new Set(q));
  if (!uq.length) return { hits: [], q: uq };
  const intent = INTENTS.find(x => x.re.test(query));
  const k1 = 1.4, b = 0.7;
  const hits = [];
  for (const d of IDX.docs) {
    const c = DB.chunks[d.i];
    if (course && c.c !== course) continue;
    let s = 0, matched = 0, titleHit = 0, cnt = 0;
    for (const t of uq) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched += idf(t); cnt++;
      if (d.titleToks.has(t)) titleHit++;
      s += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / IDX.avg));
    }
    if (!s) continue;
    if (titleHit) s *= 1 + 0.15 * titleHit;
    const raw = s;
    if (intent && intent.sec.test(c.s)) s *= 1.7;
    if (intent && intent.key === 'safety' && /^.*-0$/.test(c.e)) s *= 1.5;
    hits.push({ c, s, raw, matched, d, cnt });
  }
  hits.sort((a, b2) => b2.s - a.s);
  const totalIdf = uq.reduce((a, t) => a + idf(t), 0);
  hits.forEach(h => h.cov = h.matched / totalIdf);
  return { hits, q: uq, intent, totalIdf };
}

/* ------------------------------------------------------------------ answer composition */
function sentences(text) {
  return text.replace(/\n/g, ' \n ').split(/(?<=[.!?])\s+(?=[A-Z0-9(])|\n/).map(s => s.trim()).filter(s => s.length > 2);
}
function listItems(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}
function highlight(text, q) {
  let h = esc(text);
  const words = Array.from(new Set(q)).filter(w => w.length > 2).sort((a, b) => b.length - a.length).slice(0, 8);
  if (!words.length) return h;
  const re = new RegExp('\\b(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\w*', 'gi');
  return h.replace(re, '<mark>$&</mark>');
}
function sourceLine(c) {
  const e = EXP[c.e] || {};
  const expTxt = e.no === '0' ? 'Lab safety' : `Expt ${e.no}`;
  return `${c.c} · ${expTxt} · ${e.title || ''} · ${c.s}${c.p ? ' · p. ' + c.p : ''}`;
}
function sameSectionText(c) {
  // the contiguous run of chunks of the same experiment + section around this chunk
  const all = DB.chunks; let i = all.indexOf(c), a = i, b = i;
  while (a > 0 && all[a - 1].e === c.e && all[a - 1].s === c.s) a--;
  while (b < all.length - 1 && all[b + 1].e === c.e && all[b + 1].s === c.s) b++;
  const seen = new Set(), lines = [];
  all.slice(a, b + 1).forEach(x => x.t.split('\n').forEach(l => { if (!seen.has(l)) { seen.add(l); lines.push(l); } }));
  return lines.join('\n');
}
function compose(query, course) {
  const lang = checkEnglish(query);
  if (lang) return { kind: 'info', html: `<p>${esc(lang)}</p>` };
  const small = query.trim().toLowerCase().replace(/[!.?]+$/, '');
  if (/^(hi|hello|hey|good (morning|afternoon|evening)|vanakkam)$/.test(small))
    return { kind: 'info', html: '<p>Hello! Ask me anything about your lab experiments, for example the aim, principle, materials or procedure of an experiment.</p>' };
  if (/^(thanks|thank you|ok|okay|thank u)$/.test(small))
    return { kind: 'info', html: '<p>You are welcome. All the best for your experiment!</p>' };

  const r = search(query, course);
  const top = r.hits[0];
  const n = r.q.length;
  const needCnt = n >= 4 ? Math.ceil(n * 0.6) : Math.min(n, 2);
  const enough = top && top.cov >= MIN_COV && top.s >= MIN_SCORE && top.cnt >= needCnt;
  if (!enough) return { kind: 'none', html: `<p>${esc(NOT_FOUND)}</p>`, others: (top && top.cov >= 0.5 && top.cnt >= 1) ? r.hits.slice(0, 2) : [] };

  const intent = r.intent;
  let c = top.c;
  if (intent) {
    // anchor on the best topic match, then take the matching section of the same sub-experiment
    const anchor = r.hits.slice().sort((a, b) => b.raw - a.raw)[0];
    const near = nearestSection(anchor.c, intent.sec);
    if (near) c = near;
  }
  let body = '';
  if (intent && (intent.key === 'steps' || intent.key === 'materials' || intent.key === 'safety') && intent.sec.test(c.s)) {
    let items = listItems(sameSectionText(c));
    const cut = items.findIndex((x, i) => i >= 3 && /^(\(?\d{1,2}[.)]\s*)?[A-Z][A-Z0-9 ,&()\-–]{6,}$/.test(x) && x.split(' ').length >= 2);
    if (cut > 0) items = items.slice(0, cut);
    const glued = items.findIndex((x, i) => i >= 3 && /\s[A-Z]{3,}(?:\s[A-Z]{3,})+\s*$/.test(x));
    if (glued > 0) { items = items.slice(0, glued + 1); items[glued] = items[glued].replace(/\s[A-Z]{3,}(?:\s[A-Z]{3,})+\s*$/, ''); }
    const head = items[0] && items[0].endsWith(':') && items.length > 2 ? items.shift() : null;
    const isNum = items.filter(x => /^\(?\d{1,2}[.)]/.test(x)).length >= Math.min(3, items.length);
    const shown = items.slice(0, 12).map(x => x.replace(/^\(?\d{1,2}[.)]\s*|^[•\-–]\s*/, ''));
    body = (head ? `<div class="h">${esc(head)}</div>` : '') +
      (isNum ? '<ol>' : '<ul>') + shown.map(x => `<li>${highlight(x, r.q)}</li>`).join('') + (isNum ? '</ol>' : '</ul>') +
      (items.length > 12 ? `<p class="h">+ ${items.length - 12} more lines in the manual (tap “Show full section”).</p>` : '');
  } else {
    // short answer: best 1–2 sentences from the top experiment (sections matching the question type first)
    const scoreOf = new Map(r.hits.map(h => [h.c, h.s]));
    let pool = DB.chunks.filter(x => x.e === c.e);
    if (intent) { const f = pool.filter(x => intent.sec.test(x.s)); if (f.length) pool = f; }
    const maxS = Math.max(...pool.map(x => scoreOf.get(x) || 0), 1);
    const titleT = new Set(tokens((EXP[c.e] || {}).title || ''));
    const scored = [];
    pool.forEach((ch, ci) => sentences(ch.t).forEach((s2, si) => {
      if (/\?\s*$/.test(s2) || s2.split(' ').length < 5) return;
      if (/^(explain|evaluate|discuss|define|compare|describe|list|what|why|how|state|write|differentiate|name)\b/i.test(s2)) return;
      const st = new Set(tokens(s2));
      let sc = 0; r.q.forEach(t => { if (st.has(t)) sc += idf(t) * (titleT.has(t) ? 0.5 : 1); });
      if (!sc) return;
      sc += 1.5 * (scoreOf.get(ch) || 0) / maxS;
      if (intent && (intent.key === 'principle' || intent.key === 'define') && /\b(based on|principle|is a|are the|refers to|defined as)\b/i.test(s2)) sc += 2;
      if (si < 2 && (pool.indexOf(ch) === 0 || (pool[pool.indexOf(ch) - 1] || {}).s !== ch.s)) sc += 0.8;
      if (s2.split(' ').length > 60) sc *= 0.85;
      scored.push({ s: s2, sc, ci: pool.indexOf(ch), si });
    }));
    scored.sort((a, b) => b.sc - a.sc);
    let best = scored.slice(0, 2).filter((x, i) => i === 0 || x.sc >= scored[0].sc * 0.7);
    if (!best.length) best = sentences(c.t).slice(0, 2).map((s2, si) => ({ s: s2, ci: 0, si }));
    best.sort((a, b) => a.ci - b.ci || a.si - b.si);
    const ansChunk = scored.length ? pool[scored[0].ci] : c;
    body = best.map(x => `<p>${highlight(x.s, r.q)}</p>`).join('');
    return { kind: 'ok', html: body, chunk: ansChunk, q: r.q, others: r.hits.slice(1).filter(h => h.c.e !== c.e && h.cov >= 0.75 && h.s >= 0.6 * top.s).slice(0, 2) };
  }
  return { kind: 'ok', html: body, chunk: c, q: r.q, others: r.hits.slice(1).filter(h => h.c.e !== c.e && h.cov >= 0.75 && h.s >= 0.6 * top.s).slice(0, 2) };
}

function nearestSection(a, secRe) {
  if (secRe.test(a.s)) return a;
  const all = DB.chunks, i = all.indexOf(a);
  for (let j = i + 1; j < all.length && all[j].e === a.e; j++) {   // forward, until the next sub-experiment starts
    if (/^Aim/.test(all[j].s) && j > i + 0) break;
    if (secRe.test(all[j].s)) return all[j];
  }
  for (let j = i - 1; j >= 0 && all[j].e === a.e; j--) {             // backward, until the start of this sub-experiment
    if (secRe.test(all[j].s)) return all[j];
    if (/^Aim/.test(all[j].s)) break;
  }
  return null;
}
function checkEnglish(q) {
  if (/[஀-௿]/.test(q)) return 'Please ask your question in English. Tamil script is not supported.';
  const letters = q.match(/\p{L}/gu) || [];
  const nonLatin = letters.filter(ch => !/[A-Za-zÀ-ɏͰ-Ͽ]/.test(ch));
  if (letters.length && nonLatin.length / letters.length > 0.2) return 'Please ask your question in English.';
  return null;
}

/* ------------------------------------------------------------------ UI: navigation */
let current = 'home';
function go(view) {
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + view));
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === (view === 'chat' ? 'home' : view)));
  $('#nav').style.display = view === 'chat' ? 'none' : '';
  current = view;
  if (view === 'manuals' && !manState) showCourses();
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); go(g.dataset.go); }
});

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ------------------------------------------------------------------ UI: home */
function labName(code) { return code ? `${code} · ${COURSE[code].name}` : 'All 9 lab manuals'; }
function fillLabs() {
  const sel = $('#labPick');
  sel.innerHTML = '<option value="">All 9 lab manuals</option>' +
    DB.courses.map(c => `<option value="${c.code}">${c.code} · ${esc(c.name)} (Sem ${c.sem})</option>`).join('');
  sel.value = store.get('lab', '');
  if (!COURSE[sel.value]) sel.value = '';
  sel.addEventListener('change', () => { store.set('lab', sel.value); fillExamples(); $('#chatLab').textContent = labName(sel.value); });
  $('#chatLab').textContent = labName(sel.value);
}
function fillExamples() {
  const code = $('#labPick').value;
  const exps = DB.experiments.filter(e => e.no !== '0' && (!code || e.code === code));
  const pick = [];
  const pool = exps.slice();
  for (let i = 0; i < 3 && pool.length; i++) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const forms = [t => `What is the aim of ${t}?`, t => `Materials required for ${t}`, t => `Procedure for ${t}`, t => `Principle of ${t}`];
  const qs = pick.map((e, i) => forms[(i + Math.floor(Math.random() * 4)) % 4](shortTitle(e.title)));
  $('#examples').innerHTML = qs.map(q => `<button class="chip" type="button">${esc(q)}</button>`).join('');
  $$('#examples .chip').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
}
function shortTitle(t) {
  let s = t.replace(/\s*:.*$/, '').replace(/\s*\((?![^)]*\)\s*\S)[^)]*\)?\s*$/, '').replace(/\.$/, '').trim();
  let w = s.split(' ');
  if (w.length > 11) {
    w = w.slice(0, 10);
    while (w.length > 4 && /^(of|and|in|by|on|for|to|the|a|an|using|from|with|its|given)$/i.test(w[w.length - 1])) w.pop();
  }
  s = w.join(' ');
  return /^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}
/* ------------------------------------------------------------------ UI: chat */
function addQ(text) {
  const d = document.createElement('div'); d.className = 'q'; d.textContent = text;
  $('#msgs').appendChild(d);
}
function scrollEnd() { const s = $('#chatScroll'); requestAnimationFrame(() => s.scrollTop = s.scrollHeight); }
function ask(text) {
  text = String(text || '').trim();
  if (!text) return;
  if (!DB) { toast('Manuals are still loading…'); return; }
  go('chat');
  addQ(text);
  const typing = document.createElement('div'); typing.className = 'dots'; typing.setAttribute('aria-label', 'Finding the answer');
  typing.innerHTML = '<span></span><span></span><span></span>';
  $('#msgs').appendChild(typing); scrollEnd();
  setTimeout(() => {
    typing.remove();
    const res = compose(text, $('#labPick').value);
    renderAnswer(res, text);
  }, 250);
}
function renderAnswer(res, query) {
  const a = document.createElement('div'); a.className = 'a';
  let html = '';
  if (res.kind === 'none') html += '<span class="tag">Not found in the lab manuals</span>';
  html += res.html;
  if (res.chunk) {
    html += `<div class="src"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"></path><path d="M4 21V5"></path></svg><span>From manual · ${esc(sourceLine(res.chunk))}</span></div>`;
    html += `<div class="acts">
      <button class="btn ghost sm" type="button" data-act="speak">Read aloud</button>
      <button class="btn ghost sm" type="button" data-act="full">Show full section</button>
      <button class="btn ghost sm" type="button" data-act="open">Open experiment</button></div>
      <div class="more" hidden></div>`;
  }
  if (res.others && res.others.length) {
    html += `<div class="h">${res.kind === 'none' ? 'Closest topics in the manuals:' : 'Also see:'}</div><div class="others">` +
      res.others.map((h, i) => `<button type="button" data-other="${i}">${esc(sourceLine(h.c))}</button>`).join('') + '</div>';
  }
  a.innerHTML = html;
  $('#msgs').appendChild(a);
  if (res.chunk) {
    $('[data-act="speak"]', a).addEventListener('click', () => speak(a));
    $('[data-act="full"]', a).addEventListener('click', ev => {
      const m = $('.more', a);
      if (m.hidden) { m.innerHTML = highlight(sameSectionText(res.chunk), res.q || []); m.hidden = false; ev.target.textContent = 'Hide full section'; }
      else { m.hidden = true; ev.target.textContent = 'Show full section'; }
    });
    $('[data-act="open"]', a).addEventListener('click', () => { go('manuals'); showExperiment(res.chunk.e, res.chunk.s); });
  }
  $$('[data-other]', a).forEach(btn => btn.addEventListener('click', () => {
    const h = res.others[+btn.dataset.other];
    go('manuals'); showExperiment(h.c.e, h.c.s);
  }));
  scrollEnd();
}
function speak(el) {
  if (!('speechSynthesis' in window)) { toast('Read aloud is not supported on this phone.'); return; }
  speechSynthesis.cancel();
  const txt = Array.from(el.querySelectorAll('p, li')).map(n => n.textContent).join('. ');
  const u = new SpeechSynthesisUtterance(txt);
  u.lang = 'en-IN'; u.rate = 0.98;
  speechSynthesis.speak(u);
}
['askForm1', 'askForm2'].forEach(id => $('#' + id).addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('input', e.target); const v = inp.value; inp.value = ''; inp.blur(); ask(v);
}));
$('#clearChat').addEventListener('click', () => { $('#msgs').innerHTML = ''; });

/* ------------------------------------------------------------------ UI: manuals */
let manState = null;
function showCourses() {
  manState = { level: 'courses' };
  $('#manTitle').textContent = 'Lab manuals';
  $('#manSub').textContent = `Department of Biotechnology · ${DB ? DB.courses.length : 9} manuals on this phone`;
  $('#manBack').style.visibility = 'hidden';
  if (!DB) { $('#manBody').innerHTML = '<p class="small" style="padding:20px">Loading manuals…</p>'; return; }
  $('#manBody').innerHTML = '<div class="list">' + DB.courses.map(c => {
    const n = DB.experiments.filter(e => e.code === c.code && e.no !== '0').length;
    return `<button class="row" type="button" data-course="${c.code}"><span class="code">${c.code}</span><span class="t"><b>${esc(c.name)}</b><span>Semester ${c.sem} · ${n} experiments</span></span>${chev()}</button>`;
  }).join('') + '</div>';
  $$('[data-course]').forEach(b => b.addEventListener('click', () => showExperiments(b.dataset.course)));
  $('#manScroll').scrollTop = 0;
}
function showExperiments(code) {
  manState = { level: 'exps', code };
  $('#manTitle').textContent = COURSE[code].name;
  $('#manSub').textContent = `${code} · Semester ${COURSE[code].sem}`;
  $('#manBack').style.visibility = 'visible';
  const exps = DB.experiments.filter(e => e.code === code);
  $('#manBody').innerHTML = '<div class="list">' + exps.map(e =>
    `<button class="row" type="button" data-exp="${e.id}"><span class="code">${e.no === '0' ? '!' : esc(e.no)}</span><span class="t"><b>${esc(e.title)}</b><span>${e.no === '0' ? 'Before you start' : 'Experiment ' + esc(e.no)}${e.page ? ' · from p. ' + e.page : ''}</span></span>${chev()}</button>`
  ).join('') + '</div>';
  $$('[data-exp]').forEach(b => b.addEventListener('click', () => showExperiment(b.dataset.exp)));
  $('#manScroll').scrollTop = 0;
}
function showExperiment(id, focusSection) {
  const e = EXP[id]; if (!e) return;
  manState = { level: 'exp', code: e.code, id };
  $('#manTitle').textContent = e.no === '0' ? 'Lab safety' : `Experiment ${e.no}`;
  $('#manSub').textContent = `${e.code} · ${COURSE[e.code].name}`;
  $('#manBack').style.visibility = 'visible';
  const chunks = DB.chunks.filter(c => c.e === id);
  const secs = [];
  chunks.forEach(c => {
    let s = secs[secs.length - 1];
    if (!s || s.name !== c.s) { s = { name: c.s, page: c.p, lines: [], seen: new Set() }; secs.push(s); }
    c.t.split('\n').forEach(l => { if (!s.seen.has(l)) { s.seen.add(l); s.lines.push(l); } });
  });
  $('#manBody').innerHTML = `<div class="reader"><h2>${esc(e.title)}</h2>` + secs.map((s, i) =>
    `<div id="sec-${i}" data-sec="${esc(s.name)}"><h3>${esc(s.name)}</h3><p class="txt">${esc(s.lines.join('\n'))}</p><div class="pg">Manual page ${s.page || '–'}</div></div>`
  ).join('') + `<p class="small">Tables, graphs and record pages are in the printed manual.</p></div>`;
  const scroller = $('#manScroll'); scroller.scrollTop = 0;
  if (focusSection) {
    const t = $$('[data-sec]').find(x => x.dataset.sec === focusSection);
    if (t) requestAnimationFrame(() => scroller.scrollTop = t.offsetTop - 8);
  }
}
$('#manBack').addEventListener('click', () => {
  if (!manState || manState.level === 'courses') return;
  if (manState.level === 'exp') showExperiments(manState.code); else showCourses();
});
function chev() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B7286" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>'; }

/* ------------------------------------------------------------------ voice (Web Speech API, max 20 s) */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, vTimer = null, vStart = 0, vFinal = '', vInterim = '', vCancelled = false;
function openVoice() {
  if (!SR) { toast('Voice input is not available in this browser. Please type your question.'); return; }
  vFinal = ''; vInterim = ''; vCancelled = false;
  $('#vText').textContent = '…'; $('#vState').textContent = 'Listening'; $('#vTime').textContent = '0:00';
  $('#vLab').textContent = labName($('#labPick').value);
  $('#voice').classList.add('on');
  try {
    rec = new SR();
    rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    rec.onresult = ev => {
      vInterim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) vFinal += r[0].transcript + ' '; else vInterim += r[0].transcript;
      }
      $('#vText').textContent = (vFinal + vInterim).trim() || '…';
    };
    rec.onerror = ev => {
      const m = ev.error === 'not-allowed' ? 'Please allow microphone access to ask by voice.'
        : ev.error === 'network' ? 'Voice needs internet or offline English speech on this phone. Please type your question.'
        : ev.error === 'no-speech' ? 'No speech heard. Please try again.' : 'Voice input stopped. Please type your question.';
      closeVoice(); toast(m); vCancelled = true;
    };
    rec.onend = () => finishVoice();
    rec.start();
  } catch (e) { closeVoice(); toast('Voice input could not start. Please type your question.'); return; }
  vStart = Date.now();
  vTimer = setInterval(() => {
    const s = Math.floor((Date.now() - vStart) / 1000);
    $('#vTime').textContent = `0:${String(Math.min(20, s)).padStart(2, '0')}`;
    if (s >= 20) stopVoice();
  }, 250);
}
function stopVoice() { $('#vState').textContent = 'Processing'; try { rec && rec.stop(); } catch (e) { finishVoice(); } }
function closeVoice() { clearInterval(vTimer); $('#voice').classList.remove('on'); }
function finishVoice() {
  if (!$('#voice').classList.contains('on')) return;
  closeVoice();
  const text = (vFinal + vInterim).trim();
  if (!vCancelled && text) ask(text);
}
$$('[data-mic]').forEach(b => b.addEventListener('click', openVoice));
$('#vStop').addEventListener('click', stopVoice);
$('#vCancel').addEventListener('click', () => { vCancelled = true; try { rec && rec.abort(); } catch (e) {} closeVoice(); });

/* ------------------------------------------------------------------ install + offline */
let deferredPrompt = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  if (!standalone()) ['#installBox', '#installBox2'].forEach(s => $(s).classList.add('on'));
});
['#installBtn', '#installBtn2'].forEach(s => $(s).addEventListener('click', async () => {
  if (!deferredPrompt) { toast('Use the Chrome menu (⋮) → “Add to Home screen”.'); return; }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null;
  ['#installBox', '#installBox2'].forEach(x => $(x).classList.remove('on'));
}));
window.addEventListener('appinstalled', () => { ['#installBox', '#installBox2'].forEach(x => $(x).classList.remove('on')); toast('Installed. Open it from your home screen.'); });
$('#copyMail').addEventListener('click', () => {
  const m = 'karthikumarbt@kamarajengg.edu.in';
  (navigator.clipboard ? navigator.clipboard.writeText(m) : Promise.reject()).then(() => toast('Email address copied'), () => toast(m));
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    const res = await fetch('data/manuals.json');
    DB = await res.json();
  } catch (e) {
    toast('Could not load the manuals. Open the app once with internet.'); return;
  }
  DB.courses.forEach(c => COURSE[c.code] = c);
  DB.experiments.forEach(e => EXP[e.id] = e);
  IDX = buildIndex(DB.chunks);
  fillLabs(); fillExamples();
  $('#verLine').textContent = `Version 1.0 · ${DB.courses.length} lab manuals · ${DB.experiments.filter(e => e.no !== '0').length} experiments`;
  if (current === 'manuals') showCourses();
  if (!store.get('seenAbout', false)) { store.set('seenAbout', true); go('about'); }
}
boot();
window.BioLab = { compose, search, tokens, db: () => DB };
