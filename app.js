// SH 코치 (coach-pwa) — PC 없이 폰에서 쓰는 실행·회복 코치.
// 데이터: Dropbox 앱 폴더(Apps/sh-coach)에 이벤트 파일을 올리고, PC가 써 둔 snapshot.json을 읽는다.
// 폰 안에는 IndexedDB(kv: 토큰·스냅샷 / events: 내가 남긴 기록과 업로드 여부)만 둔다.
// PRD: sh_wiki/tasks/prd-mobile-coach-pwa.md (단계 1 — US-002·003·004)
'use strict';

const C = window.COACH_CONFIG;
const APP_VERSION = 'v5';   // sw.js의 VERSION과 함께 올린다 — 설정 창에 보여서 폰이 새 버전인지 확인할 수 있다
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
function logicalNow() { const d = new Date(); if (d.getHours() < C.DAY_CUTOFF_H) d.setDate(d.getDate() - 1); return d; }
const today = () => ymd(logicalNow());
const nowHM = () => { const d = new Date(); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200);
}

// ============ IndexedDB ============
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('sh-coach', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('events', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('kv', 'readonly', s => s.get(k)),
    set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
    del: k => tx('kv', 'readwrite', s => s.delete(k)),
    putEvent: ev => tx('events', 'readwrite', s => s.put(ev)),
    events: () => tx('events', 'readonly', s => s.getAll()),
    delEvent: id => tx('events', 'readwrite', s => s.delete(id)),
  };
})();

// ============ Dropbox (OAuth PKCE) ============
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randStr = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

const dbx = {
  async login() {
    const verifier = randStr(48), state = randStr(12);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    sessionStorage.setItem('pkce', JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({ client_id: C.DROPBOX_APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
      redirect_uri: C.REDIRECT_URI, token_access_type: 'offline', state });
    location.href = 'https://www.dropbox.com/oauth2/authorize?' + q;
  },
  // 로그인에서 돌아왔을 때 (?code=…&state=…)
  async finishLogin() {
    const q = new URLSearchParams(location.search);
    if (!q.get('code') && !q.get('error')) return false;
    history.replaceState(null, '', location.pathname);
    if (q.get('error')) { toast('연결을 취소했어요'); return false; }
    let saved = null; try { saved = JSON.parse(sessionStorage.getItem('pkce')); } catch {}
    sessionStorage.removeItem('pkce');
    if (!saved || saved.state !== q.get('state')) { toast('연결을 다시 시도해 주세요'); return false; }
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({
      code: q.get('code'), grant_type: 'authorization_code', code_verifier: saved.verifier, client_id: C.DROPBOX_APP_KEY, redirect_uri: C.REDIRECT_URI }) });
    if (!r.ok) { toast('연결에 실패했어요'); return false; }
    const j = await r.json();
    await idb.set('auth', { refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return true;
  },
  // 유효한 access token (만료됐으면 refresh token으로 새로 받는다). 연결이 끊겼으면 'revoked'를 던진다.
  async token() {
    const a = await idb.get('auth');
    if (!a) throw new Error('no-auth');
    if (a.access && a.exp > Date.now()) return a.access;
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: a.refresh, client_id: C.DROPBOX_APP_KEY }) });
    if (r.status === 400 || r.status === 401) throw new Error('revoked');
    if (!r.ok) throw new Error('net');
    const j = await r.json();
    await idb.set('auth', { ...a, access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return j.access_token;
  },
  async call(url, headers, body) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + await this.token(), ...headers }, body });
    if (r.status === 401) { await idb.set('auth', { ...(await idb.get('auth')), exp: 0 }); throw new Error('revoked'); }
    return r;
  },
  // 앱 폴더 기준 경로 (개발 서버는 /test 아래)
  path: p => (C.COACH_ROOT + p),
  async download(p) {
    const r = await this.call('https://content.dropboxapi.com/2/files/download', { 'Dropbox-API-Arg': JSON.stringify({ path: this.path(p) }) });
    if (r.status === 409) return null;   // 아직 없음 (PC가 한 번도 스냅샷을 안 씀)
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
    return r.text();
  },
  // mode=add: 같은 이름이 있으면 실패 → 덮어쓰지 않는다. 이미 올라간 파일이면(409 conflict) 성공으로 본다.
  async uploadNew(p, text) {
    const r = await this.call('https://content.dropboxapi.com/2/files/upload', {
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: this.path(p), mode: 'add', autorename: false, mute: true }),
    }, new TextEncoder().encode(text));
    if (r.ok) return true;
    if (r.status === 409 && /conflict/.test(await r.text())) return true;
    throw new Error('net');
  },
  // 클라우드 앱 폴더에 실제로 있는 파일 (설정 창 진단용 — PC Dropbox가 snapshot.json을 올렸는지 확인)
  async list(p = '') {
    const r = await this.call('https://api.dropboxapi.com/2/files/list_folder', { 'Content-Type': 'application/json' },
      JSON.stringify({ path: this.path(p) }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).entries.map(e => e['.tag'] === 'folder' ? e.name + '/' : `${e.name} (${(e.server_modified || '').slice(11, 16)} UTC)`);
  },
  async logout() {
    try { await this.call('https://api.dropboxapi.com/2/auth/token/revoke', {}); } catch {}
    await idb.del('auth');
  },
};

