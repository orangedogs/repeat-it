// Repeat It — 메인 앱
const $ = (id) => document.getElementById(id);
const media = $('media');
const linesEl = $('lines');
const stage = $('stage');

/* ================= 설정 ================= */
const DEFAULTS = { v: 2, repeat: 3, gap: '1', speed: '1', translate: false, showEn: true, listRepeat: 'off', autoAdvance: true, splitLong: true, showVideo: true, theme: 'dark', listOpen: true, volume: 1, muted: false, model: 'onnx-community/whisper-base.en_timestamped' };
let settings = { ...DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem('shadow:settings') || '{}');
  if (saved.v !== 2) delete saved.gap; // 따라 말하기 기본값(문장 길이만큼) 적용
  Object.assign(settings, saved);
} catch {}
settings.v = 2;
// 단어별 시각을 주는 모델로 교체 (대사가 빠르게 오가도 문장을 정확히 나누기 위해)
if (/^Xenova\/whisper-(tiny|base|small)\.en$/.test(settings.model)) settings.model = settings.model.replace('Xenova/', 'onnx-community/') + '_timestamped';
// 속도는 0.25 단위 (0.5 ~ 2.0)
{ const n = Math.round(Number(settings.speed) * 4) / 4; settings.speed = String(Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1); }
const saveSettings = () => { try { localStorage.setItem('shadow:settings', JSON.stringify(settings)); } catch {} };

/* ================= 상태 ================= */
let file = null, fileKey = null, hasVideo = false;
let rawSegs = [];       // 원본 문장 목록 (긴 문장 나누기 전) — 저장되는 것은 이것
let segs = [];          // 화면에 보이는 문장 [{start, end, text, sp, ko?, words }]
let koMap = {};         // 영어 문장 → 번역 (나누기를 바꿔도 번역 재사용)
let koEdited = {};      // 사용자가 직접 고친 번역 (영어 문장 → true)
let playlist = [];      // 재생 목록 [{ file, key }] — 파일 자체는 저장하지 않으므로 창을 닫으면 비워짐
let curItem = -1;
let autoplayKey = null; // 재생 목록에서 다음 파일로 넘어갈 때: 이 파일이 준비되면 첫 문장부터 바로 재생
const LIST_REPEAT = { off: '반복 안 함', one: '이 파일만 반복', all: '전체 반복' };
let names = {};         // 재생 목록에서 바꾼 이름 (파일 키 → 이름)
try { names = JSON.parse(localStorage.getItem('shadow:names') || '{}'); } catch {}
const displayName = (p) => names[p.key] || p.file.name;
let lineEls = [];
let idx = 0, rep = 1;
let phase = 'idle';     // idle | listen | speak
let running = false;
let gapTimer = null, gapStart = 0, gapDur = 0;
let worker = null;

/* ================= UI 헬퍼 ================= */
function show(section) {
  for (const id of ['drop', 'progress', 'player']) $(id).classList.toggle('hidden', id !== section);
  $('controls').classList.toggle('hidden', section !== 'player');
  $('siteFoot').classList.toggle('hidden', section !== 'drop'); // 재생 화면에서는 공간을 위해 숨김 (설정 맨 아래에 같은 내용)
  $('subMenuWrap').classList.toggle('hidden', section !== 'player');
  if (section !== 'player') { closeMenus(); resetBrowse(); }
  else setTimeout(() => showHelpHintOnce(), 600);
}
/* 알림 (화면 아래 가운데, 여러 개면 위로 쌓임)
   - 새 알림은 맨 아래에 나타나고, 먼저 뜬 알림은 위로 밀려 올라가며 흐려짐. 각자 자기 시간이 지나면 사라짐 (최대 3개)
   - important: 오류·건너뛴 파일처럼 꼭 봐야 하는 알림. 다른 알림에 덮여 사라지지 않음
   - 일반 알림('반복 3회' 등)은 새 일반 알림이 오면 바뀜 (같은 종류가 계속 쌓이지 않게)
   - onMore: 알림 오른쪽 글자 버튼 ('자세히 보기', '실행 취소' 등) */
const TOAST_MAX = 3, TOAST_GAP = 500; // 한꺼번에 생긴 알림은 0.5초 간격으로 하나씩 올라오게
let toastNextAt = 0; const toastPending = new Set();
let lineMenuIdx = -1, splitIdx = -1, lineMenuMoved = 0; // 현재 문장 ⋯ 메뉴가 열린 문장 / 문장 나누기 중인 문장
const toastBox = $('toasts');
function removeToast(el) {
  if (el && toastPending.has(el)) { toastPending.delete(el); clearTimeout(el._w); return; } // 아직 안 뜬 알림은 취소
  if (!el || !el.isConnected || el.classList.contains('out')) return;
  clearTimeout(el._t);
  el.classList.add('out');
  setTimeout(() => { flipToasts(() => el.remove()); }, 230); // 흐려지는 효과(0.22초)가 끝난 뒤 빼기
}
// 알림을 넣고 빼는 동안 나머지 알림이 부드럽게 움직이게 (이전 위치 → 새 위치)
function flipToasts(change) {
  const items = [...toastBox.children];
  const before = new Map(items.map((e) => [e, e.getBoundingClientRect().top]));
  change();
  for (const e of toastBox.children) {
    const b = before.get(e); if (b == null) continue;
    const d = b - e.getBoundingClientRect().top; if (!d) continue;
    e.animate([{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }], { duration: 220, easing: 'ease-out' });
  }
  [...toastBox.children].forEach((e, k, all) => e.classList.toggle('old', k < all.length - 1));
}
function toast(msg, ms = 2600, { onMore = null, important = false, moreText = '자세히 보기' } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (onMore ? ' actionable' : '') + (important ? ' important' : '');
  el.setAttribute('role', 'status');
  el.title = '누르면 닫혀요';
  el.textContent = msg;
  el.onclick = (e) => { e.stopPropagation(); removeToast(el); }; // 알림을 누르면 닫힘
  if (onMore) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'toast-more'; more.textContent = moreText;
    more.onclick = (e) => { e.stopPropagation(); removeToast(el); onMore(); };
    el.append(more);
  }
  const show = () => {
    toastPending.delete(el);
    flipToasts(() => {
      if (!important) [...toastBox.querySelectorAll('.toast:not(.important)')].forEach((e) => { clearTimeout(e._t); e.remove(); });
      toastBox.append(el);
      const live = [...toastBox.querySelectorAll('.toast:not(.out)')];
      live.slice(0, Math.max(0, live.length - TOAST_MAX)).forEach((e) => { clearTimeout(e._t); e.remove(); });
    });
    el._t = setTimeout(() => removeToast(el), onMore ? Math.max(ms, moreText === '자세히 보기' ? 6000 : 4000) : ms);
  };
  const now = Date.now();
  let at = Math.max(now, toastNextAt);
  // 기다리던 일반 알림은 새 것으로 바뀌고, 그 자리(시각)를 그대로 이어받음 (연달아 눌러도 늦어지지 않게)
  const waiting = important ? null : [...toastPending].find((e) => !e.classList.contains('important'));
  if (waiting) { at = waiting._at; removeToast(waiting); } else toastNextAt = at + TOAST_GAP;
  el._at = at;
  if (at > now) { toastPending.add(el); el._w = setTimeout(show, at - now); } else show();
  return el;
}
// 일반 알림 지우기 (문장 나누기 안내 등). 중요한 알림은 그대로
function hideToast() { toastBox.querySelectorAll('.toast:not(.important)').forEach(removeToast); toastPending.forEach((e) => { if (!e.classList.contains('important')) removeToast(e); }); }
// 윈도우 등 맥이 아니면 단축키 안내의 ⌘를 Ctrl로
if (!/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) document.querySelectorAll('kbd.mod').forEach((k) => { k.textContent = 'Ctrl'; });
/* ---------- 실행 취소 / 다시 실행 ----------
   문장·번역·싱크를 바꾸기 직전 상태를 기억해 두었다가 되돌림 (현재 파일 안에서만, 최근 30번까지) */
const UNDO_MAX = 30;
let undoStack = [], redoStack = [], syncSnap = null;
const snapshot = () => JSON.stringify({ raw: rawSegs.map(({ start, end, text, sp, whole, sub }) => ({ start, end, text, sp, whole, sub })), ko: koMap, ke: koEdited });
function recordUndo(snap = snapshot()) {
  if (!rawSegs.length) return;
  undoStack.push(snap);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack = [];
}
function resetUndo() { undoStack = []; redoStack = []; syncSnap = null; }
function restoreSnap(snap) {
  const d = JSON.parse(snap);
  stop();
  if (splitIdx >= 0) splitIdx = -1;
  syncSnap = null;
  koMap = d.ko; koEdited = d.ke;
  setSegments(d.raw, segs[idx]?.start || 0);
}
function undo() {
  if (!undoStack.length) { toast('더 이상 되돌릴 내용이 없어요.', 1500); return; }
  redoStack.push(snapshot());
  restoreSnap(undoStack.pop());
  toast('실행 취소했어요.', 1500);
}
function redo() {
  if (!redoStack.length) { toast('더 이상 다시 실행할 내용이 없어요.', 1500); return; }
  undoStack.push(snapshot());
  restoreSnap(redoStack.pop());
  toast('다시 적용했어요.', 1500);
}
// 바꾼 직후 알림: 휴대폰에서도 되돌릴 수 있게 [실행 취소]를 붙임
const undoToast = (msg, ms) => toast(msg, ms, { onMore: undo, moreText: '실행 취소' });

