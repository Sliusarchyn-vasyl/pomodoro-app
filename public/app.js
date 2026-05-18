const CIRCUMFERENCE = 2 * Math.PI * 96;
const STORAGE_KEY  = 'pomodoro.sessions.v1';
const SETTINGS_KEY = 'pomodoro.settings.v1';

const DEFAULT_SETTINGS = {
    workMin: 25,
    shortMin: 5,
    longMin: 15,
    cycle: 4,
    soundOn: true,
    autoStartBreaks: true,
};

const settingsStore = {
    load() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return { ...DEFAULT_SETTINGS, ...saved };
        } catch { return { ...DEFAULT_SETTINGS }; }
    },
    save(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); },
    reset() { localStorage.removeItem(SETTINGS_KEY); },
};

let settings = settingsStore.load();

const PHASES = {
    work:  { label: 'РОБОТА',          sub: 'фокусуйся',  color: 'var(--accent-work)'  },
    short: { label: 'КОРОТКА ПЕРЕРВА', sub: 'відпочинь',  color: 'var(--accent-short)' },
    long:  { label: 'ДОВГА ПЕРЕРВА',   sub: 'розслабся',  color: 'var(--accent-long)'  },
};

function phaseMinutes(p) {
    if (p === 'work')  return settings.workMin;
    if (p === 'short') return settings.shortMin;
    return settings.longMin;
}

let phase         = 'work';
let totalSeconds  = phaseMinutes('work') * 60;
let remaining     = totalSeconds;
let interval      = null;
let running       = false;
let pomodoroCount = 0;
let sessionStart  = null;

const displayEl  = document.getElementById('display');
const subEl      = document.getElementById('sub');
const ring       = document.getElementById('ring');
const phaseLabel = document.getElementById('phase-label');
const dotsEl     = document.getElementById('dots');
const btnStart   = document.getElementById('btn-start');
const btnPause   = document.getElementById('btn-pause');
const btnSkip    = document.getElementById('btn-skip');
const statusEl   = document.getElementById('status');

// -------- persistence (swap for fetch() when сервер з'явиться) --------
const store = {
    all() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
        catch { return []; }
    },
    save(list) { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); },
    add(record) {
        const list = this.all();
        list.push(record);
        this.save(list);
    },
    merge(incoming) {
        const list = this.all();
        const seen = new Set(list.map(r => r.id));
        for (const r of incoming) if (!seen.has(r.id)) list.push(r);
        list.sort((a, b) => a.startedAt - b.startedAt);
        this.save(list);
    },
    clear() { localStorage.removeItem(STORAGE_KEY); },
};

// -------- audio / сповіщення / вкладка --------
let audioCtx = null;
const ORIGINAL_TITLE = document.title;
let titleInterval = null;

function ensureAudio() {
    if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone(freq, startAt, duration = 0.3, volume = 0.18) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
    osc.start(startAt);
    osc.stop(startAt + duration);
}

function playChime(kind) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    if (kind === 'work') {
        playTone(523.25, t,        0.20); // C5
        playTone(659.25, t + 0.12, 0.20); // E5
        playTone(783.99, t + 0.24, 0.45); // G5
    } else {
        playTone(587.33, t,        0.28); // D5
        playTone(880.00, t + 0.18, 0.45); // A5
    }
}

function requestNotifPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission();
}

function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
        const n = new Notification(title, { body, silent: true });
        n.onclick = () => { window.focus(); n.close(); };
    } catch {}
}

function flashTitle(text) {
    stopTitleFlash();
    let on = false;
    titleInterval = setInterval(() => {
        document.title = on ? ORIGINAL_TITLE : text;
        on = !on;
    }, 1000);
}

function stopTitleFlash() {
    if (titleInterval) {
        clearInterval(titleInterval);
        titleInterval = null;
        document.title = ORIGINAL_TITLE;
    }
}

function signalFinish(endedPhase) {
    if (settings.soundOn) {
        playChime(endedPhase === 'work' ? 'work' : 'break');
    }
    if (endedPhase === 'work') {
        notify('🍅 Робочий блок завершено', 'Час перерви');
        if (document.hidden) flashTitle('🔔 Перерва! — Pomodoro');
    } else {
        notify('⚡ Перерва завершена', 'Час повертатися до роботи');
        if (document.hidden) flashTitle('🔔 До роботи! — Pomodoro');
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stopTitleFlash();
});

