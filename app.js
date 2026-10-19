// SH 코치 (coach-pwa) — PC 없이 폰에서 쓰는 실행·회복 코치.
// 데이터: Dropbox 앱 폴더(Apps/sh-coach)에 이벤트 파일을 올리고, PC가 써 둔 snapshot.json을 읽는다.
// 폰 안에는 IndexedDB(kv: 토큰·스냅샷 / events: 내가 남긴 기록과 업로드 여부)만 둔다.
// PRD: sh_wiki/tasks/prd-mobile-coach-pwa.md (단계 1 기반 + 단계 2 화면: 쉬기·시작하기·정리하기)
'use strict';

const C = window.COACH_CONFIG;
const APP_VERSION = 'v7';   // sw.js의 VERSION과 함께 올린다 — 설정 창에 보여서 폰이 새 버전인지 확인할 수 있다
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

// ============ 종단간 암호화 (PC daily-wiki/server/coach-crypto.js와 같은 규칙) ============
// 열쇠 = PBKDF2-SHA256(암호 문구, "sh-coach-v1", 200,000회) → AES-GCM 256. 문구는 저장하지 않고,
// 꺼낼 수 없는(non-extractable) 열쇠 객체만 IndexedDB에 둔다. Dropbox에는 암호문만 올라간다.
const cryptoBox = {
  async derive(pass) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('sh-coach-v1'), iterations: 200000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },
  async seal(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { v: 1, enc: 'aesgcm', iv: b64(iv), ct: b64(ct) };
  },
  async open(key, box) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));   // 열쇠가 틀리면 예외
    return new TextDecoder().decode(pt);
  },
};
function b64(buf) { let s = ''; for (const c of new Uint8Array(buf)) s += String.fromCharCode(c); return btoa(s); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

let flushing = false;
async function flush() {
  // 열쇠가 없으면 올리지 않는다 (평문을 Dropbox에 남기지 않게) — 폰 안에 모아 둔다
  const key = await idb.get('key');
  if (flushing || !navigator.onLine || !(await idb.get('auth')) || !key) { renderSync(); return; }
  flushing = true;
  try {
    const all = (await idb.events()).filter(e => !e.sent).sort((a, b) => a.ts - b.ts);
    for (const ev of all) {
      const { file, sent, ...body } = ev;
      await dbx.uploadNew(file, JSON.stringify(await cryptoBox.seal(key, JSON.stringify(body))));
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
    if (t) {
      const box = JSON.parse(t);
      const key = await idb.get('key');
      if (box.enc !== 'aesgcm') state.snapErr = 'PC가 아직 암호화 전 (PC 암호 문구 필요)';   // 평문 요약은 쓰지 않는다
      else if (!key) state.snapErr = '암호 문구 필요';
      else {
        try { state.snap = JSON.parse(await cryptoBox.open(key, box)); await idb.set('snapshot', state.snap); }
        catch { state.snapErr = '암호 문구가 PC와 달라요'; }
      }
    }
  } catch (e) {
    if (e.message === 'revoked') state.revoked = true;
    state.snapErr = e.message || String(e);   // 화면 아래에 보여 준다 (원인 찾기용)
  }
}

// ============ 화면 공통 ============
// 궁극 목표(호호): ① 기록의 꾸준함 ② 사소한 행복·즐거움을 놓치지 않기. 메인 = 🌿 쉬기 · ▶ 시작하기 · 🧺 정리하기 (단계 2)
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${Math.max(m, 0)}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  return `${Math.round(m / 1440)}일 전`;
}
const ls = {   // 이 폰에서만 쓰는 작은 편의값 (지워져도 괜찮은 것만)
  get(k) { try { return JSON.parse(localStorage.getItem('coach.' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('coach.' + k, JSON.stringify(v)); } catch {} },
};
const newTid = () => 't_' + randStr(6).replace(/[^A-Za-z0-9]/g, 'x');
const addDaysStr = (date, n) => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };

// PC가 아직 반영하지 않은 내 기록 (스냅샷 위에 덧씌운다)
function pendingEvents(types) {
  const merged = new Set((state.snap && state.snap.merged_ids) || []);
  const since = state.snap && !state.snap.merged_ids ? new Date(state.snap.generated_at).getTime() : 0;   // 옛 스냅샷 호환
  return state.events.filter(e => types.includes(e.type) && !merged.has(e.id) && e.ts > since).sort((a, b) => a.ts - b.ts);
}

// ============ 할 일 (PC daily-wiki/server/coach-tasks.js와 같은 규칙) ============
const DECISION = { now: '진행', later: '오늘 나중에', date: '예약', hold: '보류', drop: '하지 않음' };
const RESULT_STATUS = { 완료: '완료', 일부: '열림', 못함: '열림', '의도적으로 안 함': '하지 않음' };
const OBSTACLES = ['막막함', '상대 반응 걱정', '자료 없음', '피곤함', '노트북이 필요함'];
const REVIEW_OBSTACLES = ['피로', '시간', '장소·도구', '감정', '할 일이 막연함', '기타'];
const FALLBACK_TEMPLATES = [{ id: 'other', version: 0, name: '기타', keywords: [], obstacles: {}, steps: [
  { text: '끝났을 때 모습 한 줄로 적기', min: 1 }, { text: '지금 바로 할 수 있는 가장 작은 행동 적기', min: 1 }, { text: '그 행동 5분만 하기', min: 5 }] }];
const parseStamp = s => { const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/); return m ? new Date(`${m[1]}T${m[2] || '00:00'}:00`).getTime() : 0; };

function tasksNow() {
  const map = new Map(((state.snap && state.snap.tasks) || []).map(t => [t.id, { ...t, steps: t.steps.map(s => ({ ...s })), reviews: [...(t.reviews || [])],
    decidedTs: parseStamp(t.decided), reviewedTs: Math.max(0, ...(t.reviews || []).map(r => parseStamp(r.at))) }]));
  for (const e of pendingEvents(['task-add', 'task-steps', 'task-decide', 'task-step', 'task-review'])) {
    const p = e.payload; let t = map.get(p.tid);
    if (e.type === 'task-add') { if (!t) map.set(p.tid, { id: p.tid, title: p.title, kind: p.kind || '', status: '열림', steps: [], reviews: [], created: e.date, decidedTs: 0, reviewedTs: 0 }); continue; }
    if (!t) continue;
    if (e.type === 'task-steps') { t.steps = p.steps.map(s => ({ ...s })); t.template = p.template; }
    else if (e.type === 'task-decide') { t.status = DECISION[p.decision]; t.when = p.when || ''; t.decidedTs = e.ts; }
    else if (e.type === 'task-step' && t.steps[p.i]) t.steps[p.i].done = p.done;
    else if (e.type === 'task-review') { t.reviews.push({ at: `${e.date} ${e.hm}`, result: p.result }); t.reviewedTs = e.ts; t.status = RESULT_STATUS[p.result]; if (p.result === '완료') t.steps.forEach(s => { s.done = true; }); }
  }
  return [...map.values()];
}
const openTasks = () => tasksNow().filter(t => !['완료', '하지 않음'].includes(t.status));
const templates = () => (state.snap && state.snap.templates && state.snap.templates.length ? state.snap.templates : FALLBACK_TEMPLATES);
const tplOf = id => templates().find(t => t.id === id) || templates().find(t => t.id === 'other') || templates()[0];
function guessKind(title) {
  for (const t of templates()) if ((t.keywords || []).some(k => k && title.includes(k))) return t.id;
  return 'other';
}
// 템플릿 → 첫 행동 목록. 장애물을 고르면 그 줄을 맨 앞에, 폰만 있으면 PC 단계는 뒤로 ("💻 PC 켤 때")
function buildSteps(kind, obstacle, device) {
  const t = tplOf(kind);
  let steps = t.steps.map(s => ({ text: s.text, min: s.min, pc: !!s.pc, done: false }));
  const o = obstacle && t.obstacles && t.obstacles[obstacle];
  if (o) steps.unshift({ text: o.text, min: o.min, pc: false, done: false });
  if (device === 'phone') steps = [...steps.filter(s => !s.pc), ...steps.filter(s => s.pc)];
  return steps;
}
// 이어서 할 일 — 지금 진행 중이거나, 다시 볼 날이 된 것
function dueTasks() {
  const T = today();
  const rank = { 진행: 0, '오늘 나중에': 1, 예약: 2, 보류: 3 };
  return openTasks().filter(t => t.status === '진행' || t.status === '오늘 나중에' ||
      (['예약', '보류'].includes(t.status) && t.when && t.when.slice(0, 10) <= T))
    .sort((a, b) => rank[a.status] - rank[b.status] || String(a.when || '').localeCompare(String(b.when || '')));
}
// 오늘 남은 빈 시간 (시간표 기준) — "오늘 나중에" 제안용
function freeSlots() {
  const tt = state.snap && state.snap.timetable;
  const wd = WD[logicalNow().getDay()];
  const busy = ((tt && tt.days && tt.days[wd]) || []).map(b => [hmMin(b.start), hmMin(b.end)]);
  const now = new Date(); let t = Math.max(9 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes() + 15) / 30) * 30);
  const out = [];
  for (; t <= 22 * 60 && out.length < 3; t += 30) {
    if (!busy.some(([a, b]) => t < b && t + 30 > a)) { out.push(minHm(t)); t += 60; }
  }
  return out;
}
const hmMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const minHm = m => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;