// 확인 창: Promise<boolean>. Enter = 확인, Esc = 취소
function askConfirm(title, msg, yes = '확인') {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title; $('modalMsg').textContent = msg; $('modalYes').textContent = yes;
    $('modal').classList.remove('hidden');
    setTimeout(() => $('modalYes').focus(), 0);
    const done = (v) => {
      $('modal').classList.add('hidden');
      $('modalYes').onclick = $('modalNo').onclick = $('modal').onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      else e.stopPropagation(); // 창이 떠 있는 동안 단축키 막기
    };
    $('modalYes').onclick = () => done(true);
    $('modalNo').onclick = () => done(false);
    $('modal').onclick = (e) => { if (e.target === $('modal')) done(false); };
    document.addEventListener('keydown', onKey, true);
  });
}
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${String(x).padStart(2, '0')}`; };

/* ================= 설정 패널 ================= */
function applySettingsToUI() {
  for (const sfx of ['2']) {
    if (document.activeElement !== $('repeatInput' + sfx)) $('repeatInput' + sfx).value = settings.repeat;
    $('repMinus' + sfx).disabled = settings.repeat <= 1; $('repPlus' + sfx).disabled = settings.repeat >= 10;
  }
  $('gap').value = settings.gap;
  $('translate').checked = $('quickKo').checked = settings.translate;
  $('quickEn').checked = settings.showEn;
  document.body.classList.toggle('en-off', !settings.showEn);
  $('autoAdvance').checked = settings.autoAdvance;
  { const b = $('plRepeat'), m = LIST_REPEAT[settings.listRepeat] ? settings.listRepeat : 'off';
    b.dataset.mode = m; b.title = LIST_REPEAT[m] + ' (누를 때마다 바뀜)'; b.setAttribute('aria-label', LIST_REPEAT[m]); }
  $('splitLong').checked = settings.splitLong;
  $('showVideo').checked = settings.showVideo;
  $('lightMode').checked = settings.theme === 'light';
  document.documentElement.dataset.theme = settings.theme;
  $('model').value = settings.model;
  $('speedVal').textContent = `${Number(settings.speed)}×`.replace(/^(\d)×$/, '$1.0×');
  $('speedPop').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.speed));
  media.volume = settings.volume; media.muted = settings.muted;
  $('volRange').value = settings.muted ? 0 : settings.volume;
  $('muteBtn').textContent = settings.muted || settings.volume === 0 ? '🔇' : settings.volume < 0.5 ? '🔉' : '🔊';
  media.playbackRate = Number(settings.speed);
  document.body.classList.toggle('ko-on', settings.translate);
  $('player').classList.toggle('has-video', hasVideo && settings.showVideo);
  updateStatus();
}
function openSettings(open) {
  $('settings').classList.toggle('open', open);
  $('settings').setAttribute('aria-hidden', String(!open));
  $('scrim').classList.toggle('hidden', !open);
}
$('settingsBtn').onclick = () => openSettings(!$('settings').classList.contains('open')); // 한 번 더 누르면 닫힘
$('closeSettings').onclick = $('scrim').onclick = () => openSettings(false);
// 반복 횟수: − [숫자] + (직접 입력 가능, 1~10)
const setRepeat = (n) => {
  const v = String(n).trim() === '' ? NaN : Number(n); // 빈칸이면 그대로 두기
  n = Number.isFinite(v) ? Math.min(10, Math.max(1, Math.round(v))) : settings.repeat;
  // 진행 중인 회차보다 적게 줄이면 지금 회차를 마지막 회차로 봄 (예: 3/5 → 2로 줄이면 2/2, 이번 회차가 끝나면 다음 문장)
  settings.repeat = n; if (rep > n) rep = n; saveSettings(); applySettingsToUI(); updateStatus();
};
// 화면 아래 '반복' 버튼의 조절기
for (const sfx of ['2']) {
  $('repMinus' + sfx).onclick = () => setRepeat(settings.repeat - 1);
  $('repPlus' + sfx).onclick = () => setRepeat(settings.repeat + 1);
  const inp = $('repeatInput' + sfx);
  inp.oninput = (e) => { const v = Number(e.target.value); if (v >= 1 && v <= 10 && Number.isInteger(v)) setRepeat(v); };
  inp.onchange = (e) => { setRepeat(e.target.value); e.target.value = settings.repeat; }; // 범위 밖이면 1~10으로 맞춤
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.target.blur(); if (sfx) closeMenus(); } });
}
$('gap').onchange = (e) => { settings.gap = e.target.value; saveSettings(); };
$('autoAdvance').onchange = (e) => { settings.autoAdvance = e.target.checked; saveSettings(); };
// 재생 목록 반복: off(목록 끝에서 멈춤) / one(이 파일 반복) / all(목록 전체 반복)
const setListRepeat = (v) => { settings.listRepeat = v; saveSettings(); applySettingsToUI(); };
$('plRepeat').onclick = () => {
  const order = ['off', 'one', 'all'];
  const v = order[(order.indexOf(settings.listRepeat) + 1) % order.length];
  setListRepeat(v);
  toast({ off: '반복 안 함 — 재생 목록이 끝나면 멈춰요.', one: '이 파일만 반복 — 현재 파일이 끝나면 첫 문장부터 다시 재생해요.', all: '전체 반복 — 재생 목록이 끝나면 첫 파일부터 다시 재생해요.' }[v], 2200);
};
$('splitLong').onchange = (e) => {
  settings.splitLong = e.target.checked; saveSettings();
  if (!rawSegs.length) return;
  // 다시 인식하지 않고 바로 적용. 지금 보던 위치에서 이어서
  const t = segs[idx]?.start || 0;
  stop();
  setSegments(rawSegs, t);
  toast(settings.splitLong ? '긴 문장을 나눠서 연습해요.' : '긴 문장을 통째로 연습해요.', 1600);
};
$('showVideo').onchange = (e) => { settings.showVideo = e.target.checked; saveSettings(); applySettingsToUI(); requestAnimationFrame(positionLines); };
$('lightMode').onchange = (e) => { settings.theme = e.target.checked ? 'light' : 'dark'; saveSettings(); applySettingsToUI(); };
$('model').onchange = (e) => { settings.model = e.target.value; saveSettings(); };
// 번역을 처음 켤 때 한 번만: 영어 텍스트가 외부 번역 서비스로 전송된다는 안내 (동의하면 다시 묻지 않음)
const TRANSLATE_NOTICE = '한국어 번역에는 크롬 브라우저의 내장 번역 기능을 사용해요. 영상과 음성 파일은 외부로 전송되지 않아요.';
const TR_ONLY_CHROME = '자동 번역은 PC용 크롬 브라우저(138 버전 이상)에서만 사용할 수 있어요.';
const setTranslate = async (on, anchor = $('koSwitch')) => {
  if (on && !settings.translate && !(await translatorAvailable())) {
    applySettingsToUI(); // 스위치는 꺼진 채로
    showMiniAlert(anchor, '자동 번역을 사용할 수 없어요', `${TR_ONLY_CHROME}\n\n연필 아이콘을 눌러 번역을 직접 입력하거나, 한국어 번역이 포함된 자막 파일을 불러올 수 있어요.`);
    return false;
  }
  if (on && !settings.translate) {
    let agreed = false; try { agreed = localStorage.getItem('shadow:translateNotice') === '1'; } catch {}
    if (!agreed) {
      applySettingsToUI(); // 확인 전에는 스위치를 꺼진 상태로
      if (!(await askConfirm('번역 기능 켜기', TRANSLATE_NOTICE, '번역 켜기'))) return false;
      try { localStorage.setItem('shadow:translateNotice', '1'); } catch {}
    }
  }
  settings.translate = on; saveSettings(); applySettingsToUI();
  if (on) translateAll();
  snapLines();
  return true;
};
$('translate').onchange = (e) => setTranslate(e.target.checked, e.target.closest('.switch'));
$('translateInfo').onclick = (e) => { e.stopPropagation(); showMiniAlert(e.currentTarget, '', TRANSLATE_NOTICE, { button: false }); };

// 가벼운 안내 상자: 화면을 어둡게 하지 않고 기준 요소 근처(위나 아래)에 띄움. 확인·바깥 누르기·Esc로 닫힘
function showMiniAlert(anchor, title, msg, { button = true, buttonText = '확인', list = null, foot = '' } = {}) {
  const box = $('miniAlert');
  $('maTitle').textContent = title; $('maMsg').textContent = msg;
  $('maMsg').classList.toggle('hidden', !msg);
  const ul = $('maList'); ul.innerHTML = ''; ul.classList.toggle('hidden', !list);
  for (const it of list || []) { const li = document.createElement('li'); const b = document.createElement('b'); b.textContent = it.name; const sp = document.createElement('span'); sp.textContent = it.reason; li.append(b, sp); ul.append(li); }
  $('maFoot').textContent = foot; $('maFoot').classList.toggle('hidden', !foot);
  $('maOk').textContent = buttonText;
  box.classList.toggle('no-btn', !button);
  box.classList.remove('hidden');
  const w = box.offsetWidth, h = box.offsetHeight;
  if (!anchor) { // 기준 요소가 없으면 화면 가운데
    Object.assign(box.style, { left: `${Math.max(12, (innerWidth - w) / 2)}px`, top: `${Math.max(12, (innerHeight - h) / 2)}px` });
    if (button) $('maOk').focus({ preventScroll: true });
    return;
  }
  const r = (anchor.getBoundingClientRect().width ? anchor : document.body).getBoundingClientRect();
  const left = Math.min(innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
  const above = r.top - h - 10 >= 8 && r.top + r.height / 2 > innerHeight / 2;
  const top = above ? r.top - h - 10 : Math.min(innerHeight - h - 8, r.bottom + 10);
  Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
  if (button) $('maOk').focus({ preventScroll: true });
}
const hideMiniAlert = () => $('miniAlert').classList.add('hidden');
// 문의 이메일: 메일 앱이 없는 환경도 있어서, 누르면 메일 앱 열기와 함께 주소를 복사함
document.querySelectorAll('.mail-link').forEach((a) => a.addEventListener('click', () => {
  navigator.clipboard?.writeText('orangedog.app@gmail.com').then(() => toast('이메일 주소를 복사했어요.', 2200)).catch(() => {});
}));
$('maOk').onclick = hideMiniAlert;
document.addEventListener('pointerdown', (e) => { if (!$('miniAlert').classList.contains('hidden') && !e.target.closest('#miniAlert')) hideMiniAlert(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('miniAlert').classList.contains('hidden')) hideMiniAlert(); });
$('quickKo').onchange = (e) => setTranslate(e.target.checked);
// 영어 가리기: 글자 수만큼 밑줄만 남김 (문장부호는 그대로)
// 영어 보이기/가리기: 화면을 다시 만들지 않고 단어 글자만 바꿈 (재생·따라 말하기 진행 막대가 끊기지 않게)
const setShowEn = (on) => {
  settings.showEn = on; saveSettings(); applySettingsToUI();
  segs.forEach((s, i) => {
    const el = lineEls[i]?.querySelector('.en');
    if (!el || el.isContentEditable || !s.words) return; // 고치는 중인 문장은 건드리지 않음
    const ws = s.text.split(/\s+/).filter(Boolean);
    s.words.forEach((w, k) => { w.el.textContent = on ? ws[k] : maskWord(ws[k] || ''); });
  });
  snapLines();
};
$('quickEn').onchange = (e) => setShowEn(e.target.checked);
const maskWord = (w) => w.replace(/[A-Za-z0-9]/g, '_');
const setSpeed = (v) => { settings.speed = String(Number(v)); media.playbackRate = Number(v); saveSettings(); applySettingsToUI(); };
// 속도: 누르면 가로로 옵션이 펼쳐짐
['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'].forEach((v) => {
  const b = document.createElement('button');
  b.dataset.v = v; b.textContent = `${v}×`.replace(/^(\d)×$/, '$1.0×'); b.setAttribute('role', 'menuitemradio');
  b.onclick = () => { setSpeed(v); closeMenus(); };
  $('speedPop').append(b);
});
function closeMenus() {
  for (const [btn, pop] of [['speedBtn', 'speedPop'], ['subBtn', 'subMenu'], ['repBtn', 'repPop']]) { $(pop).classList.add('hidden'); $(btn).setAttribute('aria-expanded', 'false'); }
  $('lineMenu').classList.add('hidden'); lineMenuIdx = -1;
}
const toggleMenu = (btn, pop) => (e) => {
  e.stopPropagation();
  const open = $(pop).classList.contains('hidden');
  closeMenus();
  if (open) { $(pop).classList.remove('hidden'); $(btn).setAttribute('aria-expanded', 'true'); }
  // 속도 옵션은 버튼 바로 위 가운데에 띄우되, 화면 밖으로 나가지 않게 옆으로 밀어 줌
  if (open && (pop === 'speedPop' || pop === 'repPop')) {
    const el = $(pop); el.style.transform = 'translateX(-50%)';
    const r = el.getBoundingClientRect();
    const shift = r.left < 8 ? 8 - r.left : r.right > innerWidth - 8 ? innerWidth - 8 - r.right : 0;
    el.style.transform = `translateX(calc(-50% + ${Math.round(shift)}px))`;
  }
};
$('speedBtn').onclick = toggleMenu('speedBtn', 'speedPop');
$('repBtn').onclick = toggleMenu('repBtn', 'repPop');
$('subBtn').onclick = toggleMenu('subBtn', 'subMenu');
document.addEventListener('click', (e) => { if (!e.target.closest('.menu, .speed-pop, .rep-pop')) closeMenus(); });

// 음량
const setVolume = (v) => { settings.volume = v; settings.muted = v === 0; saveSettings(); applySettingsToUI(); };
$('volRange').oninput = (e) => setVolume(Number(e.target.value));
$('volRange').addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) e.stopPropagation(); }); // 슬라이더의 ←/→는 음량에만 사용
const toggleMute = () => {
  if (settings.muted || settings.volume === 0) { settings.muted = false; if (settings.volume === 0) settings.volume = 0.8; }
  else settings.muted = true;
  saveSettings(); applySettingsToUI();
};
$('muteBtn').onclick = (e) => { e.preventDefault(); toggleMute(); };

/* ================= 파일 열기 · 재생 목록 ================= */
const MEDIA_RE = /\.(mp3|m4a|wav|aac|flac|ogg|oga|opus|mp4|m4v|mov|webm|mkv)$/i;
const isMedia = (f) => /^(audio|video)\//.test(f.type) || MEDIA_RE.test(f.name);

// 파일들을 목록에 추가. open이면 추가한 첫 파일을 바로 엶 (아무것도 안 열려 있으면 항상 엶)
const isSub = (f) => /\.(srt|vtt)$/i.test(f.name);
const baseName = (n) => (n || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
// 파일들을 목록에 추가. open이면 추가한 첫 파일을 바로 엶 (아무것도 안 열려 있으면 항상 엶)
// 영상과 같은 이름의 자막(.srt/.vtt)을 같이 넣으면 짝지어서, 열 때 음성인식 대신 그 자막을 씀
// 파일 추가 때 건너뛴 파일 (재생 목록 아래에서 다시 볼 수 있게 다음 추가 전까지 기억)
const SKIP_FMT = '지원하지 않는 파일 형식이에요.', SKIP_NAME = '이름이 같은 음성·영상 파일이 없어요.', SKIP_EXTRA = '한 번에 하나의 자막만 불러올 수 있어요.';
let lastSkipped = [];
function showSkipped(list) {
  lastSkipped = list;
  const n = list.length;
  $('plSkippedOpen').textContent = `건너뛴 파일 ${n}개 · 자세히 보기`;
  $('plSkipped').classList.toggle('hidden', !n);
  if (!n) return;
  if (n === 1) {
    const s = list[0];
    toast(s.reason === SKIP_FMT ? `지원하지 않는 파일 형식이라 ‘${s.name}’를 건너뛰었어요.` : s.reason === SKIP_NAME ? `파일명이 일치하지 않아 ‘${s.name}’ 자막을 건너뛰었어요.` : `한 번에 하나의 자막만 불러올 수 있어 ‘${s.name}’를 건너뛰었어요.`, 5000, { important: true });
  } else {
    const allSubs = list.every((s) => s.reason === SKIP_NAME);
    toast(allSubs ? `파일명이 일치하지 않아 자막 ${n}개를 건너뛰었어요.` : `파일 ${n}개를 건너뛰었어요.`, 6000, { important: true, onMore: openSkippedDetails });
  }
}
function openSkippedDetails() {
  if (!lastSkipped.length) return;
  const hasSub = lastSkipped.some((s) => s.reason === SKIP_NAME); // 이름 규칙 안내는 이름이 안 맞아 건너뛴 자막이 있을 때만
  showMiniAlert(null, `건너뛴 파일 ${lastSkipped.length}개`, '', {
    buttonText: '닫기', list: lastSkipped,
    foot: [hasSub ? '여러 파일을 함께 추가할 때는 음성·영상 파일과 자막 파일의 이름을 같게 맞춰 주세요.' : '',
      '📁 지원 형식: 음성·영상(mp3, m4a, wav, mp4, mov, webm 등) · 자막(SRT, VTT)'].filter(Boolean).join('\n'),
  });
}
$('plSkippedOpen').onclick = (e) => { e.stopPropagation(); openSkippedDetails(); };
$('plSkippedClose').onclick = (e) => { e.stopPropagation(); lastSkipped = []; $('plSkipped').classList.add('hidden'); };

function addFiles(files, open) {
  const meds = files.filter(isMedia), subs = files.filter(isSub);
  const other = files.filter((f) => !isMedia(f) && !isSub(f)); // 지원하지 않는 형식
  const skip = (f, reason) => ({ name: f.name, reason, isSubFile: isSub(f) });
  if (!meds.length) {
    if (subs.length && file) { // 자막만 넣으면 지금 열린 파일에 적용 (첫 자막만)
      showSkipped([...other.map((f) => skip(f, SKIP_FMT)), ...subs.slice(1).map((f) => skip(f, SKIP_EXTRA))]);
      importSubs(subs[0]); return;
    }
    // txt 같은 글자 파일만 넣었으면 자막을 넣으려던 것으로 보고 자막 형식을 안내 (그림 등 다른 파일은 일반 안내)
    const textLike = other.length && other.every((f) => /\.(txt|ass|ssa|sub|sbv|smi|sami|lrc|ttml|dfxp|xml)$/i.test(f.name));
    toast(subs.length ? '자막을 적용할 음성·영상 파일이 없어요. 음성·영상 파일과 함께 넣어 주세요.'
      : textLike ? '지원하지 않는 자막 형식이에요. SRT 또는 VTT 파일을 넣어 주세요.'
      : '지원하지 않는 파일 형식이에요. 음성·영상 파일을 넣어 주세요.', 4000, { important: true });
    return;
  }
  const added = [];
  let paired = 0, fresh = 0; // fresh: 이번에 새로 들어간 파일 수 (이미 목록에 있던 파일은 다시 넣지 않음)
  for (const f of meds) {
    const key = `shadow:data:${f.name}:${f.size}`;
    let i = playlist.findIndex((p) => p.key === key);
    if (i < 0) { playlist.push({ file: f, key }); i = playlist.length - 1; fresh++; }
    let sub = subs.find((s) => [baseName(f.name), baseName(names[key])].includes(baseName(s.name)));
    if (!sub && meds.length === 1 && subs.length === 1) sub = subs[0]; // 하나씩이면 이름이 달라도 짝지음
    if (sub) { playlist[i].sub = sub; paired++; }
    added.push(i);
  }
  // 건너뛴 파일: 지원하지 않는 형식 + 짝을 못 찾은 자막 (정상 파일은 그대로 추가됨)
  showSkipped([...other.map((f) => skip(f, SKIP_FMT)), ...subs.filter((s) => !playlist.some((p) => p.sub === s)).map((f) => skip(f, SKIP_NAME))]);
  if (added.length > 1 && !settings.listOpen) { settings.listOpen = true; saveSettings(); }
  const addOnly = () => {
    renderPlaylist();
    toast(!fresh ? '이미 재생 목록에 있는 파일이에요.'
      : fresh < added.length ? `중복된 파일 ${added.length - fresh}개를 제외하고 새 파일 ${fresh}개를 추가했어요.`
      : `${added.length}개 파일을 재생 목록에 추가했어요.`);
  };
  // 이미 열려 있는 파일을 다시 열려고 하면 (짝지은 자막이 없을 때) 다시 불러오지 않음
  if ((open || curItem < 0) && added[0] === curItem && playlist[curItem]?.key === fileKey && !playlist[curItem].sub) {
    if (fresh) addOnly(); else { renderPlaylist(); toast('이미 열려 있는 파일이에요.'); }
    return;
  }
  if (open || curItem < 0) {
    const files = added.map((k) => playlist[k].file);
    confirmStopAsr(added[0]).then((ok) => {
      if (!ok) { addOnly(); return; } // 음성인식을 계속하기로 하면 목록에만 추가
      pickClose = null; // 파일 열기·끌어다 놓기로 연 경우는 목록을 건드리지 않음
      openItem(playlist.findIndex((p) => p.file === files[0]));
      nextAdded = files.slice(1); // 첫 파일이 열리지 않으면 함께 넣은 다음 파일을 엶
    });
  } else addOnly();
}
// 음성인식 중에 다른 파일을 열려고 하면 먼저 물어봄 (음성인식은 한 번에 한 파일만)
async function confirmStopAsr(i) {
  if (!worker || curItem < 0 || i === curItem || !playlist[curItem]) return true;
  return askConfirm('음성인식을 중단할까요?',
    `음성인식은 한 번에 하나의 파일만 진행할 수 있어요.\n다른 파일을 열면 ‘${displayName(playlist[curItem])}’의 음성인식이 중단돼요. 나중에 다시 열면 처음부터 음성인식을 진행해야 해요.`,
    '다른 파일 열기');
}
// 휴대폰 등 좁은 화면: 목록에서 고른 파일이 실제로 열린 뒤에만 목록을 닫음 (열기에 실패하면 목록 유지)
let pickClose = null; // 'pending' 열리면 닫기 · 'closed' 닫았음
function closeListAfterPick() { if (pickClose === 'pending') { pickClose = 'closed'; setListOpen(false); } }
let nextAdded = []; // 함께 넣은 파일 중 아직 안 연 것 (첫 파일 열기에 실패하면 차례로 시도)
let backItem = -1; // 파일 열기에 실패하면 돌아갈 직전 파일 (문장 목록이 있던 경우만)
function openItem(i, { back = true } = {}) {
  if (!playlist[i]) return;
  // 돌아갈 파일: 문장이 이미 있는 파일만 (음성인식 중이던 파일은 사용자가 중단을 골랐으므로 다시 시작하지 않음)
  if (back) { backItem = segs.length && curItem >= 0 && curItem !== i && playlist[curItem] && !playlist[curItem].fail ? curItem : -1; nextAdded = []; }
  curItem = i;
  const sub = playlist[i].sub; playlist[i].sub = null; // 짝지은 자막은 처음 열 때 한 번만 사용
  loadFile(playlist[i].file, sub);
  renderPlaylist();
}
function removeItem(i) {
  playlist.splice(i, 1);
  if (i === curItem) {
    curItem = -1;
    if (playlist.length) { openItem(Math.min(i, playlist.length - 1)); return; }
    // 목록이 비면 처음 화면으로
    stop();
    if (worker) { worker.terminate(); worker = null; }
    if (media.src) { URL.revokeObjectURL(media.src); media.removeAttribute('src'); media.load(); }
    file = null; fileKey = null; segs = []; rawSegs = []; resetUndo();
    document.title = 'Repeat It';
    $('retranscribeBtn').disabled = true;
    show('drop');
  } else if (i < curItem) curItem--;
  renderPlaylist();
}
// 재생 목록 이름 바꾸기: Enter 저장 · Esc 취소 · 비우면 원래 파일 이름으로
function renameItem(i, li) {
  const p = playlist[i];
  const box = li.querySelector('.name');
  const input = document.createElement('input');
  input.className = 'name-input'; input.value = displayName(p);
  box.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save) {
      if (v && v !== p.file.name) names[p.key] = v; else delete names[p.key];
      try { localStorage.setItem('shadow:names', JSON.stringify(names)); } catch {}
      if (i === curItem) document.title = `${displayName(p)} — Repeat It`;
    }
    renderPlaylist();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    e.preventDefault();
    if (e.isComposing || e.keyCode === 229) saveAfterCompose = true; // 한글 조합 중 Enter → 조합이 끝나면 저장
    else finish(true);
  };
  let saveAfterCompose = false;
  input.addEventListener('compositionend', () => { if (saveAfterCompose) setTimeout(() => finish(true), 0); });
  input.addEventListener('keyup', (e) => { if (saveAfterCompose && e.key === 'Enter') finish(true); });
  input.onblur = () => finish(true);
}
function setListOpen(open) {
  settings.listOpen = open; saveSettings();
  renderPlaylist();
  requestAnimationFrame(positionLines);
}
/* ---------- 재생 목록 순서 바꾸기 (끌어서 놓기) ----------
   마우스: 누른 채 5px 넘게 움직이면 끌기 시작 · 터치: 꾹 누르고(0.35초) 움직이면 끌기 (짧게 밀면 목록 스크롤) */
let plDrag = null, plDragJustEnded = false;
function startPlDrag(e, i, li) {
  if (playlist.length < 2 || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (e.target.closest('.ren, .rm, .name-input')) return;
  const touch = e.pointerType !== 'mouse';
  const ul = $('plList');
  const d = plDrag = { i, li, ul, y0: e.clientY, active: false, to: i, timer: null };
  const activate = () => {
    if (plDrag !== d) return;
    d.active = true; li.classList.add('dragging'); ul.classList.add('reordering');
  };
  const clearMarks = () => ul.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const move = (ev) => {
    const dy = ev.clientY - d.y0;
    if (!d.active) {
      if (touch) { if (Math.abs(dy) > 8) end(false); return; } // 꾹 누르기 전에 움직이면 스크롤로 봄
      if (Math.abs(dy) > 5) activate(); else return;
    }
    li.style.transform = `translateY(${dy}px)`;
    // 놓을 자리: 끌고 있는 항목을 뺀 나머지 중 가운데가 손가락(마우스)보다 위에 있는 개수
    const others = [...ul.children].filter((x) => x !== li);
    let to = 0;
    others.forEach((x) => { const r = x.getBoundingClientRect(); if (r.top + r.height / 2 < ev.clientY) to++; });
    d.to = to;
    clearMarks();
    if (to < others.length) others[to].classList.add('drop-before'); else others[others.length - 1]?.classList.add('drop-after');
  };
  const end = (apply) => {
    clearTimeout(d.timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (plDrag === d) plDrag = null;
    clearMarks(); li.classList.remove('dragging'); li.style.transform = ''; ul.classList.remove('reordering');
    if (!d.active) return;
    plDragJustEnded = true; setTimeout(() => { plDragJustEnded = false; }, 0);
    if (apply && d.to !== d.i) movePlaylistItem(d.i, d.to);
  };
  const up = () => end(true);
  const cancel = () => end(false);
  if (touch) d.timer = setTimeout(activate, 350);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}
// 터치로 끄는 동안에는 목록이 스크롤되지 않게
$('plList').addEventListener('touchmove', (e) => { if (plDrag?.active) e.preventDefault(); }, { passive: false });
// 순서 바꾸기: 지금 파일·돌아갈 파일 번호도 새 순서에 맞춤 (재생은 끊기지 않음)
function movePlaylistItem(from, to) {
  const cur = playlist[curItem], back = playlist[backItem];
  const [m] = playlist.splice(from, 1);
  playlist.splice(to, 0, m);
  curItem = cur ? playlist.indexOf(cur) : -1;
  backItem = back ? playlist.indexOf(back) : -1;
  renderPlaylist();
}
function renderPlaylist() {
  $('listBtn').classList.toggle('hidden', !playlist.length);
  $('listCount').textContent = playlist.length ? ` ${playlist.length}` : '';
  $('playlist').classList.toggle('hidden', !(playlist.length && settings.listOpen));
  const ul = $('plList');
  ul.innerHTML = '';
  playlist.forEach((p, i) => {
    let n = 0;
    // 문장 수: 화면에 보이는 수와 같게 (긴 문장 나누기 반영). 지금 연 파일은 화면 목록 그대로
    if (i === curItem && p.key === fileKey && segs.length) n = segs.length;
    else try {
      const c = JSON.parse(localStorage.getItem(p.key) || 'null');
      if (c?.raw?.length) n = settings.splitLong ? splitLong(c.raw.map((x, ri) => ({ ...x, ri }))).length : c.raw.length;
      else n = c?.segs?.length || 0;
    } catch {}
    const li = document.createElement('li');
    li.className = 'pl-item' + (i === curItem ? ' cur' : '');
    li.title = p.file.name;
    const busy = i === curItem && worker;
    // 상태: 오디오 읽기 실패 / 음성인식 실패는 따로 표시 (문장 목록이 생기면 해제)
    if (n && p.fail) p.fail = null;
    const failText = p.fail === 'audio' ? '오디오를 읽지 못했어요' : p.fail === 'asr' ? '음성인식 실패 · 누르면 다시 시도' : '';
    const meta = busy ? '음성인식 중…' : failText || (p.sub ? '자막과 함께 열기' : n ? `문장 ${n}개 · 준비됨` : '누르면 음성인식 시작');
    li.innerHTML = `<span class="num">${i === curItem && !failText ? '▶' : i + 1}</span><div class="info"><div class="name"></div><div class="meta${failText && !busy ? ' fail' : (n || p.sub) && !busy ? ' ready' : ''}"></div></div>`;
    li.querySelector('.meta').textContent = meta;
    li.insertAdjacentHTML('beforeend', `<button class="ren" title="이름 바꾸기" aria-label="이름 바꾸기">✎</button><button class="rm" title="목록에서 빼기" aria-label="목록에서 빼기">✕</button>`);
    li.querySelector('.name').textContent = displayName(p);
    li.title = (names[p.key] ? `${displayName(p)} (원래 파일: ${p.file.name})` : p.file.name) + (playlist.length > 1 ? '\n드래그하여 순서 변경' : '');
    li.addEventListener('pointerdown', (e) => startPlDrag(e, i, li));
    li.onclick = (e) => {
      if (plDragJustEnded) { plDragJustEnded = false; return; } // 끌어서 옮긴 직후의 클릭은 파일 열기로 보지 않음
      if (e.target.closest('.name-input')) return;
      if (e.target.closest('.ren')) { renameItem(i, li); return; }
      if (e.target.closest('.rm')) { removeItem(i); return; }
      if (i !== curItem || (p.fail && !worker)) { // 실패한 파일은 다시 눌러 재시도 · 휴대폰에서는 고르면 목록 닫기
        confirmStopAsr(i).then((ok) => { if (!ok || !playlist[i]) return; pickClose = innerWidth <= 820 ? 'pending' : null; openItem(playlist.indexOf(p)); });
      }
    };
    ul.append(li);
  });
}
const pick = (open) => (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) addFiles(fs, open); };
$('fileInput').onchange = pick(true); $('fileInput2').onchange = pick(true); $('addInput').onchange = pick(false);
$('listBtn').onclick = () => setListOpen(!settings.listOpen);
$('plClose').onclick = () => setListOpen(false);
const dropBox = $('dropBox');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dropBox.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) dropBox.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const fs = [...(e.dataTransfer?.files || [])]; if (!fs.length) return;
  addFiles(fs, true);
});

async function loadFile(f, sub = null) {
  stop();
  // 이전 파일의 음성인식이 아직 돌고 있으면 중단 (끝난 결과가 새 파일에 덮어써지는 것 방지)
  if (worker) { worker.terminate(); worker = null; }
  file = f;
  fileKey = `shadow:data:${f.name}:${f.size}`;
  resetUndo();
  if (media.src) URL.revokeObjectURL(media.src);
  media.src = URL.createObjectURL(f);
  hasVideo = false;
  document.title = `${names[`shadow:data:${f.name}:${f.size}`] || f.name} — Repeat It`;
  $('retranscribeBtn').disabled = false;

  await new Promise((res) => {
    media.onloadedmetadata = () => { hasVideo = media.videoWidth > 0; $('mediaWrap').classList.toggle('portrait', media.videoHeight > media.videoWidth); res(); };
    media.onerror = () => res();
  });

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(fileKey) || 'null'); } catch {}
  koMap = {}; koEdited = {};
  segs = []; rawSegs = [];
  const hasCache = !!(cached?.raw?.length || cached?.segs?.length);
  // 같이 넣은 자막이 있으면 음성인식 대신 자막으로 (저장된 목록이 있으면 먼저 물어봄)
  if (sub && (!hasCache || await askConfirm('자막으로 바꿀까요?', `이 파일에는 저장된 문장 목록이 있어요.\n함께 선택한 자막 파일 ‘${sub.name}’의 내용으로 바꿀까요?`, '자막으로 바꾸기'))) {
    if (await importSubs(sub, { ask: false, replace: hasCache })) { renderPlaylist(); return; }
  }
  const quiet = autoplayKey === fileKey || quietLoad; // 다음 파일로 넘어갈 때·실패 후 돌아갈 때는 기존 안내를 남겨 둠
  quietLoad = false;
  if (cached?.raw?.length) {
    koMap = cached.ko || {};
    koEdited = cached.ke || {};
    setSegments(cached.raw, cached.t || 0);
    if (!quiet) toast('저장된 문장 목록을 불러왔어요.');
  } else if (cached?.segs?.length) { // 예전 저장 형식
    cached.segs.forEach((x) => { if (x.ko) koMap[x.text] = x.ko; });
    setSegments(cached.segs, cached.segs[cached.idx || 0]?.start || 0);
    if (!quiet) toast('저장된 문장 목록을 불러왔어요.');
  } else {
    transcribe();
  }
  renderPlaylist();
}

/* ================= 음성인식 ================= */
async function decodeAudio(f) {
  const buf = await f.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  try {
    const ab = await ctx.decodeAudioData(buf);
    if (ab.numberOfChannels === 1) return ab.getChannelData(0);
    const out = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels;
    }
    return out;
  } finally { ctx.close(); }
}

function setProgress(title, frac, detail) {
  if (title != null) $('progTitle').textContent = title;
  const fill = $('progFill');
  if (frac == null) fill.classList.add('indet');
  else { fill.classList.remove('indet'); fill.style.width = `${Math.round(frac * 100)}%`; }
  if (detail != null) $('progDetail').textContent = detail;
}

// 파일 처리 실패: 재생 목록에 실패 상태를 남기고, 보던 파일이 있으면 그 파일로 돌아감 (다른 파일에는 영향 없음)
function failCurrent(kind, msg) {
  const failed = playlist[curItem];
  if (pickClose === 'closed' && !settings.listOpen) setListOpen(true); // 목록에서 골랐다가 실패: 목록을 다시 보여 줌
  pickClose = null;
  if (segs.length) { show('player'); renderPlaylist(); toast(msg, 8000, { important: true }); return; } // 다시 인식하다 실패: 기존 문장 목록 그대로
  if (failed) failed.fail = kind;
  const back = backItem; backItem = -1;
  if (back >= 0 && playlist[back] && back !== curItem) { quietLoad = true; openItem(back, { back: false }); }
  else if (nextAdded.length) { // 돌아갈 파일이 없으면 함께 넣은 다음 파일을 엶
    const f = nextAdded.shift(), j = playlist.findIndex((p) => p.file === f);
    if (j >= 0) { quietLoad = true; openItem(j, { back: false }); } else { show('drop'); renderPlaylist(); document.title = 'Repeat It'; }
  } else { show('drop'); renderPlaylist(); document.title = 'Repeat It'; }
  toast(msg, 8000, { important: true });
}
let quietLoad = false; // 실패 후 돌아갈 때는 '저장된 문장 목록을 불러왔어요' 알림을 띄우지 않음 (오류 알림 유지)

async function transcribe() {
  if (!file) return;
  stop();
  openSettings(false);
  show('progress');
  setProgress('오디오 불러오는 중…', null, file.name);
  $('progNote').textContent = '';
  let audio;
  try { audio = await decodeAudio(file); }
  catch (e) {
    console.error(e);
    failCurrent('audio', `‘${playlist[curItem] ? displayName(playlist[curItem]) : file?.name || '파일'}’의 소리를 읽지 못했어요. 파일이 손상됐거나 음성이 없는 파일일 수 있어요.`);
    return;
  }
  closeListAfterPick(); // 소리를 읽었으면 열린 것으로 봄
  const duration = audio.length / 16000;
  const t0 = performance.now();
  if (worker) worker.terminate();
  worker = new Worker('worker.js', { type: 'module' });
  renderPlaylist();
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'status') { setProgress(m.text, null); $('progNote').textContent = m.note || ''; }
    else if (m.type === 'download') {
      setProgress('음성인식 모델 준비 중…', m.loaded / m.total, `${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB`);
      $('progNote').textContent = '처음 한 번만 내려받아요. 다음부터는 바로 시작돼요.';
    } else if (m.type === 'progress') {
      const el = (performance.now() - t0) / 1000;
      setProgress(null, m.value, `${fmt(duration)} 길이 · ${Math.round(m.value * 100)}% · 경과 ${fmt(el)}`);
    } else if (m.type === 'done') {
      worker.terminate(); worker = null;
      const s = alignLines(m.results, duration);
      if (!s.length) { show('drop'); toast('영어 음성을 찾지 못했어요.', 4000); return; }
      setSegments(s);
      toast(`${segs.length}개 문장으로 나눴어요. ▶ 버튼을 눌러 시작하세요.`); // 화면에 보이는 문장 수 (긴 문장 나누기 반영)
      renderPlaylist();
    } else if (m.type === 'error') {
      worker.terminate(); worker = null;
      console.error(m.message);
      failCurrent('asr', `음성인식에 실패했어요. (${m.message})`);
      renderPlaylist();
    }
  };
  const regions = detectSpeech(audio);
  const windows = makeWindows(regions, duration);
  worker.postMessage({ audio, windows, model: settings.model }, [audio.buffer]);
}
$('cancelBtn').onclick = () => {
  if (worker) { worker.terminate(); worker = null; }
  show(segs.length ? 'player' : 'drop');
  renderPlaylist();
};
// 다시 음성인식: 먼저 물어보고, 저장된 기록은 새 결과가 나올 때 덮어씀 (중간에 취소해도 기존 내용 유지)
$('retranscribeBtn').onclick = async () => {
  if (!file) return;
  if (segs.length && !(await askConfirm('현재 파일의 음성인식을 다시 할까요?', '현재 파일에서 수정한 내용을 포함해 모든 문장·번역·싱크가 새 음성인식 결과로 바뀌어요.\n중간에 취소하면 기존 내용은 그대로 유지돼요.', '다시 하기'))) return;
  openSettings(false);
  transcribe();
};

/* ---------- 말 구간 찾기 (소리 크기 기반) ----------
   Whisper의 시간 정보는 부정확해서 문장 끝이 잘리기 쉽다. 그래서 실제 오디오에서
   '말하는 구간'과 '쉬는 구간'을 직접 찾고, 문장은 항상 실제 쉼에서 끝나도록 맞춘다. */
function detectSpeech(audio, SR = 16000) {
  const F = 320; // 20ms
  const n = Math.floor(audio.length / F);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * F, e = j + F; j < e; j++) sum += audio[j] * audio[j];
    db[i] = Math.max(-90, 10 * Math.log10(sum / F + 1e-12));
  }
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(n * 0.1)] ?? -90, peak = sorted[Math.floor(n * 0.95)] ?? 0;
  const thr = Math.min(Math.max(floor + 15, -50), peak - 15);
  const fs = F / SR;
  let regs = [];
  let st = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && db[i] > thr;
    if (on && st < 0) st = i;
    if (!on && st >= 0) { regs.push({ start: st * fs, end: i * fs }); st = -1; }
  }
  // 0.3초보다 짧은 끊김은 같은 말로 보고 합침, 아주 짧은 소리(잡음)는 버림
  const merged = [];
  for (const r of regs) {
    const p = merged[merged.length - 1];
    if (p && r.start - p.end < 0.3) p.end = r.end; else merged.push({ ...r });
  }
  const dur = audio.length / SR;
  return merged.filter((r) => r.end - r.start >= 0.12)
    .map((r) => ({ start: Math.max(0, r.start - 0.05), end: Math.min(dur, r.end + 0.08) }));
}

// 말 구간들을 15초 이하 창으로 묶음 (항상 쉼에서 자름)
function makeWindows(regions, duration, MAX = 15, LONG = 0.8) {
  if (!regions.length) {
    const w = [];
    for (let t = 0; t < duration; t += MAX) w.push({ start: t, end: Math.min(duration, t + MAX), regs: [{ start: t, end: Math.min(duration, t + MAX) }] });
    return w;
  }
  const out = [];
  for (const r of regions) {
    // 쉼 없이 15초를 넘는 구간은 어쩔 수 없이 잘라서 처리
    const pieces = [];
    for (let t = r.start; t < r.end; t += MAX) pieces.push({ start: t, end: Math.min(r.end, t + MAX) });
    for (const p of pieces) {
      const w = out[out.length - 1];
      const gap = w ? p.start - w.end : 0;
      // 0.8초 이상 쉬면 새 창으로 (각 구절이 정확한 시간에 맞춰짐). 단 1.2초 미만의 아주 짧은 창은 이어 붙임
      const join = w && p.end - w.start <= MAX && (gap < LONG || (w.end - w.start < 1.2 && gap < 2));
      if (join) { w.end = p.end; w.regs.push(p); }
      else out.push({ start: p.start, end: p.end, regs: [p] });
    }
  }
  return out;
}

// 말하는 구간들(sp)에서 '말한 시간'의 frac 지점이 실제 몇 초인지
function speechTime(sp, frac) {
  const total = sp.reduce((a, r) => a + r[1] - r[0], 0);
  let left = frac * total;
  for (const r of sp) { const d = r[1] - r[0]; if (left <= d) return r[0] + left; left -= d; }
  return sp[sp.length - 1][1];
}
// 반대로, 현재 시각 t까지 말한 시간의 비율 (쉬는 동안은 하이라이트가 멈춤)
function speechFrac(sp, t) {
  const total = sp.reduce((a, r) => a + r[1] - r[0], 0) || 1;
  let done = 0;
  for (const r of sp) { if (t >= r[1]) done += r[1] - r[0]; else { if (t > r[0]) done += t - r[0]; break; } }
  return done / total;
}

/* 단어별 시각 → 문장 목록
   문장부호(. ! ?), 화자 바뀜 표시(-), 1초 넘는 쉼에서 끊고, 문장의 시작·끝은 실제 단어 시각으로 정함 */
function linesFromWords(words) {
  // 음악·효과음 표시([Music], (laughs), ♪) 제거
  const ws = [];
  let depth = 0;
  for (const x of words) {
    const opens = (x.w.match(/[\[(]/g) || []).length, closes = (x.w.match(/[\])]/g) || []).length;
    const noise = depth > 0 || opens > 0 || /♪/.test(x.w);
    depth = Math.max(0, depth + opens - closes);
    if (!noise) ws.push({ ...x });
  }
  // Whisper가 가끔 같은 구절을 그대로 한 번 더 적음 (예: "each other each other") → 2~6단어짜리 연속 반복은 하나만 남김
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
  for (let i = 0; i < ws.length; i++) {
    for (let n = 6; n >= 2; n--) {
      if (i + 2 * n > ws.length) continue;
      let same = true;
      for (let k = 0; k < n && same; k++) same = norm(ws[i + k].w) === norm(ws[i + n + k].w) && norm(ws[i + k].w) !== '';
      if (same && /[.!?…]$/.test(ws[i + n - 1].w)) same = false; // "Get help! Get help!"처럼 문장째 반복은 실제로 두 번 말한 것
      if (same) { ws[i + n - 1].e = Math.max(ws[i + n - 1].e, ws[i + 2 * n - 1].e); ws[i + n - 1].w = ws[i + 2 * n - 1].w; ws.splice(i + n, n); break; }
    }
  }
  // 단어 앞뒤에 쉬는 시간이 있으면 Whisper가 그 단어를 쉼까지 늘려 잡는 경우가 많음
  // (예: 'I' 한 글자가 1.1초) → 문장이 말하기 전에 먼저 나타남. 글자 수에 비해 너무 긴 단어는 쉼 쪽을 잘라냄
  ws.forEach((x, i) => {
    const letters = x.w.replace(/[^A-Za-z0-9']/g, '').length || 1;
    const target = (0.12 + 0.075 * letters) * 1.5;
    if (x.e - x.s <= Math.max(0.45, target)) return;
    const prev = ws[i - 1], next = ws[i + 1];
    const adjPrev = prev && x.s - prev.e < 0.05, adjNext = next && next.s - x.e < 0.05;
    if (adjPrev && !adjNext) x.e = x.s + target; // 뒤가 쉼 → 끝을 당김
    else x.s = x.e - target;                       // 앞이 쉼(기본) → 시작을 늦춤
  });
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const sp = [];
    for (const x of cur) {
      const last = sp[sp.length - 1];
      if (last && x.s - last[1] < 0.3) last[1] = Math.max(last[1], x.e); else sp.push([x.s, Math.max(x.e, x.s + 0.05)]);
    }
    out.push({ start: sp[0][0], end: sp[sp.length - 1][1], text: cur.map((x) => x.w).join(' '), sp });
    cur = [];
  };
  ws.forEach((x, i) => {
    // 화자가 바뀌는 표시 "- " 앞에서 끊음
    if (/^[-–—]/.test(x.w)) { flush(); x.w = x.w.replace(/^[-–—]+\s*/, ''); if (!x.w) return; }
    cur.push(x);
    const next = ws[i + 1];
    const abbr = /^(Mr|Mrs|Ms|Dr|St|Jr|Sr|vs)\.$/i.test(x.w);
    const endS = !abbr && /[.!?…]["'”’)]?$/.test(x.w) && (!next || !/^[a-z]/.test(next.w));
    if (endS || (next && next.s - x.e > 1.0) || cur.length >= 40) flush();
  });
  flush();
  // 단어 끝 시각은 약간 이르게 나오는 경향이 있어 0.2초 여유 (다음 문장 시작은 넘지 않게)
  out.forEach((l, i) => {
    const nx = out[i + 1];
    l.end = Math.min(l.end + 0.2, nx ? Math.max(l.end, nx.start - 0.02) : l.end + 0.2);
    l.sp[l.sp.length - 1][1] = l.end;
  });
  return out;
}

/* 창별 받아쓰기 결과 + 말 구간 → 쉐도잉 문장 목록 */
function alignLines(results, duration) {
  const lines = [];
  let stream = []; // 단어 시각이 있는 결과는 창 경계와 상관없이 이어 붙여서 문장 단위로 다시 나눔
  const flushStream = () => { lines.push(...linesFromWords(stream)); stream = []; };
  results.forEach((res) => {
    // Whisper가 가끔 구간 밖(영상 끝 너머 등)의 엉뚱한 단어 시각을 줌 → 그런 구간은 단어 시각을 버리고 말 구간 기준으로 맞춤
    const badWords = (res.words || []).some((x) => x.s > res.end + 1 || x.e < res.start - 1 || x.e < x.s - 0.05 || x.s > duration);
    if (res.words?.length && !badWords) { stream.push(...res.words); return; }
    flushStream();
    const regs = res.regs?.length ? res.regs : [{ start: res.start, end: res.end }];
    const words = (res.text || '').replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return;
    // 글자 수 비율 → 말하는 시간(쉼 제외)으로 환산
    const speech = regs.reduce((a, r) => a + r.end - r.start, 0);
    const chars = words.reduce((a, w) => a + w.length + 1, 0);
    const timeAt = (frac) => {
      let left = frac * speech;
      for (const r of regs) { const d = r.end - r.start; if (left <= d) return r.start + left; left -= d; }
      return regs[regs.length - 1].end;
    };
    let acc = 0;
    const wt = words.map((w) => { const a = acc; acc += w.length + 1; return { w, s: timeAt(a / chars), e: timeAt(acc / chars) }; });

    // 자를 후보: 각 말 구간의 끝(= 쉼 직전). 마지막 구간 끝은 항상 자름
    const last = regs.length - 1;
    const cuts = new Map(); // 구간 번호 → 단어 개수(여기까지가 한 문장)
    const nearestBoundary = (t, maxDist) => {
      let best = -1, bd = Infinity;
      regs.forEach((r, k) => { const d = Math.abs(r.end - t); if (d < bd) { bd = d; best = k; } });
      return bd <= maxDist ? best : -1;
    };
    const hasPunct = /[.!?]/.test(res.text);
    wt.forEach((x, i) => {
      const next = wt[i + 1];
      if (/[.!?]["'”’)]?$/.test(x.w) && (!next || /^["'“‘(]?[A-Z0-9]/.test(next.w))) {
        const k = nearestBoundary(x.e, 2.5);
        if (k >= 0) cuts.set(k, Math.max(cuts.get(k) || 0, i + 1));
      }
    });
    if (!hasPunct) {
      // 문장부호가 없으면(가끔 Whisper가 빼먹음) 0.5초 이상 쉬는 곳마다 자름
      regs.forEach((r, k) => {
        if (k === last || regs[k + 1].start - r.end < 0.5) return;
        const idx = wt.findIndex((x) => (x.s + x.e) / 2 > r.end);
        if (idx > 0) cuts.set(k, Math.max(cuts.get(k) || 0, idx));
      });
    }
    cuts.set(last, words.length);
    let prevIdx = 0, prevK = -1;
    [...cuts.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, idx]) => {
      if (idx <= prevIdx) return;
      lines.push({ start: regs[prevK + 1].start, end: regs[k].end, text: words.slice(prevIdx, idx).join(' '), sp: regs.slice(prevK + 1, k + 1).map((r) => [r.start, r.end]) });
      prevIdx = idx; prevK = k;
    });
  });
  flushStream();
  lines.sort((a, b) => a.start - b.start);

  // 구절마다 따로 인식하면 Whisper가 끝에 마침표를 붙이므로, 소문자로 시작하는 조각은 앞 문장에 이어 붙임
  const merged = [];
  for (const l of lines) {
    const p = merged[merged.length - 1];
    const wc = (t) => t.split(' ').length;
    if (p && /^[a-z]/.test(l.text) && l.start - p.end < 2.5 && wc(p.text) + wc(l.text) <= 24) {
      p.text = p.text.replace(/\.$/, '') + ' ' + l.text; p.end = l.end; p.sp = [...p.sp, ...l.sp];
    } else merged.push({ ...l, text: l.text.charAt(0).toUpperCase() + l.text.slice(1) });
  }
  lines.length = 0; lines.push(...merged);

  const r2 = (x) => +x.toFixed(2);
  return sanitizeLines(lines.map((l) => ({ start: r2(l.start), end: r2(Math.min(l.end, duration)), text: l.text, sp: (l.sp || []).map(([x, y]) => [r2(x), r2(y)]) })), duration);
}

/* 시간이 깨진 문장 바로잡기 (끝이 시작보다 앞, 영상 길이 밖, 앞 문장보다 먼저 시작)
   깨진 문장들이 이어져 있으면 앞뒤 멀쩡한 문장 사이 시간을 글자 수 비율로 나눠 줌. 멀쩡하면 그대로 */
function sanitizeLines(lines, duration) {
  const D = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const ok = (l, prev) => l.end - l.start >= 0.1 && l.start >= 0 && l.end <= D + 0.05 && (!prev || l.start >= prev.start);
  const out = lines.map((l) => ({ ...l }));
  let changed = false;
  for (let i = 0; i < out.length; i++) {
    if (ok(out[i], out[i - 1])) continue;
    let j = i; while (j + 1 < out.length && !ok(out[j + 1], out[j])) j++; // i..j: 깨진 문장 묶음
    const n = j - i + 1;
    let b = j + 1 < out.length ? out[j + 1].start : D;
    // 앞이나 뒤에 기준이 될 문장이 없으면 문장당 최대 3초까지만 씀
    const a = i > 0 ? Math.min(out[i - 1].end, D) : Math.max(0, (Number.isFinite(b) ? b : 0) - 3 * n);
    if (j + 1 >= out.length) b = Math.min(D, a + 3 * n);
    let from = a;
    if (b - from < 0.6 * n) from = Math.max(i > 0 ? out[i - 1].start + 0.1 : 0, b - 1.5 * n);
    const chars = out.slice(i, j + 1).map((l) => l.text.length + 1), total = chars.reduce((x, y) => x + y, 0);
    let t = from;
    for (let k = i; k <= j; k++) {
      const d = (b - from) * chars[k - i] / total;
      const r2 = (x) => +x.toFixed(2);
      out[k].start = r2(t); out[k].end = r2(t + d); out[k].sp = [[out[k].start, out[k].end]];
      t += d;
    }
    changed = true; i = j;
  }
  return changed ? out : lines;
}

/* 긴 문장 나누기 (설정에서 켜고 끌 수 있음 — 원본 문장 목록은 그대로 두고 화면에 보일 때만 나눔)
   14단어가 넘으면 가운데에 가까운 곳에서 둘로: 문장부호 → 쉼표 → (부호가 없으면) 가장 길게 쉬는 곳 */
const LONG_WORDS = 14;
function splitLong(lines) {
  const split = (seg) => {
    const words = seg.text.split(' ');
    if (words.length <= LONG_WORDS) return [seg];
    const sp = seg.sp?.length ? seg.sp : [[seg.start, seg.end]];
    // 각 단어가 끝나는 대략의 시각 (말하는 시간을 글자 수 비율로 나눔)
    const cl = words.map((w) => w.length + 1), totalC = cl.reduce((x, y) => x + y, 0);
    let accC = 0;
    const wordEnd = cl.map((c) => speechTime(sp, (accC += c) / totalC));
    // 그 단어 끝 근처(1초 안)에 실제 쉬는 곳이 있으면 그 쉼 번호 (글자 수로 잡은 시각이라 오차를 넉넉히)
    const pauseNear = (k) => {
      let best = null, bd = 1.0;
      for (let g = 0; g < sp.length - 1; g++) { const d = Math.abs(sp[g][1] - wordEnd[k]); if (d < bd) { bd = d; best = g; } }
      return best;
    };
    // 문장부호 위치 중 가운데에 가까운 곳. 실제 쉼이 있는 곳을 먼저 고름 (말 중간에서 끊기지 않게)
    const pick = (re) => {
      let best = -1, bd = Infinity, bestP = -1, bdP = Infinity;
      words.forEach((w, k) => {
        if (k < 3 || k > words.length - 4 || !re.test(w)) return;
        const d = Math.abs(k + 1 - words.length / 2);
        if (d < bd) { bd = d; best = k; }
        if (pauseNear(k) != null && d < bdP) { bdP = d; bestP = k; }
      });
      return bestP >= 0 ? { cut: bestP, gap: pauseNear(bestP) } : { cut: best, gap: null };
    };
    let { cut, gap: gapK } = pick(/[.!?]["'”’)]?$/); // cut = 앞 조각의 마지막 단어 번호, gapK = 자를 쉼 번호
    if (cut < 0 || gapK == null) {
      const c2 = pick(/[,;:]$/);
      if (cut < 0 || c2.gap != null) ({ cut, gap: gapK } = c2.cut >= 0 ? c2 : { cut, gap: gapK });
    }
    if (cut < 0 && sp.length > 1) {
      // 문장부호가 없으면: 가운데에 가깝고 길게 쉬는 곳(숨 쉬는 곳)에서 자름
      let score = -Infinity;
      for (let k = 0; k < sp.length - 1; k++) {
        const frac = speechFrac(sp, sp[k][1]);
        let acc = 0, wi = 0;
        while (wi < words.length && acc + cl[wi] / 2 < frac * totalC) acc += cl[wi++];
        if (wi < 4 || wi > words.length - 4) continue;
        const sc = (sp[k + 1][0] - sp[k][1]) - Math.abs(frac - 0.5) * 1.5;
        if (sc > score) { score = sc; gapK = k; cut = wi - 1; }
      }
    }
    if (cut < 0) return [seg];
    const a = words.slice(0, cut + 1).join(' '), b = words.slice(cut + 1).join(' ');
    // 자르는 시각: 가능하면 실제 쉬는 지점에 맞춤
    if (gapK == null) {
      const mid = speechTime(sp, a.length / (a.length + b.length));
      let bd = Infinity;
      for (let k = 0; k < sp.length - 1; k++) { const d = Math.abs(sp[k][1] - mid); if (d < bd) { bd = d; gapK = k; } }
      if (bd >= 2) gapK = null;
      if (gapK == null) {
        const spA = sp.filter((r) => r[0] < mid).map((r) => [r[0], Math.min(r[1], mid)]);
        const spB = sp.filter((r) => r[1] > mid).map((r) => [Math.max(r[0], mid), r[1]]);
        return [...split({ start: seg.start, end: mid, text: a, sp: spA }), ...split({ start: mid, end: seg.end, text: b, sp: spB })];
      }
    }
    const spA = sp.slice(0, gapK + 1), spB = sp.slice(gapK + 1);
    return [...split({ start: seg.start, end: spA[spA.length - 1][1], text: a, sp: spA }), ...split({ start: spB[0][0], end: seg.end, text: b, sp: spB })];
  };
  // whole: 직접 나누거나 합친 문장은 자동으로 다시 나누지 않음
  return lines.flatMap((l) => (l.whole ? [l] : split(l)).map((x) => ({ ...x, ri: l.ri })));
}

/* ================= 자막 불러오기/내보내기 ================= */
$('subInput').onchange = (e) => { closeMenus(); const f = e.target.files?.[0]; e.target.value = ''; if (f) importSubs(f); };
// replace: 이미 있던 문장 목록을 자막으로 바꾸는 경우인지 (알림 문구가 다름)
async function importSubs(f, { ask = true, replace = segs.length > 0 } = {}) {
  const text = await f.text();
  const toSec = (t) => { const p = t.trim().replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const clean = (l) => l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim();
    const body = lines.slice(ti + 1).map(clean).filter(Boolean);
    // 한글이 들어간 줄은 번역으로 (자막 내려받기로 저장한 파일은 영어 줄 + 한글 줄)
    const en = body.filter((l) => !/[가-힣]/.test(l)).join(' ');
    const ko = body.filter((l) => /[가-힣]/.test(l)).join(' ');
    if (en) out.push({ start: toSec(a), end: toSec(b.trim().split(' ')[0]), text: en, ko, whole: true, sub: true }); // 자막 줄은 길어도 자동으로 나누지 않고 그대로 · sub: 단어별 시각을 모름
  }
  if (!out.length) { toast('자막 파일을 읽지 못했어요. SRT 또는 VTT 형식인지 확인해 주세요.', 4000); return false; }
  const willShow = out.length; // 자막 줄 = 문장 (자동으로 나누지 않음)
  if (ask && segs.length && !(await askConfirm('자막으로 바꿀까요?', `현재 문장 목록을 ‘${f.name}’의 문장 ${willShow}개로 바꿔요.\n기존 음성인식 결과와 직접 수정한 내용도 모두 새 자막의 내용으로 바뀌어요.`, '바꾸기'))) {
    toast('자막 불러오기를 취소했어요.', 1800);
    return false;
  }
  stop();
  // 음성인식 중에 자막을 적용하면 음성인식은 멈춤 (끝나면서 자막을 덮어쓰지 않게)
  if (worker) { worker.terminate(); worker = null; }
  recordUndo();
  out.forEach((x) => { if (x.ko) { koMap[x.text] = x.ko; koEdited[x.text] = true; } delete x.ko; });
  setSegments(out);
  // 문장 수는 화면에 보이는 수 (긴 문장 나누기 반영)
  if (replace) (undoStack.length ? undoToast : toast)(`✓ 자막 파일의 문장 ${segs.length}개로 바꿨어요.`, 3000);
  else toast(`✓ 자막 파일에서 문장 ${segs.length}개를 불러왔어요.`, 4000);
  // 시간이 영상 길이를 벗어났거나 잘못된 줄은 setSegments에서 자동으로 맞춰짐 → 몇 개였는지 알려 줌
  const fixed = rawSegs.filter((r, k) => out[k] && (Math.abs(r.start - out[k].start) > 0.005 || Math.abs(r.end - out[k].end) > 0.005)).length;
  if (fixed) toast(`자막 시간이 영상 길이를 벗어난 문장 ${fixed}개의 싱크를 자동으로 조정했어요. ⋯ → 싱크 맞추기에서 확인해 주세요.`, 8000, { important: true });
  return true;
}
$('exportBtn').onclick = () => {
  closeMenus();
  const ts = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const srt = segs.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text}${settings.translate && s.ko ? '\n' + s.ko : ''}\n`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([srt], { type: 'text/plain' }));
  a.download = ((playlist[curItem] && displayName(playlist[curItem])) || file?.name || 'repeat-it').replace(/\.[^.]+$/, '') + '.srt';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ================= 화면 구성 ================= */