function newId() {
    return (crypto.randomUUID && crypto.randomUUID())
        || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function logSession(outcome) {
    if (!sessionStart) return;
    const record = {
        id: newId(),
        type: phase,
        startedAt: sessionStart,
        finishedAt: Date.now(),
        plannedSec: totalSeconds,
        actualSec: totalSeconds - remaining,
        outcome, // 'completed' | 'skipped'
        pomodoro: (phase === 'work' && outcome === 'completed') ? pomodoroCount : null,
    };
    store.add(record);
    sessionStart = null;
    renderHistory();
}

// -------- утиліти часу --------
function pad(n) { return String(n).padStart(2, '0'); }

function formatTime(s) {
    if (s >= 3600) {
        return `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`;
    }
    return `${pad(Math.floor(s/60))}:${pad(s%60)}`;
}

function formatDuration(sec) {
    if (sec >= 3600) {
        const h = Math.floor(sec/3600);
        const m = Math.round((sec%3600)/60);
        return `${h}г ${m}хв`;
    }
    if (sec >= 60) return `${Math.round(sec/60)}хв`;
    return `${sec}с`;
}

function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function formatDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = new Date();
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(date, today))     return 'Сьогодні';
    if (sameDay(date, yesterday)) return 'Вчора';
    return date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
}