// ============ 화면 그리기 ============
const VIEWS = { '': '지금 무엇이 필요할까?', rest: '🌿 쉬기', start: '▶ 시작하기', log: '🧺 정리하기', run: '지금 5분' };
const view = () => { const v = location.hash.replace('#', ''); return v in VIEWS ? v : ''; };

async function renderSync() {
  const events = await idb.events();
  const waiting = events.filter(e => !e.sent).length;
  const chip = $('#sync');
  chip.hidden = !state.connected;
  if (!navigator.onLine) { chip.className = 'chip off'; chip.textContent = waiting ? `오프라인 · 올릴 기록 ${waiting}건` : '오프라인'; }
  else if (waiting) { chip.className = 'chip wait'; chip.textContent = state.hasKey ? `올릴 기록 ${waiting}건` : `암호 문구 정하면 올림 ${waiting}건`; }
  else { chip.className = 'chip'; chip.textContent = '모두 올림'; }
  $('#reconnect').hidden = !state.revoked;
}

// 오늘 목표 = 스냅샷 목표 + 폰에서 바꾼 체크 상태 (PC가 아직 병합하지 않았어도 내가 누른 대로 보이게)
function goalsFor(date) {
  const day = state.snap && state.snap.days && state.snap.days[date];
  const goals = (day ? day.goals : []).map(g => ({ ...g }));
  for (const e of pendingEvents(['goal-set']).filter(e => e.date === date)) {
    const g = goals.find(x => x.text === e.payload.text);
    if (g) g.done = !!e.payload.done;
  }
  return goals;
}
const todays = type => state.events.filter(e => e.type === type && e.date === today()).sort((a, b) => b.ts - a.ts);

