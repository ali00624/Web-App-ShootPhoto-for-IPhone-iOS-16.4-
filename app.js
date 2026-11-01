// Камера с автозагрузкой в Supabase.
// Снимок: кнопка на экране ИЛИ любая клавиша Bluetooth-клавиатуры/кнопки (keydown).
// Никаких диалогов в процессе съёмки. Счётчик — единственная обратная связь.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.APP_CONFIG || {};
const BUCKET = cfg.SUPABASE_BUCKET || 'photos';
// Куда класть фото: true — в папку по uid (как в приложении Photo),
// false — в корень bucket (как в первом приложении).
const USE_UID_FOLDERS = cfg.USE_UID_FOLDERS !== false;

function listPrefix() {
  return USE_UID_FOLDERS && currentUser ? currentUser.id : '';
}

const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const counterEl = $('counter');
const statusEl = $('uploadStatus');
const shutter = $('shutter');
const flipBtn = $('flipBtn');
const galleryBtn = $('galleryBtn');
const hintEl = $('hint');
const keyfocus = $('keyfocus');
const cameraView = $('camera-view');
const galleryView = $('gallery-view');
const thumbsEl = $('thumbs');
const backBtn = $('backBtn');
const logoutBtn = $('logoutBtn');
const lightbox = $('lightbox');
const lightboxImg = $('lightboxImg');
const lightboxClose = $('lightboxClose');
const flashEl = $('flash');
const loginView = $('login-view');
const loginCard = $('login-card');
const loginEmail = $('login-email');
const loginPassword = $('login-password');
const loginBtn = $('login-btn');
const loginError = $('login-error');
const loginTitle = $('login-title');
const loginSwitch = $('login-switch');

// клавиши-модификаторы сами по себе НЕ делают фото
const MODIFIERS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock',
  'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'Dead'
]);

let stream = null;
let facing = 'environment';
let capturing = false;
let lastCaptureAt = 0;
let sessionCount = 0;
let pendingCount = 0;
let galleryOpen = false;
let draining = false;
let dbPromise = null;
let thumbUrl = null;
let lastUploadError = '';
let currentUser = null;

// ---------- камера ----------
async function startCamera() {
  try {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    hintEl.hidden = true;
  } catch (err) {
    hintEl.hidden = false;
    hintEl.textContent = 'Нет доступа к камере. Разреши доступ к камере для этого сайта и обнови страницу.';
  }
}

function ensureStream() {
  if (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
    startCamera();
  }
}

function flash() {
  flashEl.classList.add('on');
  setTimeout(() => flashEl.classList.remove('on'), 120);
}

function capture() {
  const now = Date.now();
  if (capturing || now - lastCaptureAt < 350) return;
  if (!video.videoWidth || !video.videoHeight) return;
  capturing = true;
  lastCaptureAt = now;
  setTimeout(() => { capturing = false; }, 2500); // страховка, если toBlob вдруг завис

  const scale = Math.min(1, 1600 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  flash();

  canvas.toBlob(async (blob) => {
    sessionCount += 1;
    counterEl.textContent = 'Фото: ' + sessionCount;
    if (blob) {
      try {
        await queueAdd(blob, makeName());
        pendingCount = await queueCount();
        updateStatus();
        showThumb(blob);
        drain();
      } catch (e) {
        // IndexedDB недоступна — пробуем отправить сразу
        try {
          await supabase.storage.from(BUCKET).upload(makeName(), blob, { contentType: 'image/jpeg' });
          updateStatus();
        } catch (e2) { lastUploadError = shortErr(e2); updateStatus(); }
      }
    }
    capturing = false;
  }, 'image/jpeg', 0.82);
}

function showThumb(blob) {
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = URL.createObjectURL(blob);
  galleryBtn.textContent = '';
  galleryBtn.style.backgroundImage = 'url("' + thumbUrl + '")';
  galleryBtn.style.backgroundSize = 'cover';
  galleryBtn.style.backgroundPosition = 'center';
}

// ---------- очередь загрузки (IndexedDB — переживает перезагрузку) ----------
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('cam-app', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('pending')) {
          req.result.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function queueAdd(blob, name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').add({ name, blob, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function queueFirst() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readonly');
    const req = tx.objectStore('pending').openCursor();
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

async function queueDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function queueCount() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readonly');
    const req = tx.objectStore('pending').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const item = await queueFirst();
      if (!item) break;
      try {
        await supabase.storage.from(BUCKET).upload(item.name, item.blob, {
          contentType: 'image/jpeg',
          cacheControl: '3600'
        });
        await queueDelete(item.id);
        lastUploadError = '';
      } catch (e) {
        lastUploadError = shortErr(e);
        break; // попробуем при следующем тике
      }
    }
  } finally {
    draining = false;
    pendingCount = await queueCount();
    updateStatus();
  }
}

function updateStatus() {
  if (pendingCount > 0) {
    statusEl.textContent = '↑ ' + pendingCount + ' в очереди' + (lastUploadError ? ' · ' + lastUploadError : '');
    statusEl.style.color = '#f0c674';
  } else {
    statusEl.textContent = '✓ всё отправлено';
    statusEl.style.color = '#9ad99a';
  }
}

// короткая человекочитаемая причина ошибки загрузки
function shortErr(e) {
  const m = String((e && (e.message || e.error_description)) || '');
  if (m.includes('Bucket not found')) return 'bucket не найден';
  if (m.includes('row-level security')) return 'нет прав (политики)';
  if (m.includes('Failed to fetch') || m.includes('NetworkError')) return 'нет сети';
  return m.slice(0, 40);
}