// ============ 이벤트 (폰 기록 1건 = Dropbox 파일 1개) ============
async function record(type, payload = {}) {
  const now = new Date();
  const id = randStr(9).replace(/[^A-Za-z0-9]/g, 'x');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');   // 20261019T121055Z — 이름순 = 시간순
  const ev = { id, ts: now.getTime(), date: today(), hm: nowHM(), type, payload, file: `/events/${stamp}-${id.slice(0, 4)}.json`, sent: false };
  await idb.putEvent(ev);
  render();
  flush();
  return ev;
}

let flushing = false;
async function flush() {
  if (flushing || !navigator.onLine || !(await idb.get('auth'))) { renderSync(); return; }
  flushing = true;
  try {
    const all = (await idb.events()).filter(e => !e.sent).sort((a, b) => a.ts - b.ts);
    for (const ev of all) {
      const { file, sent, ...body } = ev;
      await dbx.uploadNew(file, JSON.stringify(body));
      await idb.putEvent({ ...ev, sent: true });
    }
    state.revoked = false;
  } catch (e) {
    if (e.message === 'revoked') state.revoked = true;
  } finally {
    flushing = false;
    renderSync();
  }
}

// 오래된 기록 정리 — 올라간 지 14일 지난 것만 지운다 (화면의 "오늘 남긴 기록"과 목표 체크 상태에 쓰인다)
async function prune() {
  const cut = Date.now() - 14 * 86400000;
  for (const e of await idb.events()) if (e.sent && e.ts < cut) await idb.delEvent(e.id);
}

// ============ 스냅샷 (PC가 써 둔 요약) ============
const state = { snap: null, events: [], revoked: false, connected: false };

async function loadSnapshot() {
  state.snap = (await idb.get('snapshot')) || null;
  if (!navigator.onLine || !state.connected) return;
  try {
    const t = await dbx.download('/snapshot.json');
    state.snapErr = t ? '' : '없음';
    if (t) { state.snap = JSON.parse(t); await idb.set('snapshot', state.snap); }
  } catch (e) {
    if (e.message === 'revoked') state.revoked = true;
    state.snapErr = e.message || String(e);   // 화면 아래에 보여 준다 (원인 찾기용)
  }
}

// ============ 화면 ============
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${Math.max(m, 0)}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  return `${Math.round(m / 1440)}일 전`;
}

async function renderSync() {
  const events = await idb.events();
  const waiting = events.filter(e => !e.sent).length;
  const chip = $('#sync');
  chip.hidden = !state.connected;
  if (!navigator.onLine) { chip.className = 'chip off'; chip.textContent = waiting ? `오프라인 · 올릴 기록 ${waiting}건` : '오프라인'; }
  else if (waiting) { chip.className = 'chip wait'; chip.textContent = `올릴 기록 ${waiting}건`; }
  else { chip.className = 'chip'; chip.textContent = '모두 올림'; }
  $('#reconnect').hidden = !state.revoked;
  const log = $('#log');
  const mine = events.filter(e => e.date === today() && ['quick', 'rest-choose'].includes(e.type)).sort((a, b) => b.ts - a.ts);
  log.innerHTML = mine.map(e => `<li><span>${esc(e.hm)}</span><b>${esc(e.payload.text || e.payload.label || '')}</b><span class="state">${e.sent ? '✓' : '…'}</span></li>`).join('');
}

// 오늘 목표 = 스냅샷 목표 + 폰에서 바꾼 체크 상태 (PC가 아직 병합하지 않았어도 내가 누른 대로 보이게)
function goalsFor(date) {
  const day = state.snap && state.snap.days && state.snap.days[date];
  const goals = (day ? day.goals : []).map(g => ({ ...g }));
  const since = state.snap ? new Date(state.snap.generated_at).getTime() : 0;
  for (const e of state.events.filter(e => e.type === 'goal-set' && e.date === date && e.ts > since).sort((a, b) => a.ts - b.ts)) {
    const g = goals.find(x => x.text === e.payload.text);
    if (g) g.done = !!e.payload.done;
  }
  return goals;
}

