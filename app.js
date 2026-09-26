'use strict';

const $ = (sel) => document.querySelector(sel);
const CLAUDE_MODEL = 'claude-sonnet-5';

// ---------- 保存 ----------
const store = {
  get(key, def) {
    try { const v = localStorage.getItem('eikaiwa:' + key); return v == null ? def : JSON.parse(v); }
    catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem('eikaiwa:' + key, JSON.stringify(val)); } catch { /* 保存できない環境 */ }
  },
};

const settings = Object.assign({ apiKey: '', voice: '', rate: 0.9 }, store.get('settings', {}));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 学習記録 ----------
const ACTIVITIES = {
  scn: '🎭 会話練習',
  ai: '🤖 AIトーク',
  pron: '🎤 発音練習',
  card: '🃏 単語カード',
  quiz: '📝 単語クイズ',
  spell: '✍️ スペル',
  translate: '🌐 翻訳',
};

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const stats = {
  lastActivity: 0,

  day(key = dayKey()) {
    const log = store.get('log', {});
    return log[key] || { sec: 0, n: {}, ok: {} };
  },

  update(fn) {
    const log = store.get('log', {});
    const key = dayKey();
    log[key] = log[key] || { sec: 0, n: {}, ok: {} };
    fn(log[key]);
    store.set('log', log);
  },

  /** 練習を1回記録。ok は正解/合格なら true（正誤のない練習は省略） */
  add(kind, ok) {
    this.update((d) => {
      d.n[kind] = (d.n[kind] || 0) + 1;
      if (ok) d.ok[kind] = (d.ok[kind] || 0) + 1;
    });
    this.lastActivity = Date.now();
  },

  miss(en) {
    const m = store.get('vocabMiss', {});
    m[en] = (m[en] || 0) + 1;
    store.set('vocabMiss', m);
  },

  isActive(d) { return d && (d.sec >= 60 || Object.values(d.n).some((v) => v > 0)); },

  streak() {
    const log = store.get('log', {});
    const d = new Date();
    if (!this.isActive(log[dayKey(d)])) d.setDate(d.getDate() - 1); // 今日まだなら昨日から数える
    let n = 0;
    while (this.isActive(log[dayKey(d)])) { n++; d.setDate(d.getDate() - 1); }
    return n;
  },
};

