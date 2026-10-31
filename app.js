// SH 코치 (coach-pwa) — PC 없이 폰에서 쓰는 실행·회복 코치.
// 데이터: Dropbox 앱 폴더(Apps/sh-coach)에 이벤트 파일을 올리고, PC가 써 둔 snapshot.json을 읽는다.
// 폰 안에는 IndexedDB(kv: 토큰·스냅샷 / events: 내가 남긴 기록과 업로드 여부)만 둔다.
// PRD: sh_wiki/tasks/prd-mobile-coach-pwa.md (단계 1 기반 + 단계 2 화면: 쉬기·시작하기·정리하기)
'use strict';

const C = window.COACH_CONFIG;
const APP_VERSION = 'v21';   // sw.js의 VERSION과 함께 올린다 — 설정 창에 보여서 폰이 새 버전인지 확인할 수 있다
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
// 한 번에 여러 건(add·steps·decide)을 남겨도 시각이 겹치지 않게 1ms씩 민다 — 같은 초 + 무작위 이름이면 PC가 순서를 뒤섞었다
let lastTs = 0;
async function record(type, payload = {}) {
  const now = new Date(lastTs = Math.max(Date.now(), lastTs + 1));
  const id = randStr(9).replace(/[^A-Za-z0-9]/g, 'x');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');   // 20261019T121055123Z — 이름순 = 시간순 (밀리초까지)
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

// ============ 알람 · 타이머 (PRD: tasks/prd-coach-log-tabs-timer-alarm.md) ============
// 웹앱은 화면에 떠 있을 때만 울릴 수 있다 → 타이머가 도는 동안 Wake Lock으로 화면을 켜 둔다. 진동은 안드로이드만.
const ALARM = { freq: 880, beepMs: 250, gapMs: 150, beeps: 3, rounds: 2, pauseMs: 1000, vibrate: [400, 200, 400, 200, 400] };
const LAUNCH = { count: 5, delaySec: 10, nudgeAfter: 3 };   // 5초 시작 카운트다운 · 미루기 10초 · 3번째 미루기부터 "더 작게" 제안
const LATE_MS = 5000;   // 앱 밖에 있다 돌아왔을 때 이만큼 지난 알람은 울리지 않고 끝난 화면만 보여 준다
const PRAISE = {
  quick: ['잘했어요! 시작이 제일 어려운 거예요', '바로 시작했네요 👏', '좋아요, 5분만 가요'],
  late: ['미뤘다가도 시작했어요. 그게 진짜예요', '돌아왔네요, 잘했어요'],
};
const pick = list => list[Math.floor(Math.random() * list.length)];

// ============ 폰 푸시 (ntfy) — PRD: tasks/prd-selfcare-promise-push.md ============
// PC·앱이 꺼져 있어도 오도록 ntfy.sh 서버에 예약 발송을 맡긴다. 알림을 보내고 지우는 일은 이 객체만 한다
// (나중에 Firebase 등으로 바꿀 때 여기만 고친다). 본문은 공용 서버를 평문으로 지나므로 종류·첫 동작만 넣는다.
// JSON 발행에서 예약 시각은 `delay` 칸(Unix 초 문자열) — `at`은 무시되고 바로 보내진다(2026-10-25 확인).
const NTFY = { base: 'https://ntfy.sh', topicLen: 24, click: 'https://kwonsuhyeon.github.io/sh-coach/' };
const push = {
  topic() { return (ls.get('ntfy.topic') || '').trim(); },
  newTopic() { const a = 'abcdefghijklmnopqrstuvwxyz0123456789', r = crypto.getRandomValues(new Uint8Array(NTFY.topicLen)); return 'shc-' + Array.from(r, b => a[b % a.length]).join(''); },
  // at: Date 또는 ms(없으면 바로) · 돌려주는 값: 메시지 id (취소에 쓴다)
  async send({ title, message, at, priority = 3, tags = [], click = NTFY.click }) {
    const topic = push.topic(); if (!topic) throw new Error('ntfy 주제 이름이 없어요');
    const body = { topic, title, message, priority, tags, click };
    if (at) body.delay = String(Math.floor(+at / 1000));
    const r = await fetch(NTFY.base + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('ntfy ' + r.status);
    return (await r.json()).id;
  },
  async cancel(id) {
    const topic = push.topic(); if (!topic || !id) return;
    await fetch(`${NTFY.base}/${encodeURIComponent(topic)}/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  },
};
const fmt = ms => `${Math.floor(ms / 60000)}:${p2(Math.floor(ms / 1000) % 60)}`;
const alarmOpt = () => ({ sound: ls.get('alarm.sound') !== false, vibe: ls.get('alarm.vibe') !== false });

// AudioContext는 사용자가 누른 순간에 만들어야 소리가 난다 → #main 클릭마다 unlockAudio()
let actx = null;
function unlockAudio() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {}
}
// notes: [[주파수, 시작(초), 길이(초)], …]
function chime(notes) {
  if (!alarmOpt().sound) return;
  unlockAudio(); if (!actx) return;
  const t0 = actx.currentTime + 0.02;
  for (const [freq, at, dur] of notes) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    o.connect(g).connect(actx.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
  }
}
function buzz(pattern) { if (alarmOpt().vibe && navigator.vibrate) navigator.vibrate(pattern); }
function alarm() {
  const step = (ALARM.beepMs + ALARM.gapMs) / 1000, round = ALARM.beeps * step + ALARM.pauseMs / 1000, notes = [];
  for (let r = 0; r < ALARM.rounds; r++) for (let b = 0; b < ALARM.beeps; b++) notes.push([ALARM.freq, r * round + b * step, ALARM.beepMs / 1000]);
  chime(notes); buzz(ALARM.vibrate);
}
const countFx = () => { chime([[660, 0, 0.05]]); buzz(60); };              // 카운트다운 숫자가 줄 때
const rewardFx = () => { chime([[660, 0, 0.15], [990, 0.15, 0.2]]); buzz([80, 60, 80]); };   // 시작 보상 (상승 두 음)

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });   // 화면을 벗어나면 브라우저가 푼다 → 돌아오면 clock()이 다시 요청
    } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch { wakeLock = null; }
}
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
const baseTemplates = () => (state.snap && state.snap.templates && state.snap.templates.length ? state.snap.templates : FALLBACK_TEMPLATES);
// 활동 첫 동작 사전(wiki/coach/activities.md) — 제목에 키워드가 있으면 일반 템플릿보다 먼저 쓴다
const activities = () => (state.snap && state.snap.activities) || [];
const actTemplates = () => activities().map(a => ({ id: 'a-' + a.id, version: a.version, name: a.name, keywords: a.keywords, steps: a.steps, small: a.small, obstacles: {}, act: true }));
const templates = () => [...actTemplates(), ...baseTemplates()];
const tplOf = id => templates().find(t => t.id === id) || templates().find(t => t.id === 'other') || templates()[0];
function guessKind(title) {
  const low = title.toLowerCase();
  for (const t of templates()) if ((t.keywords || []).some(k => k && low.includes(String(k).toLowerCase()))) return t.id;
  return 'other';
}
// 템플릿 → 첫 행동 목록. 장애물을 고르면 그 줄을 맨 앞에, 폰만 있으면 PC 단계는 뒤로 ("💻 PC 켤 때")
function buildSteps(kind, obstacle, device) {
  const t = tplOf(kind);
  let steps = t.steps.map(s => ({ text: s.text, min: s.min, pc: !!s.pc, done: false }));
  if (t.act && t.small && obstacle === '피곤함') steps = [{ ...t.small, pc: !!t.small.pc, done: false }];   // 피곤하면 "작게"만
  const o = obstacle && t.obstacles && t.obstacles[obstacle];
  if (o) steps.unshift({ text: o.text, min: o.min, pc: false, done: false });
  if (device === 'phone') steps = [...steps.filter(s => !s.pc), ...steps.filter(s => s.pc)];
  return steps;
}
// 이어서 할 일 — 지금 진행 중이거나, 다시 볼 날이 된 것
// 다시 보여 줄 시각 (ms). "HH:MM" = 정한 날의 그 시각 · "날짜 HH:MM" = 그때 · "날짜" = 그날(3시 컷오프) 0시부터 · 없으면 바로
function dueAt(t) {
  const w = String(t.when || '');
  if (/^\d{2}:\d{2}$/.test(w)) { const d = new Date(t.decidedTs || Date.now()); d.setHours(+w.slice(0, 2), +w.slice(3), 0, 0); return d.getTime(); }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(w)) return new Date(w.replace(' ', 'T') + ':00').getTime();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w <= today() ? 0 : Infinity;
  return 0;
}
// 이어서 할 일 — 지금 진행 중이거나, 정한 시각·날짜가 된 것 (그 전에는 처음 화면에 띄우지 않는다)
function dueTasks() {
  const now = Date.now();
  const rank = { 진행: 0, '오늘 나중에': 1, 예약: 2, 보류: 3 };
  return openTasks().filter(t => t.status === '진행' || (t.status in rank && (t.status === '오늘 나중에' || t.when) && dueAt(t) <= now))
    .sort((a, b) => rank[a.status] - rank[b.status] || String(a.when || '').localeCompare(String(b.when || '')));
}
// 아직 때가 안 된 예약 — 처음 화면에 "다음 예약" 한 줄로만
const upcomingTasks = () => openTasks().filter(t => ['오늘 나중에', '예약', '보류'].includes(t.status) && t.when && dueAt(t) > Date.now())
  .sort((a, b) => String(a.when).localeCompare(String(b.when)));
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

// ============ 💚 나와의 약속 — PRD: tasks/prd-selfcare-promise-push.md US-004 ============
// 종류·요일·기본 창은 PC wiki/coach/selfcare.md(요약 selfcare). 아침에 한 번 [이대로 약속하기] → promise-set 이벤트.
// 21시 뒤(새벽 3시 전까지)에는 같은 카드가 "내일의 약속"으로 뜬다. 지키지 못한 약속에는 아무 표시도 하지 않는다.
const PROMISE = { stepMin: 30, eveningH: 21, firstMin: 5 * 60, lastMin: 23 * 60 + 30 };
const CARE_CHIPS = [['점심 뒤', '13:00', '14:00'], ['퇴근 길', '18:00', '19:00'], ['저녁', '19:30', '21:00'], ['자기 전', '22:00', '23:00']];
const selfcare = () => (state.snap && state.snap.selfcare) || [];
const kindOf = id => (/^research\d*$/.test(id) ? researchKind() : selfcare().find(c => c.id === id));

// ============ 🏫 학교 날 — PRD: tasks/prd-school-day-rhythm.md US-101~103 ============
// 날 종류는 PC wiki/coach/daytypes.md(요약 daytypes). 학교 가는 요일에는 [🚌 셔틀] [🚗 차]를 묻고 기본은 셔틀(호호 결정 2026-10-28).
// 셔틀이면 그 요일의 연구 블록을 📄 약속으로 깔고 확정하지 않아도 알림을 건다. 차면 회복 날 — 연구를 안 해도 아무 표시도 없다.
// 연구 블록은 promise-set에 넣지 않는다(셔틀/차만으로 정해진다). 시간을 바꾸려면 daytypes.md를 고친다.
const daytypes = () => (state.snap && state.snap.daytypes) || null;
const dayType = date => { const dt = daytypes(); return (dt && dt.days && dt.days[wdOf(date)]) || null; };   // 학교 가는 요일만
const researchKind = () => ({ id: 'research', name: '논문 읽기', emoji: '📄', ...((daytypes() || {}).research || {}) });
function moveOf(date) {
  const ev = state.events.filter(e => e.type === 'day-move' && e.payload.date === date).sort((a, b) => b.ts - a.ts)[0];
  return ev ? ev.payload.move : 'shuttle';
}
const moveChosen = date => state.events.some(e => e.type === 'day-move' && e.payload.date === date);
function researchPromises(date, move = moveOf(date)) {
  const dt = dayType(date); if (!dt || move !== 'shuttle') return [];
  const k = researchKind();
  return (dt.blocks || []).map((b, i) => ({ id: `${date}-research${i ? i + 1 : ''}`, kind: 'research', date, start: b.start, end: b.end,
    firstStep: (k.first && k.first.text) || '', small: (k.small && k.small.text) || '' }));
}
function dayBar(date) {
  const dt = dayType(date); if (!dt) return '';
  const mv = moveOf(date), cd = (daytypes() || {}).car || { name: '회복 날', emoji: '🌙', success: '다녀오기 + 쉼 하나' }, k = researchKind();
  const info = mv === 'car' ? `${cd.emoji} ${cd.name} · ${cd.success}` : `${dt.emoji} ${dt.name}${dt.success ? ` · 성공: ${dt.success}` : ''}`;
  const blocks = researchPromises(date).map(p => `${k.emoji} ${k.name} ${p.start}~${p.end}`).join(' · ');
  return `<div class="p-day"><div class="chips small-chips">${[['shuttle', '🚌 셔틀'], ['car', '🚗 차']].map(([m, l]) =>
    `<button class="chip-btn ${mv === m ? 'on' : ''}" data-pmove="${m}" data-pd="${date}">${l}</button>`).join('')}</div>
    <p class="small p-dayinfo">${esc(info)}</p>${blocks ? `<p class="muted small">${esc(blocks)}</p>` : ''}</div>`;
}
const wdOf = date => new Date(date + 'T12:00:00').getDay();
const isEvening = () => { if (state.demoEve) return true; const h = new Date().getHours(); return h >= PROMISE.eveningH || h < C.DAY_CUTOFF_H; };
const nowDayMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + (d.getHours() < C.DAY_CUTOFF_H ? 1440 : 0); };   // 새벽은 어제의 연장
// 그날 확정한 약속 = 그날을 가리키는 가장 최근 promise-set (PC 병합 전에도 폰 기록 그대로 — US-014 전까지 PC는 이 이벤트를 읽지 않는다)
function promiseSet(date) {
  const ev = state.events.filter(e => e.type === 'promise-set' && e.payload.date === date).sort((a, b) => b.ts - a.ts)[0];
  return ev ? ev.payload : null;
}
// 카드에서 고치는 중인 값 — 확정한 날이면 그 약속에서, 아니면 요일 기본값에서 시작한다
function promiseDraft(date) {
  const drafts = state.pdrafts || (state.pdrafts = {});
  if (drafts[date]) return drafts[date];
  const set = promiseSet(date);
  const rows = selfcare().filter(c => c.days.includes(wdOf(date))).map(c => {
    const p = set && set.promises.find(x => x.kind === c.id);
    return { kind: c.id, start: p ? p.start : c.start, end: p ? p.end : c.end, off: !!set && !p, open: false };
  });
  return (drafts[date] = { date, rows });
}
function timeOptions(cur) {
  const list = []; for (let m = PROMISE.firstMin; m <= PROMISE.lastMin; m += PROMISE.stepMin) list.push(minHm(m));
  if (cur && !list.includes(cur)) list.push(cur), list.sort();   // selfcare.md에 17:15처럼 적었어도 그대로 고를 수 있게
  return list.map(t => `<option ${t === cur ? 'selected' : ''}>${t}</option>`).join('');
}
// 주제 이름이 없으면 약속 알림이 하나도 안 걸린다 → 확정한 카드에 늘 보이게 (2026-10-28 폰 저장소가 비어 알림이 안 왔다)
const pushOffNote = () => (push.topic() ? '' : `<p class="small p-pushoff">🔕 폰 알림이 꺼져 있어요 · <button class="link small" data-act="open-settings">설정에서 ntfy 주제 넣기</button></p>`);
function promiseCard(date) {
  const label = date === today() ? '오늘' : '내일';
  const set = promiseSet(date);
  if (set && state.pedit !== date) {
    const ps = [...set.promises, ...researchPromises(date)].sort((a, b) => a.start.localeCompare(b.start));
    const emo = p => (kindOf(p.kind) || {}).emoji || '💚';
    let line = ps.length ? `💚 ${label === '오늘' ? '' : '내일 '}약속 ${ps.length}개` : `💚 ${label}은 약속 없이 가요`;
    if (ps.length && label === '내일') line += ` · 첫 ${emo(ps[0])} ${ps[0].start}`;
    else if (ps.length) line = `💚 오늘 약속 ${ps.filter(p => promiseStatus(p).s === 'done').length}/${ps.length}`;
    return `<section class="card promise folded"><div class="next-head"><span>${esc(line)}</span>
      <button class="link small" data-act="promise-edit" data-date="${date}">다시 정하기</button></div>${dayBar(date)}${promiseRows(date, ps)}${ps.length ? pushOffNote() : ''}</section>`;
  }
  const d = promiseDraft(date);
  if (!d.rows.length) return dayType(date) ? `<section class="card promise"><h2>💚 ${label}의 약속</h2>${dayBar(date)}${promiseRows(date, researchPromises(date))}${researchPromises(date).length ? pushOffNote() : ''}</section>` : '';
  const on = d.rows.map((r, i) => [r, i]).filter(([r]) => !r.off), off = d.rows.map((r, i) => [r, i]).filter(([r]) => r.off);
  const row = ([r, i]) => {
    const c = kindOf(r.kind) || { name: r.kind, emoji: '💚' };
    const step = c.first ? `첫 동작: ${c.first.text}` : '';
    return `<div class="p-row">
      <div class="p-head"><b>${esc(c.emoji)} ${esc(c.name)}</b>
        ${r.start ? `<button class="p-win ${r.open ? 'on' : ''}" data-pwin="${i}" data-pd="${date}" aria-label="${esc(c.name)} 시간 바꾸기">${r.start}~${r.end}</button>` : ''}</div>
      ${r.start ? '' : `<p class="muted small p-ask">언제 할까요?</p><div class="chips small-chips">${CARE_CHIPS.map(([n, s, e], k) =>
        `<button class="chip-btn" data-pcare="${i}" data-pd="${date}" data-k="${k}">${n} <span class="muted">${s}</span></button>`).join('')}</div>`}
      ${r.open ? `<div class="p-edit"><select class="field" data-pstart="${i}" data-pd="${date}" aria-label="시작">${timeOptions(r.start)}</select><span>~</span>
        <select class="field" data-pend="${i}" data-pd="${date}" aria-label="끝">${timeOptions(r.end)}</select></div>` : ''}
      <div class="p-sub"><span class="muted small">${esc(step)}</span><button class="link small" data-poff="${i}" data-pd="${date}">${label}은 빼기</button></div></div>`;
  };
  return `<section class="card promise"><h2>💚 ${label}의 약속</h2>${dayBar(date)}${promiseRows(date, researchPromises(date))}
    ${on.length ? on.map(row).join('') : `<p class="muted small">${label}은 약속 없이 가도 괜찮아요.</p>`}
    ${off.length ? `<p class="muted small p-off">뺀 것: ${off.map(([r, i]) => `<button class="link small" data-pon="${i}" data-pd="${date}">${esc((kindOf(r.kind) || {}).emoji || '')} ${esc((kindOf(r.kind) || {}).name || r.kind)} 다시 넣기</button>`).join(' · ')}</p>` : ''}
    <div class="row ${state.pedit === date ? 'two' : ''}">${state.pedit === date ? `<button class="btn" data-act="promise-cancel" data-date="${date}">그대로 두기</button>` : ''}
      <button class="btn primary p-ok" data-act="promise-ok" data-date="${date}">이대로 약속하기</button></div></section>`;
}
// 처음 화면 맨 위 — 낮에는 오늘 카드, 21시 뒤에는 (오늘 약속 한 줄 +) 내일 카드
function drawPromises() {
  autoSavePrun();
  const box = $('#promise-box');
  if (!selfcare().length && !daytypes()) { box.innerHTML = ''; return; }
  const t = today();
  box.innerHTML = prunBanner() + stepsLine() + (isEvening() ? (promiseSet(t) ? promiseCard(t) : '') + promiseCard(addDaysStr(t, 1)) : promiseCard(t));
}
// clock()이 15초마다 바뀌었는지 본다 — 시간이 지나 창이 열리거나 닫히면 줄이 바뀐다
function promiseHomeKey() {
  const t = today();
  return [...((promiseSet(t) || {}).promises || []), ...researchPromises(t)].map(p => `${p.id}:${promiseStatus(p).s}`).join();
}
async function confirmPromises(date) {
  const d = promiseDraft(date), rows = d.rows.filter(r => !r.off);
  const miss = rows.find(r => !r.start);
  if (miss) { toast(`${(kindOf(miss.kind) || {}).name || '약속'}은 언제 할지 골라 주세요`); return; }
  const promises = rows.map(r => {
    const c = kindOf(r.kind) || {};
    return { id: `${date}-${r.kind}`, kind: r.kind, date, start: r.start, end: r.end, firstStep: (c.first && c.first.text) || '', small: (c.small && c.small.text) || '' };
  });
  await record('promise-set', { date, promises });
  delete state.pdrafts[date]; state.pedit = null;
  toast(!promises.length ? '💚 오늘은 약속 없이 가요' : push.topic() ? `💚 약속 ${promises.length}개를 잡았어요` : `💚 약속 ${promises.length}개를 잡았어요 · 폰 알림은 꺼져 있어요`);
  syncPromisePush();
}

// ============ 💚 약속 푸시 예약 — PRD US-005 ============
// 약속 하나에 ntfy 예약 4건: 창 열림 · 창 중간(창이 1시간 이상일 때) · 마감 30분 전 · 마감 10분 전.
// localStorage promisePush = { 약속id: { sig: '날짜 시작-끝', ids: [ntfy 메시지 id] } }.
// 확정한 약속과 맞춰 보는 방식(reconcile)이라 시간을 바꾸거나 빼면 옛 예약을 지우고 다시 건다.
// 오프라인이거나 보내기에 실패하면 저장하지 않고 두었다가 online·앱 열림 때 다시 맞춘다. 지난 시각은 걸지 않는다.
const PUSH_LEAD_MS = 15 * 1000;   // ntfy 예약은 최소 10초 뒤부터 받는다
const PUSH_MAX_MS = 71 * 3600 * 1000;   // ntfy 예약은 최대 3일 뒤까지 — 앱을 열 때마다 앞으로 3일 치를 다시 맞춘다
function promiseAlarms(p) {
  const c = kindOf(p.kind) || {}, emo = c.emoji || '💚', name = c.name || '약속';
  const at = hm => new Date(`${p.date}T${hm}:00`).getTime();
  const s = at(p.start), e = at(p.end), win = (e - s) / 60000;
  const first = p.firstStep || (c.first && c.first.text) || '', small = p.small || (c.small && c.small.text) || first;
  const fMin = c.first && c.first.min ? ` (${c.first.min}분)` : '', sMin = c.small && c.small.min ? ` (${c.small.min}분)` : '';
  const list = [{ t: s, priority: 3, title: `${emo} ${name} 창이 열렸어요`, message: `첫 동작: ${first}${fMin} · ${p.end}까지` }];
  if (win >= 60) list.push({ t: s + (e - s) / 2, priority: 3, title: `${emo} ${name} · ${p.end}까지`, message: `첫 동작: ${first}${fMin}` });
  list.push({ t: e - 30 * 60000, priority: 4, title: `${emo} ${name} · 30분 남았어요`, message: `작게: ${small}${sMin}` });
  list.push({ t: e - 10 * 60000, priority: 5, title: `${emo} ${name} · 10분 남았어요`, message: `작게: ${small}${sMin}` });
  // 창이 짧으면 중간·30분 전이 겹친다(60분 창은 둘 다 30분 지점) → 10분 안에 뒤 알림이 있으면 앞 것을 뺀다
  return list.filter((a, i) => (i === 0 || a.t > s) && !list.slice(i + 1).some(b => b.t - a.t < 10 * 60000)
    && a.t > Date.now() + PUSH_LEAD_MS && a.t < Date.now() + PUSH_MAX_MS);
}
// US-103: 다음 날이 학교 가는 요일이고 아직 셔틀/차를 안 골랐으면 그 전날 밤 23:00에 한 번 묻는다. 안 고르면 셔틀 그대로
function quietAlarm(p, startedAt) {   // US-006: 시작한 뒤 남는 알림 한 건
  const k = kindOf(p.kind) || {}, t = Math.max(new Date(`${p.date}T${p.end}:00`).getTime(), startedAt + 90 * 60000);
  if (t <= Date.now() + PUSH_LEAD_MS || t >= Date.now() + PUSH_MAX_MS) return [];
  return [{ t, priority: 2, title: `${k.emoji || '💚'} ${k.name || '약속'} 하는 중`, message: '끝났으면 [종료했어요]만 눌러 주세요' }];
}
const MOVE_ASK_HM = '23:00';
function moveAlarms(date) {   // date = 학교 가는 날
  const dt = dayType(date), t = new Date(`${addDaysStr(date, -1)}T${MOVE_ASK_HM}:00`).getTime();
  if (t <= Date.now() + PUSH_LEAD_MS || t >= Date.now() + PUSH_MAX_MS) return [];
  return [{ t, priority: 3, title: '🚌 내일은 셔틀 기본이에요', message: `차 탈 거면 눌러서 바꿔 주세요 · 내일 ${dt.emoji} ${dt.name}`, tags: ['bus'] }];
}
let pushSyncing = null;
function syncPromisePush() {
  if (pushSyncing) return pushSyncing.then(() => syncPromisePush());   // 겹쳐 돌면 같은 알림이 두 번 걸린다
  return (pushSyncing = (async () => {
    if (!push.topic() || !navigator.onLine || state.demo) return;
    const t = today(), events = await idb.events();
    // want = { 예약id: { date, sig, alarms, click } } — 약속(오늘~사흘 뒤 promise-set) + 셔틀 날 연구 블록 + 전날 밤 셔틀/차 알림
    const want = {}, last = (type, date) => events.filter(e => e.type === type && e.payload.date === date).sort((x, y) => y.ts - x.ts)[0];
    for (const date of [0, 1, 2, 3].map(n => addDaysStr(t, n))) {
      const set = last('promise-set', date), mv = last('day-move', date);
      for (const p of [...(set ? set.payload.promises : []), ...researchPromises(date, mv ? mv.payload.move : 'shuttle')]) {
        const byId = type => events.filter(e => e.type === type && e.payload.id === p.id).sort((x, y) => y.ts - x.ts)[0];
        const st = byId('promise-start');
        if (byId('promise-end')) continue;   // 끝낸 약속 — 남은 알림을 모두 지운다
        want[p.id] = st ? { date, sig: 'started', alarms: () => quietAlarm(p, st.payload.at), click: `#promise/${p.id}` }
          : { date, sig: `${p.date} ${p.start}-${p.end}`, alarms: () => promiseAlarms(p), click: `#promise/${p.id}` };
      }
      if (dayType(date) && !mv && date > t) want[`move-${date}`] = { date, sig: 'move', alarms: () => moveAlarms(date), click: `#move/${date}` };
    }
    const saved = ls.get('promisePush') || {};
    for (const id of Object.keys(saved)) {
      const w = want[id];
      if (w && saved[id].sig === w.sig) continue;
      if (!w && (saved[id].date || id.slice(0, 10)) < t) { delete saved[id]; continue; }   // 지난 날 알림은 ntfy가 이미 보냈다
      for (const mid of saved[id].ids) await push.cancel(mid);
      delete saved[id]; ls.set('promisePush', saved);
    }
    for (const [id, w] of Object.entries(want)) {
      if (saved[id]) continue;
      const alarms = w.alarms();
      if (!alarms.length) continue;   // 다 지났거나 아직 3일 밖 — 다음에 열 때 다시 본다
      const ids = [];
      try {
        for (const x of alarms) ids.push(await push.send({ title: x.title, message: x.message, at: x.t, priority: x.priority, tags: x.tags || ['green_heart'], click: NTFY.click + w.click }));
      } catch (err) {
        for (const mid of ids) await push.cancel(mid);   // 반쯤 걸린 예약은 지우고 다음에 통째로 다시
        console.warn('약속 푸시 예약 실패', err); return;
      }
      saved[id] = { date: w.date, sig: w.sig, ids }; ls.set('promisePush', saved);
    }
    ls.set('promisePush', saved);
  })().finally(() => { pushSyncing = null; }));
}