function persist() {
  if (!fileKey) return;
  const raw = rawSegs.map(({ start, end, text, sp, whole, sub }) => ({ start, end, text, sp, whole: whole || undefined, sub: sub || undefined }));
  const data = JSON.stringify({ v: 3, raw, ko: koMap, ke: koEdited, t: segs[idx]?.start || 0, at: Date.now() });
  // 브라우저 저장 공간(약 5MB)이 가득 차면, 가장 오래 안 쓴 다른 파일의 기록을 지울지 물어봄
  try { localStorage.setItem(fileKey, data); return; } catch {}
  let oldKey = null, oldAt = Infinity;
  for (let k = 0; k < localStorage.length; k++) {
    const key = localStorage.key(k);
    if (!key.startsWith('shadow:data:') || key === fileKey) continue;
    let at = 0; try { at = JSON.parse(localStorage.getItem(key)).at || 0; } catch {}
    if (at < oldAt) { oldAt = at; oldKey = key; }
  }
  if (oldKey) askFreeSpace(oldKey);
  else if (!persist.warned) { persist.warned = true; toast('브라우저 저장 공간이 부족해서 저장하지 못했어요.', 3500); }
}
// 저장 공간이 가득 찼을 때: 가장 오래 안 쓴 파일 기록을 지워도 되는지 물어봄 (지금 파일은 안 지움)
// 거절하면 이번에 연 동안은 다시 묻지 않음 (진행 위치·수정 내용이 저장되지 않는다고 알림)
let freeAsking = false, freeDeclined = false;
async function askFreeSpace(oldKey) {
  if (freeAsking || freeDeclined) return;
  freeAsking = true;
  stop();
  const name = oldKey.replace(/^shadow:data:/, '').replace(/:\d+$/, '');
  const ok = await askConfirm('저장 공간이 부족해요',
    `브라우저 저장 공간이 부족해 현재 파일의 문장·번역·재생 위치를 저장하지 못했어요.\n가장 오래 사용하지 않은 ‘${names[oldKey] || name}’의 기록을 삭제하고 저장할까요?\n삭제한 파일은 다시 열 때 음성인식이 필요해요.`, '삭제하고 저장');
  freeAsking = false;
  if (ok) { localStorage.removeItem(oldKey); persist(); toast('오래된 기록을 삭제하고 저장했어요.', 2000); }
  else { freeDeclined = true; toast('저장하지 않았어요. 새로고침하거나 탭을 닫으면 현재 파일의 문장·번역·재생 위치 변경 내용이 사라져요.', 4000); }
}