// 操作中かつ画面表示中の時間だけを学習時間として数える
const TICK = 15;
['click', 'keydown', 'touchstart', 'input'].forEach((ev) =>
  document.addEventListener(ev, () => { stats.lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (document.hidden || Date.now() - stats.lastActivity > 90_000) return;
  stats.update((d) => { d.sec += TICK; });
}, TICK * 1000);

const fmtMin = (sec) => {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
};

const hasJapanese = (s) => /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(s);

// ---------- 音声合成 ----------
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const sel = $('#set-voice');
  const en = voices.filter((v) => v.lang.startsWith('en'));
  sel.innerHTML = en.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} (${v.lang})</option>`).join('');
  if (!settings.voice) {
    const pref = en.find((v) => /Natural|Online/.test(v.name) && v.lang === 'en-US')
      || en.find((v) => /Google US English/.test(v.name))
      || en.find((v) => v.lang === 'en-US') || en[0];
    if (pref) settings.voice = pref.name;
  }
  sel.value = settings.voice;
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text, { lang, slow } = {}) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang || (hasJapanese(text) ? 'ja-JP' : 'en-US');
  if (u.lang.startsWith('en')) {
    const v = voices.find((x) => x.name === settings.voice);
    if (v) u.voice = v;
  } else {
    const v = voices.find((x) => x.lang === 'ja-JP');
    if (v) u.voice = v;
  }
  u.rate = slow ? Math.max(0.5, settings.rate - 0.3) : settings.rate;
  speechSynthesis.speak(u);
}

// ---------- 音声認識 ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRec = null;

/** マイクで聞き取り。btn はトグル表示用、onInterim で途中経過を受け取る。 */
function listen(btn, lang, onInterim) {
  if (!Recognition) {
    toast('このブラウザは音声認識に未対応です（Chrome / Edge 推奨）');
    return Promise.resolve('');
  }
  if (!window.isSecureContext) {
    toast('マイクは https:// のページでのみ使えます');
    return Promise.resolve('');
  }
  if (activeRec) { activeRec.stop(); return Promise.resolve(null); }
  speechSynthesis.cancel();
  return new Promise((resolve) => {
    const rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      finalText = '';
      for (const r of e.results) {
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      onInterim && onInterim(finalText + interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') toast('マイクの使用が許可されていません');
      else if (e.error === 'no-speech') toast('音声が聞き取れませんでした');
      else if (e.error !== 'aborted') toast('音声認識エラー: ' + e.error);
    };
    rec.onend = () => {
      activeRec = null;
      btn.classList.remove('listening');
      resolve(finalText.trim());
    };
    activeRec = rec;
    btn.classList.add('listening');
    rec.start();
  });
}

// ---------- 採点 ----------
function words(s) {
  return s.toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/'/g, ''))
    .filter(Boolean);
}

/** 単語列の LCS。一致した a 側のインデックス集合も返す。 */
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const matchedA = new Set();
  for (let i = a.length, j = b.length; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1]) { matchedA.add(i - 1); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return { len: dp[a.length][b.length], matchedA };
}

function similarity(x, y) {
  const a = words(x), b = words(y);
  if (!a.length || !b.length) return 0;
  return Math.round((200 * lcs(a, b).len) / (a.length + b.length));
}

const scoreClass = (s) => (s >= 80 ? 'good' : s >= 60 ? 'ok' : 'bad');

// ---------- Claude API ----------
async function callClaude(system, messages, maxTokens = 600) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) {
    let msg = res.status + '';
    try { msg = (await res.json()).error.message; } catch { /* ignore */ }
    throw new Error('Claude API エラー: ' + msg);
  }
  const data = await res.json();
  return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

// ---------- タブ ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    if (t.dataset.tab === 'ai') ai.onOpen();
    if (t.dataset.tab === 'saved') renderSaved();
    if (t.dataset.tab === 'vocab') vocab.render();
    if (t.dataset.tab === 'stats') statsView.render();
    store.set('tab', t.dataset.tab);
    window.scrollTo(0, 0);
  });
});

// スマホ: キーボード表示中は下部タブバーを隠す
const isTextField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|password|search)$/.test(el.type)));
document.addEventListener('focusin', (e) => { if (isTextField(e.target)) document.body.classList.add('kb-open'); });
document.addEventListener('focusout', () => {
  setTimeout(() => { if (!isTextField(document.activeElement)) document.body.classList.remove('kb-open'); }, 100);
});

// ---------- 保存フレーズ ----------
function savePhrase(en, ja) {
  const saved = store.get('saved', []);
  if (saved.some((s) => s.en === en)) { toast('保存済みです'); return; }
  saved.unshift({ en, ja, at: Date.now() });
  store.set('saved', saved);
  toast('⭐ 保存しました');
}

function renderSaved() {
  const saved = store.get('saved', []);
  const ul = $('#saved-list');
  if (!saved.length) { ul.innerHTML = '<li class="muted">まだ保存されたフレーズはありません</li>'; return; }
  ul.innerHTML = saved.map((s, i) => `
    <li data-i="${i}">
      <div class="txt"><div class="en">${escapeHtml(s.en)}</div><div class="ja">${escapeHtml(s.ja || '')}</div></div>
      <button class="btn ghost" data-act="del" title="削除">🗑️</button>
    </li>`).join('');
}
$('#saved-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const saved = store.get('saved', []);
  const i = +li.dataset.i;
  if (e.target.dataset.act === 'del') {
    saved.splice(i, 1);
    store.set('saved', saved);
    renderSaved();
  } else {
    speak(saved[i].en, { lang: 'en-US' });
  }
});

// ---------- 翻訳 ----------
const tr = {
  from: 'ja', // 'ja' | 'en'
  last: null,

  setDir(from) {
    this.from = from;
    $('#src-lang-label').textContent = from === 'ja' ? '日本語' : 'English';
    $('#dst-lang-label').textContent = from === 'ja' ? 'English' : '日本語';
    $('#src-text').placeholder = from === 'ja'
      ? '翻訳したい日本語を入力、またはマイクで話してください'
      : 'Type or speak English to translate into Japanese';
  },

  async translate(text, from, to) {
    if (settings.apiKey) {
      const out = await callClaude(
        `You are a professional translator. Translate the user's text from ${from === 'ja' ? 'Japanese' : 'English'} to ${to === 'ja' ? 'Japanese' : 'English'}. Use natural, conversational phrasing. Output only the translation, nothing else.`,
        [{ role: 'user', content: text }],
        1000,
      );
      return { text: out, engine: 'Claude' };
    }
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${from}|${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('翻訳サービスに接続できませんでした');
    const data = await res.json();
    if (data.responseStatus !== 200) throw new Error(data.responseDetails || '翻訳に失敗しました');
    const t = document.createElement('textarea');
    t.innerHTML = data.responseData.translatedText; // HTML エンティティを戻す
    return { text: t.value, engine: 'MyMemory' };
  },

  async run() {
    const text = $('#src-text').value.trim();
    if (!text) { toast('文章を入力してください'); return; }
    const from = hasJapanese(text) ? 'ja' : 'en';
    const to = from === 'ja' ? 'en' : 'ja';
    this.setDir(from);
    const btn = $('#btn-translate');
    const dst = $('#dst-text');
    btn.disabled = true;
    dst.classList.add('placeholder');
    dst.textContent = '翻訳中…';
    try {
      const r = await this.translate(text, from, to);
      dst.classList.remove('placeholder');
      dst.textContent = r.text;
      $('#engine-label').textContent = 'by ' + r.engine;
      this.last = from === 'ja' ? { en: r.text, ja: text } : { en: text, ja: r.text };
      this.last.dst = r.text;
      this.last.dstLang = to;
      const hist = store.get('history', []).filter((h) => h.en !== this.last.en);
      hist.unshift({ en: this.last.en, ja: this.last.ja });
      store.set('history', hist.slice(0, 20));
      this.renderHistory();
      stats.add('translate');
      if (to === 'en') speak(r.text, { lang: 'en-US' });
    } catch (e) {
      dst.textContent = '⚠️ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  },

  renderHistory() {
    const hist = store.get('history', []);
    $('#history-list').innerHTML = hist.length
      ? hist.map((h, i) => `
        <li data-i="${i}">
          <div class="txt"><div class="en">${escapeHtml(h.en)}</div><div class="ja">${escapeHtml(h.ja)}</div></div>
          <button class="btn ghost" data-act="speak" title="読み上げ">🔊</button>
        </li>`).join('')
      : '<li class="muted">翻訳履歴はまだありません</li>';
  },
};

$('#btn-translate').addEventListener('click', () => tr.run());
$('#src-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) tr.run();
});
$('#btn-swap').addEventListener('click', () => {
  if (tr.last) $('#src-text').value = tr.last.dst;
  tr.setDir(tr.from === 'ja' ? 'en' : 'ja');
});
$('#btn-clear').addEventListener('click', () => {
  $('#src-text').value = '';
  $('#dst-text').textContent = 'ここに翻訳結果が表示されます';
  $('#dst-text').classList.add('placeholder');
  $('#engine-label').textContent = '';
  tr.last = null;
});
$('#btn-src-mic').addEventListener('click', async (e) => {
  const lang = tr.from === 'ja' ? 'ja-JP' : 'en-US';
  const text = await listen(e.currentTarget, lang, (t) => { $('#src-text').value = t; });
  if (text) { $('#src-text').value = text; tr.run(); }
});
$('#btn-src-speak').addEventListener('click', () => speak($('#src-text').value));
$('#btn-dst-speak').addEventListener('click', () => tr.last && speak(tr.last.dst));
$('#btn-dst-slow').addEventListener('click', () => tr.last && speak(tr.last.dst, { slow: true }));
$('#btn-copy').addEventListener('click', async () => {
  if (!tr.last) return;
  try { await navigator.clipboard.writeText(tr.last.dst); toast('コピーしました'); }
  catch { toast('コピーできませんでした'); }
});
$('#btn-save').addEventListener('click', () => tr.last && savePhrase(tr.last.en, tr.last.ja));
$('#history-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const h = store.get('history', [])[+li.dataset.i];
  if (e.target.dataset.act === 'speak') { speak(h.en, { lang: 'en-US' }); return; }
  $('#src-text').value = h.ja;
  tr.setDir('ja');
  $('#dst-text').classList.remove('placeholder');
  $('#dst-text').textContent = h.en;
  tr.last = { en: h.en, ja: h.ja, dst: h.en, dstLang: 'en' };
});