function render() {
  idb.events().then(ev => { state.events = ev; draw(); });
}
function draw() {
  const v = view();
  const d = logicalNow();
  $('#date').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
  $('#title').textContent = VIEWS[v];
  $('#btn-back').hidden = v === '';
  $('#connect').hidden = state.connected;
  $('#keycard').hidden = !state.connected || (state.hasKey && !state.rekey);
  for (const k of Object.keys(VIEWS)) $('#v-' + (k || 'home')).hidden = k !== v;
  ({ '': drawHome, rest: drawRest, start: drawStart, log: drawLog, run: drawRun })[v]();

  const s = state.snap;
  const err = state.snapErr && state.snapErr !== '없음' ? ` · 요약 받기 실패: ${state.snapErr}` : '';
  $('#pc-sync').textContent = (s ? `PC 동기화: ${ago(s.generated_at)}` : (state.connected ? 'PC가 아직 요약을 쓰지 않았어요' : '')) + err +
    (state.connected ? ' · 눌러서 다시 받기' : '');
  renderSync();
}

// ----- 처음 -----
function drawHome() {
  // 돌아보기: "지금 시작"을 누른 지 30분이 지났는데 아직 돌아보지 않은 할 일 하나
  const rv = openTasks().find(t => t.status === '진행' && t.decidedTs && t.decidedTs < Date.now() - 30 * 60000 &&
    t.reviewedTs < t.decidedTs && !ls.get('dismiss.' + t.id + '.' + t.decidedTs));
  const rc = $('#review-card');
  rc.hidden = !rv;
  if (rv) reviewUI(rc, rv, `‘${rv.title}’ 어떻게 됐어요?`, () => render());

  const nx = dueTasks().filter(t => t !== rv)[0];
  const nc = $('#next-card');
  nc.hidden = !nx;
  if (nx) {
    const step = nx.steps.find(s => !s.done);
    nc.innerHTML = `<div class="muted small">이어서 할 첫 행동 · ${esc(nx.status)}${nx.when ? ' ' + esc(nx.when) : ''}</div>
      <div class="next-title">${esc(nx.title)}</div>
      ${step ? `<div class="next-step">${step.pc ? '💻 ' : ''}${esc(step.text)}${step.min ? ` <span class="muted">(${step.min}분)</span>` : ''}</div>` : ''}
      <div class="row"><button class="btn" data-act="redo" data-tid="${nx.id}">다시 정하기</button><button class="btn primary" data-act="run" data-tid="${nx.id}">▶ 5분 시작</button></div>`;
  }
  const n = todays('joy').length;
  $('#joy-line').innerHTML = n ? `✨ 오늘의 작은 즐거움 <b>${n}</b>개` : `<a href="#log">✨ 오늘의 작은 즐거움, 하나 남겨 볼까요?</a>`;
}