function render() {
  idb.events().then(ev => { state.events = ev; draw(); });
}
function draw() {
  const d = logicalNow();
  $('#date').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
  $('#connect').hidden = state.connected;

  const goals = goalsFor(today());
  $('#goals-card').hidden = !goals.length;
  $('#goals').innerHTML = goals.map((g, i) => `<li class="${g.done ? 'done' : ''} ${g.depth ? 'sub' : ''}">
    <input type="checkbox" data-i="${i}" ${g.done ? 'checked' : ''} aria-label="${esc(g.text)}"><span>${esc(g.text)}</span></li>`).join('');

  const r = state.snap && state.snap.reading;
  $('#reading-card').hidden = !(r && r.papers && r.papers.length);
  if (r && r.papers) {
    const readEv = state.events.some(e => e.type === 'reading-done' && e.date === today());
    $('#reading').innerHTML = r.papers.map((p, i) => `<div class="paper">
      <div class="title">${esc(p.title)}</div>
      <div class="meta">${esc(p.authors || '')} ${esc(p.year || '')} · 오늘 p.${p.from}~${p.to}</div>
      ${p.question ? `<div class="q">❓ ${esc(p.question)}</div>` : ''}
      <div class="row">
        ${p.pdfUrl ? `<a class="btn soft" href="${esc(p.pdfUrl)}" target="_blank" rel="noopener" data-open="${i}">PDF 열기</a>` : ''}
        ${i === 0 ? `<button class="btn" id="btn-read" ${r.readToday || readEv ? 'disabled' : ''}>${r.readToday || readEv ? '오늘 읽음 ✓' : '읽었어요'}</button>` : ''}
      </div></div>`).join('') + `<p class="muted small" style="margin:8px 0 0">${esc(r.lineageTitle || '')}${r.progress ? ` · ${r.progress.done}/${r.progress.total}편` : ''}</p>`;
  }

  const s = state.snap;
  const err = state.snapErr && state.snapErr !== '없음' ? ` · 요약 받기 실패: ${state.snapErr}` : '';
  $('#pc-sync').textContent = (s ? `PC 동기화: ${ago(s.generated_at)}` : (state.connected ? 'PC가 아직 요약을 쓰지 않았어요' : '')) + err +
    (state.connected ? ' · 눌러서 다시 받기' : '');
  renderSync();
}

// ============ 이벤트 연결 ============
$('#btn-connect').onclick = () => dbx.login();
$('#btn-reconnect').onclick = () => dbx.login();
$('#btn-quick').onclick = async () => {
  const text = $('#quick').value.trim();
  if (!text) return;
  await record('quick', { text });
  $('#quick').value = '';
  toast('남겼어요');
};
$('#goals').onchange = async e => {
  const i = +e.target.dataset.i;
  const g = goalsFor(today())[i];
  if (g) await record('goal-set', { text: g.text, index: i, done: e.target.checked });
};
$('#reading').onclick = async e => {
  const open = e.target.closest('[data-open]');
  if (open) { const p = state.snap.reading.papers[+open.dataset.open]; record('reading-open', { id: p.id }); return; }   // 링크는 그대로 열린다
  if (e.target.id === 'btn-read') { await record('reading-done', { id: state.snap.reading.papers[0].id }); toast('오늘 읽음으로 남겼어요'); }
};
$('#btn-settings').onclick = async () => {
  const ev = await idb.events();
  $('#settings-info').textContent = `${state.connected ? 'Dropbox 연결됨' : '연결 안 됨'} · 폰에 있는 기록 ${ev.length}건 (올리지 못한 것 ${ev.filter(e => !e.sent).length}건)` +
    (C.COACH_ROOT ? ` · 테스트 폴더 ${C.COACH_ROOT}` : '') + ` · 앱 ${APP_VERSION}` +
    (state.snapErr ? ` · 요약: ${state.snapErr}` : '');
  $('#settings').showModal();
  if (state.connected && navigator.onLine) {
    try {
      const root = await dbx.list('');
      const ev = await dbx.list('/events').catch(() => []);
      $('#settings-info').textContent += ` · 클라우드: ${root.join(', ') || '(비어 있음)'} · events: ${ev.filter(n => !n.endsWith('/')).length}건 대기`;
    } catch (e) { $('#settings-info').textContent += ` · 클라우드 확인 실패: ${e.message}`; }
  }
};
$('#btn-close').onclick = () => $('#settings').close();
$('#pc-sync').onclick = async () => { $('#pc-sync').textContent = '받는 중…'; await loadSnapshot(); render(); flush(); };
$('#btn-disconnect').onclick = async () => {
  if (!confirm('Dropbox 연결을 끊을까요? 올리지 못한 기록은 폰에 남아 있다가 다시 연결하면 올라가요.')) return;
  await dbx.logout(); state.connected = false; $('#settings').close(); draw();
};
window.addEventListener('online', () => { flush(); loadSnapshot().then(render); });
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush(); loadSnapshot().then(render); } });

// ============ 시작 ============
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  const justLoggedIn = await dbx.finishLogin();
  state.connected = !!(await idb.get('auth'));
  // 개발 서버 전용 미리보기: localhost/?demo → 같은 폴더의 demo-snapshot.json으로 화면만 그린다 (공개 주소에서는 꺼짐)
  if (C.COACH_ROOT && new URLSearchParams(location.search).has('demo')) {
    state.snap = await (await fetch('demo-snapshot.json')).json();
    state.connected = true; render(); return;
  }
  if (justLoggedIn) { await record('hello', { ua: navigator.userAgent.slice(0, 80) }); toast('Dropbox에 연결됐어요'); }   // 앱 폴더가 이때 생긴다
  render();
  await loadSnapshot();
  render();
  flush();
  prune();
})();