// ---------- チャット表示の共通部品 ----------
function addBubble(chat, who, text, sub) {
  const div = document.createElement('div');
  div.className = 'bubble ' + who;
  div.innerHTML = `<div>${escapeHtml(text)}</div>`;
  if (who === 'ai') {
    const subEl = document.createElement('div');
    subEl.className = 'sub hidden';
    subEl.textContent = sub || '';
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML = '<button title="読み上げ">🔊</button><button title="ゆっくり">🐢</button>'
      + (sub ? '<button title="日本語訳">🇯🇵</button>' : '') + '<button title="保存">⭐</button>';
    actions.addEventListener('click', (e) => {
      const t = e.target.title;
      if (t === '読み上げ') speak(text, { lang: 'en-US' });
      if (t === 'ゆっくり') speak(text, { lang: 'en-US', slow: true });
      if (t === '日本語訳') subEl.classList.toggle('hidden');
      if (t === '保存') savePhrase(text, sub);
    });
    div.append(subEl, actions);
  }
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addHtml(chat, cls, html) {
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = html;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

// ---------- シナリオ会話練習 ----------
const scn = {
  cur: null,
  idx: 0,
  scores: [],
  tries: 0,

  renderPicker() {
    const best = store.get('scnBest', {});
    $('#scenario-grid').innerHTML = SCENARIOS.map((s) => `
      <button class="scn-card" data-id="${s.id}">
        <div class="emoji">${s.emoji}</div>
        <div class="name">${s.name}</div>
        <div class="desc">${s.desc}（${s.turns.length}ターン）</div>
        ${best[s.id] != null ? `<div class="best">ベスト: ${best[s.id]}点</div>` : ''}
      </button>`).join('');
  },

  start(id) {
    this.cur = SCENARIOS.find((s) => s.id === id);
    this.idx = 0;
    this.scores = [];
    $('#scenario-picker').classList.add('hidden');
    $('#scenario-play').classList.remove('hidden');
    $('#scn-title').textContent = `${this.cur.emoji} ${this.cur.name}`;
    $('#scn-chat').innerHTML = '';
    this.ask();
  },

  get turn() { return this.cur.turns[this.idx]; },

  ask() {
    this.tries = 0;
    $('#scn-hint').classList.add('hidden');
    $('#scn-progress').textContent = `${this.idx + 1} / ${this.cur.turns.length}`;
    addBubble($('#scn-chat'), 'ai', this.turn.ai, this.turn.ja);
    speak(this.turn.ai, { lang: 'en-US' });
    $('#scn-input').value = '';
    $('#scn-input').focus();
  },

  answer(text) {
    text = text.trim();
    if (!text || !this.cur || this.idx >= this.cur.turns.length) return;
    const chat = $('#scn-chat');
    addBubble(chat, 'me', text);
    $('#scn-input').value = '';

    if (hasJapanese(text)) {
      addHtml(chat, 'feedback bad', '英語で言ってみよう！💡ヒントや📖模範解答も使えます。');
      return;
    }
    this.tries++;
    let best = { score: 0, ans: this.turn.answers[0] };
    for (const a of this.turn.answers) {
      const s = similarity(text, a);
      if (s > best.score) best = { score: s, ans: a };
    }
    stats.add('scn', best.score >= 60);
    const cls = scoreClass(best.score);
    const msg = best.score >= 80 ? 'Excellent! 🎉' : best.score >= 60 ? 'Good! 👍' : 'もう少し！';
    const fb = addHtml(chat, `feedback ${cls}`,
      `<span class="score ${cls}">${best.score}点</span> ${msg}<br>`
      + `<span class="muted">例:</span> ${escapeHtml(best.ans)} <button class="btn ghost" data-speak>🔊</button>`);
    fb.querySelector('[data-speak]').addEventListener('click', () => speak(best.ans, { lang: 'en-US' }));

    if (best.score >= 60 || this.tries >= 3) {
      this.scores.push(best.score);
      this.next();
    } else {
      const skip = document.createElement('button');
      skip.className = 'btn ghost';
      skip.textContent = 'スキップ →';
      skip.addEventListener('click', () => { skip.remove(); this.scores.push(best.score); this.next(); });
      fb.appendChild(skip);
    }
  },

  next() {
    this.idx++;
    if (this.idx < this.cur.turns.length) {
      setTimeout(() => this.ask(), 1200);
      return;
    }
    const avg = Math.round(this.scores.reduce((a, b) => a + b, 0) / this.scores.length);
    const best = store.get('scnBest', {});
    const isBest = best[this.cur.id] == null || avg > best[this.cur.id];
    if (isBest) { best[this.cur.id] = avg; store.set('scnBest', best); }
    const cls = scoreClass(avg);
    const end = addHtml($('#scn-chat'), 'bubble system',
      `🏁 会話終了！ 平均スコア <span class="score ${cls}">${avg}点</span>${isBest ? '（ベスト更新！）' : ''}<br>`
      + '<button class="btn primary" data-retry>もう一度</button> <button class="btn ghost" data-back>シーン一覧へ</button>');
    end.querySelector('[data-retry]').addEventListener('click', () => this.start(this.cur.id));
    end.querySelector('[data-back]').addEventListener('click', () => this.back());
    $('#scn-progress').textContent = '完了';
  },

  back() {
    if (activeRec) activeRec.stop();
    speechSynthesis.cancel();
    this.cur = null;
    $('#scenario-play').classList.add('hidden');
    $('#scenario-picker').classList.remove('hidden');
    this.renderPicker();
  },
};

$('#scenario-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.scn-card');
  if (card) scn.start(card.dataset.id);
});
$('#btn-scn-back').addEventListener('click', () => scn.back());
$('#btn-scn-send').addEventListener('click', () => scn.answer($('#scn-input').value));
$('#scn-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) scn.answer($('#scn-input').value);
});
$('#btn-scn-mic').addEventListener('click', async (e) => {
  const text = await listen(e.currentTarget, 'en-US', (t) => { $('#scn-input').value = t; });
  if (text) scn.answer(text);
});
$('#btn-scn-hint').addEventListener('click', () => {
  if (!scn.cur || scn.idx >= scn.cur.turns.length) return;
  const el = $('#scn-hint');
  el.innerHTML = `💡 ${escapeHtml(scn.turn.hint)}<br><span class="muted">相手: ${escapeHtml(scn.turn.ja)}</span>`;
  el.classList.remove('hidden');
});
$('#btn-scn-answer').addEventListener('click', () => {
  if (!scn.cur || scn.idx >= scn.cur.turns.length) return;
  const el = $('#scn-hint');
  el.innerHTML = '📖 模範解答<br>' + scn.turn.answers.map((a) => '・' + escapeHtml(a)).join('<br>');
  el.classList.remove('hidden');
  speak(scn.turn.answers[0], { lang: 'en-US' });
});
$('#btn-scn-repeat').addEventListener('click', () => {
  if (scn.cur && scn.idx < scn.cur.turns.length) speak(scn.turn.ai, { lang: 'en-US' });
});

// ---------- AI フリートーク ----------
const TOPICS = {
  free: 'anything the learner wants to talk about (casual small talk)',
  hobby: "the learner's hobbies and interests",
  travel: 'travel experiences and dream destinations',
  work: "the learner's job and work life",
  food: 'food, cooking and restaurants',
  interview: 'a job interview in English (you are the interviewer; ask typical interview questions one at a time)',
};
const LEVELS = {
  beginner: 'a beginner (CEFR A1-A2). Use very simple words and short sentences.',
  intermediate: 'an intermediate learner (CEFR B1-B2). Use natural everyday English.',
  advanced: 'an advanced learner (CEFR C1). Use natural, idiomatic English.',
};