// ============ 화면 그리기 ============
const VIEWS = { '': '지금 무엇이 필요할까?', rest: '🌿 쉬기', start: '▶ 시작하기', paper: '📚 오늘의 논문', log: '🧺 정리하기', run: '지금 5분', prun: '💚 약속' };
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
// ⚡ 기록 탭 — 고른 탭의 접두어를 줄 앞에 붙여 quick 이벤트로 보낸다 (PC applyQuick이 접두어로 섹션을 고른다)
const QUICK_TABS = {
  한: { label: '한 일', ph: '목록에 없는 것 — 연구 30', hint: '체크하고 분을 고르거나, 없는 건 적어요' },
  밥: { label: '밥', ph: '점심 김치찌개', hint: '끼니와 메뉴' },
  몸: { label: '몸', ph: '', hint: '누르고 남기기 — 바꾼 값만 저장돼요' },
  목표: { label: '목표', ph: '산책 20분', hint: '🎯 오늘 목표에 바로 추가돼요' },
};
const QUICK_RE = /^(한|밥|몸|목표|메모)\s*[:：]?\s+(.+)$/;   // server.js applyQuick과 같은 규칙
const quickTab = () => (ls.get('quickTab') in QUICK_TABS ? ls.get('quickTab') : '한');
function quickLines(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .map(l => { const m = l.match(QUICK_RE); return m ? { kind: m[1], text: m[2].trim() } : { kind: '메모', text: l }; });
}