// самопроверка при старте: доступен ли bucket (без диалогов, только статус)
async function checkBucket() {
  try {
    const { error } = await supabase.storage.from(BUCKET).list(listPrefix(), { limit: 1 });
    if (error) {
      const isMissing = String((error && error.message) || '').includes('Bucket not found');
      statusEl.textContent = '⚠ ' + shortErr(error) + (isMissing ? ' («' + BUCKET + '»)' : '');
      statusEl.style.color = '#ff8b8b';
    }
  } catch (e) { /* нет сети — покажет очередь при первой загрузке */ }
}

function makeName() {
  const d = new Date();
  const p = (n, l) => String(n).padStart(l, '0');
  const prefix = USE_UID_FOLDERS && currentUser ? currentUser.id + '/' : '';
  return prefix + 'shot-' + d.getFullYear() + p(d.getMonth() + 1, 2) + p(d.getDate(), 2) +
    '-' + p(d.getHours(), 2) + p(d.getMinutes(), 2) + p(d.getSeconds(), 2) +
    '-' + p(d.getMilliseconds(), 3) + '-' + Math.floor(Math.random() * 10000) + '.jpg';
}

// ---------- лента ----------
async function openGallery() {
  galleryOpen = true;
  galleryView.hidden = false;
  cameraView.hidden = true;
  thumbsEl.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'loading';
  note.textContent = 'Загрузка…';
  thumbsEl.appendChild(note);

  const { data, error } = await supabase.storage.from(BUCKET).list(listPrefix(), {
    limit: 100,
    sortBy: { column: 'name', order: 'desc' }
  });

  thumbsEl.innerHTML = '';
  if (error) {
    const err = document.createElement('div');
    err.className = 'loading';
    err.textContent = 'Не удалось загрузить ленту: ' + (error.message || 'ошибка');
    thumbsEl.appendChild(err);
    return;
  }
  const files = (data || []).filter((f) => f && f.name && f.name.toLowerCase().endsWith('.jpg'));
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'loading';
    empty.textContent = 'Пока пусто';
    thumbsEl.appendChild(empty);
    return;
  }
  for (const f of files) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = f.name;
    cell.appendChild(img);
    thumbsEl.appendChild(cell);
    supabase.storage.from(BUCKET)
      .createSignedUrl((USE_UID_FOLDERS && currentUser ? currentUser.id + '/' : '') + f.name, 600)
      .then((res) => {
        if (res.data && res.data.signedUrl) {
          img.src = res.data.signedUrl;
          img.addEventListener('load', () => cell.classList.add('ready'));
          img.addEventListener('click', () => openLightbox(res.data.signedUrl));
        } else {
          cell.classList.add('failed');
        }
      })
      .catch(() => cell.classList.add('failed'));
  }
}

function closeGallery() {
  galleryOpen = false;
  galleryView.hidden = true;
  cameraView.hidden = false;
  lightbox.hidden = true;
  requestWake();
  ensureStream();
}

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = '';
}

// ---------- триггеры ----------
shutter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  capture();
});

flipBtn.addEventListener('click', () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  startCamera();
});

galleryBtn.addEventListener('click', () => {
  if (galleryOpen) return;
  openGallery();
});

backBtn.addEventListener('click', closeGallery);
logoutBtn.addEventListener('click', () => { supabase.auth.signOut(); });
lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});

// внешняя кнопка/клавиатура: любая не-модификаторная клавиша = фото
document.addEventListener('keydown', (e) => {
  if (!appStarted) return;
  if (galleryOpen) {
    if (e.key === 'Escape') closeGallery();
    return;
  }
  if (e.repeat || MODIFIERS.has(e.key)) return;
  e.preventDefault();
  capture();
}, true);

// ---------- экран не гаснет ----------
let wakeLockObj = null;
async function requestWake() {
  if ('wakeLock' in navigator) {
    try {
      if (wakeLockObj) { try { await wakeLockObj.release(); } catch (e) {} wakeLockObj = null; }
      wakeLockObj = await navigator.wakeLock.request('screen');
    } catch (e) { /* не критично */ }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWake();
    ensureStream();
    drain();
  }
});

// ---------- вход (Supabase Auth) ----------
let appStarted = false;

function showLogin() {
  loginView.hidden = false;
}

function startApp(session) {
  if (appStarted) return;
  appStarted = true;
  currentUser = session && session.user ? session.user : null;
  loginView.hidden = true;
  startCamera();
  requestWake();
  try { keyfocus.focus(); } catch (e) {}
  queueCount().then((n) => { pendingCount = n; updateStatus(); });
  checkBucket();
  drain();
  setInterval(() => drain(), 8000);
  setInterval(() => requestWake(), 300000); // каждые 5 минут продлеваем блокировку экрана
}

let authMode = 'signin';

function setAuthMode(m) {
  authMode = m;
  loginTitle.textContent = m === 'signin' ? 'Вход' : 'Регистрация';
  loginBtn.textContent = m === 'signin' ? 'Войти' : 'Создать аккаунт';
  loginSwitch.textContent = m === 'signin' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти';
  loginError.textContent = '';
}

loginSwitch.addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));

loginCard.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  try {
    const email = loginEmail.value.trim();
    const password = loginPassword.value;
    if (authMode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) loginError.textContent = error.message;
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) loginError.textContent = error.message;
      else if (data && !data.session) loginError.textContent = 'Аккаунт создан — подтверди почту и войди.';
    }
  } catch (err) {
    loginError.textContent = String((err && err.message) || err);
  } finally {
    loginBtn.disabled = false;
  }
});

// ---------- старт ----------
(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); });

  const { data } = await supabase.auth.getSession();
  if (data && data.session) {
    startApp(data.session);
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      startApp(session);
    } else {
      appStarted = false;
      showLogin();
    }
  });
})();