// 원본 목록 → 화면용 목록 (설정에 따라 긴 문장 나누기). t초 위치의 문장에서 이어서 시작
function setSegments(raw, t = 0) {
  rawSegs = sanitizeLines(raw.map(({ start, end, text, sp, whole, sub }) => ({ start, end, text, sp, whole, sub })), media.duration);
  const withRi = rawSegs.map((s, ri) => ({ ...s, ri })); // ri: 원본 문장 번호 (영어 문장 수정 때 사용)
  segs = (settings.splitLong ? splitLong(withRi) : withRi).map((s) => ({ ...s, ko: koMap[s.text] }));
  if (syncIdx !== -2) syncIdx = -1; // 목록을 다시 만들면 열려 있던 싱크 창은 닫음
  resetBrowse();
  idx = 0;
  segs.forEach((s, i) => { if (s.start <= t + 0.01) idx = i; });
  rep = 1;
  persist();
  render();
  closeListAfterPick();
  renderPlaylist(); // 재생 목록의 문장 수도 바로 맞춤 (나누기·합치기·되돌리기 등)
  show('player');
  applySettingsToUI();
  requestAnimationFrame(() => { linesEl.style.transition = 'none'; positionLines(); linesEl.offsetHeight; linesEl.style.transition = ''; });
  if (settings.translate) translateAll();
  if (autoplayKey && autoplayKey === fileKey) { autoplayKey = null; setTimeout(() => jumpTo(0, true), 300); }
}