// ✅ 한 일 체크리스트 (앱 v20, 호호 "한 일 입력이 불편해") — 오늘 약속·자주 한 활동을 체크로 남긴다.
// 체크 → 분 버튼 → did {act, min} · 체크 풀기 → did-undo {act} (PC가 같은 활동명의 마지막 줄을 지운다)
const PROMISE_ACT = { log: '기록', gym: '운동', study: '공부', research: '논문' };
const promiseActOf = r => PROMISE_ACT[r.kind] || (r.kind === 'care' ? '나를 아끼는 시간' : (kindOf(r.kind) || {}).name || '약속');   // server coach-promises.js와 같은 이름
const DID_MINS = [15, 30, 60, 90, 120];
function didNow(date) {   // 스냅샷의 한 일 + PC가 아직 반영하지 않은 내 기록
  const day = state.snap && state.snap.days && state.snap.days[date];
  const list = ((day && day.did) || []).map(x => ({ ...x }));
  for (const e of pendingEvents(['did', 'did-undo', 'quick']).filter(e => e.date === date)) {
    if (e.type === 'did') list.push({ act: e.payload.act, min: e.payload.min || null });
    else if (e.type === 'did-undo') { const i = list.map(x => x.act).lastIndexOf(e.payload.act); if (i >= 0) list.splice(i, 1); }
    else for (const l of quickLines(e.payload.text)) if (l.kind === '한') {
      const m = l.text.match(/^(.*\S)\s+(\d{1,4})$/); list.push(m ? { act: m[1], min: +m[2] } : { act: l.text, min: null });
    }
  }
  return list;
}
function drawDidList() {
  const el = $('#did-list');
  el.hidden = quickTab() !== '한'; if (el.hidden) return;
  const date = today(), done = didNow(date);
  const fromPromises = [...((promiseSet(date) || {}).promises || []), ...researchPromises(date)].map(x => PROMISE_ACT[x.kind]).filter(Boolean);
  // 끝낸 약속은 한 일에 체크된 채 보이기만 한다 — did를 만들지 않아 같은 시간이 두 번 집계되지 않는다 (US-208)
  const kept = promiseResults().filter(r => r.date === date), keptActs = kept.map(promiseActOf);
  const acts = [...new Set([...done.map(x => x.act), ...fromPromises, ...((state.snap && state.snap.acts) || [])])]
    .filter(a => !keptActs.includes(a) || done.some(x => x.act === a) || state.didPick === a);
  el.innerHTML = kept.map(r => `<li class="done p-kept"><input type="checkbox" checked data-pact="1" aria-label="${esc(promiseActOf(r))} 약속 기록">
    <span>${esc(promiseActOf(r))}${r.min ? ` <span class="muted small">${r.min}분</span>` : ''} ✓ 💚</span></li>`).join('') + acts.map(act => {
    const mine = done.filter(x => x.act === act), mins = mine.map(x => x.min).filter(Boolean);
    return `<li class="${mine.length ? 'done' : ''}"><input type="checkbox" data-did="${esc(act)}" ${mine.length || state.didPick === act ? 'checked' : ''} aria-label="${esc(act)}">
      <span>${esc(act)}${mins.length ? ` <span class="muted small">${mins.map(m => m + '분').join(' · ')}</span>` : ''}</span>
      ${state.didPick === act ? `<div class="chips small-chips did-mins">${['', ...DID_MINS].map(m =>
        `<button class="chip-btn" data-didmin="${m}" data-act-name="${esc(act)}">${m ? m + '분' : '분 없이'}</button>`).join('')}</div>` : ''}</li>`;
  }).join('');
}

// 💪 몸 탭 — 입력할 값이 정해져 있어서 글 대신 버튼·숫자 칸으로 받고, 바뀐 값만 body 이벤트로 보낸다 (PC는 op set)
const BODY_KEYS = ['energy', 'mood', 'weight', 'water', 'steps'];
const BODY_OK = { weight: /^\d{2,3}(\.\d)?$/, steps: /^\d{1,6}$/ };   // server.js BODY_FIELDS와 같은 규칙
function parseBodyText(text) {   // server.js parseBody와 같은 규칙 (quick의 "몸 …" 줄)
  const out = {};
  for (const [re, k] of [[/(?:체력|에너지)\s*([1-5])/, 'energy'], [/기분\s*([1-5])/, 'mood'], [/(?:몸무게|체중)\s*(\d{2,3}(?:\.\d)?)/, 'weight'], [/물\s*(\d{1,2})/, 'water'], [/걸음\s*(\d{1,6})/, 'steps']]) {
    const m = String(text).match(re); if (m) out[k] = m[1];
  }
  return out;
}
// 오늘 몸 상태 = 스냅샷 값 + PC가 아직 반영하지 않은 내 기록
function bodyNow(date) {
  const day = state.snap && state.snap.days && state.snap.days[date];
  const b = Object.fromEntries(BODY_KEYS.map(k => [k, String((day && day.body && day.body[k]) || '')]));
  for (const e of pendingEvents(['body', 'quick']).filter(e => e.date === date)) {
    if (e.type === 'body') { for (const k of BODY_KEYS) if (e.payload[k] != null && e.payload[k] !== '') b[k] = String(e.payload[k]); }
    else for (const l of quickLines(e.payload.text)) if (l.kind === '몸') Object.assign(b, parseBodyText(l.text));
  }
  return b;
}
const bodyText = p => [p.energy && `체력 ${p.energy}`, p.mood && `기분 ${p.mood}`, p.weight && `몸무게 ${p.weight}kg`, p.water && `물 ${p.water}잔`, p.steps && `걸음 ${p.steps}`].filter(Boolean).join(' · ');
function readBodyInputs() {
  if (!state.body) return;
  for (const k of ['weight', 'steps']) { const el = $('#body-' + k); if (el) state.body[k] = el.value.trim(); }
}
function drawBodyForm() {
  const b = state.body || (state.body = bodyNow(today()));
  const scale = (k, label) => `<div class="body-row"><span class="body-k">${label}</span><div class="chips">${[1, 2, 3, 4, 5].map(n =>
    `<button class="chip-btn num ${b[k] === String(n) ? 'on' : ''}" data-body="${k}" data-n="${n}">${n}</button>`).join('')}</div></div>`;
  $('#body-form').innerHTML = `${scale('energy', '체력')}${scale('mood', '기분')}
    <div class="body-row"><span class="body-k">몸무게</span><input class="field body-in" id="body-weight" inputmode="decimal" placeholder="68.5" value="${esc(b.weight)}"><span class="muted small">kg</span></div>
    <div class="body-row"><span class="body-k">물</span><button class="chip-btn num" data-water="-1" aria-label="물 한 잔 빼기">−</button>
      <b class="water">${+b.water || 0}잔</b><button class="chip-btn num" data-water="1" aria-label="물 한 잔 더">+</button></div>
    <div class="body-row"><span class="body-k">걸음</span><input class="field body-in" id="body-steps" inputmode="numeric" placeholder="8000" value="${esc(b.steps)}"></div>`;
}
async function saveBody() {
  readBodyInputs();
  const cur = bodyNow(today()), b = state.body || cur, diff = {};
  for (const k of BODY_KEYS) if (b[k] !== '' && b[k] !== cur[k]) diff[k] = b[k];
  for (const [k, re] of Object.entries(BODY_OK)) if (diff[k] && !re.test(diff[k])) { toast(k === 'weight' ? '몸무게는 68.5처럼 적어 주세요' : '걸음은 숫자로 적어 주세요'); return; }
  if (!Object.keys(diff).length) { toast('바꾼 값이 없어요'); return; }
  state.body = null;
  await record('body', diff); toast('💪 남겼어요');
}

// 목표 탭으로 남긴 목표(quick의 "목표 …" 줄)도 PC 병합 전에 바로 보이게 덧붙인다
function goalsFor(date) {
  const day = state.snap && state.snap.days && state.snap.days[date];
  const goals = (day ? day.goals : []).map(g => ({ ...g }));
  for (const e of pendingEvents(['quick']).filter(e => e.date === date))
    for (const l of quickLines(e.payload.text)) if (l.kind === '목표' && !goals.some(g => g.text === l.text)) goals.push({ text: l.text, done: false });
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
  ({ '': drawHome, rest: drawRest, start: drawStart, paper: drawReading, log: drawLog, run: drawRun, prun: drawPrun })[v]();

  const s = state.snap;
  const err = state.snapErr && state.snapErr !== '없음' ? ` · 요약 받기 실패: ${state.snapErr}` : '';
  $('#pc-sync').textContent = (s ? `PC 동기화: ${ago(s.generated_at)}` : (state.connected ? 'PC가 아직 요약을 쓰지 않았어요' : '')) + err +
    (state.connected ? ' · 눌러서 다시 받기' : '');
  renderSync();
}

// ----- 처음 -----
function drawHome() {
  drawPromises();
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
    // 폰 폭(약 340px)에 버튼 셋은 글자가 꺾인다 → "다시 정하기"는 위 줄 오른쪽 링크, 아래는 두 버튼
    nc.innerHTML = `<div class="next-head"><span class="muted small">이어서 할 첫 행동 · ${esc(nx.status)}${nx.when ? ' ' + esc(nx.when) : ''}</span>
        <button class="link small" data-act="redo" data-tid="${nx.id}">다시 정하기</button></div>
      <div class="next-title">${esc(nx.title)}</div>
      ${step ? `<div class="next-step">${step.pc ? '💻 ' : ''}${esc(step.text)}${step.min ? ` <span class="muted">(${step.min}분)</span>` : ''}</div>` : ''}
      <div class="row two"><button class="btn done" data-act="task-done" data-tid="${nx.id}">✓ 했어요</button><button class="btn primary" data-act="run" data-tid="${nx.id}">▶ 5분 시작</button></div>`;
  }
  const up = upcomingTasks();
  $('#plan-line').innerHTML = up.length ? `<a href="#start">⏰ 예약 ${up.length}개 · 다음 ${esc(up[0].when)} ${esc(up[0].title)}</a>` : '';
  $('#menu-paper-sub').textContent = readingSub();
  const n = todays('joy').length;
  $('#joy-line').innerHTML = n ? `✨ 오늘의 작은 즐거움 <b>${n}</b>개` : `<a href="#log">✨ 오늘의 작은 즐거움, 하나 남겨 볼까요?</a>`;
}