const ai = {
  messages: [],
  busy: false,

  system() {
    return `You are a friendly English conversation partner for a Japanese learner who is ${LEVELS[$('#ai-level').value]}
Topic: ${TOPICS[$('#ai-topic').value]}.
Keep the conversation going: reply in 1-3 sentences and usually end with a question.
If the learner writes Japanese, understand it and gently show how to say it in English.

Always answer in exactly this format:
REPLY: <your English reply>
JA: <natural Japanese translation of your reply>
FEEDBACK: <In Japanese, point out grammar or wording mistakes in the learner's last message and give a more natural English version. If it was already natural, write なし. For the very first message write なし.>`;
  },

  onOpen() {
    $('#ai-nokey').classList.toggle('hidden', !!settings.apiKey);
    if (settings.apiKey && !this.messages.length && !this.busy) this.reset();
  },

  reset() {
    this.messages = [];
    $('#ai-chat').innerHTML = '';
    if (!settings.apiKey) { this.onOpen(); return; }
    this.send('(Please start the conversation with a greeting and a first question.)', true);
  },

  parse(raw) {
    const get = (tag) => {
      const m = raw.match(new RegExp(tag + ':\\s*([\\s\\S]*?)(?=\\n(?:REPLY|JA|FEEDBACK):|$)'));
      return m ? m[1].trim() : '';
    };
    return { reply: get('REPLY') || raw, ja: get('JA'), feedback: get('FEEDBACK') };
  },

  async send(text, hidden = false) {
    text = text.trim();
    if (!text || this.busy) return;
    if (!settings.apiKey) { this.onOpen(); toast('⚙️ 設定で API キーを登録してください'); return; }
    const chat = $('#ai-chat');
    if (!hidden) addBubble(chat, 'me', text);
    $('#ai-input').value = '';
    this.messages.push({ role: 'user', content: text });
    this.busy = true;
    const typing = addHtml(chat, 'bubble ai typing', '<span></span><span></span><span></span>');
    try {
      const raw = await callClaude(this.system(), this.messages);
      this.messages.push({ role: 'assistant', content: raw });
      typing.remove();
      const p = this.parse(raw);
      if (!hidden && p.feedback && p.feedback !== 'なし') {
        addHtml(chat, 'feedback ok', '✏️ ' + escapeHtml(p.feedback).replace(/\n/g, '<br>'));
      }
      addBubble(chat, 'ai', p.reply, p.ja);
      if (!hidden) stats.add('ai');
      if ($('#ai-autospeak').checked) speak(p.reply, { lang: 'en-US' });
    } catch (e) {
      typing.remove();
      this.messages.pop();
      addHtml(chat, 'bubble system', '⚠️ ' + escapeHtml(e.message));
    } finally {
      this.busy = false;
    }
  },
};

$('#btn-ai-send').addEventListener('click', () => ai.send($('#ai-input').value));
$('#ai-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) ai.send($('#ai-input').value);
});
$('#btn-ai-mic').addEventListener('click', async (e) => {
  const text = await listen(e.currentTarget, 'en-US', (t) => { $('#ai-input').value = t; });
  if (text) ai.send(text);
});
$('#btn-ai-reset').addEventListener('click', () => ai.reset());
$('#ai-topic').addEventListener('change', () => ai.reset());
$('#ai-level').addEventListener('change', () => ai.reset());

// ---------- 発音練習 ----------
const pron = {
  cat: Object.keys(PHRASES)[0],
  idx: 0,

  get list() { return PHRASES[this.cat]; },
  get phrase() { return this.list[this.idx]; },

  render() {
    const [en, ja] = this.phrase;
    $('#pron-en').textContent = en;
    $('#pron-ja').textContent = ja;
    $('#pron-pos').textContent = `${this.idx + 1} / ${this.list.length}`;
    const best = store.get('pronBest', {})[en];
    $('#pron-result').innerHTML = best != null ? `<span class="muted">ベスト: ${best}点</span>` : '';
    const all = store.get('pronBest', {});
    const scored = this.list.filter(([p]) => all[p] != null);
    $('#pron-score-total').textContent = scored.length
      ? `このカテゴリの平均: ${Math.round(scored.reduce((s, [p]) => s + all[p], 0) / scored.length)}点（${scored.length}/${this.list.length}）`
      : '';
  },

  judge(heard) {
    const [en] = this.phrase;
    const target = en.split(/\s+/);
    const tw = target.map((w) => words(w).join(''));
    const hw = words(heard);
    const { len, matchedA } = lcs(tw, hw);
    const score = Math.round((200 * len) / (tw.length + hw.length || 1));
    const cls = scoreClass(score);
    const marked = target.map((w, i) => `<span class="${matchedA.has(i) ? 'w-ok' : 'w-ng'}">${escapeHtml(w)}</span>`).join(' ');
    const msg = score >= 90 ? 'Perfect! 🎉' : score >= 70 ? 'Nice! 👍' : score >= 50 ? 'Almost! 💪' : 'Try again! 🔁';
    $('#pron-result').innerHTML = `
      <div class="big-score score ${cls}">${score}点</div>
      <div>${msg}</div>
      <div class="words">${marked}</div>
      <div class="heard">聞き取り結果: “${escapeHtml(heard)}”</div>`;
    stats.add('pron', score >= 70);
    const best = store.get('pronBest', {});
    if (best[en] == null || score > best[en]) { best[en] = score; store.set('pronBest', best); }
  },
};

$('#pron-cat').innerHTML = Object.keys(PHRASES).map((c) => `<option>${escapeHtml(c)}</option>`).join('');
$('#pron-cat').addEventListener('change', (e) => { pron.cat = e.target.value; pron.idx = 0; pron.render(); });
$('#btn-pron-listen').addEventListener('click', () => speak(pron.phrase[0], { lang: 'en-US' }));
$('#btn-pron-slow').addEventListener('click', () => speak(pron.phrase[0], { lang: 'en-US', slow: true }));
$('#btn-pron-prev').addEventListener('click', () => { pron.idx = (pron.idx - 1 + pron.list.length) % pron.list.length; pron.render(); });
$('#btn-pron-next').addEventListener('click', () => { pron.idx = (pron.idx + 1) % pron.list.length; pron.render(); });
$('#btn-pron-mic').addEventListener('click', async (e) => {
  $('#pron-result').innerHTML = '<span class="muted">🎧 聞いています… 英語で読み上げてください</span>';
  const heard = await listen(e.currentTarget, 'en-US', (t) => {
    $('#pron-result').innerHTML = `<span class="muted">🎧 ${escapeHtml(t)}</span>`;
  });
  if (heard) pron.judge(heard);
  else if (heard === '') $('#pron-result').innerHTML = '<span class="muted">聞き取れませんでした。もう一度どうぞ。</span>';
});

// ---------- 単語帳 ----------
const MY_WORDS = '★ マイ単語';
const ALL_WORDS = '🔀 すべての単語';
const MASTERED = 3; // このレベル以上で「覚えた」

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const normalizeWord = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function addMyWord(en, ja, ex = '') {
  en = en.trim();
  const mine = store.get('myWords', []);
  if (mine.some((w) => w.en.toLowerCase() === en.toLowerCase())) { toast('単語帳に登録済みです'); return false; }
  mine.unshift({ en, ja: ja.trim(), ex: ex.trim() });
  store.set('myWords', mine);
  toast('📚 単語帳に追加しました');
  return true;
}