// 돌아보기 카드 (처음 화면·실행 화면 공용) — 1~2번 터치. "나중에"는 한 번으로 닫히고 다시 묻지 않는다
function reviewUI(box, t, question, done) {
  const st = box._rv && box._rv.tid === t.id ? box._rv : (box._rv = { tid: t.id, result: '', obstacle: '' });
  box.innerHTML = `<h2>${esc(question)}</h2>
    <div class="chips">${['완료', '일부', '못함', '의도적으로 안 함'].map(r => `<button class="chip-btn ${st.result === r ? 'on' : ''}" data-r="${r}">${r}</button>`).join('')}</div>
    ${st.result === '못함' ? `<p class="muted small mt">무엇 때문이었을까요? (골라도, 안 골라도 돼요)</p>
      <div class="chips">${REVIEW_OBSTACLES.map(o => `<button class="chip-btn ${st.obstacle === o ? 'on' : ''}" data-o="${o}">${o}</button>`).join('')}</div>
      <input class="field" data-note placeholder="다음엔 이렇게 (선택)" maxlength="120">` : ''}
    <div class="row"><button class="btn" data-later>나중에</button><button class="btn primary" data-save ${st.result ? '' : 'disabled'}>남기기</button></div>`;
  box.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.r) { st.result = b.dataset.r; reviewUI(box, t, question, done); return; }
    if (b.dataset.o) { st.obstacle = st.obstacle === b.dataset.o ? '' : b.dataset.o; const note = box.querySelector('[data-note]'); st.note = note ? note.value : ''; reviewUI(box, t, question, done); if (st.note) box.querySelector('[data-note]').value = st.note; return; }
    if (b.hasAttribute('data-later')) { ls.set('dismiss.' + t.id + '.' + t.decidedTs, 1); box._rv = null; done(); return; }
    if (b.hasAttribute('data-save')) {
      const note = box.querySelector('[data-note]');
      await record('task-review', { tid: t.id, result: st.result, obstacle: st.obstacle, note: note ? note.value.trim() : '' });
      box._rv = null;
      toast(st.result === '완료' ? '잘했어요 ✓' : '남겼어요. 다음 방식에 반영할게요');
      done();
    }
  };
}