function render() {
  linesEl.innerHTML = '';
  lineEls = segs.map((s, i) => {
    const li = document.createElement('div');
    li.className = 'line';
    const en = document.createElement('div'); en.className = 'en';
    const words = s.text.split(/\s+/).filter(Boolean);
    const weights = words.map((w) => w.replace(/[^\w']/g, '').length + 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    s.words = words.map((w, k) => {
      const span = document.createElement('span'); span.className = 'w'; span.textContent = settings.showEn ? w : maskWord(w);
      en.append(span, ' ');
      const at = acc / total; acc += weights[k];
      return { el: span, at };
    });
    const pen = (kind, title) => {
      const b = document.createElement('button'); b.className = 'pen'; b.textContent = '✎'; b.title = title; b.setAttribute('aria-label', title);
      b.onclick = (e) => { e.stopPropagation(); editLine(i, kind); };
      return b;
    };
    const enRow = document.createElement('div'); enRow.className = 'en-row';
    const syncBtn = document.createElement('button'); syncBtn.className = 'pen more'; syncBtn.textContent = '⋯'; syncBtn.title = '싱크 맞추기 · 문장 나누기 · 문장 합치기'; syncBtn.setAttribute('aria-label', '싱크 맞추기 · 문장 나누기 · 문장 합치기');
    syncBtn.setAttribute('aria-haspopup', 'true');
    syncBtn.onclick = (e) => { e.stopPropagation(); toggleLineMenu(i, syncBtn); };
    enRow.append(en, syncBtn, pen('en', '영어 문장 수정'));
    const row = document.createElement('div'); row.className = 'ko-row';
    const ko = document.createElement('div'); ko.className = 'ko' + (koEdited[s.text] ? ' edited' : ''); ko.textContent = s.ko || '';
    row.append(ko, pen('ko', '한국어 번역 수정'));
    const gl = document.createElement('div'); gl.className = 'gaplabel'; gl.textContent = '🗣 따라 말해 보세요';
    const gb = document.createElement('div'); gb.className = 'gapbar'; gb.append(document.createElement('i'));
    li.append(enRow, row, gl, gb);
    if (i === syncIdx) li.append(syncPanel(i));
    li.onclick = (e) => { if (e.target.closest('[contenteditable="true"]')) return; jumpTo(i, true); };
    linesEl.append(li);
    return li;
  });
  updateClasses();
}

/* 화면에서 바로 고치기 (kind: 'en' 영어 문장 / 'ko' 번역)
   Enter 저장 · Esc 취소 · 다른 곳 누르면 저장. 번역을 비우고 저장하면 자동 번역으로 되돌림 */
function editLine(i, kind) {
  const el = lineEls[i]?.querySelector(kind === 'en' ? '.en' : '.ko');
  if (!el || el.isContentEditable) return;
  stop();
  const s = segs[i];
  const before = kind === 'en' ? s.text : (s.ko || '');
  el.textContent = before; // 영어는 단어 하이라이트용 조각을 평범한 글자로
  el.contentEditable = 'true';
  el.classList.remove('edited');
  el.focus();
  const range = document.createRange(); range.selectNodeContents(el);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  positionLines();
  let done = false;
  const finish = (cancelled) => {
    if (done) return;
    done = true;
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('keyup', onKeyUp);
    el.removeEventListener('beforeinput', onBeforeInput);
    el.removeEventListener('compositionstart', onCompStart);
    el.removeEventListener('compositionend', onCompEnd);
    el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    el.blur();
    const v = el.textContent.replace(/\s+/g, ' ').trim();
    if (kind === 'en') {
      if (cancelled || !v || v === before) { render(); return; }
      recordUndo();
      applyEnEdit(i, v);
      undoToast('문장을 수정했어요.', 1200);
      return;
    }
    if (cancelled || v === before) { el.textContent = before; if (koEdited[s.text]) el.classList.add('edited'); }
    else if (!v) { // 비우면 직접 고친 번역을 지우고 자동 번역으로
      recordUndo();
      delete koMap[s.text]; delete koEdited[s.text]; s.ko = ''; el.textContent = '';
      persist(); if (settings.translate) translateAll();
      undoToast('자동 번역으로 되돌렸어요.', 1500);
    } else {
      recordUndo();
      s.ko = v; koMap[s.text] = v; koEdited[s.text] = true; el.textContent = v; el.classList.add('edited');
      persist(); undoToast('번역을 수정했어요.', 1200);
    }
    positionLines();
  };
  // Enter 저장: 한글 입력 중(글자 조합 중)에 누른 Enter도 조합이 끝나는 즉시 저장
  let composing = false, saveAfterCompose = false;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(true); return; }
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    e.preventDefault();
    if (e.isComposing || composing || e.keyCode === 229) saveAfterCompose = true;
    else finish(false);
  };
  // 줄바꿈이 들어가지 않게 (브라우저마다 Enter 처리 순서가 달라서 한 번 더 막음)
  const onBeforeInput = (e) => {
    if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return;
    e.preventDefault();
    if (composing) saveAfterCompose = true; else finish(false);
  };
  const onCompStart = () => { composing = true; };
  const onCompEnd = () => { composing = false; if (saveAfterCompose) setTimeout(() => finish(false), 0); };
  const onKeyUp = (e) => { if (saveAfterCompose && !composing && e.key === 'Enter') finish(false); };
  const onBlur = () => finish(false);
  el.addEventListener('keydown', onKey);
  el.addEventListener('keyup', onKeyUp);
  el.addEventListener('beforeinput', onBeforeInput);
  el.addEventListener('compositionstart', onCompStart);
  el.addEventListener('compositionend', onCompEnd);
  el.addEventListener('blur', onBlur);
}