const vocab = {
  cat: store.get('vocabCat', Object.keys(VOCAB)[0]),
  mode: 'list',
  filter: 'all',
  session: null, // カード・クイズ・スペルの進行状態

  words(cat = this.cat) {
    const toObj = ([en, ja, ex]) => ({ en, ja, ex });
    const mine = store.get('myWords', []).map((w) => ({ ...w, mine: true }));
    if (cat === MY_WORDS) return mine;
    if (cat === ALL_WORDS) return [...Object.values(VOCAB).flat().map(toObj), ...mine];
    return (VOCAB[cat] || []).map(toObj);
  },

  // 単語数が多いので習熟度はメモリに持ち、変更時だけ保存する
  lvMap: null,
  lv(en) {
    if (!this.lvMap) this.lvMap = store.get('vocabLv', {});
    return this.lvMap[en] || 0;
  },
  setLv(en, v) {
    this.lv(en);
    this.lvMap[en] = Math.max(0, v);
    store.set('vocabLv', this.lvMap);
  },
  isDone(en) { return this.lv(en) >= MASTERED; },

  badge(en) {
    const lv = this.lv(en);
    if (lv >= MASTERED) return '<span class="badge done">覚えた</span>';
    if (lv > 0) return `<span class="badge learning">学習中 ${lv}/${MASTERED}</span>`;
    return '';
  },

  renderCats() {
    const cats = [...Object.keys(VOCAB), MY_WORDS, ALL_WORDS];
    if (!cats.includes(this.cat)) this.cat = cats[0];
    $('#vocab-cat').innerHTML = cats.map((c) => {
      const ws = this.words(c);
      const done = ws.filter((w) => this.isDone(w.en)).length;
      return `<option value="${escapeHtml(c)}">${escapeHtml(c)}（${done}/${ws.length}）</option>`;
    }).join('');
    $('#vocab-cat').value = this.cat;
  },

  renderProgress() {
    this.renderCats();
    const ws = this.words();
    const done = ws.filter((w) => this.isDone(w.en)).length;
    $('#vocab-progress').textContent = ws.length ? `覚えた ${done} / ${ws.length} 語` : '';
    $('#vocab-bar').style.width = ws.length ? `${(100 * done) / ws.length}%` : '0';
  },

  render() {
    this.renderProgress();
    document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('active', m.dataset.mode === this.mode));
    const ws = this.words();
    if (!ws.length) {
      $('#vocab-area').innerHTML = '<div class="card muted">まだ単語がありません。下の「＋ マイ単語を追加」や、翻訳画面の「📚 単語帳へ」から追加できます。</div>';
      return;
    }
    if (this.mode === 'list') this.renderList();
    if (this.mode === 'card') this.startCard();
    if (this.mode === 'quiz') this.startQuiz();
    if (this.mode === 'spell') this.startSpell();
  },

  // ----- 一覧 -----
  query: '',
  shown: 50, // 一覧に一度に表示する数（「もっと見る」で増える）

  renderList() {
    const chip = (key, label) => `<button class="chip ${this.filter === key ? 'active' : ''}" data-filter="${key}">${label}</button>`;
    $('#vocab-area').innerHTML = `
      <input id="vocab-search" class="search" type="search" placeholder="🔍 すべての単語から検索（英語・日本語）" value="${escapeHtml(this.query)}">
      <div class="filter-row">${chip('all', 'すべて')}${chip('todo', 'まだ')}${chip('done', '覚えた')}<span id="vocab-count" class="muted"></span></div>
      <ul id="vocab-ul" class="list"></ul>
      <div id="vocab-more" class="row center"></div>`;
    this.renderListItems();
  },

  listWords() {
    const q = this.query.trim().toLowerCase();
    const base = q
      ? this.words(ALL_WORDS).filter((w) => w.en.toLowerCase().includes(q) || w.ja.includes(q))
      : this.words();
    return base.filter((w) => this.filter === 'all' || (this.filter === 'done' ? this.isDone(w.en) : !this.isDone(w.en)));
  },

  renderListItems() {
    const ws = this.listWords();
    const page = ws.slice(0, this.shown);
    $('#vocab-count').textContent = `${ws.length} 語`;
    $('#vocab-ul').innerHTML = page.length ? page.map((w) => `
        <li class="vocab-item" data-en="${escapeHtml(w.en)}">
          <div class="txt">
            <div class="en">${escapeHtml(w.en)}${this.badge(w.en)}</div>
            <div class="ja">${escapeHtml(w.ja)}</div>
            ${w.ex ? `<div class="ex">${escapeHtml(w.ex)}</div>` : ''}
          </div>
          <button class="btn ghost" data-act="ex" title="例文を読み上げ" ${w.ex ? '' : 'disabled'}>💬</button>
          <button class="btn ghost" data-act="done" title="覚えた／戻す">${this.isDone(w.en) ? '↩️' : '✅'}</button>
          ${w.mine ? '<button class="btn ghost" data-act="del" title="削除">🗑️</button>' : ''}
        </li>`).join('') : '<li class="muted">該当する単語はありません</li>';
    $('#vocab-more').innerHTML = ws.length > this.shown
      ? `<button class="btn ghost" data-act="more">もっと見る（残り ${ws.length - this.shown} 語）</button>` : '';
  },

  onListClick(e) {
    const chip = e.target.closest('[data-filter]');
    if (chip) { this.filter = chip.dataset.filter; this.shown = 50; this.renderList(); return; }
    if (e.target.closest('[data-act=more]')) { this.shown += 100; this.renderListItems(); return; }
    const li = e.target.closest('li[data-en]');
    if (!li) return;
    const w = this.words(ALL_WORDS).find((x) => x.en === li.dataset.en);
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'ex') speak(w.ex, { lang: 'en-US' });
    else if (act === 'done') { this.setLv(w.en, this.isDone(w.en) ? 0 : MASTERED); this.renderProgress(); this.renderListItems(); }
    else if (act === 'del') {
      store.set('myWords', store.get('myWords', []).filter((x) => x.en !== w.en));
      this.render();
    } else speak(w.en, { lang: 'en-US' });
  },

  /** 覚えていない単語を優先して n 個選ぶ */
  pick(n) {
    const ws = shuffle(this.words());
    ws.sort((a, b) => Math.min(this.lv(a.en), MASTERED) - Math.min(this.lv(b.en), MASTERED));
    return ws.slice(0, n);
  },

  // ----- フラッシュカード -----
  startCard() {
    const todo = shuffle(this.words().filter((w) => !this.isDone(w.en)));
    this.session = {
      queue: todo.length ? todo : shuffle(this.words()),
      i: 0, flipped: false, known: 0,
      jaFront: store.get('cardJaFront', false),
    };
    this.renderCard();
  },

  renderCard() {
    const s = this.session;
    if (s.i >= s.queue.length) {
      $('#vocab-area').innerHTML = `
        <div class="card result-box">
          <div class="big-score">🎉</div>
          <p>${s.queue.length} 枚のカードを一周しました！（覚えた: ${s.known} 枚）</p>
          <button class="btn primary" data-act="restart">もう一周</button>
        </div>`;
      return;
    }
    const w = s.queue[s.i];
    const front = s.jaFront ? w.ja : w.en;
    $('#vocab-area').innerHTML = `
      <div class="row"><span class="muted">${s.i + 1} / ${s.queue.length}</span><span class="spacer"></span>
        <label class="check"><input type="checkbox" data-act="jafront" ${s.jaFront ? 'checked' : ''}> 日本語を表にする</label></div>
      <div class="flashcard" data-act="flip">
        <div class="front">${escapeHtml(front)}</div>
        ${s.flipped ? `
          <div class="back">
            <div class="ja">${escapeHtml(s.jaFront ? w.en : w.ja)}</div>
            ${w.ex ? `<div class="ex">${escapeHtml(w.ex)}</div>` : ''}
          </div>` : '<div class="tap">タップして答えを見る</div>'}
      </div>
      <div class="card-actions">
        <button class="btn ghost" data-act="speak">🔊</button>
        ${s.flipped ? `
          <button class="btn bad" data-act="again">😓 まだ</button>
          <button class="btn good" data-act="know">😊 覚えた</button>` : ''}
      </div>`;
    if (!s.jaFront || s.flipped) speak(w.en, { lang: 'en-US' });
  },

  onCardClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const s = this.session;
    if (!act) return;
    if (act === 'restart') { this.startCard(); return; }
    const w = s.queue[s.i];
    if (act === 'jafront') { s.jaFront = e.target.checked; store.set('cardJaFront', s.jaFront); s.flipped = false; this.renderCard(); return; }
    if (act === 'flip') { s.flipped = !s.flipped; this.renderCard(); return; }
    if (act === 'speak') { speak(w.en, { lang: 'en-US' }); return; }
    if (act === 'know') { this.setLv(w.en, MASTERED); s.known++; stats.add('card', true); }
    if (act === 'again') { this.setLv(w.en, 0); s.queue.push(w); stats.add('card', false); stats.miss(w.en); } // 最後にもう一度出す
    s.i++;
    s.flipped = false;
    this.renderProgress();
    this.renderCard();
  },

  // ----- 4択クイズ -----
  startQuiz() {
    const qs = this.pick(10);
    let pool = this.words();
    if (pool.length < 4) pool = this.words(ALL_WORDS);
    this.session = {
      qs: qs.map((w) => {
        const type = ['en2ja', 'ja2en', 'listen'][Math.floor(Math.random() * 3)];
        const others = shuffle(pool.filter((x) => x.en !== w.en)).slice(0, 3);
        return { w, type, choices: shuffle([w, ...others]) };
      }),
      i: 0, correct: 0, wrong: [], answered: false,
    };
    this.renderQuiz();
  },

  renderQuiz() {
    const s = this.session;
    if (s.i >= s.qs.length) { this.renderResult(s.correct, s.qs.length, s.wrong); return; }
    const { w, type, choices } = s.qs[s.i];
    const label = { en2ja: '意味は？', ja2en: '英語では？', listen: '🎧 聞こえた単語の意味は？' }[type];
    const q = type === 'en2ja' ? escapeHtml(w.en) : type === 'ja2en' ? escapeHtml(w.ja) : '<button class="btn ghost big" data-act="speak">🔊 もう一度</button>';
    $('#vocab-area').innerHTML = `
      <div class="card quiz-q">
        <div class="muted">${s.i + 1} / ${s.qs.length} ・ ${label}</div>
        <div class="q">${q}</div>
      </div>
      <div class="choices">${choices.map((c, k) => `
        <button class="choice" data-k="${k}">${escapeHtml(type === 'ja2en' ? c.en : c.ja)}</button>`).join('')}
      </div>
      <div id="quiz-next" class="row center"></div>`;
    if (type === 'listen') speak(w.en, { lang: 'en-US' });
  },

  onQuizClick(e) {
    const s = this.session;
    if (e.target.closest('[data-act=restart]')) { this.startQuiz(); return; }
    if (e.target.closest('[data-act=speak]')) { speak(s.qs[s.i].w.en, { lang: 'en-US' }); return; }
    if (e.target.closest('[data-act=next]')) { s.i++; s.answered = false; this.renderQuiz(); return; }
    const btn = e.target.closest('.choice');
    if (!btn || s.answered) return;
    s.answered = true;
    const { w, choices } = s.qs[s.i];
    const ok = choices[+btn.dataset.k].en === w.en;
    document.querySelectorAll('.choice').forEach((b) => {
      if (choices[+b.dataset.k].en === w.en) b.classList.add('correct');
    });
    if (ok) { s.correct++; this.setLv(w.en, this.lv(w.en) + 1); }
    else { btn.classList.add('wrong'); s.wrong.push(w); this.setLv(w.en, 0); stats.miss(w.en); }
    stats.add('quiz', ok);
    speak(w.en, { lang: 'en-US' });
    this.renderProgress();
    $('#quiz-next').innerHTML = `
      <div>${ok ? '⭕ 正解！' : '❌ 不正解'} <b>${escapeHtml(w.en)}</b> = ${escapeHtml(w.ja)}</div>
      <button class="btn primary" data-act="next">次へ →</button>`;
  },

  // ----- スペル練習 -----
  startSpell() {
    this.session = { qs: this.pick(10), i: 0, correct: 0, wrong: [], answered: false, hint: 0 };
    this.renderSpell();
  },

  renderSpell() {
    const s = this.session;
    if (s.i >= s.qs.length) { this.renderResult(s.correct, s.qs.length, s.wrong); return; }
    const w = s.qs[s.i];
    $('#vocab-area').innerHTML = `
      <div class="card quiz-q">
        <div class="muted">${s.i + 1} / ${s.qs.length} ・ 聞こえた英語をつづってください</div>
        <div class="q">${escapeHtml(w.ja)}</div>
        <div id="spell-hint" class="muted"></div>
        <div class="row center">
          <button class="btn ghost" data-act="speak">🔊 聞く</button>
          <button class="btn ghost" data-act="slow">🐢 ゆっくり</button>
          <button class="btn ghost" data-act="hint">💡 ヒント</button>
        </div>
      </div>
      <div class="composer">
        <input id="spell-input" class="spell-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="type here">
        <button class="btn primary" data-act="check">答える</button>
      </div>
      <div id="spell-result" class="row center"></div>`;
    $('#spell-input').focus();
    speak(w.en, { lang: 'en-US' });
  },

  checkSpell() {
    const s = this.session;
    if (s.answered) { s.i++; s.answered = false; s.hint = 0; this.renderSpell(); return; }
    const input = $('#spell-input').value;
    if (!input.trim()) return;
    const w = s.qs[s.i];
    const ok = normalizeWord(input) === normalizeWord(w.en);
    s.answered = true;
    if (ok) { s.correct++; this.setLv(w.en, this.lv(w.en) + 1); }
    else { s.wrong.push(w); this.setLv(w.en, 0); stats.miss(w.en); }
    stats.add('spell', ok);
    this.renderProgress();
    $('#spell-result').innerHTML = `
      <div>${ok ? '⭕ 正解！' : `❌ 正解は <b>${escapeHtml(w.en)}</b>`}${w.ex ? `<div class="muted"><i>${escapeHtml(w.ex)}</i></div>` : ''}</div>
      <button class="btn primary" data-act="check">次へ →</button>`;
    $('#spell-input').disabled = true;
    speak(w.ex || w.en, { lang: 'en-US' });
  },

  onSpellClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const s = this.session;
    if (act === 'restart') { this.startSpell(); return; }
    if (!act || s.i >= s.qs.length) return;
    const w = s.qs[s.i];
    if (act === 'speak') speak(w.en, { lang: 'en-US' });
    if (act === 'slow') speak(w.en, { lang: 'en-US', slow: true });
    if (act === 'check') this.checkSpell();
    if (act === 'hint') {
      s.hint = Math.min(s.hint + 1, w.en.length);
      $('#spell-hint').textContent = [...w.en].map((c, k) => (k < s.hint || c === ' ' ? c : '_')).join(' ');
    }
  },

  renderResult(correct, total, wrong) {
    const score = Math.round((100 * correct) / total);
    const cls = scoreClass(score);
    $('#vocab-area').innerHTML = `
      <div class="card result-box">
        <div class="big-score score ${cls}">${correct} / ${total}</div>
        <p>${score >= 80 ? 'すばらしい！🎉' : score >= 60 ? 'いい調子！👍' : '復習してもう一度！💪'}</p>
        ${wrong.length ? `<p class="muted">まちがえた単語</p>
          <ul class="list">${wrong.map((w) => `<li><div class="txt"><div class="en">${escapeHtml(w.en)}</div><div class="ja">${escapeHtml(w.ja)}</div></div></li>`).join('')}</ul>` : ''}
        <button class="btn primary" data-act="restart">もう一度</button>
      </div>`;
  },
};