// ----- 🌿 쉬기 -----
const REST_TABLE = {
  low: { 5: ['눈 감고 쉬기', '물 한 잔 마시기'], 10: ['아무것도 안 하기', '짧은 산책'], 30: ['낮잠', '좋아하는 영상 보기'] },
  mid: { 5: ['창밖 보기', '스트레칭'], 10: ['음악 듣기', '산책'], 30: ['책 읽기', '걷기·가벼운 러닝'] },
  refresh: { 5: ['책 펼치기', '좋아하는 노래 한 곡'], 10: ['관심 개념 하나 찾아보기', '산책'], 30: ['흥미로운 논문 읽기', '가벼운 외출'] },
};
function drawRest() {
  const r = state.rest;
  const now = ls.get('resting');
  $('#rest-pick').hidden = !!now;
  $('#rest-now').hidden = !now;
  if (now) {
    $('#rest-now').innerHTML = `<div class="muted small">${esc(now.hm)}부터</div><div class="resting-label">🌿 ${esc(now.label)}${now.min ? ` <span class="muted">${now.min}분</span>` : ''}</div>
      <p class="muted">쉬는 동안엔 다른 건 신경 쓰지 않아도 돼요.</p>
      ${now.ending ? `<h2 class="mt">회복됐나요?</h2><div class="chips">${['그렇다', '조금', '아니다'].map(f => `<button class="chip-btn" data-felt="${f}">${f}</button>`).join('')}</div>`
        : `<div class="row"><button class="btn" data-act="rest-close">그냥 닫기</button><button class="btn primary" data-act="rest-end">끝났어요</button></div>`}`;
    return;
  }
  document.querySelectorAll('#rest-energy .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.v === r.energy));
  document.querySelectorAll('#rest-time .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.v === String(r.time)));
  const box = $('#rest-suggest');
  if (!r.energy || !r.time) { box.innerHTML = ''; return; }
  const day = state.snap && state.snap.days && state.snap.days[today()];
  const reserved = day && day.rest;
  const items = REST_TABLE[r.energy][r.time];
  box.innerHTML = `<h2 class="mt">이건 어때요?</h2><div class="pick">
    ${reserved ? `<button class="pick-btn reserved" data-label="${esc(reserved)}">📌 예약해 둔 쉼: ${esc(reserved)}</button>` : ''}
    ${items.map(x => `<button class="pick-btn" data-label="${esc(x)}">${esc(x)}</button>`).join('')}
    </div><button class="link mt" data-label="휴대폰으로 쉬기">📱 휴대폰으로 쉴래요</button>`;
}

// ----- ▶ 시작하기 -----
function drawStart() {
  drawReading();
  const f = state.flow;
  const box = $('#flow');
  if (!f) {
    box.innerHTML = `<h2>무엇을 시작할까요?</h2>
      <div class="inline"><input class="field" id="flow-title" placeholder="예) 교수님께 메일, 논문 읽기" maxlength="120"><button class="btn primary" data-act="flow-new">나누기</button></div>
      <p class="muted small">크게 적어도 괜찮아요. 1~5분짜리 첫 행동으로 나눠 드릴게요.</p>`;
  } else {
    const tpl = tplOf(f.kind);
    box.innerHTML = `<div class="muted small">${f.isNew ? '새 할 일' : '이어서'}</div><h2>${esc(f.title)}</h2>
      <div class="chips small-chips">${templates().map(t => `<button class="chip-btn ${t.id === f.kind ? 'on' : ''}" data-kind="${t.id}">${esc(t.name)}</button>`).join('')}</div>
      <p class="muted small mt">걸리는 게 있다면 (선택)</p>
      <div class="chips small-chips">${OBSTACLES.map(o => `<button class="chip-btn ${o === f.obstacle ? 'on' : ''}" data-obstacle="${o}">${o}</button>`).join('')}</div>
      <div class="chips small-chips mt"><button class="chip-btn ${f.device === 'phone' ? 'on' : ''}" data-device="phone">📱 폰만</button><button class="chip-btn ${f.device === 'pc' ? 'on' : ''}" data-device="pc">💻 PC 있음</button></div>
      <h2 class="mt">첫 행동</h2>
      <ol class="steps">${f.steps.map((s, i) => `<li class="${s.done ? 'done' : ''}">
        <input class="field step-text" data-step="${i}" value="${esc(s.text)}" aria-label="단계 ${i + 1}">
        <span class="step-meta">${s.pc ? '💻' : ''}<input class="field step-min" data-min="${i}" value="${s.min || ''}" inputmode="numeric" aria-label="분">분</span>
        <button class="x" data-del="${i}" aria-label="지우기">×</button></li>`).join('')}</ol>
      <button class="link" data-act="step-add">+ 단계 추가</button>
      ${f.choosing ? decideExtra(f) : `<h2 class="mt">언제 할까요?</h2>
      <div class="decide">
        <button class="btn primary" data-decide="now">▶ 지금 5분 시작</button>
        <button class="btn" data-decide="later">오늘 나중에</button>
        <button class="btn" data-decide="date">날짜 정하기</button>
        <button class="btn" data-decide="hold">보류</button>
        <button class="btn" data-decide="drop">하지 않기</button>
      </div>`}
      <div class="row"><span class="muted small">${esc(tpl.name)} 템플릿 v${tpl.version}${f.edited ? ' · 고침' : ''}</span><button class="link" data-act="flow-cancel">취소</button></div>`;
  }
  const list = openTasks().filter(t => !state.flow || t.id !== state.flow.tid);
  $('#tasks-card').hidden = !list.length;
  $('#tasks').innerHTML = list.map(t => `<li><button class="task" data-open-task="${t.id}"><b>${esc(t.title)}</b>
    <span class="badge">${esc(t.status)}${t.when ? ' · ' + esc(t.when) : ''}</span></button></li>`).join('');
}
function decideExtra(f) {
  if (f.choosing === 'later') {
    const slots = freeSlots();
    return `<h2 class="mt">몇 시쯤?</h2><div class="chips">${slots.map(s => `<button class="chip-btn" data-when="${s}">${s}</button>`).join('')}</div>
      <div class="inline mt"><input class="field" type="time" id="when-time"><button class="btn primary" data-act="when-ok" data-kind-when="later">정하기</button></div>
      <button class="link mt" data-when="">시간은 안 정할래요</button> · <button class="link" data-act="choose-back">돌아가기</button>`;
  }
  const label = f.choosing === 'date' ? '언제 다시 볼까요?' : '다시 볼 날 (선택)';
  return `<h2 class="mt">${label}</h2><div class="inline"><input class="field" type="date" id="when-date" value="${addDaysStr(today(), 1)}">
    <button class="btn primary" data-act="when-ok">정하기</button></div>
    ${f.choosing === 'hold' ? '<button class="link mt" data-when="">날짜 없이 보류</button> · ' : ''}<button class="link" data-act="choose-back">돌아가기</button>`;
}
async function decide(decision, when = '') {
  const f = state.flow;
  if (!f.steps.length) { toast('첫 행동을 하나 이상 남겨 주세요'); return; }
  const tpl = tplOf(f.kind);
  if (f.isNew) await record('task-add', { tid: f.tid, title: f.title, kind: f.kind });
  await record('task-steps', { tid: f.tid, steps: f.steps, template: tpl.id, version: tpl.version, kind: f.kind, edited: !!f.edited });
  await record('task-decide', { tid: f.tid, decision, when });
  state.flow = null;
  if (decision === 'now') { state.run = { tid: f.tid, endAt: Date.now() + 5 * 60000 }; location.hash = '#run'; return; }
  toast({ later: '오늘 나중에 다시 보여 드릴게요', date: `${when}에 다시 보여 드릴게요`, hold: '보류함에 넣어 뒀어요', drop: '하지 않기로 정했어요. 그것도 결정이에요' }[decision]);
  location.hash = '';
}
function drawReading() {
  const r = state.snap && state.snap.reading;
  $('#reading-card').hidden = !(r && r.papers && r.papers.length);
  if (!(r && r.papers)) return;
  const readEv = todays('reading-done').length > 0;
  $('#reading').innerHTML = r.papers.map((p, i) => `<div class="paper">
    <div class="title">${esc(p.title)}</div>
    <div class="meta">${esc(p.authors || '')} ${esc(p.year || '')} · 오늘 p.${p.from}~${p.to}</div>
    ${p.question ? `<div class="q">❓ ${esc(p.question)}</div>` : ''}
    <div class="row">
      ${p.pdfUrl ? `<a class="btn soft" href="${esc(p.pdfUrl)}" target="_blank" rel="noopener" data-open="${i}">PDF 열기</a>` : ''}
      ${i === 0 ? `<button class="btn" id="btn-read" ${r.readToday || readEv ? 'disabled' : ''}>${r.readToday || readEv ? '오늘 읽음 ✓' : '읽었어요'}</button>` : ''}
    </div></div>`).join('') + `<p class="muted small" style="margin:8px 0 0">${esc(r.lineageTitle || '')}${r.progress ? ` · ${r.progress.done}/${r.progress.total}편` : ''}</p>`;
}

// ----- 실행 (지금 5분) -----
let runTimer = null;
function drawRun() {
  clearInterval(runTimer);
  const run = state.run || ls.get('run');
  const t = run && tasksNow().find(x => x.id === run.tid);
  const box = $('#run');
  if (!t) { box.innerHTML = '<p class="muted">진행 중인 일이 없어요.</p><a class="btn" href="#">처음으로</a>'; return; }
  state.run = run; ls.set('run', run);
  const i = t.steps.findIndex(s => !s.done);
  if (run.reviewing || i < 0) {
    reviewUI(box, t, i < 0 ? `‘${t.title}’ 단계를 다 했어요! 어땠어요?` : `‘${t.title}’ 여기까지 어땠어요?`, () => { state.run = null; ls.set('run', null); location.hash = ''; });
    return;
  }
  const s = t.steps[i];
  box.innerHTML = `<div class="muted small">${esc(t.title)} · ${i + 1}/${t.steps.length}단계</div>
    <div class="run-step">${s.pc ? '💻 ' : ''}${esc(s.text)}</div>
    <div class="timer" id="timer"></div>
    <div class="row"><button class="btn" data-act="run-stop">여기까지</button><button class="btn primary" data-act="step-done" data-i="${i}">✓ 이 단계 끝</button></div>`;
  const tick = () => {
    const left = Math.max(0, run.endAt - Date.now());
    const el = $('#timer'); if (!el) return;
    if (left > 0) el.textContent = `${Math.floor(left / 60000)}:${p2(Math.floor(left / 1000) % 60)}`;
    else { clearInterval(runTimer); el.innerHTML = `5분 지났어요. <button class="link" data-act="run-more">5분 더</button>`; }   // 소리 없이
  };
  tick(); runTimer = setInterval(tick, 1000);
}

// ----- 🧺 정리하기 -----
function drawLog() {
  $('#joy-list').innerHTML = todays('joy').map(e => `<li><span>${esc(e.hm)}</span><b>✨ ${esc(e.payload.text)}</b><span class="state">${e.sent ? '✓' : '…'}</span></li>`).join('');
  $('#log').innerHTML = todays('quick').map(e => `<li><span>${esc(e.hm)}</span><b>${esc(e.payload.text)}</b><span class="state">${e.sent ? '✓' : '…'}</span></li>`).join('');
  const goals = goalsFor(today());
  $('#goals-card').hidden = !goals.length;
  $('#goals').innerHTML = goals.map((g, i) => `<li class="${g.done ? 'done' : ''} ${g.depth ? 'sub' : ''}">
    <input type="checkbox" data-i="${i}" ${g.done ? 'checked' : ''} aria-label="${esc(g.text)}"><span>${esc(g.text)}</span></li>`).join('');
  const all = tasksNow();
  $('#dump-list').innerHTML = (state.dumpIds || []).map(id => all.find(t => t.id === id)).filter(Boolean).map(t => `<li class="dump">
    <b>${esc(t.title)}</b>${t.status !== '열림' ? `<span class="badge">${esc(t.status)}</span>` : `<div class="chips small-chips">
      <button class="chip-btn" data-dump="start" data-tid="${t.id}">▶ 시작하기로</button><button class="chip-btn" data-dump="later" data-tid="${t.id}">나중에</button>
      <button class="chip-btn" data-dump="hold" data-tid="${t.id}">보류</button><button class="chip-btn" data-dump="drop" data-tid="${t.id}">하지 않기</button></div>`}</li>`).join('');
}

// ============ 이벤트 연결 ============
const openFlow = t => {
  state.flow = { isNew: false, tid: t.id, title: t.title, kind: t.kind || guessKind(t.title), obstacle: '', device: 'phone',
    steps: t.steps.length ? t.steps.map(s => ({ ...s })) : buildSteps(t.kind || guessKind(t.title), '', 'phone'), edited: false };
};
$('#btn-back').onclick = () => { location.hash = ''; };
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); draw(); });