// 영어 문장 수정 → 원본 문장 목록에 반영하고 다시 그림 (나눠서 보이던 문장이면 그 조각만 바꿈)
function applyEnEdit(i, v) {
  const seg = segs[i], raw = rawSegs[seg.ri];
  if (!raw) return;
  const parts = segs.filter((x) => x.ri === seg.ri);
  const old = seg.text;
  raw.text = parts.length > 1 ? parts.map((x) => (x === seg ? v : x.text)).join(' ') : v;
  // 직접 고친 번역은 새 문장에도 유지, 자동 번역은 새 문장으로 다시 번역
  if (koEdited[old]) { koMap[v] = koMap[old]; koEdited[v] = true; }
  setSegments(rawSegs, seg.start);
}

function updateClasses() {
  if (lineMenuIdx >= 0) closeMenus();
  lineEls.forEach((el, i) => {
    const d = i - idx;
    el.dataset.d = d < -2 || d > 4 ? 'far' : String(d);
    if (d !== 0) el.classList.remove('gap');
  });
  browseY = 0; setBrowsing(false);
  if (syncIdx >= 0 && syncIdx !== idx) { syncIdx = -1; lineEls.forEach((l) => l.querySelector('.sync')?.remove()); }
  positionLines();
  updateStatus();
}

/* ---------- 현재 문장 ⋯ 메뉴: 싱크 맞추기 · 문장 나누기 · 다음 문장과 합치기 ---------- */
function toggleLineMenu(i, btn) {
  const open = lineMenuIdx !== i;
  closeMenus();
  if (!open) return;
  stop(); // 메뉴를 여는 동안 다음 문장으로 넘어가며 메뉴가 닫히지 않게 일시정지 (메뉴의 모든 동작도 일시정지 상태에서 함)
  lineMenuMoved = 0;
  const m = $('lineMenu');
  m.querySelector('[data-act="merge"]').disabled = i >= segs.length - 1;
  m.querySelector('[data-act="delete"]').disabled = segs.length <= 1; // 마지막 한 문장은 지울 수 없음
  m.classList.remove('hidden');
  lineMenuIdx = i;
  // 버튼 바로 아래, 오른쪽 끝을 버튼에 맞춤 (화면 밖으로 나가면 위쪽·안쪽으로)
  const r = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  let x = Math.min(innerWidth - 8 - w, Math.max(8, r.right - w));
  let y = r.bottom + 6;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - 6 - h);
  m.style.left = `${Math.round(x)}px`; m.style.top = `${Math.round(y)}px`;
}
$('lineMenu').onclick = (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  e.stopPropagation();
  const i = lineMenuIdx;
  closeMenus();
  if (i < 0 || !segs[i]) return;
  if (b.dataset.act === 'sync') openSync(i);
  else if (b.dataset.act === 'split') startSplit(i);
  else if (b.dataset.act === 'delete') deleteLine(i);
  else mergeNext(i);
};

// 고칠 문장들이 '긴 문장 나누기'로 화면에서만 나뉘어 보이던 것이면, 원본에서도 보이는 대로 나눈 새 목록을 만듦
// 반환: { raw: 새 원본 목록, pos: 문장 → 새 목록에서의 위치 }
function rawWith(targets) {
  const raw = [], pos = new Map();
  rawSegs.forEach((r, ri) => {
    const parts = segs.filter((x) => x.ri === ri);
    if (parts.length > 1 && targets.some((t) => t.ri === ri)) {
      parts.forEach((x) => { pos.set(x, raw.length); raw.push({ start: x.start, end: x.end, text: x.text, sp: x.sp, whole: true, sub: x.sub }); });
    } else {
      targets.forEach((t) => { if (t.ri === ri) pos.set(t, raw.length); });
      raw.push(r);
    }
  });
  return { raw, pos };
}
const spOf = (r) => (r.sp?.length ? r.sp : [[r.start, r.end]]).map((x) => [...x]);

// 문장 나누기: ⋯ → 문장 나누기 → 두 번째 문장이 시작할 단어를 누름
function startSplit(i) {
  stop();
  if (syncIdx >= 0) closeSync();
  splitIdx = i;
  const li = lineEls[i];
  li.classList.add('splitting');
  // 영어를 가려 둔 상태여도 고를 수 있게 잠시 보여 줌
  const ws = segs[i].text.split(/\s+/).filter(Boolean);
  segs[i].words?.forEach((w, k) => { w.el.textContent = ws[k] || ''; });
  toast('두 번째 문장을 시작할 단어를 선택해 주세요. (취소: Esc)', 600000);
}
function cancelSplit(notify) {
  if (splitIdx < 0) return;
  splitIdx = -1;
  render();
  if (notify) toast('문장 나누기를 취소했어요.', 1500);
  else hideToast();
}
// 단어를 누르면 나누고, 다른 곳을 누르면 취소 (나누는 동안 문장 이동·재생은 막음)
document.addEventListener('click', (e) => {
  if (splitIdx < 0) return;
  const li = lineEls[splitIdx];
  const w = e.target.closest('.w');
  e.stopPropagation(); e.preventDefault();
  if (w && li?.contains(w)) {
    const k = segs[splitIdx].words.findIndex((x) => x.el === w);
    if (k <= 0) return; // 첫 단어 앞에서는 나눌 수 없음 (계속 고르기)
    splitAt(splitIdx, k);
  } else cancelSplit(true);
}, true);
function splitAt(i, k) {
  splitIdx = -1;
  const seg = segs[i];
  const { raw, pos } = rawWith([seg]);
  const p = pos.get(seg), r = raw[p];
  const words = r.text.split(/\s+/).filter(Boolean);
  if (k <= 0 || k >= words.length) { render(); return; }
  const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
  const sp = spOf(r);
  // 나누는 시각: 글자 수 비율로 어림한 뒤, 1초 안에 실제로 쉰 곳이 있으면 그 쉼에 맞춤
  const mid = +speechTime(sp, (a.length + 1) / (a.length + 1 + b.length)).toFixed(2);
  let g = -1, bd = 1.0;
  for (let q = 0; q < sp.length - 1; q++) { const d = Math.abs((sp[q][1] + sp[q + 1][0]) / 2 - mid); if (d < bd) { bd = d; g = q; } }
  let spA, spB;
  if (g >= 0) { spA = sp.slice(0, g + 1); spB = sp.slice(g + 1); }
  else {
    spA = sp.filter((x) => x[0] < mid).map((x) => [x[0], Math.min(x[1], mid)]);
    spB = sp.filter((x) => x[1] > mid).map((x) => [Math.max(x[0], mid), x[1]]);
  }
  if (!spA.length || !spB.length) { spA = [[r.start, mid]]; spB = [[mid, r.end]]; }
  const A = { start: r.start, end: spA[spA.length - 1][1], text: a, sp: spA, whole: true, sub: r.sub };
  const B = { start: spB[0][0], end: r.end, text: b, sp: spB, whole: true, sub: r.sub };
  recordUndo();
  raw.splice(p, 1, A, B);
  setSegments(raw, A.start);
  undoToast('문장을 둘로 나눴어요. 싱크가 어긋나면 ⋯ → 싱크 맞추기에서 조정해 주세요.', 3500);
}
// 문장 삭제: 그 구간은 건너뛰고 다음 문장으로 (영상 자체는 그대로). 실행 취소로 되돌릴 수 있음
function deleteLine(i) {
  if (segs.length <= 1 || !segs[i]) return;
  stop();
  const seg = segs[i], after = segs[i + 1] || segs[i - 1];
  const { raw, pos } = rawWith([seg]);
  const p = pos.get(seg);
  if (p == null) return;
  recordUndo();
  raw.splice(p, 1);
  setSegments(raw, after.start);
  undoToast('문장을 삭제했어요.', 2500);
}
function mergeNext(i) {
  if (i >= segs.length - 1) return;
  stop();
  const s1 = segs[i], s2 = segs[i + 1];
  const { raw, pos } = rawWith([s1, s2]);
  const p1 = pos.get(s1), p2 = pos.get(s2);
  if (p1 == null || p2 == null || p2 <= p1) return;
  const A = raw[p1], B = raw[p2];
  // 두 문장의 말 구간을 이어 붙임 (겹치는 곳은 하나로)
  const sp = [...spOf(A), ...spOf(B)].sort((x, y) => x[0] - y[0]).reduce((acc, x) => {
    const last = acc[acc.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else acc.push(x);
    return acc;
  }, []);
  const M = { start: Math.min(A.start, B.start), end: Math.max(A.end, B.end), text: `${A.text} ${B.text}`, sp, whole: true, sub: A.sub || B.sub };
  recordUndo();
  raw.splice(p1, p2 - p1 + 1, M);
  setSegments(raw, M.start);
  undoToast('다음 문장과 합쳤어요.', 1500);
}

/* ---------- 싱크 맞추기 ----------
   현재 문장의 시작·끝 시간을 0.1초씩 옮기거나, 지금 재생 위치로 맞춤. '들어보기'로 바로 확인 */
let syncIdx = -1, previewOnly = false;
// 싱크 창의 들어보기 버튼: 재생 중에는 일시정지 버튼으로 바뀜
const PREVIEW_LABEL = {
  play: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.6"/><path d="M6.7 5.4v5.2L10.6 8z" fill="currentColor" stroke-linejoin="round"/></svg>들어보기',
  pause: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.6"/><path d="M6.6 5.6v4.8M9.4 5.6v4.8" stroke-linecap="round"/></svg>일시정지',
};
const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
function openSync(i) {
  stop();
  if (syncIdx === i) { closeSync(); return; }
  syncSnap = snapshot(); // 이 싱크 창에서 바꾼 것은 한 번에 되돌림
  let seg = segs[i];
  // 긴 문장 나누기로 쪼개져 보이던 문장이면, 조각별로 시간을 고칠 수 있게 원본에서도 나눠 둠
  const parts = segs.filter((x) => x.ri === seg.ri);
  if (parts.length > 1) {
    rawSegs.splice(seg.ri, 1, ...parts.map(({ start, end, text, sp, sub }) => ({ start, end, text, sp, sub })));
    syncIdx = -2; // 다시 그린 뒤 같은 문장을 찾아 열기
    setSegments(rawSegs, seg.start);
    i = segs.findIndex((x) => Math.abs(x.start - seg.start) < 0.005 && x.text === seg.text);
    if (i < 0) { syncIdx = -1; return; }
  }
  syncIdx = i;
  render();
  positionLines();
}
function closeSync() { syncIdx = -1; render(); positionLines(); }
function syncPanel(i) {
  const s = segs[i];
  const box = document.createElement('div');
  box.className = 'sync';
  box.innerHTML = `
    <div class="sync-row"><span class="lab">시작</span><button data-a="s" data-d="-0.1">−0.1</button><input class="t" data-a="s" value="${fmtT(s.start)}" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="시작 시간 (분:초)" title="직접 입력 가능 (예: 0:12.3) · Enter로 적용"><button data-a="s" data-d="0.1">+0.1</button><button class="now" data-a="s" data-now="1" title="일시정지한 위치를 시작 시간으로 설정">⌖ 현재 위치</button></div>
    <div class="sync-row"><span class="lab">끝</span><button data-a="e" data-d="-0.1">−0.1</button><input class="t" data-a="e" value="${fmtT(s.end)}" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="끝 시간 (분:초)" title="직접 입력 가능 (예: 0:15.8) · Enter로 적용"><button data-a="e" data-d="0.1">+0.1</button><button class="now" data-a="e" data-now="1" title="일시정지한 위치를 끝 시간으로 설정">⌖ 현재 위치</button></div>
    <div class="sync-row act"><button class="play" data-a="play">${PREVIEW_LABEL.play}</button><button class="done" data-a="done">완료</button></div>
    <p class="sync-warn hidden"></p>
    <p class="sync-tip">시간 칸을 눌러 직접 입력할 수도 있어요. (예: 0:12.3) 입력한 시간이 허용 범위를 벗어나면 최소·최대값으로 자동 조정돼요.<br>팁: ▶ 들어보기로 재생하다가 원하는 위치에서 ‘일시정지’ 버튼이나 Space 키를 누른 뒤, ‘현재 위치’를 누르면 해당 시간으로 설정돼요.</p>`;
  const inputs = box.querySelectorAll('input.t');
  const showTimes = () => { inputs[0].value = fmtT(s.start); inputs[1].value = fmtT(s.end); };
  // a: 's' 시작 / 'e' 끝, v: 새 시각(초), typed: 직접 입력이면 범위 밖일 때 최소·최대로 맞췄다고 알림
  const apply = (a, v, typed = false) => {
    stop();
    const dur = media.duration || Infinity;
    let { start, end } = s;
    // 앞뒤 문장과 조금 겹치는 건 괜찮지만, 앞 문장 시작보다 앞·뒤 문장 끝보다 뒤로는 못 감
    const prev = segs[i - 1], next = segs[i + 1];
    const minS = prev ? prev.start + 0.1 : 0, maxE = next ? next.end - 0.1 : dur;
    let hit = '';
    // 앞뒤 문장 시간이 이미 엇갈려 있으면(예: 앞 문장이 이 문장 끝보다 늦게 시작) 범위가 뒤집히므로,
    // 그때는 이 문장 자체의 시작<끝 조건을 우선함
    if (a === 's') {
      const hi = end - 0.2, lo = Math.min(minS, hi);
      if (v < lo && prev) hit = '앞 문장의 시작 시간보다 앞으로 이동할 수 없어요.';
      start = Math.max(lo, Math.min(v, hi));
      if (typed && (v < lo || v > hi)) hit = `입력한 시간이 허용 범위(${fmtT(lo)}~${fmtT(hi)})를 벗어나 ${v < lo ? '최소' : '최대'}값(${fmtT(start)})으로 자동 조정했어요.`;
    } else {
      const lo = start + 0.2, hi = Math.max(maxE, lo);
      if (v > hi && next) hit = '뒤 문장의 종료 시간보다 뒤로 이동할 수 없어요.';
      end = Math.min(hi, Math.max(v, lo));
      if (typed && (v < lo || v > hi)) hit = `입력한 시간이 허용 범위(${fmtT(lo)}~${fmtT(hi)})를 벗어나 ${v > hi ? '최대' : '최소'}값(${fmtT(end)})으로 자동 조정했어요.`;
    }
    setSyncTimes(i, +start.toFixed(2), +end.toFixed(2));
    showTimes();
    syncWarn(i, box, hit);
  };
  box.onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'done') { const changed = !syncSnap; syncSnap = null; closeSync(); if (changed) toast('싱크를 저장했어요.', 1200); return; } // 바꾼 게 없으면 알림 없이 닫기
    if (a === 'play') { if (running && previewOnly) stop(); else { previewOnly = true; rep = 1; playLine(); } return; } // 들어보기 ↔ 일시정지
    apply(a, b.dataset.now ? media.currentTime : (a === 's' ? s.start : s.end) + Number(b.dataset.d));
  };
  // 시간 직접 입력: "0:12.3" · "12.3" · "1:05" 모두 가능. Enter·다른 곳 누르면 적용, Esc 취소
  const parseT = (str) => {
    const m = String(str).trim().replace(/[,，]/g, '.').match(/^(?:(\d+)\s*[:：]\s*)?(\d+(?:\.\d*)?|\.\d+)$/);
    if (!m) return NaN;
    return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  };
  inputs.forEach((inp) => {
    inp.onfocus = () => { stop(); inp.select(); };
    const commit = () => {
      const cur = inp.dataset.a === 's' ? s.start : s.end;
      if (inp.value.trim() === fmtT(cur)) return;
      const v = parseT(inp.value);
      if (!Number.isFinite(v)) { showTimes(); syncWarn(i, box, '시간은 "분:초" 형식으로 입력해 주세요. (예: 0:12.3)'); return; }
      apply(inp.dataset.a, v, true);
    };
    inp.onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); commit(); inp.select(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showTimes(); inp.blur(); }
    };
    inp.onblur = commit;
  });
  syncWarn(i, box, '');
  return box;
}
// 앞 문장 시작·뒤 문장 끝에 막혔을 때만 이유를 알려 줌 (조금 겹치는 건 괜찮아서 따로 알리지 않음)
function syncWarn(i, box, hit) {
  const s = segs[i], prev = segs[i - 1], next = segs[i + 1];
  const msgs = [];
  if (hit) msgs.push(hit);
  const el = box.querySelector('.sync-warn');
  el.textContent = msgs.join(' · ');
  el.classList.toggle('hidden', !msgs.length);
  el.classList.toggle('hit', !!hit);
}
function setSyncTimes(i, start, end) {
  if (syncSnap) { recordUndo(syncSnap); syncSnap = null; }
  const s = segs[i];
  // 단어 하이라이트용 말 구간도 새 범위에 맞춤
  let sp = (s.sp?.length ? s.sp : [[s.start, s.end]]).map((r) => [Math.max(r[0], start), Math.min(r[1], end)]).filter((r) => r[1] > r[0]);
  if (!sp.length) sp = [[start, end]];
  sp[0][0] = start; sp[sp.length - 1][1] = end;
  s.start = start; s.end = end; s.sp = sp;
  const raw = rawSegs[s.ri];
  if (raw) { raw.start = start; raw.end = end; raw.sp = sp.map((r) => [...r]); }
  persist();
}