function formatClock(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// -------- рендер таймера --------
function animateRing(pct, duration = 600) {
    const offset = CIRCUMFERENCE * (1 - pct);
    anime({ targets: ring, strokeDashoffset: offset, duration, easing: 'easeOutQuart' });
}

function setDanger(on) {
    displayEl.classList.toggle('danger', on);
    ring.style.stroke = on ? 'var(--danger)' : PHASES[phase].color;
}

function applyPhase() {
    document.documentElement.style.setProperty('--accent', PHASES[phase].color);
    ring.style.stroke = PHASES[phase].color;
    phaseLabel.textContent = PHASES[phase].label;
}

function renderDots() {
    dotsEl.innerHTML = '';
    const cycle = settings.cycle;
    const done = phase === 'work'
        ? pomodoroCount % cycle
        : ((pomodoroCount - 1) % cycle) + 1;
    const current = phase === 'work' ? pomodoroCount % cycle : -1;
    for (let i = 0; i < cycle; i++) {
        const d = document.createElement('div');
        d.className = 'dot';
        if (i < done) d.classList.add('done');
        else if (i === current) d.classList.add('current');
        dotsEl.appendChild(d);
    }
}

function updateUI() {
    displayEl.textContent = formatTime(remaining);
    animateRing(totalSeconds > 0 ? remaining / totalSeconds : 0);
    setDanger(remaining <= 10 && remaining > 0 && running);
}

// -------- фази --------
function loadPhase(newPhase, { autoStart } = { autoStart: false }) {
    phase = newPhase;
    totalSeconds = phaseMinutes(phase) * 60;
    remaining = totalSeconds;
    applyPhase();
    renderDots();
    displayEl.textContent = formatTime(remaining);
    subEl.textContent = PHASES[phase].sub;
    setDanger(false);
    animateRing(1, 600);

    if (autoStart) {
        startRunning();
    } else {
        running = false;
        ring.classList.remove('pulsing');
        btnStart.disabled = false;
        btnPause.disabled = true;
        btnPause.textContent = 'Пауза';
    }
}

function startRunning() {
    if (sessionStart === null) sessionStart = Date.now();
    ensureAudio();
    running = true;
    ring.classList.add('pulsing');
    btnStart.disabled = true;
    btnPause.disabled = false;
    statusEl.textContent = '';

    anime({
        targets: ring,
        strokeDashoffset: [CIRCUMFERENCE, CIRCUMFERENCE * (1 - remaining / totalSeconds)],
        duration: 800,
        easing: 'easeOutExpo',
        complete: () => {
            updateUI();
            interval = setInterval(tick, 1000);
        }
    });
}

function handleStart() {
    requestNotifPermission();
    startRunning();
}

function tick() {
    if (remaining <= 0) { finishPhase(); return; }
    remaining--;

    displayEl.classList.remove('tick');
    void displayEl.offsetWidth;
    displayEl.classList.add('tick');

    updateUI();
    if (remaining === 0) finishPhase();
}

function finishPhase() {
    clearInterval(interval); interval = null; running = false;
    ring.classList.remove('pulsing');
    setDanger(false);
    signalFinish(phase);

    anime({
        targets: '#card',
        translateY: [0, -6, 0, -3, 0],
        duration: 500,
        easing: 'easeInOutSine'
    });

    if (phase === 'work') {
        pomodoroCount++;
        logSession('completed');
        const next = (pomodoroCount % settings.cycle === 0) ? 'long' : 'short';
        statusEl.textContent = `🍅 ${pomodoroCount} — перерва починається…`;
        setTimeout(() => loadPhase(next, { autoStart: settings.autoStartBreaks }), 1200);
    } else {
        logSession('completed');
        statusEl.textContent = 'готовий до нового помідора';
        setTimeout(() => loadPhase('work', { autoStart: false }), 1200);
    }
}

function handlePause() {
    if (!running) {
        running = true;
        ring.classList.add('pulsing');
        interval = setInterval(tick, 1000);
        btnPause.textContent = 'Пауза';
        subEl.textContent = PHASES[phase].sub;
    } else {
        running = false;
        ring.classList.remove('pulsing');
        clearInterval(interval); interval = null;
        btnPause.textContent = 'Далі';
        subEl.textContent = 'пауза';
    }
}

function handleSkip() {
    clearInterval(interval); interval = null; running = false;
    ring.classList.remove('pulsing');
    logSession('skipped');

    if (phase === 'work') {
        pomodoroCount++;
        const next = (pomodoroCount % settings.cycle === 0) ? 'long' : 'short';
        loadPhase(next, { autoStart: false });
    } else {
        loadPhase('work', { autoStart: false });
    }
    statusEl.textContent = 'пропущено';
}

function handleReset() {
    clearInterval(interval); interval = null; running = false;
    logSession('skipped');
    pomodoroCount = 0;
    loadPhase('work', { autoStart: false });
    statusEl.textContent = 'сесію скинуто';
}

// -------- історія --------
function renderHistory() {
    const list = store.all();
    const listEl = document.getElementById('history-list');
    const statsEl = document.getElementById('today-stats');

    const todayK = dayKey(Date.now());
    const todayAll = list.filter(r => dayKey(r.startedAt) === todayK && r.outcome === 'completed');
    const todayWork = todayAll.filter(r => r.type === 'work');
    const focusSec = todayWork.reduce((s, r) => s + r.actualSec, 0);

    if (todayWork.length > 0) {
        statsEl.textContent = `${todayWork.length}🍅 · ${formatDuration(focusSec)}`;
    } else if (todayAll.length > 0) {
        const breakSec = todayAll.reduce((s, r) => s + r.actualSec, 0);
        statsEl.textContent = `0🍅 · ${formatDuration(breakSec)} перерв`;
    } else {
        statsEl.textContent = 'сьогодні пусто';
    }

    if (list.length === 0) {
        listEl.innerHTML = '<div class="history-empty">ще нема записів</div>';
        return;
    }

    const byDay = {};
    for (const r of list) {
        const k = dayKey(r.startedAt);
        (byDay[k] = byDay[k] || []).push(r);
    }
    const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));

    listEl.innerHTML = '';
    for (const day of days) {
        const records = byDay[day].slice().sort((a, b) => a.startedAt - b.startedAt);
        const workDone = records.filter(r => r.type === 'work' && r.outcome === 'completed');
        const daySec = workDone.reduce((s, r) => s + r.actualSec, 0);

        const dayEl = document.createElement('div');
        dayEl.className = 'day';

        const head = document.createElement('div');
        head.className = 'day-head';
        head.innerHTML = `
            <span class="date">${formatDate(day)}</span>
            <span class="meta">${workDone.length}🍅 · ${formatDuration(daySec)}</span>
        `;
        dayEl.appendChild(head);

        const sessEl = document.createElement('div');
        sessEl.className = 'sessions';
        for (const r of records) {
            const row = document.createElement('div');
            row.className = 'session' + (r.outcome === 'skipped' ? ' skipped' : '');
            row.innerHTML = `
                <span class="time">${formatClock(r.startedAt)}</span>
                <span class="type ${r.type}">${PHASES[r.type].label.toLowerCase()}</span>
                <span class="dur">${formatDuration(r.actualSec)}</span>
            `;
            sessEl.appendChild(row);
        }
        dayEl.appendChild(sessEl);
        listEl.appendChild(dayEl);
    }
}