$('#main').addEventListener('click', async e => {
  const b = e.target.closest('button, a'); if (!b) return;
  const d = b.dataset;
  // 처음
  if (d.act === 'run') { state.run = { tid: d.tid, endAt: Date.now() + 5 * 60000 }; ls.set('run', state.run); location.hash = '#run'; return; }
  if (d.act === 'redo') { const t = tasksNow().find(x => x.id === d.tid); if (t) { openFlow(t); location.hash = '#start'; } return; }
  // 쉬기
  if (b.closest('#rest-energy')) { state.rest.energy = d.v; drawRest(); return; }
  if (b.closest('#rest-time')) { state.rest.time = +d.v; drawRest(); return; }
  if (d.label) {
    await record('rest-choose', { label: d.label, min: state.rest.time || null });
    ls.set('resting', { label: d.label, min: state.rest.time || null, hm: nowHM() });
    state.rest = {}; drawRest(); return;
  }
  if (d.act === 'rest-end') { ls.set('resting', { ...ls.get('resting'), ending: true }); drawRest(); return; }
  if (d.act === 'rest-close') { ls.set('resting', null); location.hash = ''; return; }
  if (d.felt) { const r = ls.get('resting'); await record('rest-done', { label: r.label, felt: d.felt }); ls.set('resting', null); toast('잘 쉬었어요'); location.hash = ''; return; }
  // 시작하기
  if (d.act === 'flow-new') {
    const title = $('#flow-title').value.trim(); if (!title) return;
    const kind = guessKind(title);
    state.flow = { isNew: true, tid: newTid(), title, kind, obstacle: '', device: 'phone', steps: buildSteps(kind, '', 'phone'), edited: false };
    drawStart(); return;
  }
  const f = state.flow;
  if (f && (d.kind || d.obstacle !== undefined || d.device)) {
    if (d.kind) f.kind = d.kind;
    if (d.obstacle !== undefined) f.obstacle = f.obstacle === d.obstacle ? '' : d.obstacle;
    if (d.device) f.device = d.device;
    if (!f.edited) f.steps = buildSteps(f.kind, f.obstacle, f.device);   // 사람이 고친 뒤에는 덮어쓰지 않는다
    drawStart(); return;
  }
  if (f && d.del !== undefined) { f.steps.splice(+d.del, 1); f.edited = true; drawStart(); return; }
  if (f && d.act === 'step-add') { f.steps.push({ text: '', min: null, done: false }); f.edited = true; drawStart(); document.querySelectorAll('.step-text')[f.steps.length - 1].focus(); return; }
  if (f && d.act === 'flow-cancel') { state.flow = null; drawStart(); return; }
  if (f && d.decide) {
    f.steps = f.steps.filter(s => String(s.text).trim());
    if (d.decide === 'now' || d.decide === 'drop') { await decide(d.decide); return; }
    f.choosing = d.decide; drawStart(); return;
  }
  if (f && d.act === 'choose-back') { f.choosing = null; drawStart(); return; }
  if (f && d.when !== undefined) { const c = f.choosing; f.choosing = null; await decide(c, d.when); return; }
  if (f && d.act === 'when-ok') {
    const c = f.choosing; const v = c === 'later' ? $('#when-time').value : $('#when-date').value;
    if (!v) { toast(c === 'later' ? '시간을 골라 주세요' : '날짜를 골라 주세요'); return; }
    f.choosing = null; await decide(c, v); return;
  }
  if (d.openTask) { const t = tasksNow().find(x => x.id === d.openTask); if (t) { openFlow(t); drawStart(); window.scrollTo(0, 0); } return; }
  // 실행
  if (d.act === 'step-done') { await record('task-step', { tid: state.run.tid, i: +d.i, done: true }); return; }   // record → render → 다음 단계
  if (d.act === 'run-stop') { state.run.reviewing = true; ls.set('run', state.run); drawRun(); return; }
  if (d.act === 'run-more') { state.run.endAt = Date.now() + 5 * 60000; ls.set('run', state.run); drawRun(); return; }
  // 정리하기 — 머릿속 비우기 후 하나씩 고르기
  if (d.dump) {
    const t = tasksNow().find(x => x.id === d.tid); if (!t) return;
    if (d.dump === 'start') { openFlow(t); location.hash = '#start'; return; }
    await record('task-steps', { tid: t.id, steps: buildSteps(t.kind, '', 'phone'), template: t.kind, version: tplOf(t.kind).version, kind: t.kind, edited: false });
    await record('task-decide', { tid: t.id, decision: d.dump, when: '' });
    return;
  }
});
// 단계 문장·분 고치기 (입력 중에는 다시 그리지 않는다)
$('#main').addEventListener('input', e => {
  const f = state.flow; if (!f) return;
  if (e.target.dataset.step !== undefined) { f.steps[+e.target.dataset.step].text = e.target.value; f.edited = true; }
  if (e.target.dataset.min !== undefined) { const m = parseInt(e.target.value, 10); f.steps[+e.target.dataset.min].min = m > 0 ? m : null; f.edited = true; }
});
$('#main').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.target.id === 'flow-title') { e.preventDefault(); document.querySelector('[data-act="flow-new"]').click(); }
  if (e.target.id === 'joy') { e.preventDefault(); $('#btn-joy').click(); }
});

