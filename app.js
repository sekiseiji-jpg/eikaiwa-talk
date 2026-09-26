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

function speak(text, { lang, slow, rateScale = 1 } = {}) {
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
  u.rate = (slow ? Math.max(0.5, settings.rate - 0.3) : settings.rate) * rateScale;
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

  group: 'all',

  renderPicker() {
    const best = store.get('scnBest', {});
    const ORDER = ['旅行・移動', '食事・買い物', '日常・生活', '仕事・学校', '人づきあい', 'トラブル・緊急'];
    const groups = [...new Set([...ORDER, ...SCENARIOS.map((s) => s.group)])]
      .filter((g) => SCENARIOS.some((s) => s.group === g));
    const chip = (key, label) => `<button class="chip ${this.group === key ? 'active' : ''}" data-group="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
    $('#scenario-groups').innerHTML = chip('all', `すべて（${SCENARIOS.length}）`)
      + groups.map((g) => chip(g, g)).join('') + chip('todo', 'まだ挑戦していない');
    const shown = (g) => this.group === 'all' || this.group === 'todo' || this.group === g;
    const card = (s) => `
      <button class="scn-card" data-id="${s.id}">
        <div class="emoji">${s.emoji}</div>
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="desc">${escapeHtml(s.desc)}（${s.turns.length}ターン）</div>
        ${best[s.id] != null ? `<div class="best">ベスト: ${best[s.id]}点</div>` : ''}
      </button>`;
    $('#scenario-grid').innerHTML = groups.filter(shown).map((g) => {
      const list = SCENARIOS.filter((s) => s.group === g && (this.group !== 'todo' || best[s.id] == null));
      if (!list.length) return '';
      const done = list.filter((s) => best[s.id] != null).length;
      return `<h3 class="scn-group">${escapeHtml(g)} <span class="muted">${done}/${list.length}</span></h3>
        <div class="grid">${list.map(card).join('')}</div>`;
    }).join('') || '<p class="muted">すべてのシーンに挑戦済みです 🎉</p>';
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
$('#scenario-groups').addEventListener('click', (e) => {
  const c = e.target.closest('[data-group]');
  if (!c) return;
  scn.group = c.dataset.group;
  scn.renderPicker();
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
// [キー, 表示名, AIへの指示]。ロールプレイは AI が役を演じる
const TOPIC_GROUPS = [
  ['💬 雑談', [
    ['free', '自由に雑談', 'anything the learner wants to talk about (casual small talk)'],
    ['today', '今日の出来事', 'what the learner did today and how their day went'],
    ['weekend', '週末の予定・過ごし方', "the learner's weekend plans or how they spent last weekend"],
    ['hobby', '趣味', "the learner's hobbies and interests"],
    ['food', '食べ物・料理', 'food, cooking, favorite dishes and restaurants'],
    ['travel', '旅行の思い出', 'travel experiences and dream destinations'],
    ['movies', '映画・ドラマ・アニメ', 'movies, TV dramas, anime and what the learner has watched recently'],
    ['music', '音楽', 'music, favorite artists, concerts and karaoke'],
    ['sports', 'スポーツ・運動', 'sports, exercise and staying active'],
    ['family', '家族・友達', "the learner's family and friends"],
    ['pets', 'ペット・動物', 'pets and animals'],
    ['childhood', '子どもの頃の思い出', "the learner's childhood memories and school days"],
    ['dreams', '将来の夢・目標', "the learner's goals, dreams and plans for the future"],
    ['health', '健康・生活習慣', 'health, sleep, diet and daily habits'],
    ['tech', 'スマホ・テクノロジー', 'smartphones, apps, the internet and technology in daily life'],
  ]],
  ['🗾 日本・文化', [
    ['japan', '日本を紹介する', 'Japan. You are a foreign friend who is curious about Japan; ask the learner to explain Japanese food, places, customs and culture'],
    ['culture', '文化の違い', 'cultural differences between Japan and other countries'],
    ['seasons', '季節・行事', 'seasons, holidays and events such as New Year, cherry blossoms and summer festivals'],
    ['news', '最近のニュース', 'recent everyday news and social topics (keep it light and balanced; avoid partisan politics)'],
  ]],
  ['🎭 ロールプレイ', [
    ['rp_restaurant', 'レストランの店員', 'Role-play: you are a waiter at a restaurant and the learner is the customer. Seat them, take the order, and handle requests'],
    ['rp_cafe', 'カフェの店員', 'Role-play: you are a barista at a busy cafe and the learner is ordering'],
    ['rp_shop', '洋服店の店員', 'Role-play: you are a clerk at a clothing store helping the learner find, try on and buy clothes'],
    ['rp_hotel', 'ホテルのフロント', 'Role-play: you are a hotel front desk clerk; the learner is a guest checking in and asking questions'],
    ['rp_airport', '空港のチェックイン', 'Role-play: you are an airline check-in agent at the airport; the learner is a passenger'],
    ['rp_immigration', '入国審査官', 'Role-play: you are an immigration officer asking the learner typical entry questions'],
    ['rp_doctor', '病院の医師', 'Role-play: you are a doctor; the learner is a patient explaining their symptoms'],
    ['rp_tourist', '道を聞く観光客', 'Role-play: you are a foreign tourist in Tokyo asking the learner for directions and recommendations; the learner must explain'],
    ['rp_party', 'パーティーで初対面', 'Role-play: you just met the learner at a friend\'s party; make friendly small talk to get to know them'],
    ['rp_colleague', '外国人の同僚', 'Role-play: you are the learner\'s new coworker from abroad; chat about work, the office and life in Japan'],
    ['rp_phone', '電話で予約', 'Role-play: you are a receptionist answering the phone; the learner wants to make a reservation (restaurant, salon or clinic)'],
    ['rp_landlord', '部屋探し（不動産屋）', 'Role-play: you are a real estate agent helping the learner find an apartment abroad'],
  ]],
  ['💼 仕事・試験', [
    ['work', '仕事の話', "the learner's job and work life"],
    ['interview', '英語面接', 'a job interview in English (you are the interviewer; ask typical interview questions one at a time)'],
    ['meeting', '会議・プレゼン練習', 'a business meeting; you are a colleague, ask the learner to explain ideas, give updates and answer questions'],
    ['debate', 'ディベート（賛成・反対）', 'a friendly debate. Propose a simple debatable question (e.g. city life vs countryside), ask the learner\'s opinion with reasons, then politely give counterarguments'],
    ['exam', 'スピーキング試験風', 'speaking test practice. Act like an English speaking-test examiner: ask the learner to describe things, compare, and give opinions with reasons, one question at a time'],
  ]],
];
const TOPICS = Object.fromEntries(TOPIC_GROUPS.flatMap(([, list]) => list.map(([k, label, prompt]) => [k, { label, prompt }])));

$('#ai-topic').innerHTML = '<option value="random">🎲 おまかせ（ランダム）</option>'
  + TOPIC_GROUPS.map(([g, list]) => `<optgroup label="${escapeHtml(g)}">${list.map(([k, label]) =>
    `<option value="${k}">${escapeHtml(label)}</option>`).join('')}</optgroup>`).join('');
const savedTopic = store.get('aiTopic', 'free');
$('#ai-topic').value = (TOPICS[savedTopic] || savedTopic === 'random') ? savedTopic : 'free';
// label: 表示名 / prompt: AIへの指示 / feedback: 添削の細かさ / showJa: 日本語訳を最初から表示 / rate: 読み上げ速度の倍率
const LEVELS = {
  starter: {
    label: '超初級（英検5〜4級）',
    prompt: 'a true beginner (CEFR A1, about junior high school year 1). Use only the most basic words and very short sentences (8 words or fewer), mostly present tense. Ask one simple yes/no or either/or question at a time.',
    feedback: 'Only point out the single most important mistake, very gently and simply. Praise effort.',
    showJa: true, rate: 0.8,
  },
  beginner: {
    label: '初級（英検3級 / TOEIC 〜400）',
    prompt: 'a beginner (CEFR A2). Use simple everyday words and short sentences (12 words or fewer). Avoid idioms and phrasal verbs.',
    feedback: 'Point out only clear grammar mistakes, gently, with a simple corrected sentence.',
    showJa: true, rate: 0.9,
  },
  elementary: {
    label: '初中級（英検準2級 / TOEIC 400〜550）',
    prompt: 'a pre-intermediate learner (CEFR A2-B1). Use simple, natural English and common expressions. Keep sentences fairly short.',
    feedback: 'Point out grammar mistakes and unnatural word choices, briefly.',
    showJa: false, rate: 0.95,
  },
  intermediate: {
    label: '中級（英検2級 / TOEIC 550〜750）',
    prompt: 'an intermediate learner (CEFR B1-B2). Use natural everyday English, including common phrasal verbs.',
    feedback: 'Point out grammar mistakes and unnatural phrasing, and suggest a more natural version.',
    showJa: false, rate: 1,
  },
  upper: {
    label: '中上級（英検準1級 / TOEIC 750〜900）',
    prompt: 'an upper-intermediate learner (CEFR B2-C1). Use natural English with common idioms, and ask follow-up questions that invite opinions and reasons.',
    feedback: 'Point out mistakes and also suggest more natural or more precise expressions a native speaker would use.',
    showJa: false, rate: 1,
  },
  advanced: {
    label: '上級（英検1級 / TOEIC 900〜）',
    prompt: 'an advanced learner (CEFR C1). Use natural, idiomatic English with nuanced vocabulary; replies may be 2-4 sentences. Challenge the learner with deeper questions.',
    feedback: 'Focus on nuance, register (formal/casual), collocations and more sophisticated alternatives, not just errors.',
    showJa: false, rate: 1.05,
  },
  native: {
    label: 'ネイティブ並み',
    prompt: 'a near-native speaker (CEFR C2). Talk exactly like a native speaker friend: casual, fast-paced, with idioms, slang that is common and not offensive, and natural contractions.',
    feedback: 'Only comment on things that sound unnatural to a native speaker, and suggest how a native would say it.',
    showJa: false, rate: 1.1,
  },
};
$('#ai-level').innerHTML = Object.entries(LEVELS).map(([k, l]) => `<option value="${k}">${escapeHtml(l.label)}</option>`).join('');
$('#ai-level').value = LEVELS[store.get('aiLevel')] ? store.get('aiLevel') : 'intermediate';
const aiLevel = () => LEVELS[$('#ai-level').value] || LEVELS.intermediate;

const ai = {
  messages: [],
  busy: false,
  topic: 'free', // 実際に使っているトピック（おまかせのときは選ばれたもの）

  system() {
    const t = TOPICS[this.topic] || TOPICS.free;
    const lv = aiLevel();
    return `You are a friendly English conversation partner for a Japanese learner who is ${lv.prompt}
Topic: ${t.prompt}.
Keep the conversation going: reply in 1-3 sentences (unless the level says otherwise) and usually end with a question.
Always match your English to the learner's level described above.
In a role-play, stay in character for the whole conversation and play your role naturally.
If the learner writes Japanese, understand it and gently show how to say it in English.

Feedback policy for this level: ${lv.feedback}

Always answer in exactly this format:
REPLY: <your English reply>
JA: <natural Japanese translation of your reply>
FEEDBACK: <In Japanese, following the feedback policy, comment on the learner's last message and give a better English version. If there is nothing to fix, write なし. For the very first message write なし.>`;
  },

  onOpen() {
    $('#ai-nokey').classList.toggle('hidden', !!settings.apiKey);
    if (settings.apiKey && !this.messages.length && !this.busy) this.reset();
  },

  conv: 0, // 会話の番号。新しい会話にするたびに増やす

  reset() {
    this.conv++;
    this.busy = false;
    this.messages = [];
    $('#ai-chat').innerHTML = '';
    const sel = $('#ai-topic').value;
    const keys = Object.keys(TOPICS);
    this.topic = sel === 'random' ? keys[Math.floor(Math.random() * keys.length)] : sel;
    if (!settings.apiKey) { this.onOpen(); return; }
    addHtml($('#ai-chat'), 'bubble system', `トピック：<b>${escapeHtml(TOPICS[this.topic].label)}</b>${this.topic.startsWith('rp_') ? '（AIが役を演じます）' : ''}`
      + `<br>レベル：${escapeHtml(aiLevel().label)}`);
    this.send('(Please start the conversation. In a role-play, begin in character.)', true);
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
    const conv = this.conv; // 返事を待つ間に「新しい会話」になったら、この返事は捨てる
    const typing = addHtml(chat, 'bubble ai typing', '<span></span><span></span><span></span>');
    try {
      const raw = await callClaude(this.system(), this.messages);
      if (conv !== this.conv) return;
      this.messages.push({ role: 'assistant', content: raw });
      typing.remove();
      const p = this.parse(raw);
      if (!hidden && p.feedback && p.feedback !== 'なし') {
        addHtml(chat, 'feedback ok', '✏️ ' + escapeHtml(p.feedback).replace(/\n/g, '<br>'));
      }
      const lv = aiLevel();
      const bubble = addBubble(chat, 'ai', p.reply, p.ja);
      if (lv.showJa && p.ja) bubble.querySelector('.sub').classList.remove('hidden'); // 初級までは日本語訳を最初から表示
      if (!hidden) stats.add('ai');
      if ($('#ai-autospeak').checked) speak(p.reply, { lang: 'en-US', rateScale: lv.rate });
    } catch (e) {
      if (conv !== this.conv) return;
      typing.remove();
      this.messages.pop();
      addHtml(chat, 'bubble system', '⚠️ ' + escapeHtml(e.message));
    } finally {
      if (conv === this.conv) this.busy = false;
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
$('#ai-topic').addEventListener('change', (e) => { store.set('aiTopic', e.target.value); ai.reset(); });
$('#ai-level').addEventListener('change', (e) => { store.set('aiLevel', e.target.value); ai.reset(); });

// ---------- 発音練習 ----------
// [キー, 名前, 説明]
const PRON_MODES = [
  ['read', '📖 読んで発音', '文を見て発音する'],
  ['repeat', '🎧 聞いてリピート', '文を見ずに、聞いてまねする'],
  ['ja2en', '🇯🇵 日本語から言う', '日本語を見て英語で言う'],
  ['dictation', '✍️ ディクテーション', '聞いた英語を書き取る'],
  ['pairs', '👂 聞き分け', '似た音の2語のどちらかを当てる'],
  ['test', '🏁 10問テスト', '10問続けて平均点を出す'],
];
const PAIR_RE = /^([a-z]+) and ([a-z]+)$/i;

const pron = {
  cat: Object.keys(PHRASES)[0],
  mode: store.get('pronMode', 'read'),
  idx: 0,
  revealed: false,
  test: null, // 10問テストの進行
  pair: null, // 聞き分けの出題
  pairScore: { ok: 0, total: 0 },

  get list() { return PHRASES[this.cat]; },
  get phrase() { return this.test ? this.test.items[this.test.i] : this.list[this.idx]; },

  renderHeader() {
    $('#pron-modes').innerHTML = PRON_MODES.map(([k, name, desc]) =>
      `<button class="mode ${this.mode === k ? 'active' : ''}" data-pmode="${k}" title="${escapeHtml(desc)}">${name}</button>`).join('');
    const all = store.get('pronBest', {});
    const scored = this.list.filter(([p]) => all[p] != null);
    $('#pron-score-total').textContent = scored.length
      ? `このカテゴリの平均: ${Math.round(scored.reduce((s, [p]) => s + all[p], 0) / scored.length)}点（${scored.length}/${this.list.length}）`
      : '';
  },

  render() {
    this.renderHeader();
    if (this.mode === 'pairs') { this.renderPairs(); return; }
    if (this.mode === 'test' && !this.test) this.startTest();
    const [en, ja] = this.phrase;
    const m = this.mode;
    const showEn = m === 'read' || m === 'test' || this.revealed;
    const showJa = m !== 'repeat' && m !== 'dictation' ? true : this.revealed;
    const pos = this.test ? `🏁 テスト ${this.test.i + 1} / ${this.test.items.length}` : `${this.idx + 1} / ${this.list.length}`;
    const hidden = { repeat: '🎧 お手本を聞いて、まねして言おう', ja2en: '（英語で言ってみよう）', dictation: '🎧 聞こえた英語を書き取ろう' }[m];
    const canListen = m !== 'ja2en' || this.revealed; // 日本語から言うときは、お手本を聞くと答えがわかってしまう
    const best = store.get('pronBest', {})[en];
    $('#pron-area').innerHTML = `
      <div class="card pron-card">
        <div class="muted">${pos}</div>
        ${m === 'ja2en' ? `<div class="pron-en">${escapeHtml(ja)}</div>` : ''}
        <div class="pron-en ${showEn ? '' : 'masked'}">${showEn ? escapeHtml(en) : escapeHtml(hidden || '')}</div>
        ${m !== 'ja2en' && showJa ? `<div class="muted">${escapeHtml(ja)}</div>` : ''}
        <div class="row center">
          ${canListen ? `<button class="btn ghost" data-act="listen">🔊 お手本</button>
          <button class="btn ghost" data-act="slow">🐢 ゆっくり</button>` : ''}
          ${m === 'dictation' ? '' : '<button class="btn mic big" data-act="mic">🎤 発音する</button>'}
          ${!showEn ? '<button class="btn ghost" data-act="reveal">💡 答えを見る</button>' : ''}
        </div>
        ${m === 'dictation' && !this.revealed ? `
          <div class="composer"><input id="dict-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="聞こえた英文を入力">
          <button class="btn primary" data-act="check">答える</button></div>` : ''}
        <div id="pron-result" class="pron-result">${best != null && m !== 'test' && m !== 'dictation' ? `<span class="muted">発音のベスト: ${best}点</span>` : ''}</div>
        <div class="row center">
          ${this.test
            ? '<button class="btn ghost" data-act="skip">スキップ →</button>'
            : `<button class="btn ghost" data-act="prev">← 前へ</button>
               <button class="btn ghost" data-act="shuffle" title="ランダム">🔀</button>
               <button class="btn ghost" data-act="next">次へ →</button>`}
        </div>
      </div>`;
    if (m === 'repeat' || m === 'dictation') speak(en, { lang: 'en-US' });
  },

  /** 採点して結果を表示し、点数を返す */
  judge(heard, target = this.phrase[0], label = '聞き取り結果') {
    const tokens = target.split(/\s+/);
    const tw = tokens.map((w) => words(w).join(''));
    const hw = words(heard);
    const { len, matchedA } = lcs(tw, hw);
    const score = Math.round((200 * len) / (tw.length + hw.length || 1));
    const cls = scoreClass(score);
    const marked = tokens.map((w, i) => `<span class="${matchedA.has(i) ? 'w-ok' : 'w-ng'}">${escapeHtml(w)}</span>`).join(' ');
    const msg = score >= 90 ? 'Perfect! 🎉' : score >= 70 ? 'Nice! 👍' : score >= 50 ? 'Almost! 💪' : 'Try again! 🔁';
    $('#pron-result').innerHTML = `
      <div class="big-score score ${cls}">${score}点</div>
      <div>${msg}</div>
      <div class="words">${marked}</div>
      <div class="heard">${label}: “${escapeHtml(heard)}”</div>`;
    stats.add('pron', score >= 70);
    const best = store.get('pronBest', {});
    if (this.mode !== 'dictation' && (best[target] == null || score > best[target])) { best[target] = score; store.set('pronBest', best); }
    return score;
  },

  go(delta) {
    this.idx = (this.idx + delta + this.list.length) % this.list.length;
    this.revealed = false;
    this.render();
  },

  // ----- 10問テスト -----
  startTest() {
    this.test = { items: shuffle(this.list).slice(0, 10), i: 0, scores: [] };
    this.revealed = false;
  },

  testNext(score) {
    const t = this.test;
    t.scores[t.i] = score;
    t.i++;
    if (t.i < t.items.length) { this.render(); return; }
    const done = t.scores.filter((x) => x != null);
    const avg = done.length ? Math.round(done.reduce((a, b) => a + b, 0) / t.items.length) : 0;
    const all = store.get('pronTestBest', {});
    const isBest = all[this.cat] == null || avg > all[this.cat];
    if (isBest) { all[this.cat] = avg; store.set('pronTestBest', all); }
    $('#pron-area').innerHTML = `
      <div class="card result-box">
        <div class="muted">🏁 ${escapeHtml(this.cat)} 10問テスト</div>
        <div class="big-score score ${scoreClass(avg)}">平均 ${avg}点</div>
        <p>${isBest ? 'ベスト更新！🎉' : `ベスト: ${all[this.cat]}点`}</p>
        <ul class="list compact">${t.items.map(([en], k) => `<li data-say="${escapeHtml(en)}"><div class="txt">${escapeHtml(en)}</div>
          <span class="score ${t.scores[k] == null ? '' : scoreClass(t.scores[k])}">${t.scores[k] == null ? 'スキップ' : t.scores[k] + '点'}</span></li>`).join('')}</ul>
        <button class="btn primary" data-act="retest">もう一度</button>
      </div>`;
    this.test = null;
  },

  // ----- 聞き分け -----
  newPair() {
    // 「X and Y」形式のフレーズを聞き分け問題にする。カテゴリに少なければ全カテゴリから
    const pairsOf = (list) => list.map(([en, ja]) => { const m = PAIR_RE.exec(en); return m && { a: m[1], b: m[2], ja }; }).filter(Boolean);
    const here = pairsOf(this.list);
    const fromAll = here.length < 3;
    const pool = fromAll ? pairsOf(Object.values(PHRASES).flat()) : here;
    const p = pool[Math.floor(Math.random() * pool.length)];
    this.pair = { ...p, answer: Math.random() < 0.5 ? p.a : p.b, done: false, fromAll };
  },

  renderPairs() {
    if (!this.pair) this.newPair();
    const p = this.pair;
    const sc = this.pairScore;
    $('#pron-area').innerHTML = `
      <div class="card pron-card">
        <div class="muted">👂 どちらの単語が聞こえた？ ・ 正解 <span id="pair-score">${sc.ok} / ${sc.total}</span>${p.fromAll ? '（このカテゴリにペアが少ないので全カテゴリから出題）' : ''}</div>
        <div class="row center"><button class="btn ghost big" data-act="pair-play">🔊 もう一度聞く</button>
          <button class="btn ghost" data-act="pair-slow">🐢</button></div>
        <div class="choices">
          <button class="choice" data-pick="${escapeHtml(p.a)}">${escapeHtml(p.a)}</button>
          <button class="choice" data-pick="${escapeHtml(p.b)}">${escapeHtml(p.b)}</button>
        </div>
        <div id="pron-result" class="pron-result"></div>
      </div>`;
    speak(p.answer, { lang: 'en-US' });
  },

  choosePair(word, btn) {
    const p = this.pair;
    if (p.done) return;
    p.done = true;
    const ok = word === p.answer;
    this.pairScore.total++;
    if (ok) this.pairScore.ok++;
    $('#pair-score').textContent = `${this.pairScore.ok} / ${this.pairScore.total}`;
    stats.add('pron', ok);
    document.querySelectorAll('#pron-area [data-pick]').forEach((b) => { if (b.dataset.pick === p.answer) b.classList.add('correct'); });
    if (!ok) btn.classList.add('wrong');
    $('#pron-result').innerHTML = `
      <div class="big-score score ${ok ? 'good' : 'bad'}">${ok ? '⭕ 正解！' : '❌ ざんねん'}</div>
      <div>聞こえたのは <b>${escapeHtml(p.answer)}</b>（${escapeHtml(p.ja)}）</div>
      <div class="row center">
        <button class="btn ghost" data-say="${escapeHtml(p.a)}">🔊 ${escapeHtml(p.a)}</button>
        <button class="btn ghost" data-say="${escapeHtml(p.b)}">🔊 ${escapeHtml(p.b)}</button>
        <button class="btn primary" data-act="pair-next">次へ →</button>
      </div>`;
  },

  async onClick(e) {
    const say = e.target.closest('[data-say]');
    if (say) { speak(say.dataset.say, { lang: 'en-US' }); return; }
    const pick = e.target.closest('[data-pick]');
    if (pick) { this.choosePair(pick.dataset.pick, pick); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const [en] = this.mode === 'pairs' ? [''] : this.phrase || [''];
    switch (act) {
      case 'listen': speak(en, { lang: 'en-US' }); break;
      case 'slow': speak(en, { lang: 'en-US', slow: true }); break;
      case 'prev': this.go(-1); break;
      case 'next': this.go(1); break;
      case 'shuffle': this.go(1 + Math.floor(Math.random() * (this.list.length - 1))); break;
      case 'reveal': this.revealed = true; this.render(); speak(en, { lang: 'en-US' }); break;
      case 'skip': this.testNext(null); break;
      case 'retest': this.startTest(); this.render(); break;
      case 'pair-play': speak(this.pair.answer, { lang: 'en-US' }); break;
      case 'pair-slow': speak(this.pair.answer, { lang: 'en-US', slow: true }); break;
      case 'pair-next': this.newPair(); this.renderPairs(); break;
      case 'check': this.checkDictation(); break;
      case 'test-next': this.testNext(this.lastScore); break;
      case 'mic': {
        $('#pron-result').innerHTML = '<span class="muted">🎧 聞いています… 英語で話してください</span>';
        const btn = e.target.closest('[data-act]');
        const heard = await listen(btn, 'en-US', (t) => { $('#pron-result').innerHTML = `<span class="muted">🎧 ${escapeHtml(t)}</span>`; });
        if (heard === null) return;
        if (!heard) { $('#pron-result').innerHTML = '<span class="muted">聞き取れませんでした。もう一度どうぞ。</span>'; return; }
        const wasHidden = this.mode === 'repeat' || this.mode === 'ja2en';
        if (wasHidden && !this.revealed) { this.revealed = true; this.render(); }
        this.lastScore = this.judge(heard, en);
        if (this.test) {
          $('#pron-result').insertAdjacentHTML('beforeend',
            `<div class="row center"><button class="btn ghost" data-act="mic">🎤 言い直す</button>
             <button class="btn primary" data-act="test-next">次へ →</button></div>`);
        }
        break;
      }
      default:
    }
  },

  checkDictation() {
    const input = $('#dict-input');
    if (!input || !input.value.trim()) return;
    const typed = input.value;
    this.revealed = true;
    this.render();
    this.judge(typed, this.phrase[0], 'あなたの答え');
  },
};

$('#pron-cat').innerHTML = Object.keys(PHRASES).map((c) => `<option>${escapeHtml(c)}</option>`).join('');
$('#pron-cat').addEventListener('change', (e) => {
  pron.cat = e.target.value;
  pron.idx = 0;
  pron.revealed = false;
  pron.test = null;
  pron.pair = null;
  pron.render();
});
$('#pron-modes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pmode]');
  if (!b) return;
  pron.mode = b.dataset.pmode;
  store.set('pronMode', pron.mode);
  pron.revealed = false;
  pron.test = null;
  pron.pair = null;
  speechSynthesis.cancel();
  pron.render();
});
$('#pron-area').addEventListener('click', (e) => pron.onClick(e));
$('#pron-area').addEventListener('keydown', (e) => {
  if (e.target.id === 'dict-input' && e.key === 'Enter' && !e.isComposing) pron.checkDictation();
});

// ---------- 単語帳 ----------
const MY_WORDS = '★ マイ単語';
const ALL_WORDS = '🔀 すべての単語';
const MASTERED = 3; // このレベル以上で「覚えた」

// クイズの形式 [キー, 名前, 説明]
const QUIZ_KINDS = [
  ['mix', '🔀 ミックス', 'いろいろな形式がランダムに出る'],
  ['en2ja', '🇬🇧→🇯🇵 意味を選ぶ', '英単語を見て日本語を4択'],
  ['ja2en', '🇯🇵→🇬🇧 英語を選ぶ', '日本語を見て英単語を4択'],
  ['listen', '🎧 リスニング', '発音を聞いて意味を4択'],
  ['cloze', '📝 例文の穴埋め', '例文の空欄に入る単語を4択'],
  ['tf', '⭕❌ ○×クイズ', '単語と意味の組み合わせは正しい？'],
  ['order', '🧩 例文の並べ替え', 'バラバラの単語を正しい順に'],
  ['speak', '🎤 スピーキング', '日本語を見て英語で言う'],
  ['time', '⏱️ タイムアタック', '60秒で何問正解できるか'],
];
const QUIZ_LABELS = {
  en2ja: '意味は？', ja2en: '英語では？', listen: '🎧 聞こえた単語の意味は？', cloze: '📝 空欄に入る単語は？',
  tf: '⭕❌ 正しい？', order: '🧩 正しい順に並べよう', speak: '🎤 英語で言おう',
};

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
    this.stopTimer();
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

  // ----- クイズ -----
  quizKind: store.get('quizKind', 'mix'),
  quizCount: store.get('quizCount', 10),
  timer: null,

  startQuiz() { this.renderQuizMenu(); },

  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  },

  renderQuizMenu() {
    this.stopTimer();
    this.session = null;
    const best = store.get('timeBest', {})[this.cat];
    const chip = (n) => `<button class="chip ${this.quizCount === n ? 'active' : ''}" data-count="${n}">${n}問</button>`;
    $('#vocab-area').innerHTML = `
      <div class="filter-row"><span class="muted">問題数</span>${[10, 20, 30].map(chip).join('')}</div>
      <div class="quiz-menu">${QUIZ_KINDS.map(([k, name, desc]) => `
        <button class="quiz-kind ${this.quizKind === k ? 'last' : ''}" data-kind="${k}">
          <div class="name">${name}</div>
          <div class="desc">${desc}${k === 'time' && best ? `<br><b>ベスト ${best}問</b>` : ''}</div>
        </button>`).join('')}
      </div>`;
  },

  /** 例文の見出し語の部分を空欄にする。見つからなければ null */
  clozeOf(w) {
    if (!w.ex) return null;
    const en = w.en.toLowerCase();
    if (en.includes(' ')) {
      const i = w.ex.toLowerCase().indexOf(en);
      return i < 0 ? null : w.ex.slice(0, i) + '_____' + w.ex.slice(i + en.length);
    }
    const stem = en.length > 4 ? en.replace(/(e|y)$/, '') : en;
    const parts = w.ex.split(/(\s+)/);
    const k = parts.findIndex((t) => {
      const word = t.toLowerCase().replace(/[^a-z']/g, '');
      return en.length <= 3 ? [en, en + 's', en + 'es', en + 'ed'].includes(word)
        : word.startsWith(stem) && word.length <= en.length + 4;
    });
    if (k < 0) return null;
    parts[k] = parts[k].replace(/[A-Za-z'’-]+/, '_____');
    return parts.join('');
  },

  makeQ(w, type, pool) {
    const others = (n) => shuffle(pool.filter((x) => x.en !== w.en)).slice(0, n);
    if (type === 'cloze') {
      const sentence = this.clozeOf(w);
      return sentence && { w, type, sentence, choices: shuffle([w, ...others(3)]) };
    }
    if (type === 'tf') {
      const truth = Math.random() < 0.5;
      const shownJa = truth ? w.ja : (others(1)[0] || w).ja;
      return { w, type, truth: shownJa === w.ja, shownJa };
    }
    if (type === 'order') {
      const tokens = (w.ex || '').split(/\s+/).filter(Boolean);
      if (tokens.length < 3 || tokens.length > 12) return null;
      let tiles;
      do { tiles = shuffle(tokens.map((t, id) => ({ t, id }))); } while (tiles.map((x) => x.t).join(' ') === tokens.join(' '));
      return { w, type, tokens, tiles, picked: [] };
    }
    if (type === 'speak') return { w, type, tries: 0 };
    return { w, type, choices: shuffle([w, ...others(3)]) };
  },

  beginQuiz(kind) {
    this.stopTimer();
    this.quizKind = kind;
    store.set('quizKind', kind);
    let pool = this.words();
    if (pool.length < 4) pool = this.words(ALL_WORDS);
    this.session = { kind, pool, i: 0, correct: 0, wrong: [], answered: false, qs: [] };
    const s = this.session;
    if (kind === 'time') {
      s.end = Date.now() + 60_000;
      s.qs.push(this.randomQ(pool));
      this.timer = setInterval(() => {
        if (this.session !== s) { this.stopTimer(); return; }
        const left = Math.max(0, Math.ceil((s.end - Date.now()) / 1000));
        const el = $('#quiz-timer');
        if (el) el.textContent = `⏱️ 残り ${left}秒 ・ 正解 ${s.correct}`;
        if (left <= 0) this.finishTime();
      }, 250);
    } else {
      const MIX = ['en2ja', 'ja2en', 'listen', 'cloze', 'tf'];
      // 穴埋め・並べ替えは例文が使える単語だけなので多めに候補を取る
      for (const w of this.pick(this.quizCount * 4)) {
        if (s.qs.length >= this.quizCount) break;
        const type = kind === 'mix' ? MIX[Math.floor(Math.random() * MIX.length)] : kind;
        const q = this.makeQ(w, type, pool) || (kind === 'mix' ? this.makeQ(w, 'en2ja', pool) : null);
        if (q) s.qs.push(q);
      }
      if (!s.qs.length) { toast('この単語帳ではこの形式の問題が作れません'); this.renderQuizMenu(); return; }
    }
    this.renderQuiz();
  },

  randomQ(pool) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    return this.makeQ(w, Math.random() < 0.5 ? 'en2ja' : 'ja2en', pool);
  },

  finishTime() {
    const s = this.session;
    this.stopTimer();
    const all = store.get('timeBest', {});
    const isBest = s.correct > (all[this.cat] || 0);
    if (isBest) { all[this.cat] = s.correct; store.set('timeBest', all); }
    this.renderResult(s.correct, s.i + (s.answered ? 1 : 0), s.wrong,
      `<p>⏱️ 60秒で <b>${s.correct}問</b> 正解${isBest ? '（ベスト更新！🎉）' : ''}</p>`);
  },

  renderQuiz() {
    const s = this.session;
    if (!s.end && s.i >= s.qs.length) { this.renderResult(s.correct, s.qs.length, s.wrong); return; }
    const q = s.qs[s.i];
    const { w, type } = q;
    const head = s.end
      ? `<div id="quiz-timer" class="muted">⏱️ 残り ${Math.max(0, Math.ceil((s.end - Date.now()) / 1000))}秒 ・ 正解 ${s.correct}</div>`
      : `<div class="muted">${s.i + 1} / ${s.qs.length} ・ ${QUIZ_LABELS[type]}</div>`;
    let body = '';
    if (['en2ja', 'ja2en', 'listen', 'cloze'].includes(type)) {
      const qText = type === 'en2ja' ? escapeHtml(w.en)
        : type === 'ja2en' ? escapeHtml(w.ja)
        : type === 'listen' ? '<button class="btn ghost big" data-act="speak">🔊 もう一度</button>'
        : `<div class="cloze">${escapeHtml(q.sentence).replace('_____', '<span class="blank">＿＿＿</span>')}</div><div class="muted">ヒント：${escapeHtml(w.ja)}</div>`;
      body = `<div class="card quiz-q">${head}<div class="q">${qText}</div></div>
        <div class="choices">${q.choices.map((c, k) => `
          <button class="choice" data-k="${k}">${escapeHtml(type === 'ja2en' || type === 'cloze' ? c.en : c.ja)}</button>`).join('')}
        </div>`;
    } else if (type === 'tf') {
      body = `<div class="card quiz-q">${head}
          <div class="q">${escapeHtml(w.en)}</div>
          <div class="tf-ja">＝ ${escapeHtml(q.shownJa)} ？</div></div>
        <div class="choices"><button class="choice tf" data-tf="1">⭕ 正しい</button><button class="choice tf" data-tf="0">❌ ちがう</button></div>`;
    } else if (type === 'order') {
      const used = new Set(q.picked.map((x) => x.id));
      body = `<div class="card quiz-q">${head}
          <div class="muted">ヒント：<b>${escapeHtml(w.en)}</b>（${escapeHtml(w.ja)}）を使った文</div>
          <div class="order-line">${q.picked.map((x) => `<button class="tile placed" data-pid="${x.id}">${escapeHtml(x.t)}</button>`).join('') || '<span class="muted">下の単語をタップして並べよう</span>'}</div></div>
        <div class="word-tiles">${q.tiles.map((x) => `<button class="tile" data-tid="${x.id}" ${used.has(x.id) ? 'disabled' : ''}>${escapeHtml(x.t)}</button>`).join('')}</div>
        <div class="row center"><button class="btn ghost" data-act="reset-order">↩️ やり直す</button></div>`;
    } else if (type === 'speak') {
      body = `<div class="card quiz-q">${head}
          <div class="q">${escapeHtml(w.ja)}</div>
          <div class="muted">英語で言ってみよう</div>
          <div class="row center">
            <button class="btn mic big" data-act="mic">🎤 話す</button>
            <button class="btn ghost" data-act="giveup">答えを見る</button>
          </div>
          <div id="speak-heard" class="muted"></div></div>`;
    }
    $('#vocab-area').innerHTML = body + '<div id="quiz-next" class="row center"></div>';
    if (type === 'listen') speak(w.en, { lang: 'en-US' });
  },

  /** 正誤を記録して結果を表示する */
  answerQuiz(ok) {
    const s = this.session;
    const { w } = s.qs[s.i];
    s.answered = true;
    if (ok) { s.correct++; this.setLv(w.en, this.lv(w.en) + 1); }
    else { s.wrong.push(w); this.setLv(w.en, 0); stats.miss(w.en); }
    stats.add('quiz', ok);
    this.renderProgress();
    if (s.end) { // タイムアタックはテンポよく次へ
      setTimeout(() => { if (this.session === s && Date.now() < s.end) this.nextQ(); }, ok ? 350 : 1100);
      $('#quiz-next').innerHTML = ok ? '⭕' : `❌ <b>${escapeHtml(w.en)}</b> = ${escapeHtml(w.ja)}`;
      return;
    }
    speak(s.qs[s.i].type === 'order' ? w.ex : w.en, { lang: 'en-US' });
    $('#quiz-next').innerHTML = `
      <div>${ok ? '⭕ 正解！' : '❌ 不正解'} <b>${escapeHtml(w.en)}</b> = ${escapeHtml(w.ja)}
        ${w.ex ? `<div class="muted"><i>${escapeHtml(w.ex)}</i></div>` : ''}</div>
      <button class="btn primary" data-act="next">次へ →</button>`;
  },

  nextQ() {
    const s = this.session;
    s.i++;
    s.answered = false;
    if (s.end && s.i >= s.qs.length) s.qs.push(this.randomQ(s.pool));
    this.renderQuiz();
  },

  async onQuizClick(e) {
    const t = (sel) => e.target.closest(sel);
    if (t('[data-count]')) { this.quizCount = +t('[data-count]').dataset.count; store.set('quizCount', this.quizCount); this.renderQuizMenu(); return; }
    if (t('[data-kind]')) { this.beginQuiz(t('[data-kind]').dataset.kind); return; }
    if (t('[data-act=menu]')) { this.renderQuizMenu(); return; }
    if (t('[data-act=restart]')) { this.beginQuiz(this.quizKind); return; }
    const s = this.session;
    if (!s || !s.qs[s.i]) return;
    const q = s.qs[s.i];
    if (t('[data-act=speak]')) { speak(q.w.en, { lang: 'en-US' }); return; }
    if (t('[data-act=next]')) { this.nextQ(); return; }
    if (s.answered) return;

    const choice = t('.choice[data-k]');
    if (choice) {
      const ok = q.choices[+choice.dataset.k].en === q.w.en;
      document.querySelectorAll('.choice[data-k]').forEach((b) => {
        if (q.choices[+b.dataset.k].en === q.w.en) b.classList.add('correct');
      });
      if (!ok) choice.classList.add('wrong');
      this.answerQuiz(ok);
      return;
    }
    const tf = t('[data-tf]');
    if (tf) {
      const ok = (tf.dataset.tf === '1') === q.truth;
      tf.classList.add(ok ? 'correct' : 'wrong');
      this.answerQuiz(ok);
      return;
    }
    if (q.type === 'order') {
      if (t('[data-act=reset-order]')) { q.picked = []; this.renderQuiz(); return; }
      const placed = t('[data-pid]');
      if (placed) { q.picked = q.picked.filter((x) => x.id !== +placed.dataset.pid); this.renderQuiz(); return; }
      const tile = t('[data-tid]');
      if (tile && !tile.disabled) {
        q.picked.push(q.tiles.find((x) => x.id === +tile.dataset.tid));
        this.renderQuiz();
        if (q.picked.length === q.tokens.length) {
          const ok = q.picked.map((x) => x.t).join(' ') === q.tokens.join(' ');
          document.querySelector('.order-line').classList.add(ok ? 'correct' : 'wrong');
          this.answerQuiz(ok);
        }
      }
      return;
    }
    if (q.type === 'speak') {
      if (t('[data-act=giveup]')) { this.answerQuiz(false); return; }
      const mic = t('[data-act=mic]');
      if (mic) {
        const heard = await listen(mic, 'en-US', (x) => { $('#speak-heard').textContent = '🎧 ' + x; });
        if (!heard || this.session !== s || s.answered) return;
        const nh = ` ${normalizeWord(heard)} `;
        const ok = nh.includes(` ${normalizeWord(q.w.en)} `);
        if (ok) { $('#speak-heard').textContent = `🎧 “${heard}”`; this.answerQuiz(true); }
        else $('#speak-heard').textContent = `🎧 “${heard}” … もう一度 話すか「答えを見る」`;
      }
    }
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

  renderResult(correct, total, wrong, extra = '') {
    const score = total ? Math.round((100 * correct) / total) : 0;
    const cls = scoreClass(score);
    $('#vocab-area').innerHTML = `
      <div class="card result-box">
        <div class="big-score score ${cls}">${correct} / ${total}</div>
        ${extra}
        <p>${score >= 80 ? 'すばらしい！🎉' : score >= 60 ? 'いい調子！👍' : '復習してもう一度！💪'}</p>
        ${wrong.length ? `<p class="muted">まちがえた単語</p>
          <ul class="list">${wrong.map((w) => `<li><div class="txt"><div class="en">${escapeHtml(w.en)}</div><div class="ja">${escapeHtml(w.ja)}</div></div></li>`).join('')}</ul>` : ''}
        <button class="btn primary" data-act="restart">もう一度</button>
        ${this.mode === 'quiz' ? '<button class="btn ghost" data-act="menu">形式を選ぶ</button>' : ''}
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