function exportLog() {
    const list = store.all();
    if (list.length === 0) { statusEl.textContent = 'нема чого експортувати'; return; }
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pomodoro-log-${dayKey(Date.now())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = `експортовано ${list.length}`;
}

function importLog(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const incoming = JSON.parse(reader.result);
            if (!Array.isArray(incoming)) throw new Error('not an array');
            const before = store.all().length;
            store.merge(incoming);
            const after = store.all().length;
            statusEl.textContent = `+${after - before} нових записів`;
            renderHistory();
        } catch {
            statusEl.textContent = 'помилка імпорту';
        }
        ev.target.value = '';
    };
    reader.readAsText(file);
}

function clearLog() {
    if (!confirm('Видалити всю історію?')) return;
    store.clear();
    statusEl.textContent = 'історію очищено';
    renderHistory();
}

// -------- налаштування --------
function isDefaultSettings(s) {
    return Object.keys(DEFAULT_SETTINGS).every(k => s[k] === DEFAULT_SETTINGS[k]);
}

function renderSettingsHint() {
    const hint = document.getElementById('settings-hint');
    hint.textContent = isDefaultSettings(settings)
        ? 'за замовчуванням'
        : `${settings.workMin}/${settings.shortMin}/${settings.longMin} · ×${settings.cycle}`;
}

function renderSettings() {
    document.getElementById('set-work').value  = settings.workMin;
    document.getElementById('set-short').value = settings.shortMin;
    document.getElementById('set-long').value  = settings.longMin;
    document.getElementById('set-cycle').value = settings.cycle;
    document.getElementById('set-sound').checked = settings.soundOn;
    document.getElementById('set-auto').checked  = settings.autoStartBreaks;
    renderSettingsHint();
}

function readSettingsForm() {
    const num = (id, min, max, label) => {
        const v = parseInt(document.getElementById(id).value, 10);
        if (isNaN(v) || v < min || v > max) {
            throw new Error(`${label}: ${min}–${max}`);
        }
        return v;
    };
    return {
        workMin:  num('set-work',  1, 180, 'Робота'),
        shortMin: num('set-short', 1, 60,  'Коротка'),
        longMin:  num('set-long',  1, 120, 'Довга'),
        cycle:    num('set-cycle', 2, 12,  'Цикл'),
        soundOn:  document.getElementById('set-sound').checked,
        autoStartBreaks: document.getElementById('set-auto').checked,
    };
}

let noteTimer = null;
function setNote(text, kind = '') {
    const note = document.getElementById('settings-note');
    note.textContent = text;
    note.className = 'settings-note' + (kind ? ' ' + kind : '');
    clearTimeout(noteTimer);
    if (text) {
        noteTimer = setTimeout(() => {
            note.textContent = '';
            note.className = 'settings-note';
        }, 3000);
    }
}

function applySettings(newSettings) {
    const wasRunning = running;
    settings = newSettings;
    settingsStore.save(settings);
    renderSettingsHint();

    if (wasRunning) {
        renderDots();
        return 'pending';
    }
    loadPhase(phase, { autoStart: false });
    return 'applied';
}

function handleSaveSettings() {
    let newSettings;
    try {
        newSettings = readSettingsForm();
    } catch (e) {
        setNote(e.message, 'err');
        return;
    }
    const result = applySettings(newSettings);
    if (result === 'pending') setNote('застосується після поточної фази', 'warn');
    else                      setNote('збережено ✓', 'ok');
}

function handleResetSettings() {
    settingsStore.reset();
    settings = { ...DEFAULT_SETTINGS };
    renderSettings();
    if (running) {
        renderDots();
        setNote('застосується після поточної фази', 'warn');
    } else {
        loadPhase(phase, { autoStart: false });
        setNote('скинуто до стандартних', 'ok');
    }
}

// -------- init --------
applyPhase();
renderDots();
renderHistory();
renderSettings();