$('#vocab-cat').addEventListener('change', (e) => {
  vocab.cat = e.target.value;
  vocab.shown = 50;
  vocab.query = '';
  store.set('vocabCat', vocab.cat);
  vocab.render();
});
document.querySelectorAll('.mode').forEach((m) => m.addEventListener('click', () => {
  vocab.mode = m.dataset.mode;
  vocab.render();
}));
$('#vocab-area').addEventListener('click', (e) => {
  if (vocab.mode === 'list') vocab.onListClick(e);
  if (vocab.mode === 'card') vocab.onCardClick(e);
  if (vocab.mode === 'quiz') vocab.onQuizClick(e);
  if (vocab.mode === 'spell') vocab.onSpellClick(e);
});
$('#vocab-area').addEventListener('input', (e) => {
  if (e.target.id !== 'vocab-search') return;
  clearTimeout(vocab.searchTimer);
  vocab.searchTimer = setTimeout(() => {
    vocab.query = e.target.value;
    vocab.shown = 50;
    vocab.renderListItems();
  }, 150);
});
$('#vocab-area').addEventListener('keydown', (e) => {
  if (vocab.mode === 'spell' && e.target.id === 'spell-input' && e.key === 'Enter' && !e.isComposing) vocab.checkSpell();
});
$('#btn-add-word').addEventListener('click', async () => {
  const en = $('#add-en').value.trim();
  let ja = $('#add-ja').value.trim();
  if (!en) { toast('英単語を入力してください'); return; }
  const btn = $('#btn-add-word');
  if (!ja) {
    btn.disabled = true;
    btn.textContent = '翻訳中…';
    try { ja = (await tr.translate(en, 'en', 'ja')).text; }
    catch (err) { toast(err.message); btn.disabled = false; btn.textContent = '追加'; return; }
    btn.disabled = false;
    btn.textContent = '追加';
  }
  if (addMyWord(en, ja, $('#add-ex').value)) {
    ['#add-en', '#add-ja', '#add-ex'].forEach((s) => { $(s).value = ''; });
    vocab.cat = MY_WORDS;
    store.set('vocabCat', vocab.cat);
    vocab.mode = 'list';
    vocab.render();
  }
});
$('#btn-to-vocab').addEventListener('click', () => tr.last && addMyWord(tr.last.en, tr.last.ja));