$('#btn-connect').onclick = () => dbx.login();
$('#btn-reconnect').onclick = () => dbx.login();
$('#btn-joy').onclick = async () => {
  const text = $('#joy').value.trim(); if (!text) return;
  await record('joy', { text }); $('#joy').value = ''; toast('✨ 남겼어요');
};
$('#btn-quick').onclick = async () => {
  const text = $('#quick').value.trim(); if (!text) return;
  await record('quick', { text }); $('#quick').value = ''; toast('남겼어요');
};
$('#btn-dump').onclick = async () => {
  const lines = $('#dump').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 15);
  if (!lines.length) return;
  state.dumpIds = state.dumpIds || [];
  for (const title of lines) { const tid = newTid(); state.dumpIds.push(tid); await record('task-add', { tid, title, kind: guessKind(title) }); }
  $('#dump').value = ''; toast(`${lines.length}개를 옮겼어요. 하나씩 골라 보세요`);
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
  $('#settings-info').textContent = `${state.connected ? 'Dropbox 연결됨' : '연결 안 됨'} · ${state.hasKey ? '🔐 암호화 켜짐' : '암호 문구 없음'} · 폰에 있는 기록 ${ev.length}건 (올리지 못한 것 ${ev.filter(e => !e.sent).length}건)` +
    (C.COACH_ROOT ? ` · 테스트 폴더 ${C.COACH_ROOT}` : '') + ` · 앱 ${APP_VERSION}` + (state.snapErr ? ` · 요약: ${state.snapErr}` : '');
  $('#settings').showModal();
};
$('#btn-close').onclick = () => $('#settings').close();
$('#pc-sync').onclick = async () => { $('#pc-sync').textContent = '받는 중…'; await loadSnapshot(); render(); flush(); };
$('#btn-key').onclick = async () => {
  const p = $('#pass').value, p2v = $('#pass2').value;
  if (p.length < 8) { $('#key-msg').textContent = '8자 이상으로 정해 주세요'; return; }
  if (p !== p2v) { $('#key-msg').textContent = '두 칸이 서로 달라요'; return; }
  $('#key-msg').textContent = '열쇠 만드는 중…';
  await idb.set('key', await cryptoBox.derive(p));
  $('#pass').value = $('#pass2').value = ''; $('#key-msg').textContent = '';
  state.hasKey = true; state.rekey = false;
  toast('암호 문구를 정했어요');
  await loadSnapshot(); render(); flush();
};
$('#btn-rekey').onclick = () => { state.rekey = true; $('#settings').close(); draw(); $('#pass').focus(); };
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
  state.rest = {};
  // 개발 서버 전용 미리보기: localhost/?demo → 같은 폴더의 demo-snapshot.json으로 화면만 그린다 (공개 주소에서는 꺼짐)
  if (C.COACH_ROOT && new URLSearchParams(location.search).has('demo')) {
    state.snap = await (await fetch('demo-snapshot.json')).json();
    state.connected = true; state.hasKey = true; state.events = [];
    // 화면 확인용: ?demo&flow=제목&ob=막막함&choose=later · ?demo&rest=low-10 · ?demo&run=t_demo1
    const q = new URLSearchParams(location.search);
    if (q.get('flow')) { const k = guessKind(q.get('flow')); state.flow = { isNew: true, tid: 't_demoX', title: q.get('flow'), kind: k, obstacle: q.get('ob') || '', device: 'phone', steps: buildSteps(k, q.get('ob') || '', 'phone'), edited: false, choosing: q.get('choose') || null }; }
    if (q.get('rest')) { const [en, tm] = q.get('rest').split('-'); state.rest = { energy: en, time: +tm }; }
    if (q.get('run')) state.run = { tid: q.get('run'), endAt: Date.now() + 5 * 60000 };
    draw(); return;   // 미리보기는 IndexedDB를 기다리지 않고 바로
  }
  const justLoggedIn = await dbx.finishLogin();
  state.connected = !!(await idb.get('auth'));
  state.hasKey = !!(await idb.get('key'));
  if (justLoggedIn) { await record('hello', { ua: navigator.userAgent.slice(0, 80) }); toast('Dropbox에 연결됐어요'); }   // 앱 폴더가 이때 생긴다
  render();
  await loadSnapshot();
  render();
  flush();
  prune();
})();