// 돌아보기 카드 (처음 화면·실행 화면 공용) — 1~2번 터치. "나중에"는 한 번으로 닫히고 다시 묻지 않는다
// extra: 회고에 같이 실을 값 (실행 화면은 미룬 횟수 delays)
function reviewUI(box, t, question, done, extra = {}) {
  const st = box._rv && box._rv.tid === t.id ? box._rv : (box._rv = { tid: t.id, result: '', obstacle: '' });
  box.innerHTML = `<h2>${esc(question)}</h2>
    <div class="chips">${['완료', '일부', '못함', '의도적으로 안 함'].map(r => `<button class="chip-btn ${st.result === r ? 'on' : ''}" data-r="${r}">${r}</button>`).join('')}</div>
    ${st.result === '못함' ? `<p class="muted small mt">무엇 때문이었을까요? (골라도, 안 골라도 돼요)</p>
      <div class="chips">${REVIEW_OBSTACLES.map(o => `<button class="chip-btn ${st.obstacle === o ? 'on' : ''}" data-o="${o}">${o}</button>`).join('')}</div>
      <input class="field" data-note placeholder="다음엔 이렇게 (선택)" maxlength="120">` : ''}
    <div class="row"><button class="btn" data-later>나중에</button><button class="btn primary" data-save ${st.result ? '' : 'disabled'}>남기기</button></div>`;
  box.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.r) { st.result = b.dataset.r; reviewUI(box, t, question, done, extra); return; }
    if (b.dataset.o) { st.obstacle = st.obstacle === b.dataset.o ? '' : b.dataset.o; const note = box.querySelector('[data-note]'); st.note = note ? note.value : ''; reviewUI(box, t, question, done, extra); if (st.note) box.querySelector('[data-note]').value = st.note; return; }
    if (b.hasAttribute('data-later')) { ls.set('dismiss.' + t.id + '.' + t.decidedTs, 1); box._rv = null; done(); return; }
    if (b.hasAttribute('data-save')) {
      const note = box.querySelector('[data-note]');
      await record('task-review', { tid: t.id, result: st.result, obstacle: st.obstacle, note: note ? note.value.trim() : '', ...extra });
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
// 사전에서 쉼 고르기: 에너지가 맞고 시간 안에 드는 것 → 회복 응답·기록 횟수 순. 길면 "작게"로 줄여서
const restScore = (a, time) => (a.recover ? a.recover['그렇다'] * 3 + a.recover['조금'] - a.recover['아니다'] : 0) + Math.log1p(a.count || 0) + ((a.min || 0) * 2 >= time ? 1 : 0);
function restCands(energy, time) {
  const acts = activities().filter(a => a.type === '쉼' && a.id !== 'phone' && (a.energy || []).includes(energy));
  const by = (x, y) => restScore(y, time) - restScore(x, time);
  const fit = acts.filter(a => (a.min || 0) <= time).sort(by).map(a => ({ a, steps: a.steps, short: false }));
  const short = acts.filter(a => (a.min || 0) > time && a.small && (a.small.min || 0) <= time).sort(by).map(a => ({ a, steps: [a.small], short: true }));
  // 시간 안에 드는 것 2 + 긴 쉼을 작게 줄인 것 2 (산책처럼 좋아하는 쉼이 짧은 시간에도 보이게), 모자라면 서로 채운다
  const nShort = Math.min(short.length, Math.max(2, 4 - fit.length));
  return [...fit.slice(0, 4 - nShort), ...short.slice(0, nShort)];
}
const actByText = text => { const t = tplOf(guessKind(text)); return t.act ? activities().find(a => 'a-' + a.id === t.id) : null; };
function restPickBtn(c) {
  const rc = c.a.recover && c.a.recover['그렇다'] ? ` · 회복됐던 쉼 ${c.a.recover['그렇다']}번` : '';
  return `<button class="pick-btn" data-rest-act="${esc(c.a.id)}" data-short="${c.short ? 1 : ''}"><b>${esc(c.a.name)}${c.short ? ' · 작게' : ''}</b>
    <span class="pick-sub">${esc(c.steps[0].text)}부터${c.short ? '' : c.a.min ? ` · ${c.a.min}분` : ''}${rc}</span></button>`;
}
function drawRest() {
  const r = state.rest;
  const now = ls.get('resting');
  $('#rest-pick').hidden = !!now;
  $('#rest-now').hidden = !now;
  if (now && now.back) { $('#rest-now').innerHTML = backToWork(); return; }
  if (now) {
    const counting = now.endAt && !now.ending;
    $('#rest-now').innerHTML = `<div class="muted small">${esc(now.hm)}부터</div><div class="resting-label">🌿 ${esc(now.label)}${now.min ? ` <span class="muted">${now.min}분</span>` : ''}</div>
      ${counting ? `<div class="timer" id="rest-timer">${fmt(Math.max(0, now.endAt - Date.now()))}</div><p class="muted small">타이머 동안 화면을 켜 둘게요</p>`
        : now.ending ? '' : '<p class="muted">쉬는 동안엔 다른 건 신경 쓰지 않아도 돼요.</p>'}
      ${now.steps && now.steps.length ? `<ol class="rsteps">${now.steps.map((s, i) => `<li><button class="rstep ${s.done ? 'done' : ''}" data-rstep="${i}"><span class="ck">${s.done ? '✓' : ''}</span>${esc(s.text)}${s.min ? ` <small>${s.min}분</small>` : ''}</button></li>`).join('')}</ol>` : ''}
      ${now.ending ? `${now.timeUp ? `<div class="time-up">⏰ ${now.min}분 다 쉬었어요</div>` : ''}<h2 class="mt">회복됐나요?</h2>
        <div class="chips">${['그렇다', '조금', '아니다'].map(f => `<button class="chip-btn" data-felt="${f}">${f}</button>`).join('')}</div>
        ${now.timeUp ? '<button class="link mt" data-act="rest-more">🌿 5분 더 쉬기</button>' : ''}`
        : `<div class="row"><button class="btn" data-act="rest-close">그냥 닫기</button><button class="btn primary" data-act="rest-end">끝났어요</button></div>`}`;
    return;
  }
  document.querySelectorAll('#rest-energy .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.v === r.energy));
  document.querySelectorAll('#rest-time .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.v === String(r.time)));
  const box = $('#rest-suggest');
  if (!r.energy || !r.time) { box.innerHTML = ''; return; }
  const day = state.snap && state.snap.days && state.snap.days[today()];
  const reserved = day && day.rest;
  const cands = restCands(r.energy, r.time);
  const items = cands.length ? cands.map(restPickBtn) : REST_TABLE[r.energy][r.time].map(x => `<button class="pick-btn" data-label="${esc(x)}">${esc(x)}</button>`);
  box.innerHTML = `<h2 class="mt">이건 어때요?</h2><p class="muted small">첫 동작 하나만 하면 시작이에요.</p><div class="pick">
    ${reserved ? `<button class="pick-btn reserved" data-label="${esc(reserved)}">📌 예약해 둔 쉼: ${esc(reserved)}</button>` : ''}
    ${items.join('')}
    </div><button class="link mt" ${activities().some(a => a.id === 'phone') ? 'data-rest-act="phone"' : 'data-label="휴대폰으로 쉬기"'}>📱 휴대폰으로 쉴래요</button>`;
}

// 쉼 → 일 전환: 쉼은 끝내기가 어렵다. "회복됐나요?"에 답하면 이어서 할 일의 첫 동작을 5초 카운트다운으로 바로 잇는다
const BACK_MS = 30 * 60000;   // 이 시간이 지나면 전환 카드를 접고 다시 쉼 고르기 화면으로
function backToWork() {
  const nx = dueTasks()[0];
  const step = nx && nx.steps.find(s => !s.done);
  return `<h2>잘 쉬었어요 🌿</h2>
    <p class="muted">쉼에서 일로 넘어가는 게 제일 어려워요. 첫 동작 하나만 해 볼까요?</p>
    ${nx ? `<div class="next-title">${esc(nx.title)}</div>
      ${step ? `<div class="next-step">${step.pc ? '💻 ' : ''}${esc(step.text)}${step.min ? ` <span class="muted">(${step.min}분)</span>` : ''}</div>` : ''}
      <div class="row"><button class="btn" data-act="back-home">나중에</button><button class="btn primary" data-act="run" data-tid="${nx.id}">▶ 5초 뒤 시작</button></div>`
    : `<div class="row"><button class="btn" data-act="back-home">처음으로</button><a class="btn primary" href="#start" data-act="back-start">▶ 시작하기</a></div>`}`;
}

// ----- ▶ 시작하기 -----
function drawStart() {
  const f = state.flow;
  const box = $('#flow');
  if (!f) {
    box.innerHTML = `<h2>무엇을 시작할까요?</h2>
      <div class="inline"><input class="field" id="flow-title" placeholder="예) 교수님께 메일, 논문 읽기" maxlength="120"><button class="btn primary" data-act="flow-new">나누기</button></div>
      <p class="muted small">크게 적어도 괜찮아요. 1~5분짜리 첫 행동으로 나눠 드릴게요.</p>
      ${quickActs().length ? `<h2 class="mt">자주 하던 일</h2><div class="chips small-chips">${quickActs().map(a => `<button class="chip-btn" data-quick-act="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div>` : ''}`;
  } else {
    const tpl = tplOf(f.kind);
    box.innerHTML = `<div class="muted small">${f.isNew ? '새 할 일' : '이어서'}</div><h2>${esc(f.title)}</h2>
      <div class="chips small-chips">${[...(tpl.act ? [tpl] : []), ...baseTemplates()].map(t => `<button class="chip-btn ${t.id === f.kind ? 'on' : ''}" data-kind="${t.id}">${esc(t.name)}</button>`).join('')}</div>
      <p class="muted small mt">걸리는 게 있다면 (선택)</p>
      <div class="chips small-chips">${OBSTACLES.map(o => `<button class="chip-btn ${o === f.obstacle ? 'on' : ''}" data-obstacle="${o}">${o}</button>`).join('')}</div>
      <div class="chips small-chips mt"><button class="chip-btn ${f.device === 'phone' ? 'on' : ''}" data-device="phone">📱 폰만</button><button class="chip-btn ${f.device === 'pc' ? 'on' : ''}" data-device="pc">💻 PC 있음</button></div>
      <h2 class="mt">첫 행동</h2>
      <ol class="steps">${f.steps.map((s, i) => `<li class="${s.done ? 'done' : ''}">
        <textarea class="field step-text" data-step="${i}" rows="1" aria-label="단계 ${i + 1}">${esc(s.text)}</textarea>
        <span class="step-meta">${s.pc ? '💻 PC' : ''}<input class="field step-min" data-min="${i}" value="${s.min || ''}" inputmode="numeric" aria-label="분">분
        <button class="x" data-del="${i}" aria-label="지우기">×</button></span></li>`).join('')}</ol>
      <button class="link" data-act="step-add">+ 단계 추가</button>
      ${f.choosing ? decideExtra(f) : `<h2 class="mt">언제 할까요?</h2>
      <div class="decide">
        <button class="btn primary" data-decide="now">▶ 지금 5분 시작</button>
        <button class="btn" data-decide="later">오늘 나중에</button>
        <button class="btn" data-decide="date">날짜 정하기</button>
        <button class="btn done" data-decide="done">✓ 이미 했어요</button>
        <button class="btn" data-decide="drop">하지 않기</button>
      </div>`}
      <div class="row"><span class="muted small">${esc(tpl.name)} ${tpl.act ? '첫 동작 사전' : '템플릿'} v${tpl.version}${f.edited ? ' · 고침' : ''}</span><button class="link" data-act="flow-cancel">취소 (나중에 정하기)</button></div>`;
  }
  const list = openTasks().filter(t => !state.flow || t.id !== state.flow.tid);
  $('#tasks-card').hidden = !list.length;
  $('#tasks').innerHTML = list.map(t => `<li class="task-li"><button class="task" data-open-task="${t.id}"><b>${esc(t.title)}</b>
    <span class="badge">${esc(t.status)}${t.when ? ' · ' + esc(t.when) : ''}</span></button>
    <button class="chip-btn done-chip" data-act="task-done" data-tid="${t.id}" aria-label="${esc(t.title)} 완료">✓ 완료</button></li>`).join('');
  document.querySelectorAll('.step-text').forEach(fitText);
}
// 단계 칸 높이를 문장 길이에 맞춘다 (field-sizing을 모르는 브라우저용)
function fitText(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; }
// 시작하기 빈 화면의 "자주 하던 일" — 사전의 일·생활 중 최근 기록이 많은 것
const quickActs = () => activities().filter(a => a.type !== '쉼').sort((x, y) => (y.count || 0) - (x.count || 0)).slice(0, 6);
function decideExtra(f) {
  if (f.choosing === 'later') {
    const slots = freeSlots();
    return `<h2 class="mt">몇 시쯤?</h2><div class="chips">${slots.map(s => `<button class="chip-btn" data-when="${s}">${s}</button>`).join('')}</div>
      <div class="inline mt"><input class="field" type="time" id="when-time"><button class="btn primary" data-act="when-ok" data-kind-when="later">정하기</button></div>
      <button class="link mt" data-when="">시간은 안 정할래요</button> · <button class="link" data-act="choose-back">돌아가기</button>`;
  }
  const label = f.choosing === 'date' ? '언제 다시 볼까요?' : '다시 볼 날 (선택)';
  // 내일·모레는 3시 컷오프 기준 — 새벽 1시에 "내일"을 누르면 자고 일어난 날
  const dayChip = n => { const v = addDaysStr(today(), n), d = new Date(v + 'T12:00:00');
    return `<button class="chip-btn" data-pick-date="${v}">${n === 1 ? '내일' : '모레'} ${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}</button>`; };
  return `<h2 class="mt">${label}</h2><div class="chips">${dayChip(1)}${dayChip(2)}</div>
    <div class="when-grid mt"><input class="field" type="date" id="when-date" value="${addDaysStr(today(), 1)}" aria-label="날짜">
      <input class="field" type="time" id="when-date-time" aria-label="시각 (선택)"></div>
    <p class="muted small">시각은 비워도 돼요. 정하면 그 시각부터, 비우면 그날 하루 동안 처음 화면에 떠요.</p>
    <div class="row"><span></span><button class="btn primary" data-act="when-ok">정하기</button></div>
    ${f.choosing === 'hold' ? '<button class="link mt" data-when="">날짜 없이 보류</button> · ' : ''}<button class="link" data-act="choose-back">돌아가기</button>`;
}
async function decide(decision, when = '') {
  const f = state.flow;
  if (!f.steps.length) { toast('첫 행동을 하나 이상 남겨 주세요'); return; }
  const tpl = tplOf(f.kind);
  if (f.isNew) await record('task-add', { tid: f.tid, title: f.title, kind: f.kind });
  await record('task-steps', { tid: f.tid, steps: f.steps, template: tpl.id, version: tpl.version, kind: f.kind, edited: !!f.edited });
  state.flow = null;
  if (decision === 'done') { await markDone(f.tid); location.hash = ''; return; }   // 이미 해 버린 일 — 결정 대신 완료 회고
  await record('task-decide', { tid: f.tid, decision, when });
  if (decision === 'now') { startCount(f.tid); location.hash = '#run'; return; }
  toast({ later: '오늘 나중에 다시 보여 드릴게요', date: `${when}에 다시 보여 드릴게요`, hold: '보류함에 넣어 뒀어요', drop: '하지 않기로 정했어요. 그것도 결정이에요' }[decision]);
  location.hash = '';
}
// ✓ 완료 — 이어서 할 일을 이미 해 버렸을 때 (처음 화면·할 일 목록·결정 화면·머릿속 비우기 공용). PC coach-tasks가 단계까지 모두 끝으로 바꾼다
async function markDone(tid) {
  const run = getRun();
  if (run && run.tid === tid) saveRun(null);
  await record('task-review', { tid, result: '완료', obstacle: '', note: '' });
  toast('완료로 남겼어요 ✓');
}
// 📚 오늘의 논문 — 처음 화면 메뉴에서 여는 화면 (v12, 예전엔 ▶ 시작하기 위쪽 카드)
function readingSub() {
  const r = state.snap && state.snap.reading;
  if (!(r && r.papers && r.papers.length)) return '오늘 읽을 논문';
  if (r.readToday || todays('reading-done').length) return '오늘 읽음 ✓';
  const p = r.papers[0];
  return `오늘 p.${p.from}~${p.to}${r.progress ? ` · ${r.progress.done}/${r.progress.total}편` : ''}`;
}
function drawReading() {
  const r = state.snap && state.snap.reading;
  if (!(r && r.papers && r.papers.length)) { $('#reading').innerHTML = '<p class="muted">오늘 읽을 논문이 아직 없어요. PC papers-wiki에서 이달의 계보를 정하면 여기에 떠요.</p>'; return; }
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
// run = { tid, phase: 'count'(5초 시작 카운트다운) | 'run'(5분), countAt, endAt, delays(이 단계에서 미룬 횟수), delaysTotal, rang, startedAt, praise, reviewing }
const getRun = () => state.run || ls.get('run');
const saveRun = r => { state.run = r; ls.set('run', r); };
const runMs = () => (state.demoSec || 5 * 60) * 1000;   // 데모 &sec=N 이면 N초
const phaseOf = r => r.phase || 'run';                  // v9에서 남은 실행 상태는 바로 5분 단계
function startCount(tid, prev = {}) {
  unlockAudio();
  saveRun({ tid, phase: 'count', countAt: Date.now() + LAUNCH.count * 1000, delays: 0, delaysTotal: prev.delaysTotal || 0 });
}
function startRun(r) {
  const now = Date.now();
  saveRun({ ...r, phase: 'run', endAt: now + runMs(), rang: false, startedAt: now, praise: pick(r.delays ? PRAISE.late : PRAISE.quick) });
  rewardFx();
}
function drawRun() {
  const run = getRun();
  const t = run && tasksNow().find(x => x.id === run.tid);
  const box = $('#run');
  if (!t) { box.innerHTML = '<p class="muted">진행 중인 일이 없어요.</p><a class="btn" href="#">처음으로</a>'; return; }
  saveRun(run);
  const i = t.steps.findIndex(s => !s.done);
  if (run.reviewing || i < 0) {
    reviewUI(box, t, i < 0 ? `‘${t.title}’ 단계를 다 했어요! 어땠어요?` : `‘${t.title}’ 여기까지 어땠어요?`,
      () => { saveRun(null); location.hash = ''; }, { delays: run.delaysTotal || 0 });
    return;
  }
  const s = t.steps[i];
  const head = `<div class="muted small">${esc(t.title)} · ${i + 1}/${t.steps.length}단계</div>
    <div class="run-step">${s.pc ? '💻 ' : ''}${esc(s.text)}</div>`;
  if (phaseOf(run) === 'count') {
    box.innerHTML = `${head}
      <div class="count" id="count">${Math.max(1, Math.ceil((run.countAt - Date.now()) / 1000))}</div>
      <p class="muted small center">0이 되면 시작이에요</p>
      <div class="row"><button class="btn" data-act="count-delay">⏳ ${LAUNCH.delaySec}초 미루기</button><button class="btn primary" data-act="count-go">지금 바로</button></div>
      ${run.delays >= LAUNCH.nudgeAfter - 1 ? `<button class="link mt" data-act="redo" data-tid="${t.id}">첫 동작을 더 작게 바꿔 볼까요?</button>` : ''}`;
    return;
  }
  const left = run.endAt - Date.now();
  const since = Date.now() - (run.startedAt || 0);
  box.innerHTML = `${head}
    ${run.praise && since < 2500 ? `<div class="praise" style="animation-delay:-${since}ms">${esc(run.praise)}</div>` : ''}
    <div class="timer${left > 0 ? "" : " over"}" id="timer">${left > 0 ? fmt(left) : `${Math.round(runMs() / 60000) || 5}분 지났어요. <button class="link" data-act="run-more">5분 더</button>`}</div>
    ${left > 0 ? '<p class="muted small">타이머 동안 화면을 켜 둘게요</p>' : ''}
    <div class="row"><button class="btn" data-act="run-stop">여기까지</button><button class="btn primary" data-act="step-done" data-i="${i}">✓ 이 단계 끝</button></div>`;
}

// ----- 💚 약속 실행 — PRD tasks/prd-selfcare-promise-push.md US-006 -----
// 알림(#promise/<id>)이나 약속 카드 ▶에서 연다 → 5초 카운트다운(v10 LAUNCH) → "하는 중" 화면. 시작만 센다:
// 남은 시간·진행 막대·끝 알람이 없다(호호 2026-10-25). 시작 = promise-start, 끝 = promise-end 이벤트 →
// syncPromisePush가 이걸 보고 남은 재촉 알림을 지우고, 조용한 알림 한 건(마감 또는 시작 90분 뒤 중 늦은 쪽)만 다시 건다.
// 하는 중 = 단계 체크가 중심, 종료는 작은 링크 → 마지막 단계를 체크하면 큰 버튼. 지난 시간은 눌렀을 때만 5초(PRD tasks/prd-promise-flow-daybar.md US-201·202).
// prun = { id, phase: 'count' | 'doing' | 'step' | 'result', countAt, delays, useSmall, startedAt, praise, stepsDone, endedAt, late, rPick, rCustom, rSize }
const getPrun = () => state.prun || ls.get('prun');
const savePrun = r => { state.prun = r; ls.set('prun', r); };
const hmOf = ms => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
function findPromise(id) {
  const date = String(id).slice(0, 10), set = promiseSet(date);
  return (set && set.promises.find(x => x.id === id)) || researchPromises(date).find(x => x.id === id) || null;
}
const promiseEv = (type, id) => state.events.filter(e => e.type === type && e.payload.id === id).sort((a, b) => b.ts - a.ts)[0];
async function openPromise(id) {
  const evs = await idb.events();   // 알림으로 막 열렸으면 아직 기록을 안 읽었다 → 합친다
  state.events = [...state.events.filter(e => !evs.some(x => x.id === e.id)), ...evs];
  const p = findPromise(id);
  if (!p) { toast('이 약속을 찾지 못했어요'); location.hash = ''; return; }
  if (promiseEv('promise-end', id)) { toast('이미 끝낸 약속이에요 👏'); location.hash = ''; return; }
  const cur = getPrun();
  if (!(cur && cur.id === id)) {
    const st = promiseEv('promise-start', id);
    savePrun(st ? { id, phase: 'doing', startedAt: st.payload.at, delays: 0 } : { id, phase: 'count', countAt: Date.now() + LAUNCH.count * 1000, delays: 0, useSmall: false });
  }
  location.hash = '#prun';
}
// #promise/<id>(알림) · #move/<날짜>(셔틀/차 알림 — 처음 화면 카드에 칩이 있다)
function routeHash() {
  const h = decodeURIComponent(location.hash.replace('#', ''));
  if (h.startsWith('promise/')) { openPromise(h.slice(8)); return true; }
  if (h.startsWith('move/')) { location.hash = ''; return true; }
  return false;
}
async function startPrun() {
  const r = getPrun(); if (!r || r.phase !== 'count') return;
  const at = Date.now();
  savePrun({ ...r, phase: 'doing', startedAt: at, praise: pick(r.delays ? PRAISE.late : PRAISE.quick) });
  rewardFx(); drawPrun();
  await record('promise-start', { id: r.id, at, small: !!r.useSmall });
  syncPromisePush();
}
async function endPrun(skipStep) {
  const r = getPrun(); if (!r) return;
  const p = findPromise(r.id), endedAt = r.endedAt || Date.now();
  if (!skipStep && p && p.kind === 'research' && r.phase !== 'step') { savePrun({ ...r, phase: 'step', endedAt }); drawPrun(); return; }   // US-104
  const k = (p && kindOf(p.kind)) || {}, late = endedAt - (r.startedAt || endedAt) > PROMISE_LATE_MS;
  // 결과 카드(US-203) — 약속을 못 찾게 되어도 기록할 수 있게 종류·이름·날짜를 함께 둔다
  savePrun({ ...r, phase: 'result', endedAt, late, rPick: late ? null : 0, rSize: r.useSmall ? 'small' : 'full',
    kind: p ? p.kind : '', name: k.name || '약속', date: p ? p.date : String(r.id).slice(0, 10) });
  stampFx(p); drawPrun();
  await record('promise-end', { id: r.id, at: endedAt });
  syncPromisePush();
}
// 끝난 시각: rPick = 0·15·30(종료 누른 때보다 N분 전) · 'custom'(직접 고른 시각) · null(모름)
const PROMISE_LATE_MS = 3 * 3600 * 1000;   // 이보다 길면 종료를 깜빡한 것으로 보고 분을 계산하지 않는다
function prunEndAt(r) {
  if (r.rPick === null || r.rPick === undefined) return null;
  return r.rPick === 'custom' ? r.rCustom || null : r.endedAt - r.rPick * 60000;
}
const prunMin = (start, end) => Math.max(1, Math.round((end - start) / 60000));
function pickCustomEnd(r, hm) {   // 시작 시각 뒤에 처음 오는 그 시각 (자정을 넘긴 경우 포함)
  const [h, m] = hm.split(':').map(Number), d = new Date(r.startedAt);
  d.setHours(h, m, 0, 0);
  if (d.getTime() < r.startedAt) d.setDate(d.getDate() + 1);
  return d.getTime() <= r.endedAt + 60000 ? d.getTime() : null;
}
async function savePrunResult(r) {
  const endAt = prunEndAt(r);
  savePrun(null);   // record → render → drawPromises가 다시 저장하지 않게 먼저 비운다
  await record('promise-result', { id: r.id, kind: r.kind, name: r.name, date: r.date, startAt: r.startedAt, endAt, min: endAt ? prunMin(r.startedAt, endAt) : null, size: r.rSize, manual: false });
}
// 결과 카드에서 저장하지 않고 떠났으면 그때 고른 값(기본값)으로 남긴다
function autoSavePrun() {
  const r = getPrun();
  if (r && r.phase === 'result' && view() !== 'prun') savePrunResult(r);
}
// 💮 도장 — 인증 사진 대신(호호 2026-10-28 "도장 찍는 듯한 스티커 효과면 돼"). 화면 가운데 쾅 찍히고 1.8초 뒤 사라진다
function stampFx(p) {
  const el = $('#stamp'), k = (p && kindOf(p.kind)) || { emoji: '💚' }, d = logicalNow();
  $('#stamp-sub').textContent = `${k.emoji || '💚'} ${d.getMonth() + 1}.${d.getDate()}`;
  el.hidden = false; el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  chime([[523, 0, 0.08], [784, 0.1, 0.3]]); buzz([30, 40, 140]);
  clearTimeout(stampFx.t); stampFx.t = setTimeout(() => { el.hidden = true; el.classList.remove('on'); }, 1900);
}
// 📄 박사 한 걸음 — PRD tasks/prd-school-day-rhythm.md US-104. 이번 주 = 요약 steps(PC 반영분) + 아직 안 올라간 research-step
const mondayOf = date => addDaysStr(date, -((wdOf(date) + 6) % 7));
function weekSteps() {
  const mon = mondayOf(today());
  const split = t => { const i = t.indexOf(' — '); return i < 0 ? { title: t, line: '' } : { title: t.slice(0, i), line: t.slice(i + 3) }; };
  const list = ((state.snap && state.snap.steps) || []).filter(x => x.date >= mon).map(x => ({ date: x.date, ...split(x.text) }));
  for (const e of pendingEvents(['research-step']).filter(e => e.date >= mon))
    list.push({ date: e.date, title: e.payload.title || '(제목 없이)', line: e.payload.line || '' });
  return list;
}
function stepsLine() {
  const st = weekSteps(); if (!st.length) return '';
  const papers = new Set(st.map(x => x.title).filter(t => t && t !== '(제목 없이)')).size;
  return `<p class="small p-steps-line">📄 이번 주 박사 한 걸음 ${st.length}개${papers ? ` · 논문 ${papers}편` : ''}</p>`;
}
function readStepInputs() {
  const r = getPrun(), t = $('#step-title'), l = $('#step-line'); if (!r || !t) return r;
  const nr = { ...r, otherTitle: t.value, line: l.value }; savePrun(nr); return nr;
}
async function saveStep() {
  const r = readStepInputs(); if (!r) return;
  const papers = (state.snap && state.snap.reading && state.snap.reading.papers) || [];
  const picked = papers.find(x => x.id === r.paper);
  const title = (picked ? picked.title : (r.otherTitle || '')).trim(), line = (r.line || '').trim();
  if (title || line) await record('research-step', { date: today(), paperId: picked ? picked.id : null, title, line });
  // 오늘의 논문을 골랐으면 papers-wiki 읽음 체크도 같이 (오늘의 논문 카드의 [읽었어요]와 같은 이벤트)
  if (picked && papers[0] && picked.id === papers[0].id && !(state.snap.reading.readToday || todays('reading-done').length)) await record('reading-done', { id: picked.id });
  await endPrun(true);
}
function drawPrun() {
  const r = getPrun(), box = $('#prun'), p = r && findPromise(r.id);
  if (!p) { box.innerHTML = '<p class="muted">진행 중인 약속이 없어요.</p><a class="btn" href="#">처음으로</a>'; return; }
  const k = kindOf(p.kind) || { name: '약속', emoji: '💚' };
  const first = (k.first && k.first.text) || p.firstStep, small = (k.small && k.small.text) || p.small;
  const head = `<div class="muted small">${esc(k.emoji)} ${esc(k.name)} · ${p.start}~${p.end}</div>
    <div class="run-step">${r.useSmall ? '작게: ' : '첫 동작: '}${esc((r.useSmall ? small : first) || '시작하기')}</div>`;
  if (r.phase === 'step') {
    const papers = (state.snap && state.snap.reading && state.snap.reading.papers) || [];
    const short = t => (t.length > 28 ? t.slice(0, 27) + '…' : t);
    box.innerHTML = `<div class="muted small">📄 박사 한 걸음 · 비워도 돼요</div>
      <div class="run-step">오늘 읽은 논문</div>
      ${papers.length ? `<div class="chips small-chips">${papers.map(x => `<button class="chip-btn ${r.paper === x.id ? 'on' : ''}" data-steppaper="${esc(x.id)}">${esc(short(x.title || ''))}</button>`).join('')}</div>` : ''}
      ${r.paper ? '' : `<input class="field mt" id="step-title" placeholder="${papers.length ? '다른 논문이면 제목' : '읽은 논문 제목'}" value="${esc(r.otherTitle || '')}">`}
      <textarea class="mt" id="step-line" rows="2" placeholder="알게 된 것 한 줄">${esc(r.line || '')}</textarea>
      <div class="row mt"><button class="btn" data-act="step-skip">건너뛰기</button><button class="btn primary" data-act="step-save">남기기</button></div>`;
    return;
  }
  if (r.phase === 'count') {
    const nudge = r.delays >= LAUNCH.nudgeAfter - 1;
    box.innerHTML = `${head}
      <div class="count" id="pcount">${Math.max(1, Math.ceil((r.countAt - Date.now()) / 1000))}</div>
      <p class="muted small center">0이 되면 시작이에요</p>
      <div class="row"><button class="btn" data-act="pcount-delay">⏳ ${LAUNCH.delaySec}초 미루기</button><button class="btn primary" data-act="pcount-go">지금 바로</button></div>
      ${small && !r.useSmall ? `<button class="${nudge ? 'btn soft wide' : 'link'} mt" data-act="pcount-small">작게 할래요 · ${esc(small)}</button>` : ''}`;
    return;
  }
  if (r.phase === 'result') { box.innerHTML = prunResultCard(r, k); return; }
  const since = Date.now() - (r.startedAt || 0), steps = prunSteps(r, k, small), done = r.stepsDone || [];
  const cur = steps.findIndex((x, i) => !done.includes(i)), allDone = cur < 0;
  const elapsed = (state.prunElapsedUntil || 0) > Date.now();
  box.innerHTML = `<div class="muted small">${esc(k.emoji)} ${esc(k.name)} · ${p.start}~${p.end}</div>
    ${r.praise && since < 2500 ? `<div class="praise" style="animation-delay:-${since}ms">${esc(r.praise)}</div>` : ''}
    <p class="muted">${hmOf(r.startedAt)} 시작 · 하는 중</p>
    ${steps.length ? `<div class="p-steps">${steps.map((x, i) => `<button class="p-step ${done.includes(i) ? 'done' : ''} ${i === cur ? 'cur' : ''}" data-pstep="${i}" aria-pressed="${done.includes(i)}">
      <span class="p-box" aria-hidden="true"></span><span class="p-step-t">${esc(x.text)}${x.min ? ` <span class="muted small">${x.min}분</span>` : ''}</span>${i === cur ? '<span class="p-step-ok">완료</span>' : ''}</button>`).join('')}</div>` : ''}
    <button class="link small mt p-elapsed" data-act="prun-elapsed">${elapsed ? `⏱ ${esc(elapsedText(since))}` : '⏱ 얼마나 됐지?'}</button>
    ${allDone ? `${steps.length ? '<p class="p-more">더 해도 좋아요. 끝나면 눌러 주세요.</p>' : ''}<button class="btn primary wide big mt" data-act="prun-end">✅ 종료했어요</button>`
      : '<button class="link mt" data-act="prun-end">오늘은 여기까지 (종료)</button>'}
    <button class="link mt" data-act="prun-leave">처음 화면으로 (하는 중으로 둘게요)</button>`;
}
const prunSteps = (r, k, small) => (r.useSmall ? (small ? [{ text: small }] : []) : k.steps || []);
const elapsedText = ms => { const m = Math.floor(ms / 60000); return m < 1 ? '방금 시작했어요' : `${m}분째`; };
// 도장 뒤 결과 카드 — 끝난 시각·크기를 고친다. 저장하지 않고 떠나도 autoSavePrun이 남긴다
function prunResultCard(r, k) {
  const endAt = prunEndAt(r), chip = (v, label, off) => `<button class="chip-btn ${r.rPick === (v === 'null' ? null : v) ? 'on' : ''}" data-rpick="${v}" ${off ? 'disabled' : ''}>${label}</button>`;
  const before = m => r.endedAt - m * 60000 < r.startedAt;
  const custom = r.rPick === 'custom' ? `<input class="field mt" type="time" id="pr-end" aria-label="끝난 시각" value="${r.rCustom ? hmOf(r.rCustom) : ''}">` : '';
  return `<div class="p-result"><div class="p-result-head">${esc(k.emoji)} ${esc(k.name)}</div>
    <div class="run-step">${hmOf(r.startedAt)}~${endAt ? `${hmOf(endAt)} · ${prunMin(r.startedAt, endAt)}분` : ''}</div>
    <p class="muted small">${r.late ? '시작한 지 오래됐어요. 언제 끝났어요?' : '끝난 시각'}</p>
    <div class="chips small-chips">${r.late ? chip('custom', '직접') + chip('null', '기억 안 나요') : chip(0, '방금') + chip(15, '15분 전', before(15)) + chip(30, '30분 전', before(30)) + chip('custom', '직접')}</div>${custom}
    <p class="muted small mt">크기</p>
    <div class="chips small-chips"><button class="chip-btn ${r.rSize === 'full' ? 'on' : ''}" data-rsize="full">다 했어요</button><button class="chip-btn ${r.rSize === 'small' ? 'on' : ''}" data-rsize="small">작게 했어요</button></div>
    <button class="btn primary wide big mt" data-act="prun-save">저장</button></div>`;
}
// 처음 화면 — 하는 중인 약속 한 줄, 지금 창이 열린 약속 ▶
function prunBanner() {
  const r = getPrun(), p = r && (r.phase === 'doing' || r.phase === 'step') && findPromise(r.id); if (!p) return '';
  const k = kindOf(p.kind) || { name: '약속', emoji: '💚' };
  return `<section class="card promise folded"><div class="next-head"><span>${esc(k.emoji)} ${esc(k.name)} 하는 중 · ${hmOf(r.startedAt)} 시작</span>
    <button class="link small" data-act="promise-go" data-id="${esc(p.id)}">이어 보기</button></div></section>`;
}
// 약속 하나의 지금 상태(US-204). v21까지의 기록은 promise-result가 없어서 시작·종료 이벤트로 계산한다
// 지킨 약속 = 요약(최근 30일) + PC가 아직 반영하지 않은 내 기록. 폰은 보낸 지 오래된 이벤트를 지우므로 요약이 있어야 지난 기록이 남는다
function promiseResults() {
  const map = new Map(((state.snap && state.snap.promises) || []).map(r => [r.id, r]));
  for (const e of pendingEvents(['promise-result'])) {
    const p = e.payload;
    map.set(p.id, { id: p.id, date: p.date, kind: p.kind, start: p.startAt ? hmOf(p.startAt) : '', end: p.endAt ? hmOf(p.endAt) : '', min: p.min || null, size: p.size });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function promiseStatus(p) {
  const res = promiseEv('promise-result', p.id), end = promiseEv('promise-end', p.id), st = promiseEv('promise-start', p.id), r = getPrun();
  if (res) return { s: 'done', ...res.payload };
  const old = !end && !st && promiseResults().find(x => x.id === p.id);   // 이 폰에 이벤트가 없어도 요약에 있으면 지킨 약속
  if (old) return { s: 'done', time: old.start ? old.start + (old.end ? `~${old.end}` : ' 시작') : '', min: old.min, size: old.size };
  if (end) {
    const startAt = st ? st.payload.at : null, cur = r && r.id === p.id && r.phase === 'result' ? r : null;
    const endAt = cur ? prunEndAt(cur) : end.payload.at;
    return { s: 'done', startAt, endAt, min: startAt && endAt && endAt - startAt <= PROMISE_LATE_MS ? prunMin(startAt, endAt) : null, size: st && st.payload.small ? 'small' : 'full' };
  }
  if (st || (r && r.id === p.id && r.phase !== 'count')) return { s: 'doing', startAt: st ? st.payload.at : r.startedAt };
  const now = nowDayMin();
  return { s: now < hmMin(p.start) ? 'before' : now < hmMin(p.end) ? 'open' : 'past' };
}
function promiseRow(p) {
  const k = kindOf(p.kind) || { name: '약속', emoji: '💚' }, st = promiseStatus(p), name = `${esc(k.emoji)} ${esc(k.name)}`;
  if (st.s === 'done') {
    const time = st.time != null ? st.time : st.startAt ? hmOf(st.startAt) + (st.endAt ? `~${hmOf(st.endAt)}` : ' 시작') : '';
    const bits = [time, st.min ? `${st.min}분` : '', st.size === 'small' ? '작게' : ''].filter(Boolean).join(' · ');
    return `<div class="p-now done"><span class="p-now-t">✅ ${name}</span><span class="p-now-w">${esc(bits)}</span></div>`;
  }
  if (st.s === 'doing') return `<div class="p-now"><span class="p-now-t">${name}</span><span class="p-now-w">${hmOf(st.startAt)} 시작 <button class="link small" data-act="promise-go" data-id="${esc(p.id)}">이어 보기</button></span></div>`;
  const did = `<button class="link small" data-act="pdone-open" data-id="${esc(p.id)}">✓ 했어요</button>`;
  const form = state.pdone && state.pdone.id === p.id ? promiseDoneForm() : '';
  if (st.s === 'open') return `<button class="btn soft wide p-go" data-act="promise-go" data-id="${esc(p.id)}">▶ ${name} 지금 시작 · ~${p.end}</button><div class="p-now-did">${did}</div>${form}`;
  return `<div class="p-now ${st.s === 'past' ? 'past' : ''}"><span class="p-now-t">${name}</span><span class="p-now-w">${p.start}~${p.end} ${did}</span></div>${form}`;
}
function promiseRows(date, ps) { return date === today() && ps.length ? `<div class="p-rows">${ps.map(p => promiseRow(p) + promiseHist(p)).join('')}</div>${promiseGrass()}` : ''; }
// 지난번 10.29 · 40분 · 이번 주 2회 (US-209) — 기록이 없으면 줄을 뺀다
function promiseHist(p) {
  const mine = promiseResults().filter(r => r.kind === p.kind);
  const last = mine.filter(r => r.date < p.date).pop();
  const mon = addDaysStr(p.date, -((wdOf(p.date) + 6) % 7));
  const week = mine.filter(r => r.date >= mon && r.date <= p.date).length;
  const lastText = last ? `지난번 ${+last.date.slice(5, 7)}.${+last.date.slice(8)}${last.min ? ` · ${last.min}분` : ''}` : '';
  const bits = [lastText, week ? `이번 주 ${week}회` : ''].filter(Boolean).join(' · ');
  return bits ? `<p class="p-hist">${esc(bits)}</p>` : '';
}
// 최근 14일 잔디 — 지킨 약속 수만큼 진해진다(작게 한 약속은 0.5). 끊긴 날을 따로 알리지 않는다
function promiseGrass() {
  const all = promiseResults(), t = today(), cells = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDaysStr(t, -i), n = all.filter(r => r.date === d).reduce((sum, r) => sum + (r.size === 'small' ? 0.5 : 1), 0);
    cells.push(`<i class="lv${Math.min(3, Math.ceil(n))}" title="${d} · ${n}개"></i>`);
  }
  return `<div class="p-grass" role="img" aria-label="최근 14일 지킨 약속"><span class="muted small">14일</span>${cells.join('')}</div>`;
}
// [✓ 했어요] — 시작을 누르지 않고 먼저 한 약속(US-205). 시작·끝 시각이 없어서 PC는 타임라인에 넣지 않는다
const DONE_MINS = [15, 30, 60, 90, 120];
function promiseDoneForm() {
  const f = state.pdone;
  return `<div class="p-done-form"><div class="chips small-chips">${[...DONE_MINS, 0].map(m => `<button class="chip-btn ${f.min === m ? 'on' : ''}" data-pdmin="${m}">${m ? m + '분' : '분 없이'}</button>`).join('')}</div>
    <div class="chips small-chips"><button class="chip-btn ${f.size === 'full' ? 'on' : ''}" data-pdsize="full">다 했어요</button><button class="chip-btn ${f.size === 'small' ? 'on' : ''}" data-pdsize="small">작게 했어요</button></div>
    <div class="row"><button class="btn" data-act="pdone-cancel">그만두기</button><button class="btn primary" data-act="pdone-save">저장</button></div></div>`;
}
async function savePromiseDone() {
  const f = state.pdone, p = f && findPromise(f.id); state.pdone = null; if (!p) return;
  const k = kindOf(p.kind) || {};
  stampFx(p);
  await record('promise-result', { id: p.id, kind: p.kind, name: k.name || '약속', date: p.date, startAt: null, endAt: null, min: f.min || null, size: f.size, manual: true });
  await record('promise-end', { id: p.id, at: Date.now() });   // 남은 알림을 지운다
  syncPromisePush();
}

// 1초보다 잘게 도는 시계 하나가 두 타이머(실행·쉼)를 함께 돌린다 — 어느 화면에 있든 끝나면 울린다
function clock() {
  const now = Date.now();
  let active = false;
  const redraw = v => { if (view() === v) (v === 'run' ? drawRun : drawRest)(); };
  const run = getRun();
  const t = run && !run.reviewing && tasksNow().find(x => x.id === run.tid);
  if (t && t.steps.some(s => !s.done)) {
    if (phaseOf(run) === 'count') {
      active = true;
      if (now >= run.countAt) {
        if (now - run.countAt > LATE_MS) saveRun({ ...run, countAt: now + LAUNCH.count * 1000 });   // 카운트 중에 앱을 떠났다 왔으면 다시 센다
        else startRun(run);
        redraw('run');
      } else {
        const el = $('#count'), n = String(Math.ceil((run.countAt - now) / 1000));
        if (el && el.textContent !== n) { el.textContent = n; countFx(); }
      }
    } else if (run.endAt) {
      if (now < run.endAt) { active = true; const el = $('#timer'); if (el) el.textContent = fmt(run.endAt - now); }
      else if (!run.rang) { saveRun({ ...run, rang: true }); if (now - run.endAt <= LATE_MS) alarm(); redraw('run'); }
    }
  }
  const pr = getPrun();
  if (pr && pr.phase === 'count' && view() === 'prun') {
    active = true;
    if (now >= pr.countAt) {
      if (now - pr.countAt > LATE_MS) { savePrun({ ...pr, countAt: now + LAUNCH.count * 1000 }); drawPrun(); }   // 떠났다 왔으면 다시 센다
      else startPrun();
    } else {
      const el = $('#pcount'), n = String(Math.ceil((pr.countAt - now) / 1000));
      if (el && el.textContent !== n) { el.textContent = n; countFx(); }
    }
  }
  const r = ls.get('resting');
  if (r && r.back && now - (r.backAt || 0) > BACK_MS) { ls.set('resting', null); redraw('rest'); }
  else if (r && r.endAt && !r.ending) {
    if (now < r.endAt) { active = true; const el = $('#rest-timer'); if (el) el.textContent = fmt(r.endAt - now); }
    else { ls.set('resting', { ...r, ending: true, timeUp: true, endedAt: r.endAt }); if (now - r.endAt <= LATE_MS) alarm(); redraw('rest'); }
  }
  // 처음 화면: 예약해 둔 시각이 되면 이어서 할 일 카드를 새로 그린다 (15초마다 확인)
  if (view() === '' && now - (state.dueCheck || 0) > 15000) {
    state.dueCheck = now;
    const key = dueTasks().map(t => t.id).join() + '|' + isEvening() + '|' + promiseHomeKey();   // 약속 한 줄("다음 🏋️ 17:00")·21시 전환도
    if (state.dueKey !== undefined && key !== state.dueKey) drawHome();
    state.dueKey = key;
  }
  keepAwake(active);
}

// ----- 🧺 정리하기 -----
function drawLog() {
  $('#joy-list').innerHTML = todays('joy').map(e => `<li><span>${esc(e.hm)}</span><b>✨ ${esc(e.payload.text)}</b><span class="state">${e.sent ? '✓' : '…'}</span></li>`).join('');
  const tab = quickTab();
  $('#quick-tabs').innerHTML = Object.entries(QUICK_TABS).map(([k, v]) =>
    `<button class="chip-btn ${k === tab ? 'on' : ''}" role="tab" aria-selected="${k === tab}" data-qtab="${k}">${v.label}</button>`).join('');
  $('#quick').placeholder = '예) ' + QUICK_TABS[tab].ph;
  $('#quick-hint').textContent = QUICK_TABS[tab].hint;
  $('#quick').hidden = tab === '몸';
  $('#body-form').hidden = tab !== '몸';
  if (tab === '몸') { readBodyInputs(); drawBodyForm(); }
  drawDidList();
  const st = weekSteps().sort((a, b) => b.date.localeCompare(a.date));
  $('#steps-card').hidden = !st.length;
  $('#steps-list').innerHTML = st.map(x => `<li><span>${esc(x.date.slice(5).replace('-', '.'))}</span><b>${esc(x.title)}${x.line ? ` <span class="muted small">— ${esc(x.line)}</span>` : ''}</b></li>`).join('');
  const li = (e, kind, text) => `<li><span>${esc(e.hm)}</span><span class="badge">${esc(kind)}</span><b>${esc(text)}</b><span class="state">${e.sent ? '✓' : '…'}</span></li>`;
  $('#log').innerHTML = state.events.filter(e => (e.type === 'quick' || e.type === 'body') && e.date === today()).sort((a, b) => b.ts - a.ts)
    .flatMap(e => e.type === 'body' ? [li(e, '몸', bodyText(e.payload))] : quickLines(e.payload.text).map(l => li(e, l.kind === '한' ? '한 일' : l.kind, l.text))).join('');
  const goals = goalsFor(today());
  $('#goals-card').hidden = !goals.length;
  $('#goals').innerHTML = goals.map((g, i) => `<li class="${g.done ? 'done' : ''} ${g.depth ? 'sub' : ''}">
    <input type="checkbox" data-i="${i}" ${g.done ? 'checked' : ''} aria-label="${esc(g.text)}"><span>${esc(g.text)}</span></li>`).join('');
  const all = tasksNow();
  $('#dump-list').innerHTML = (state.dumpIds || []).map(id => all.find(t => t.id === id)).filter(Boolean).map(t => `<li class="dump">
    <b>${esc(t.title)}</b>${t.status !== '열림' ? `<span class="badge">${esc(t.status)}</span>` : `<div class="chips small-chips">
      <button class="chip-btn" data-dump="start" data-tid="${t.id}">▶ 시작하기로</button><button class="chip-btn" data-dump="later" data-tid="${t.id}">나중에</button>
      <button class="chip-btn" data-act="task-done" data-tid="${t.id}">✓ 완료</button><button class="chip-btn" data-dump="drop" data-tid="${t.id}">하지 않기</button></div>`}</li>`).join('');
}

// ============ 이벤트 연결 ============
const openFlow = t => {
  state.flow = { isNew: false, tid: t.id, title: t.title, kind: t.kind || guessKind(t.title), obstacle: '', device: 'phone',
    steps: t.steps.length ? t.steps.map(s => ({ ...s })) : buildSteps(t.kind || guessKind(t.title), '', 'phone'), edited: false };
};
$('#btn-back').onclick = () => { location.hash = ''; };
window.addEventListener('hashchange', () => { if (routeHash()) return; window.scrollTo(0, 0); draw(); });

$('#main').addEventListener('click', async e => {
  const b = e.target.closest('button, a'); if (!b) return;
  const d = b.dataset;
  unlockAudio();   // 누른 순간에만 소리를 열 수 있다 — 나중에 타이머 끝 알람이 이걸 쓴다
  // 처음 (쉼 → 일 전환 카드에서도 같은 버튼)
  if (d.act === 'run') { if ((ls.get('resting') || {}).back) ls.set('resting', null); startCount(d.tid); location.hash = '#run'; return; }
  if (d.act === 'back-home') { ls.set('resting', null); location.hash = ''; return; }
  if (d.act === 'back-start') { ls.set('resting', null); return; }   // 링크는 그대로 #start로
  if (d.qtab) { ls.set('quickTab', d.qtab); state.body = null; drawLog(); if (d.qtab !== '몸') $('#quick').focus(); return; }
  if (d.body) { readBodyInputs(); state.body[d.body] = d.n; drawBodyForm(); return; }
  if (d.water) { readBodyInputs(); state.body.water = String(Math.max(0, Math.min(99, (+state.body.water || 0) + +d.water))); drawBodyForm(); return; }
  if (d.act === 'task-done') { await markDone(d.tid); return; }   // record → render → 목록에서 빠진다
  // 💚 오늘의 약속 카드
  if (d.pwin !== undefined || d.poff !== undefined || d.pon !== undefined || d.pcare !== undefined) {
    const dr = (state.pdrafts || {})[d.pd]; if (!dr) return;
    const r = dr.rows[+(d.pwin ?? d.poff ?? d.pon ?? d.pcare)];
    if (d.pwin !== undefined) r.open = !r.open;
    else if (d.poff !== undefined) { r.off = true; r.open = false; }
    else if (d.pon !== undefined) r.off = false;
    else { const [, s, e] = CARE_CHIPS[+d.k]; r.start = s; r.end = e; }
    drawPromises(); return;
  }
  if (d.act === 'promise-go') { openPromise(d.id); return; }
  if (d.act === 'pcount-go') { startPrun(); return; }
  if (d.act === 'pcount-delay') {
    const r = getPrun(); savePrun({ ...r, countAt: Date.now() + LAUNCH.delaySec * 1000, delays: (r.delays || 0) + 1 }); drawPrun(); return;
  }
  if (d.act === 'pcount-small') { const r = getPrun(); savePrun({ ...r, useSmall: true, countAt: Date.now() + LAUNCH.count * 1000 }); drawPrun(); return; }
  if (d.act === 'prun-end') { await endPrun(); return; }
  if (d.pstep !== undefined) {
    const r = getPrun(), i = +d.pstep, done = r.stepsDone || [];
    savePrun({ ...r, stepsDone: done.includes(i) ? done.filter(x => x !== i) : [...done, i] }); drawPrun(); return;
  }
  if (d.act === 'prun-elapsed') {
    state.prunElapsedUntil = Date.now() + 5000; drawPrun();
    clearTimeout(state.prunElapsedT); state.prunElapsedT = setTimeout(() => { if (view() === 'prun') drawPrun(); }, 5100);
    return;
  }
  if (d.rpick !== undefined) {
    const v = d.rpick === 'custom' ? 'custom' : d.rpick === 'null' ? null : +d.rpick;
    savePrun({ ...getPrun(), rPick: v }); drawPrun(); return;
  }
  if (d.rsize) { savePrun({ ...getPrun(), rSize: d.rsize }); drawPrun(); return; }
  if (d.act === 'prun-save') {
    const r = getPrun();
    if (r.rPick === 'custom' && !r.rCustom) { toast('끝난 시각을 골라 주세요'); return; }
    const saving = savePrunResult(r); location.hash = ''; await saving; return;
  }
  if (d.act === 'pdone-open') { state.pdone = { id: d.id, min: 0, size: 'full' }; drawPromises(); return; }
  if (d.act === 'pdone-cancel') { state.pdone = null; drawPromises(); return; }
  if (d.pdmin !== undefined) { state.pdone.min = +d.pdmin; drawPromises(); return; }
  if (d.pdsize) { state.pdone.size = d.pdsize; drawPromises(); return; }
  if (d.act === 'pdone-save') { await savePromiseDone(); return; }
  if (d.steppaper !== undefined) { const r = readStepInputs(); savePrun({ ...r, paper: r.paper === d.steppaper ? null : d.steppaper }); drawPrun(); return; }
  if (d.act === 'step-save') { await saveStep(); return; }
  if (d.act === 'step-skip') { await endPrun(true); return; }
  if (d.act === 'prun-leave') { location.hash = ''; return; }
  if (d.didmin !== undefined) {
    const act = d.actName; state.didPick = null;
    await record('did', { act, min: d.didmin ? +d.didmin : null });
    toast(`✓ ${act}${d.didmin ? ` ${d.didmin}분` : ''}`); return;
  }
  if (d.pmove) {
    if (moveOf(d.pd) === d.pmove && moveChosen(d.pd)) return;
    await record('day-move', { date: d.pd, move: d.pmove });
    toast(d.pmove === 'car' ? '🌙 회복 날로 바꿨어요. 연구 알림은 뺐어요' : '🚌 셔틀 날이에요. 연구 블록 알림을 걸었어요');
    syncPromisePush(); return;
  }
  if (d.act === 'promise-ok') { await confirmPromises(d.date); return; }
  if (d.act === 'open-settings') { $('#btn-settings').click(); return; }   // record → render → 접힌 한 줄
  if (d.act === 'promise-edit') { state.pedit = d.date; delete (state.pdrafts || {})[d.date]; drawPromises(); return; }
  if (d.act === 'promise-cancel') { state.pedit = null; delete (state.pdrafts || {})[d.date]; drawPromises(); return; }
  if (d.act === 'redo') { const t = tasksNow().find(x => x.id === d.tid); if (t) { openFlow(t); location.hash = '#start'; } return; }
  // 쉬기
  if (b.closest('#rest-energy')) { state.rest.energy = d.v; drawRest(); return; }
  if (b.closest('#rest-time')) { state.rest.time = +d.v; drawRest(); return; }
  if (d.restAct || d.label) {
    let label = d.label, steps = [], act = '';
    const a = d.restAct ? activities().find(x => x.id === d.restAct) : actByText(d.label);
    if (a) { act = a.id; steps = d.short && a.small ? [a.small] : a.steps; if (!label) label = a.name + (d.short ? ' · 작게' : ''); }
    const min = state.rest.time || null, startAt = Date.now();
    await record('rest-choose', { label, min, act });
    // 고른 시간으로 카운트다운 바로 시작 (clock()이 돌리고 끝나면 울린다)
    ls.set('resting', { label, min, hm: nowHM(), steps: steps.map(s => ({ text: s.text, min: s.min, done: false })), startAt, endAt: min ? startAt + min * 60000 : null });
    state.rest = {}; drawRest(); return;
  }
  if (d.rstep !== undefined) { const r = ls.get('resting'); if (r && r.steps && r.steps[+d.rstep]) { r.steps[+d.rstep].done = !r.steps[+d.rstep].done; ls.set('resting', r); drawRest(); } return; }
  if (d.act === 'rest-end') { ls.set('resting', { ...ls.get('resting'), ending: true, endedAt: Date.now() }); drawRest(); return; }
  if (d.act === 'rest-more') { const r = ls.get('resting'); ls.set('resting', { ...r, ending: false, timeUp: false, endedAt: null, endAt: Date.now() + 5 * 60000, min: (r.min || 0) + 5 }); drawRest(); return; }
  if (d.act === 'rest-close') { ls.set('resting', null); location.hash = ''; return; }
  if (d.felt) {
    const r = ls.get('resting');
    const actual = r.startAt ? Math.max(1, Math.round(((r.endedAt || Date.now()) - r.startAt) / 60000)) : null;
    await record('rest-done', { label: r.label, felt: d.felt, ...(actual ? { actual } : {}) });
    ls.set('resting', { back: true, backAt: Date.now() }); drawRest(); return;   // 쉼 → 일 전환 카드
  }
  // 시작하기
  if (d.quickAct) {
    const a = activities().find(x => x.id === d.quickAct); if (!a) return;
    state.flow = { isNew: true, tid: newTid(), title: a.name, kind: 'a-' + a.id, obstacle: '', device: 'phone', steps: buildSteps('a-' + a.id, '', 'phone'), edited: false };
    drawStart(); return;
  }
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
    if (['now', 'drop', 'done'].includes(d.decide)) { await decide(d.decide); return; }
    f.choosing = d.decide; drawStart(); return;
  }
  if (f && d.act === 'choose-back') { f.choosing = null; drawStart(); return; }
  if (f && d.when !== undefined) { const c = f.choosing; f.choosing = null; await decide(c, d.when); return; }
  if (f && d.pickDate) { $('#when-date').value = d.pickDate; document.querySelectorAll('[data-pick-date]').forEach(x => x.classList.toggle('on', x === b)); return; }
  if (f && d.act === 'when-ok') {
    const c = f.choosing;
    const tm = c === 'later' ? '' : $('#when-date-time').value;
    const v = c === 'later' ? $('#when-time').value : $('#when-date').value + ($('#when-date').value && tm ? ' ' + tm : '');
    if (!v) { toast(c === 'later' ? '시간을 골라 주세요' : '날짜를 골라 주세요'); return; }
    f.choosing = null; await decide(c, v); return;
  }
  if (d.openTask) { const t = tasksNow().find(x => x.id === d.openTask); if (t) { openFlow(t); drawStart(); window.scrollTo(0, 0); } return; }
  // 실행
  if (d.act === 'count-go') { startRun(getRun()); drawRun(); return; }
  if (d.act === 'count-delay') {
    const r = getRun();
    saveRun({ ...r, countAt: Date.now() + LAUNCH.delaySec * 1000, delays: (r.delays || 0) + 1, delaysTotal: (r.delaysTotal || 0) + 1 });
    drawRun(); return;
  }
  if (d.act === 'step-done') {
    // 한 단계 끝 → 짧은 보상, 다음 단계도 5초 카운트다운부터 (마지막 단계면 drawRun이 회고로 넘어간다)
    startCount(state.run.tid, state.run); toast('✓ 한 단계 끝!'); buzz(80);
    await record('task-step', { tid: state.run.tid, i: +d.i, done: true }); return;   // record → render → 다음 단계
  }
  if (d.act === 'run-stop') { saveRun({ ...getRun(), reviewing: true }); drawRun(); return; }
  if (d.act === 'run-more') { saveRun({ ...getRun(), endAt: Date.now() + 5 * 60000, rang: false, praise: null }); drawRun(); return; }
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
  if (e.target.dataset.step !== undefined) { f.steps[+e.target.dataset.step].text = e.target.value.replace(/\n/g, ' '); f.edited = true; fitText(e.target); }
  if (e.target.dataset.min !== undefined) { const m = parseInt(e.target.value, 10); f.steps[+e.target.dataset.min].min = m > 0 ? m : null; f.edited = true; }
});
// 약속 시간 창 고르기 — 시작을 옮기면 길이는 그대로, 끝이 시작보다 앞서면 30분 뒤로
$('#main').addEventListener('change', e => {
  if (e.target.id === 'pr-end') {
    const r = getPrun(), at = e.target.value ? pickCustomEnd(r, e.target.value) : null;
    if (e.target.value && !at) toast('종료를 누른 때보다 늦은 시각이에요');
    savePrun({ ...r, rCustom: at }); drawPrun(); return;
  }
  const t = e.target.dataset, dr = (state.pdrafts || {})[t.pd]; if (!dr || (t.pstart === undefined && t.pend === undefined)) return;
  const r = dr.rows[+(t.pstart ?? t.pend)], len = hmMin(r.end) - hmMin(r.start);
  if (t.pstart !== undefined) { r.start = e.target.value; r.end = minHm(Math.min(hmMin(r.start) + (len > 0 ? len : 60), 24 * 60 - 1)); }
  else { r.end = e.target.value; if (hmMin(r.end) <= hmMin(r.start)) r.end = minHm(hmMin(r.start) + PROMISE.stepMin); }
  drawPromises();
});
$('#main').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.target.id === 'flow-title') { e.preventDefault(); document.querySelector('[data-act="flow-new"]').click(); }
  if (e.target.id === 'joy') { e.preventDefault(); $('#btn-joy').click(); }
  if (e.target.dataset.step !== undefined) e.preventDefault();   // 단계는 한 문장 — 줄바꿈 대신 칸이 알아서 늘어난다
});

$('#btn-connect').onclick = () => dbx.login();
$('#btn-reconnect').onclick = () => dbx.login();
$('#btn-joy').onclick = async () => {
  const text = $('#joy').value.trim(); if (!text) return;
  await record('joy', { text }); $('#joy').value = ''; toast('✨ 남겼어요');
};
$('#btn-quick').onclick = async () => {
  const tab = quickTab();
  if (tab === '몸') { await saveBody(); return; }
  const lines = $('#quick').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .map(l => (QUICK_RE.test(l) ? l : `${tab} ${l}`));   // 직접 접두어를 쓴 줄(메모 … 등)은 그대로
  if (!lines.length) return;
  await record('quick', { text: lines.join('\n') }); $('#quick').value = ''; toast('남겼어요');
};
$('#btn-dump').onclick = async () => {
  const lines = $('#dump').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 15);
  if (!lines.length) return;
  state.dumpIds = state.dumpIds || [];
  for (const title of lines) { const tid = newTid(); state.dumpIds.push(tid); await record('task-add', { tid, title, kind: guessKind(title) }); }
  $('#dump').value = ''; toast(`${lines.length}개를 옮겼어요. 하나씩 골라 보세요`);
};
$('#did-list').onchange = async e => {
  if (e.target.dataset.pact) { e.target.checked = true; toast('약속 기록이에요'); return; }
  const act = e.target.dataset.did; if (act == null) return;
  if (e.target.checked) { state.didPick = act; drawDidList(); return; }   // 분을 고르면 그때 남긴다
  if (state.didPick === act) { state.didPick = null; drawDidList(); return; }
  await record('did-undo', { act }); toast(`${act} 체크를 풀었어요`);
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
  $('#opt-sound').checked = alarmOpt().sound; $('#opt-vibe').checked = alarmOpt().vibe;
  $('#ntfy-topic').value = push.topic();
  $('#settings').showModal();
};
$('#ntfy-topic').onchange = e => { ls.set('ntfy.topic', e.target.value.trim()); drawPromises(); toast(e.target.value.trim() ? '주제 이름을 저장했어요' : '폰 푸시를 껐어요'); };
$('#btn-ntfy-new').onclick = () => {
  if (push.topic() && !confirm('새 이름을 만들면 ntfy 앱에서 다시 구독해야 해요. 만들까요?')) return;
  const t = push.newTopic(); ls.set('ntfy.topic', t); $('#ntfy-topic').value = t; toast('새 이름을 만들었어요. 복사해서 ntfy 앱에 구독하세요');
};
$('#btn-ntfy-copy').onclick = async () => {
  const t = push.topic(); if (!t) { toast('주제 이름이 없어요'); return; }
  try { await navigator.clipboard.writeText(t); toast('복사했어요'); } catch { $('#ntfy-topic').select(); toast('길게 눌러 복사해 주세요'); }
};
$('#btn-ntfy-test').onclick = async () => {
  try { await push.send({ title: '🔔 코치 앱 시험 알림', message: '이 알림이 보이면 폰 푸시 연결 완료예요. 누르면 코치 앱이 열려요.', priority: 4, tags: ['green_heart'] }); toast('보냈어요. 10초 안에 와야 해요'); }
  catch (e) { toast(navigator.onLine ? '보내지 못했어요: ' + e.message : '인터넷이 연결되면 다시 눌러 주세요'); }
};
$('#opt-sound').onchange = e => ls.set('alarm.sound', e.target.checked);
$('#opt-vibe').onchange = e => ls.set('alarm.vibe', e.target.checked);
$('#btn-alarm-test').onclick = () => { unlockAudio(); alarm(); };
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
window.addEventListener('online', () => { flush(); loadSnapshot().then(render).then(syncPromisePush); });
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush(); loadSnapshot().then(render).then(syncPromisePush); } });

// ============ 시작 ============
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  state.rest = {};
  setInterval(clock, 250);
  // 개발 서버 전용 미리보기: localhost/?demo → 같은 폴더의 demo-snapshot.json으로 화면만 그린다 (공개 주소에서는 꺼짐)
  if (C.COACH_ROOT && new URLSearchParams(location.search).has('demo')) {
    state.snap = await (await fetch('demo-snapshot.json')).json();
    state.connected = true; state.hasKey = true; state.events = [];
    state.demo = !new URLSearchParams(location.search).get('pushtest');   // 미리보기는 푸시를 걸지 않는다 (&pushtest=1이면 시험용 주제로 건다)
    // 화면 확인용: ?demo&flow=제목&ob=막막함&choose=later · ?demo&rest=low-10 · ?demo&run=t_demo1
    const q = new URLSearchParams(location.search);
    if (q.get('flow')) { const k = guessKind(q.get('flow')); state.flow = { isNew: true, tid: 't_demoX', title: q.get('flow'), kind: k, obstacle: q.get('ob') || '', device: 'phone', steps: buildSteps(k, q.get('ob') || '', 'phone'), edited: false, choosing: q.get('choose') || null }; }
    if (q.get('rest')) { const [en, tm] = q.get('rest').split('-'); state.rest = { energy: en, time: +tm }; }
    // 타이머 확인용: &sec=N (실행·쉼 타이머를 N초로) · &phase=run (카운트다운 건너뜀) · &delays=N · &end=1 (쉼 시간 다 됨) · &back=1 (쉼 → 일 전환 카드)
    state.demoSec = +q.get('sec') || 0;
    if (q.get('tab')) ls.set('quickTab', q.get('tab'));   // &tab=몸 → 기록 카드의 그 탭
    const now = Date.now();
    ls.set('resting', null); ls.set('run', null);
    if (q.get('resting')) {
      const a = activities().find(x => x.id === q.get('resting'));
      if (a) ls.set('resting', { label: a.name, min: a.min, hm: '21:30', steps: a.steps.map((s, i) => ({ ...s, done: i < 2 })), startAt: now,
        endAt: now + (state.demoSec ? state.demoSec * 1000 : a.min * 60000), ...(q.get('end') ? { ending: true, timeUp: true, endedAt: now } : {}) });
    }
    if (q.get('back')) ls.set('resting', { back: true, backAt: now });
    // 약속 카드 확인용: &eve=1 (21시 뒤처럼 내일 카드) · &promised=today|tomorrow (확정한 한 줄) · &pwin=0 (첫 줄 시간 고르기 펼침)
    state.demoEve = !!q.get('eve');
    if (q.get('promised')) {
      const date = q.get('promised') === 'tomorrow' ? addDaysStr(today(), 1) : today();
      const promises = selfcare().filter(c => c.days.includes(wdOf(date)) && c.start).map(c => ({ id: `${date}-${c.id}`, kind: c.id, date, start: c.start, end: c.end, firstStep: '', small: '' }));
      state.events = [{ id: 'demoP', ts: now, date: today(), type: 'promise-set', payload: { date, promises }, sent: true }];
    }
    if (q.get('pwin')) { const dr = promiseDraft(today()); if (dr.rows[+q.get('pwin')]) dr.rows[+q.get('pwin')].open = true; }
    if (q.get('run')) {
      const delays = +q.get('delays') || 0;
      state.run = q.get('phase') === 'run' ? { tid: q.get('run'), phase: 'run', endAt: now + runMs(), startedAt: now, praise: PRAISE.quick[0], delays, delaysTotal: delays }
        : { tid: q.get('run'), phase: 'count', countAt: now + LAUNCH.count * 1000, delays, delaysTotal: delays };
    }
    if (!routeHash()) draw(); return;   // 미리보기는 IndexedDB를 기다리지 않고 바로
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
  syncPromisePush();   // 꺼져 있던 동안 못 건 약속 푸시를 건다
  routeHash();         // 알림을 눌러 열렸으면 그 약속으로
})();