// ---------- 学習記録の画面 ----------
const statsView = {
  range: 7,

  render() {
    const log = store.get('log', {});
    const today = stats.day();
    const totalSec = Object.values(log).reduce((s, d) => s + d.sec, 0);
    const activeDays = Object.values(log).filter((d) => stats.isActive(d)).length;
    const allWords = vocab.words(ALL_WORDS);
    const mastered = allWords.filter((w) => vocab.isDone(w.en)).length;
    const todayCount = Object.values(today.n).reduce((a, b) => a + b, 0);
    const streak = stats.streak();

    const tile = (label, value, unit, note) => `
      <div class="tile"><div class="label">${label}</div>
        <div class="value">${value}<small>${unit}</small></div>
        ${note ? `<div class="note">${note}</div>` : ''}</div>`;
    $('#stat-tiles').innerHTML =
      tile('🔥 連続学習', streak, '日', streak ? '今日も続けよう！' : '今日から始めよう')
      + tile('⏱️ 今日の学習時間', Math.floor(today.sec / 60), '分', `練習 ${todayCount} 回`)
      + tile('📅 累計', fmtMin(totalSec), '', `学習した日 ${activeDays} 日`)
      + tile('📚 覚えた単語', mastered, '語', `全 ${allWords.length} 語中`);

    const goal = store.get('goalMin', 10);
    $('#goal-min').value = goal;
    const pct = Math.min(100, (100 * today.sec) / 60 / goal);
    $('#goal-bar').style.width = pct + '%';
    $('#goal-bar').parentElement.classList.toggle('done', pct >= 100);
    $('#goal-text').textContent = pct >= 100
      ? `🎉 目標達成！（${Math.floor(today.sec / 60)}分 / ${goal}分）`
      : `あと ${Math.max(1, Math.ceil(goal - today.sec / 60))} 分（${Math.floor(today.sec / 60)}分 / ${goal}分）`;

    this.renderBars(log);
    this.renderHeatmap(log);
    this.renderBreakdown(log);
    this.renderWeak();
    this.renderScnBests();
  },

  renderBars(log) {
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = dayKey(d);
      days.push({ d, k, min: Math.round(((log[k] && log[k].sec) || 0) / 60), n: log[k] ? Object.values(log[k].n).reduce((a, b) => a + b, 0) : 0 });
    }
    const raw = Math.max(...days.map((x) => x.min), 1);
    const max = raw <= 10 ? 10 : Math.ceil(raw / 10) * 10; // 目盛りをきりの良い数に
    const wd = '日月火水木金土';
    $('#chart-days').innerHTML = `
      <span class="ymax">${max}</span><span class="ymid">${max / 2}</span>
      <div class="plot">${days.map((x) => `
        <div class="col" data-tip="${x.d.getMonth() + 1}/${x.d.getDate()}(${wd[x.d.getDay()]})：${x.min}分・練習${x.n}回">
          <div class="bar ${x.min ? '' : 'zero'}" style="height:${(100 * x.min) / max}%"></div>
        </div>`).join('')}
      </div>
      <div class="xlabels">${days.map((x, i) => `<span class="${i === 13 ? 'today' : ''}">${i === 13 ? '今日' : x.d.getDate()}</span>`).join('')}</div>`;
  },

  renderHeatmap(log) {
    const WEEKS = 16;
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - today.getDay() - (WEEKS - 1) * 7); // 日曜はじまり
    const level = (min, active) => (!active ? 0 : min < 5 ? 1 : min < 15 ? 2 : min < 30 ? 3 : 4);
    const cells = [];
    for (let i = 0; i < WEEKS * 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const k = dayKey(d);
      if (d > today) { cells.push('<div class="hm future"></div>'); continue; }
      const e = log[k];
      const min = e ? Math.floor(e.sec / 60) : 0;
      const n = e ? Object.values(e.n).reduce((a, b) => a + b, 0) : 0;
      cells.push(`<div class="hm l${level(min, stats.isActive(e))} ${k === dayKey() ? 'today' : ''}" data-tip="${d.getMonth() + 1}/${d.getDate()}：${min}分・練習${n}回"></div>`);
    }
    $('#heatmap').innerHTML = `<div class="heatmap">${cells.join('')}</div>
      <div class="heat-legend">少ない ${[0, 1, 2, 3, 4].map((l) => `<span class="hm l${l}"></span>`).join('')} 多い</div>`;
  },

  renderBreakdown(log) {
    const keys = Object.keys(log).filter((k) => {
      if (!this.range) return true;
      const d = new Date();
      d.setDate(d.getDate() - (this.range - 1));
      return k >= dayKey(d);
    });
    const n = {}, ok = {};
    keys.forEach((k) => {
      Object.entries(log[k].n).forEach(([a, v]) => { n[a] = (n[a] || 0) + v; });
      Object.entries(log[k].ok).forEach(([a, v]) => { ok[a] = (ok[a] || 0) + v; });
    });
    const max = Math.max(1, ...Object.values(n));
    const graded = { scn: '合格', pron: '70点以上', card: '覚えた', quiz: '正解', spell: '正解' };
    $('#breakdown').innerHTML = Object.entries(ACTIVITIES).map(([k, label]) => {
      const c = n[k] || 0;
      const rate = graded[k] && c ? `<small>${graded[k]} ${Math.min(100, Math.round((100 * (ok[k] || 0)) / c))}%</small>` : '';
      return `<div class="hbar-row" data-tip="${label}：${c}回">
        <span>${label}</span>
        <div class="hbar-track"><div class="hbar ${c ? '' : 'zero'}" style="width:${(100 * c) / max}%"></div></div>
        <span class="hbar-val">${c}回 ${rate}</span>
      </div>`;
    }).join('');
    document.querySelectorAll('#range-chips .chip').forEach((c) => c.classList.toggle('active', +c.dataset.range === this.range));
  },

  renderWeak() {
    const miss = store.get('vocabMiss', {});
    const dict = Object.fromEntries(vocab.words(ALL_WORDS).map((w) => [w.en, w]));
    const top = Object.entries(miss).filter(([en]) => dict[en] && !vocab.isDone(en))
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    $('#weak-words').innerHTML = top.length
      ? top.map(([en, c]) => `<li data-en="${escapeHtml(en)}">
          <div class="txt"><span class="en">${escapeHtml(en)}</span> <span class="ja">${escapeHtml(dict[en].ja)}</span></div>
          <span class="miss">×${c}回</span></li>`).join('')
      : '<li class="muted">まだありません。単語帳のクイズやスペルでまちがえた単語がここに出ます。</li>';
  },

  renderScnBests() {
    const best = store.get('scnBest', {});
    const done = SCENARIOS.filter((s) => best[s.id] != null);
    $('#scn-bests').innerHTML = done.length
      ? done.map((s) => `<li><div class="txt">${s.emoji} ${escapeHtml(s.name)}</div>
          <span class="score ${scoreClass(best[s.id])}">${best[s.id]}点</span></li>`).join('')
        + `<li class="muted">挑戦したシーン ${done.length} / ${SCENARIOS.length}</li>`
      : '<li class="muted">まだありません。会話練習でシーンをクリアすると記録されます。</li>';
  },
};