let browseY = 0; // 스크롤로 위아래 둘러본 만큼 (0이면 현재 문장이 가운데)
let lineOverflow = false, followFrac = 0; // 현재 문장이 보이는 영역보다 긴지 · 지금 들리는 위치(0~1)
// 아주 긴 현재 문장: 보이는 영역(화면 위아래 흐려지는 부분 제외)에 들어갈 때까지 글자를 조금씩 줄임 (최소 16px)
const FIT_MIN_PX = 16;
function fitCurrentLine(cur) {
  const h = stage.clientHeight, w = stage.clientWidth;
  const key = `${idx}|${segs[idx]?.text}|${h}|${w}|${settings.translate}|${settings.showEn}|${segs[idx]?.ko || ''}`;
  if (fitCurrentLine.el === cur && fitCurrentLine.key === key) return;
  fitCurrentLine.el = cur; fitCurrentLine.key = key;
  lineEls.forEach((l) => { const e = l.querySelector('.en'); if (l !== cur && e?.style.fontSize) e.style.fontSize = ''; });
  const en = cur.querySelector('.en'), enRow = cur.querySelector('.en-row'), koRow = cur.querySelector('.ko-row');
  if (!en || !enRow) return;
  en.style.fontSize = '';
  const textH = () => (koRow && koRow.offsetHeight ? koRow.getBoundingClientRect().bottom : enRow.getBoundingClientRect().bottom) - enRow.getBoundingClientRect().top;
  const avail = h * 0.58;
  let size = parseFloat(getComputedStyle(en).fontSize);
  while (textH() > avail && size > FIT_MIN_PX) { size = Math.max(FIT_MIN_PX, size * 0.9); en.style.fontSize = `${size}px`; }
}
function positionLines() {
  const cur = lineEls[idx];
  if (!cur) return;
  if (positionLines.idx !== idx) { positionLines.idx = idx; followFrac = 0; } // 문장이 바뀌면 첫 줄부터
  fitCurrentLine(cur);
  const h0 = stage.clientHeight;
  const anchor = h0 * 0.36;
  // 문장이 길어 가운데 맞춤으로는 첫 줄이 위쪽 흐린 부분에 걸리면, 첫 줄(⋯·✎ 버튼)이 보이게 아래로 내림.
  // 글자를 줄여도 보이는 영역보다 길면 나머지는 휠·드래그로 내려 보기
  const topLimit = h0 * 0.16 + 4;
  let base = anchor - cur.offsetHeight / 2 < topLimit ? topLimit - cur.offsetTop : anchor - (cur.offsetTop + cur.offsetHeight / 2);
  // 보이는 영역보다 길면: 듣는 위치(followFrac)만큼 아래로 내려서 지금 들리는 부분이 보이게
  const visibleH = h0 * 0.64 - 8;
  lineOverflow = cur.offsetHeight > visibleH;
  // 싱크 창을 열어 둔 동안(들어보기 포함)은 따라 내려가지 않음 — 시간 칸·버튼이 움직이면 맞추기 어려움
  if (lineOverflow && syncIdx !== idx) base -= (cur.offsetHeight - visibleH) * followFrac;
  // 첫 문장 위·마지막 문장 아래로 너무 넘어가지 않게
  const H = linesEl.scrollHeight, h = stage.clientHeight;
  const minY = h * 0.5 - H, maxY = h * 0.4;
  browseY = Math.min(maxY - base, Math.max(minY - base, browseY));
  if (browseY > 0 && base > maxY) browseY = 0;
  linesEl.style.transform = `translateY(${Math.round(base + browseY)}px)`;
}
// 글자·번역 표시만 바뀌어 줄 높이가 달라질 때: 미끄러지는 효과 없이 제자리에 바로 맞춤
function snapLines() {
  linesEl.style.transition = 'none';
  positionLines();
  linesEl.offsetHeight;
  linesEl.style.transition = '';
}
function setBrowsing(on) {
  stage.classList.toggle('browsing', on);
  $('backCur').classList.toggle('hidden', !on);
}
function resetBrowse() { browseY = 0; setBrowsing(false); positionLines(); }
let wheelT;
const browseBy = (dy) => {
  if (!segs.length) return;
  browseY -= dy;
  // ⋯ 메뉴: 손가락 떨림·트랙패드 관성 같은 작은 움직임에는 문장과 함께 따라 움직이고, 확실히 둘러볼 때(24px 이상)만 닫음
  if (lineMenuIdx >= 0) {
    lineMenuMoved += Math.abs(dy);
    if (lineMenuMoved > 24) closeMenus();
    else { const m = $('lineMenu'); m.style.top = `${parseFloat(m.style.top) - dy}px`; }
  }
  linesEl.style.transition = 'none';
  positionLines();
  setBrowsing(Math.abs(browseY) > 4);
  clearTimeout(wheelT); wheelT = setTimeout(() => { linesEl.style.transition = ''; }, 120);
};
stage.addEventListener('wheel', (e) => { e.preventDefault(); browseBy(e.deltaY); }, { passive: false });
let touchY = null, touchMoved = false;
stage.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; touchMoved = false; }, { passive: true });
stage.addEventListener('touchmove', (e) => {
  if (touchY == null) return;
  const y = e.touches[0].clientY;
  if (Math.abs(y - touchY) > 2) { touchMoved = true; e.preventDefault(); browseBy(touchY - y); touchY = y; }
}, { passive: false });
stage.addEventListener('touchend', () => { touchY = null; });
$('backCur').onclick = () => { linesEl.style.transition = ''; resetBrowse(); };
// 창 크기 변경: 폭이 바뀔 때만 메뉴를 닫음 (휴대폰은 주소창이 숨거나 나타날 때 높이만 바뀜)
let lastW = innerWidth;
window.addEventListener('resize', () => { if (lineMenuIdx >= 0 && innerWidth !== lastW) closeMenus(); lastW = innerWidth; positionLines(); });

// 단어 색칠: 음성인식으로 만든 문장만 (자막에서 불러온 문장은 단어별 시각을 몰라 맞지 않으므로 칠하지 않음)
// 화면보다 긴 문장은 들리는 위치에 맞춰 아래로 따라 내려감
function setWordProgress(frac) {
  const s = segs[idx]; if (!s?.words) return;
  for (const w of s.words) w.el.classList.toggle('on', !s.sub && w.at < frac);
  const f = Math.max(0, Math.min(1, frac || 0));
  if (Math.abs(f - followFrac) > 0.01 || (f === 0) !== (followFrac === 0)) { followFrac = f; if (lineOverflow) positionLines(); }
}

function updateStatus() {
  if (!segs.length) return;
  $('lineNoVal').textContent = `${idx + 1} / ${segs.length}`;
  $('repInfo').textContent = `${rep} / ${settings.repeat}`;
  // 상태 배지: 크기가 고정돼 있어서 옆 버튼들이 움직이지 않음
  const st = !running ? 'pause' : phase === 'speak' ? 'speak' : 'listen';
  $('phase').className = `phase ${st}`;
  $('phaseText').textContent = { pause: '일시정지', listen: '듣는 중', speak: '따라 말하기' }[st];
  $('playBtn').textContent = running ? '❚❚' : '▶';
  const pb = document.querySelector('.sync .play');
  if (pb) { const k = running && previewOnly ? 'pause' : 'play'; if (pb.dataset.k !== k) { pb.dataset.k = k; pb.innerHTML = PREVIEW_LABEL[k]; } }
}

/* ================= 쉐도잉 엔진 ================= */
const PAD_START = 0.05, PAD_END = 0.15;
const segStart = (i) => Math.max(0, segs[i].start - PAD_START);
const segEnd = (i) => {
  const next = segs[i + 1];
  const e = segs[i].end + PAD_END;
  return next ? Math.min(e, Math.max(segs[i].end, next.start)) : Math.min(e, media.duration || e);
};

function clearGap() {
  clearTimeout(gapTimer); gapTimer = null;
  lineEls[idx]?.classList.remove('gap');
}

async function playLine() {
  clearGap();
  phase = 'listen'; running = true;
  setWordProgress(0);
  media.playbackRate = Number(settings.speed);
  media.currentTime = segStart(idx);
  try { await media.play(); } catch (e) { console.warn(e); running = false; phase = 'idle'; }
  updateStatus();
  tick();
}

function tick() {
  if (!running || phase !== 'listen') return;
  const s = segs[idx];
  const t = media.currentTime;
  setWordProgress(s.sp?.length ? speechFrac(s.sp, t) : (t - s.start) / Math.max(0.1, s.end - s.start));
  updateTimeline();
  if (t >= segEnd(idx) || media.ended) { onLineEnd(); return; }
  clearTimeout(tickTimer);
  tickTimer = setTimeout(tick, 30);
}
let tickTimer = null;
// 창이 백그라운드여서 타이머가 느려질 때를 위한 보조 체크
media.addEventListener('timeupdate', () => { if (running && phase === 'listen') tick(); });

function onLineEnd() {
  if (phase !== 'listen') return;
  if (previewOnly) { stop(); setWordProgress(1); return; } // 싱크 맞추기의 '들어보기'는 한 번만 재생
  media.pause();
  setWordProgress(1);
  const factor = Number(settings.gap);
  const dur = (segs[idx].end - segs[idx].start) / Number(settings.speed);
  const gapMs = factor > 0 ? Math.max(800, dur * factor * 1000) : 350;
  phase = 'speak';
  updateStatus();
  if (factor > 0) {
    const el = lineEls[idx]; el.classList.add('gap');
    const bar = el.querySelector('.gapbar i');
    gapStart = performance.now(); gapDur = gapMs;
    const anim = () => {
      if (phase !== 'speak' || !running) return;
      bar.style.width = `${Math.min(100, (performance.now() - gapStart) / gapDur * 100)}%`;
      if (performance.now() - gapStart < gapDur) requestAnimationFrame(anim);
    };
    bar.style.width = '0%'; anim();
  }
  gapTimer = setTimeout(afterGap, gapMs);
}

function afterGap() {
  gapTimer = null;
  if (!running) return;
  if (rep < settings.repeat) { rep++; playLine(); return; }
  if (settings.autoAdvance && idx < segs.length - 1) {
    idx++; rep = 1; persist(); updateClasses(); playLine(); return;
  }
  if (settings.autoAdvance && idx >= segs.length - 1 && fileFinished()) return;
  // 반복이 끝남: 멈추고 반복 횟수는 처음으로 (다시 ▶ 누르면 처음부터 반복)
  rep = 1;
  stop();
  if (idx >= segs.length - 1) toast('🎉 마지막 문장까지 완료했어요!');
  else toast('반복 완료! → 키나 ⏭ 버튼으로 다음 문장으로 이동하세요.', 2400);
}

// 파일의 마지막 문장까지 끝났을 때 재생 목록 반복 설정대로 이어서 재생. 이어 가면 true
function fileFinished() {
  const mode = settings.listRepeat;
  let next = curItem + 1;
  if (mode === 'one' || (mode === 'all' && playlist.length <= 1)) {
    toast('🔂 처음 문장부터 다시 재생해요.', 1800); jumpTo(0, true); return true;
  }
  if (next >= playlist.length) { if (mode !== 'all') return false; next = 0; }
  if (!playlist[next] || next === curItem) return false;
  const f = playlist[next].file;
  rep = 1; stop();
  autoplayKey = `shadow:data:${f.name}:${f.size}`;
  toast(`▶ 다음 파일: ${displayName(playlist[next])}`, 2200);
  openItem(next);
  return true;
}

function stop() {
  running = false; phase = 'idle'; previewOnly = false;
  clearGap();
  if (!media.paused) media.pause();
  updateStatus();
}

function togglePlay() {
  if (!segs.length) return;
  if (running) stop(); else playLine();
}

function jumpTo(i, play = running) {
  if (!segs.length) return;
  i = Math.max(0, Math.min(segs.length - 1, i));
  const wasRunning = running;
  stop();
  if (i !== idx) setWordProgress(0);
  idx = i; rep = 1;
  persist();
  updateClasses();
  updateTimeline();
  if (play || wasRunning) playLine();
}

function updateTimeline() {
  const d = media.duration; if (!d) return;
  const t = running || !segs.length ? media.currentTime : segs[idx]?.start || 0;
  $('timelineFill').style.width = `${(t / d) * 100}%`;
  $('tCur').textContent = fmt(t);
  $('tDur').textContent = fmt(d);
}
media.addEventListener('timeupdate', updateTimeline);
media.addEventListener('loadedmetadata', updateTimeline);

$('playBtn').onclick = togglePlay;
$('prevBtn').onclick = () => jumpTo(idx - 1);
$('nextBtn').onclick = () => jumpTo(idx + 1);
$('replayBtn').onclick = () => { rep = 1; playLine(); };
$('timeline').onclick = (e) => {
  const d = media.duration; if (!d || !segs.length) return;
  const r = e.currentTarget.getBoundingClientRect();
  const t = (e.clientX - r.left) / r.width * d;
  let i = segs.findIndex((s) => s.end > t);
  if (i < 0) i = segs.length - 1;
  jumpTo(i);
};