$('#goal-min').addEventListener('change', (e) => { store.set('goalMin', +e.target.value); statsView.render(); });
$('#range-chips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-range]');
  if (!c) return;
  statsView.range = +c.dataset.range;
  statsView.renderBreakdown(store.get('log', {}));
});
$('#weak-words').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-en]');
  if (li) speak(li.dataset.en, { lang: 'en-US' });
});
$('#btn-reset-stats').addEventListener('click', () => {
  if (!confirm('学習時間・練習回数・苦手な単語の記録をすべて消します。よろしいですか？\n（単語の「覚えた」状態と保存フレーズは残ります）')) return;
  ['log', 'vocabMiss'].forEach((k) => { try { localStorage.removeItem('eikaiwa:' + k); } catch { /* ignore */ } });
  statsView.render();
  toast('学習記録をリセットしました');
});

// ツールチップ（グラフのホバー／タップ）
const tip = $('#tooltip');
function showTip(e) {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { tip.classList.remove('show'); return; }
  const r = t.getBoundingClientRect();
  tip.textContent = t.dataset.tip;
  const x = Math.min(Math.max(r.left + r.width / 2, 80), window.innerWidth - 80);
  tip.style.left = x + 'px';
  tip.style.top = r.top + 'px';
  tip.classList.add('show');
}
$('#tab-stats').addEventListener('mouseover', showTip);
$('#tab-stats').addEventListener('click', showTip);
$('#tab-stats').addEventListener('mouseleave', () => tip.classList.remove('show'));
window.addEventListener('scroll', () => tip.classList.remove('show'), { passive: true });

// ---------- 設定 ----------
const dlg = $('#settings-dialog');
$('#btn-settings').addEventListener('click', () => {
  $('#set-apikey').value = settings.apiKey;
  $('#set-voice').value = settings.voice;
  $('#set-rate').value = settings.rate;
  $('#set-rate-val').textContent = settings.rate;
  dlg.showModal();
});
$('#set-rate').addEventListener('input', (e) => { $('#set-rate-val').textContent = e.target.value; });
$('#btn-set-test').addEventListener('click', () => {
  const prev = { voice: settings.voice, rate: settings.rate };
  settings.voice = $('#set-voice').value;
  settings.rate = +$('#set-rate').value;
  speak("Hello! Let's practice English together.", { lang: 'en-US' });
  Object.assign(settings, prev);
});
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  settings.apiKey = $('#set-apikey').value.trim();
  settings.voice = $('#set-voice').value;
  settings.rate = +$('#set-rate').value;
  store.set('settings', settings);
  toast('設定を保存しました');
  if ($('#tab-ai').classList.contains('active')) ai.onOpen();
});

// ---------- 初期化 ----------
tr.setDir('ja');
tr.renderHistory();
scn.renderPicker();
pron.render();
const lastTab = document.querySelector(`.tab[data-tab="${store.get('tab', 'translate')}"]`);
if (lastTab) lastTab.click();
if (!Recognition) toast('音声入力は Chrome / Edge / Safari でご利用ください');

// オフライン対応・ホーム画面への追加（PWA）
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 未対応環境では無視 */ });
}