document.addEventListener('keydown', (e) => {
  if (e.target.isContentEditable) return; // 번역 수정 중
  if (splitIdx >= 0) { // 문장 나누기 중: Esc 취소, 다른 키를 누르면 조용히 취소하고 그 키 동작
    if (e.key === 'Escape') { e.preventDefault(); cancelSplit(true); return; }
    cancelSplit(false);
  }
  if (!$('modal').classList.contains('hidden')) return;
  if (e.target.matches('input, select, textarea') && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (!segs.length || $('player').classList.contains('hidden')) return; // 음성인식 진행 화면 등에서는 단축키 무시
  // 한글 입력 상태에서는 E가 'ㄷ'처럼 들어오므로, 글자 대신 키보드의 키 위치(e.code)로 알아봄
  const byCode = { KeyE: 'e', KeyT: 't', KeyM: 'm', KeyR: 'r', KeyZ: 'z', KeyY: 'y' }[e.code];
  const k = byCode ? (e.shiftKey && byCode === 'z' ? 'Z' : byCode) : (!e.shiftKey && /^Digit[0-9]$/.test(e.code) ? e.code.slice(5) : e.key);
  // ⌘Z(Ctrl+Z) 실행 취소 · ⌘⇧Z(Ctrl+Shift+Z, Ctrl+Y) 다시 실행
  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    if (k === 'z' || k === 'Z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if ((k === 'y' || k === 'Y') && e.ctrlKey) { e.preventDefault(); redo(); }
    return;
  }
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); jumpTo(idx - 1); }
  else if (k === 'ArrowRight') { e.preventDefault(); jumpTo(idx + 1); }
  else if (k === 'r' || k === 'R' || k === 'ArrowUp') { e.preventDefault(); rep = 1; playLine(); }
  else if (k === 'm' || k === 'M') { toggleMute(); toast(settings.muted ? '음소거' : '소리 켬', 1000); }
  else if (k === 'e' || k === 'E') { setShowEn(!settings.showEn); toast(settings.showEn ? '영어 문장 표시' : '영어 문장 숨김', 1200); }
  else if (k === 't' || k === 'T') { setTranslate(!settings.translate).then((done) => { if (done) toast(settings.translate ? '한국어 번역 켬' : '한국어 번역 끔', 1200); }); }
  else if (/^[0-9]$/.test(k)) {
    setRepeat(k === '0' ? 10 : Number(k)); toast(`반복 ${settings.repeat}회`, 1200);
  } else if (k === 'Escape') openSettings(false);
});

/* ================= 번역 ================= */
// 크롬 내장 번역(Translator API)만 사용: 번역은 사용자의 크롬 안에서 처리됨 (외부 번역 서비스로 보내지 않음)
// PC용 크롬 138 이상에서만 동작. 처음 한 번 크롬이 영→한 번역 데이터를 내려받음
const TR_OPTS = { sourceLanguage: 'en', targetLanguage: 'ko' };
// 지원 여부 확인 (환경에 따라 응답이 안 오는 경우가 있어 4초 안에 답이 없으면 '사용 불가'로 봄). 한 번 확인한 결과는 기억
let trAvail = null;
async function translatorAvailable() {
  if (trAvail === true) return true;
  if (!('Translator' in self)) return (trAvail = false);
  try {
    const a = await Promise.race([self.Translator.availability(TR_OPTS), new Promise((res) => setTimeout(() => res('timeout'), 4000))]);
    trAvail = a !== 'unavailable' && a !== 'timeout';
  } catch { trAvail = false; }
  return trAvail;
}
let translatorP = null;
function getTranslator() {
  if (!translatorP) {
    translatorP = self.Translator.create({
      ...TR_OPTS,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { if (e.loaded < 1) toast(`번역 준비 중… ${Math.round(e.loaded * 100)}%`, 1500); }); },
    }).catch((e) => { translatorP = null; throw e; });
  }
  return translatorP;
}
async function translateOne(text) {
  const t = await getTranslator();
  return t.translate(text);
}

let translating = false;
async function translateAll() {
  if (translating || !segs.length) return;
  if (!(await translatorAvailable())) { // 번역을 쓸 수 없는 브라우저에서 예전에 켜 둔 경우: 조용히 끔
    settings.translate = false; saveSettings(); applySettingsToUI(); requestAnimationFrame(positionLines); return;
  }
  translating = true;
  try { await getTranslator(); } catch (e) {
    // 번역 데이터를 처음 내려받을 때는 사용자의 클릭이 필요함 → 다음 클릭·키 입력 때 다시 시도
    translating = false; console.warn('[번역] 준비 실패', e);
    const retry = () => { removeEventListener('pointerdown', retry, true); removeEventListener('keydown', retry, true); if (settings.translate) translateAll(); };
    addEventListener('pointerdown', retry, true); addEventListener('keydown', retry, true);
    return;
  }
  // 현재 문장 근처부터 먼저 번역
  const order = segs.map((_, i) => i).sort((a, b) => {
    const da = a >= idx ? a - idx : 1000 + idx - a, db = b >= idx ? b - idx : 1000 + idx - b;
    return da - db;
  }).filter((i) => !segs[i].ko);
  order.forEach((i) => { if (koMap[segs[i].text]) segs[i].ko = koMap[segs[i].text]; });
  for (let k = order.length - 1; k >= 0; k--) if (segs[order[k]].ko) order.splice(k, 1);
  let failed = 0;
  const list = segs; // 도중에 파일이 바뀌면 중단
  const workerFn = async () => {
    while (order.length && settings.translate && segs === list) {
      const i = order.shift();
      try {
        const ko = await translateOne(list[i].text);
        list[i].ko = ko;
        koMap[list[i].text] = ko;
        if (segs !== list) break; // 번역 중 다른 파일을 열었으면 화면은 건드리지 않음
        const el = lineEls[i]?.querySelector('.ko');
        if (el) el.textContent = ko;
        if (Math.abs(i - idx) <= 1) snapLines();
      } catch (e) { failed++; console.warn(e); }
    }
  };
  await Promise.all([workerFn(), workerFn(), workerFn()]);
  translating = false;
  if (segs === list) persist();
  snapLines();
  if (failed) toast(`${failed}개 문장을 번역하지 못했어요.`, 3000);
  // 번역 도중 다른 파일을 열었다면 새 파일 번역을 이어서 시작
  if (segs !== list && settings.translate) translateAll();
}

/* ================= ? 도움말 레이어 =================
   지금 화면에 보이는 버튼만 골라서 테두리 + 짧은 설명을 붙임 */
const HELP = [
  ['#openLabel', '파일을 재생 목록에 추가하고 바로 열기', 0],
  ['body:has(#playlist:not(.hidden)) #listBtn', '재생 목록 펼치기 / 접기', 0],
  ['body:has(#playlist.hidden) #listBtn', '재생 목록 펼치기 / 접기\n재생 목록을 펼쳐 파일을 추가하거나 반복 모드를 설정할 수 있어요.', 0],
  ['#plRepeat', '재생 목록 반복 — 누를 때마다 반복 모드가 바뀌어요.\n반복 안 함 → 이 파일만 반복 → 전체 반복', 0],
  ['#subBtn', '자막 내려받기(백업) / 불러오기', 0],
  ['#settingsBtn', '따라 말하기 시간, 번역, 화면 모드 등 설정', 0],
  ['#dropBox .btn', '파일을 끌어다 놓아도 열 수 있어요.', 0],
  ['.line[data-d="0"] .en-row .pen:nth-of-type(1)', '싱크 맞추기 · 문장 나누기 · 다음 문장과 합치기', 1],
  ['.line[data-d="0"] .en-row .pen:nth-of-type(2)', '영어 문장 수정', 1],
  ['body.ko-on .line[data-d="0"] .ko-row .pen', '한국어 번역 수정', 1],
  ['.line[data-d="0"] .en', '따라 할 문장 표시 — 말하는 단어는 색으로 강조돼요. (불러온 자막은 제외)\n위아래 문장은 휠이나 드래그로 탐색할 수 있어요.', 1],
  ['.time-row', '재생 위치 확인 — 누르면 해당 문장으로 이동', 2],
  ['#phase', '현재 상태 표시 (듣는 중 / 따라 말하기 / 일시정지)', 2],
  ['#lineNo', '현재 문장 번호 / 전체 문장 수', 2],
  ['#repBtn', '반복 횟수 확인 및 변경 (숫자키 1~9, 0은 10회)', 2],
  ['#prevBtn', '이전 문장 (←)', 3],
  ['#replayBtn', '현재 문장 처음부터 (R / ↑)', 3],
  ['#playBtn', '재생 / 일시정지 (Space)', 3],
  ['#nextBtn', '다음 문장 (→)', 3],
  ['#enSwitch', '영어 문장 가리기 — 글자 수만큼 밑줄 표시 (E)', 4],
  ['#koSwitch', '한국어 번역 켜기 / 끄기 (T)', 4],
  ['#speedBtn', '재생 속도 조절', 4],
  ['.vol', '음량 조절 (M: 음소거)', 4],
];
// 화면 크기와 상관없이 묶음(위쪽 버튼 → 문장 → 아래 막대…)별로 하나씩: 누를 때마다 다음 묶음
let helpStep = 0, helpSteps = [];
function openHelp(step = 0) {
  closeMenus(); openSettings(false); hideHelpHint();
  const layer = $('helpLayer');
  layer.innerHTML = '';
  // 다른 화면(예: 휴대폰에서 펼친 재생 목록)에 가려진 버튼은 설명하지 않음 → 도움말 레이어를 띄우기 전에 확인
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= innerHeight) return false;
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
  };
  $('help').classList.add('hidden'); // 다음 장으로 넘길 때 도움말 레이어 자신이 버튼을 가린 것으로 잡히지 않게
  const visible = HELP.filter(([sel]) => { const el = document.querySelector(sel); return !!el && shown(el); });
  $('help').classList.remove('hidden');
  const mobile = true; // 넓은 화면도 휴대폰처럼 묶음(위쪽 버튼 → 문장 → 상태 → 재생 버튼 → 아래 스위치)별로 한 장씩
  helpSteps = mobile ? [...new Set(visible.map((h) => h[2]))] : [null];
  helpStep = Math.min(step, helpSteps.length - 1);
  const items = mobile ? visible.filter((h) => h[2] === helpSteps[helpStep]) : visible;
  $('helpFootText').textContent = mobile && helpSteps.length > 1
    ? `${helpStep + 1} / ${helpSteps.length} · 화면을 누르면 ${helpStep + 1 < helpSteps.length ? '다음 설명으로 이동' : '닫기'}`
    : '화면 아무 곳이나 누르면 닫혀요.';
  const W = innerWidth, H = innerHeight;
  const placed = []; // 이미 놓은 설명 상자 (겹치지 않게)
  // 설명 상자가 다른 설명 대상 버튼을 가리지 않도록, 표시할 버튼 자리도 미리 넣어 둠
  const targetBoxes = new Map();
  for (const [sel] of items) {
    const el = document.querySelector(sel); if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) { const tb = { left: r.left - 4, right: r.right + 4, top: r.top - 4, bottom: r.bottom + 4 }; placed.push(tb); targetBoxes.set(sel, tb); }
  }
  const overlaps = (a) => placed.some((b) => a.left < b.right + 6 && a.right > b.left - 6 && a.top < b.bottom + 6 && a.bottom > b.top - 6);
  let minTop = innerHeight, maxBottom = 0;
  for (const [sel, text] of items) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > H || getComputedStyle(el).visibility === 'hidden') continue;
    const targetBox = targetBoxes.get(sel);
    const ring = document.createElement('div');
    ring.className = 'help-ring';
    Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    layer.append(ring);
    const tip = document.createElement('div');
    tip.className = 'help-tip';
    tip.textContent = text;
    layer.append(tip);
    // 화면 위쪽 버튼은 아래에, 아래쪽 버튼은 위에 설명을 붙이고, 겹치면 더 밀어냄
    const below = r.top + r.height / 2 < H / 2;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = Math.min(W - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2));
    let top = below ? r.bottom + 10 : r.top - th - 10;
    let box = { left, right: left + tw, top, bottom: top + th };
    for (let k = 0; k < 12 && overlaps(box); k++) {
      top += below ? th + 6 : -(th + 6);
      box = { left, right: left + tw, top, bottom: top + th };
    }
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
    tip.classList.add(below ? 'below' : 'above');
    // 설명 상자와 버튼을 잇는 선
    const line = document.createElement('div');
    line.className = 'help-line';
    const cx = r.left + r.width / 2;
    const y1 = below ? r.bottom + 4 : top + th, y2 = below ? top : r.top - 4;
    const ya = Math.min(y1, y2), yb = Math.max(y1, y2);
    // 선이 다른 버튼 위를 지나가지 않도록: 버튼 폭과 설명 상자 폭이 겹치는 범위에서, 가운데에 가장 가까운 빈 자리를 고름
    const xlo = Math.max(r.left + 6, left + 8), xhi = Math.min(r.right - 6, left + tw - 8);
    const clear = (x) => !placed.some((b) => b !== targetBox && x > b.left - 3 && x < b.right + 3 && ya < b.bottom && yb > b.top);
    let lx = Math.min(Math.max(cx, left + 8), left + tw - 8);
    if (xlo <= xhi && !clear(lx)) {
      for (let d = 2; d <= xhi - xlo; d += 2) {
        const c = [lx - d, lx + d].find((x) => x >= xlo && x <= xhi && clear(x));
        if (c != null) { lx = c; break; }
      }
    }
    Object.assign(line.style, { left: `${lx}px`, top: `${ya}px`, height: `${Math.max(0, yb - ya)}px` });
    layer.append(line);
    placed.push(box);
    minTop = Math.min(minTop, r.top, top); maxBottom = Math.max(maxBottom, r.bottom, top + th);
  }
  // 닫기 안내는 설명과 겹치지 않는 쪽에
  const foot = $('help').querySelector('.help-foot');
  foot.style.top = (minTop + maxBottom) / 2 > innerHeight / 2 ? '18%' : '78%';
}
const closeHelp = () => $('help').classList.add('hidden');
$('helpBtn').onclick = (e) => { e.stopPropagation(); if ($('help').classList.contains('hidden')) openHelp(); else closeHelp(); };
$('help').onclick = () => { if (helpStep + 1 < helpSteps.length) openHelp(helpStep + 1); else closeHelp(); };
window.addEventListener('resize', closeHelp);
document.addEventListener('keydown', (e) => {
  if (!$('help').classList.contains('hidden')) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeHelp(); } else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); $('help').onclick(); } e.stopPropagation(); return; }
  if ((e.key === '?' || (e.code === 'Slash' && e.shiftKey)) && !e.target.matches('input, textarea, select') && !e.target.isContentEditable && $('modal').classList.contains('hidden')) { e.preventDefault(); openHelp(); }
}, true);

// 처음 파일을 열었을 때 한 번만: "? 를 누르면 버튼 설명을 볼 수 있어요"
function showHelpHintOnce() {
  try { if (localStorage.getItem('shadow:helpHint')) return; localStorage.setItem('shadow:helpHint', '1'); } catch { return; }
  const r = $('helpBtn').getBoundingClientRect();
  const h = $('helpHint');
  h.style.top = `${r.bottom + 10}px`;
  h.style.right = `${Math.max(8, innerWidth - r.right - 8)}px`;
  h.classList.remove('hidden');
  clearTimeout(showHelpHintOnce.t);
  showHelpHintOnce.t = setTimeout(hideHelpHint, 9000);
}
function hideHelpHint() { $('helpHint').classList.add('hidden'); }
$('helpHintClose').onclick = hideHelpHint;
// 재생 목록 아래 안내: ✕로 닫으면 다음부터 안 보임
try { if (localStorage.getItem('shadow:plNote')) $('plNote').remove(); } catch {}
if ($('plNoteClose')) $('plNoteClose').onclick = () => { $('plNote').remove(); try { localStorage.setItem('shadow:plNote', '1'); } catch {} };

/* ================= 시작 ================= */
applySettingsToUI();
renderPlaylist();
show('drop');
