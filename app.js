// Parla Català — PWA per practicar català parlat
// STT via Web Speech API, conversa/feedback via Anthropic API,
// perfil d'errors acumulatiu a localStorage.

const LS_KEYS = {
  apiKey: 'pc_apiKey',
  model: 'pc_model',
  level: 'pc_level',
  topic: 'pc_topic',
  profile: 'pc_profile',
  history: 'pc_history',
};

const DEFAULTS = {
  model: 'gemini-2.5-flash',
  level: 'B1',
  topic: '',
};

const MAX_HISTORY_TURNS = 12;
const MAX_PROFILE_ERRORS = 40;

// ---------- Estat ----------
const state = {
  apiKey: localStorage.getItem(LS_KEYS.apiKey) || '',
  model: localStorage.getItem(LS_KEYS.model) || DEFAULTS.model,
  level: localStorage.getItem(LS_KEYS.level) || DEFAULTS.level,
  topic: localStorage.getItem(LS_KEYS.topic) || DEFAULTS.topic,
  profile: loadProfile(),
  history: loadHistory(),
  recognizing: false,
  busy: false,
  lastQuestion: '',
};

function loadProfile() {
  try {
    const raw = localStorage.getItem(LS_KEYS.profile);
    if (!raw) return { errors: [], totalTurns: 0, startedAt: new Date().toISOString() };
    return JSON.parse(raw);
  } catch {
    return { errors: [], totalTurns: 0, startedAt: new Date().toISOString() };
  }
}

function saveProfile() {
  localStorage.setItem(LS_KEYS.profile, JSON.stringify(state.profile));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEYS.history) || '[]');
  } catch {
    return [];
  }
}

function saveHistory() {
  const trimmed = state.history.slice(-MAX_HISTORY_TURNS * 2);
  localStorage.setItem(LS_KEYS.history, JSON.stringify(trimmed));
}

// ---------- DOM ----------
const chatEl = document.getElementById('chat');
const micBtn = document.getElementById('micBtn');
const micLabel = document.getElementById('micLabel');
const transcriptEl = document.getElementById('transcript');
const nextBtn = document.getElementById('nextBtn');
const repeatBtn = document.getElementById('repeatBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsDialog = document.getElementById('settingsDialog');
const settingsForm = document.getElementById('settingsForm');
const apiKeyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('model');
const levelSelect = document.getElementById('level');
const topicInput = document.getElementById('topic');
const profilePreview = document.getElementById('profilePreview');
const resetProfileBtn = document.getElementById('resetProfile');

// ---------- UI helpers ----------
function addMessage(role, content, extra = {}) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (extra.label) {
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = extra.label;
    div.appendChild(l);
  }
  const body = document.createElement('div');
  body.textContent = content;
  div.appendChild(body);
  if (extra.feedback) {
    const fb = document.createElement('div');
    fb.className = 'feedback';
    fb.innerHTML = extra.feedback;
    div.appendChild(fb);
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function addThinking() {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = '<div class="thinking"><span></span><span></span><span></span></div>';
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderFeedback(fb) {
  if (!fb) return '';
  const parts = [];
  if (Array.isArray(fb.corrections) && fb.corrections.length) {
    parts.push('<div><strong>Correccions:</strong></div>');
    for (const c of fb.corrections) {
      parts.push(`<div class="feedback-item">• <span class="wrong">${escapeHtml(c.wrong || '')}</span> → <span class="right">${escapeHtml(c.right || '')}</span>${c.note ? ' — <em>' + escapeHtml(c.note) + '</em>' : ''}</div>`);
    }
  } else {
    parts.push('<div class="feedback-item"><span class="right">Perfecte! ✓</span></div>');
  }
  if (fb.tip) parts.push(`<div class="feedback-item">💡 ${escapeHtml(fb.tip)}</div>`);
  return parts.join('');
}

// ---------- Perfil d'errors ----------
function updateProfile(corrections) {
  state.profile.totalTurns += 1;
  if (!Array.isArray(corrections)) { saveProfile(); return; }
  for (const c of corrections) {
    if (!c || !c.right) continue;
    const key = (c.category || 'altres').toLowerCase();
    const existing = state.profile.errors.find(e =>
      e.category === key && e.wrong === c.wrong && e.right === c.right
    );
    if (existing) {
      existing.count += 1;
      existing.lastSeen = new Date().toISOString();
    } else {
      state.profile.errors.push({
        category: key,
        wrong: c.wrong || '',
        right: c.right,
        note: c.note || '',
        count: 1,
        lastSeen: new Date().toISOString(),
      });
    }
  }
  state.profile.errors.sort((a, b) => b.count - a.count);
  if (state.profile.errors.length > MAX_PROFILE_ERRORS) {
    state.profile.errors = state.profile.errors.slice(0, MAX_PROFILE_ERRORS);
  }
  saveProfile();
}

function profileSummary() {
  if (!state.profile.errors.length) return 'Cap error registrat encara.';
  const top = state.profile.errors.slice(0, 15);
  const byCat = {};
  for (const e of top) {
    byCat[e.category] = byCat[e.category] || [];
    byCat[e.category].push(`"${e.wrong}" → "${e.right}"${e.note ? ' (' + e.note + ')' : ''} [×${e.count}]`);
  }
  return Object.entries(byCat)
    .map(([cat, items]) => `${cat}:\n  - ${items.join('\n  - ')}`)
    .join('\n');
}

// ---------- Gemini API ----------
const SYSTEM_PROMPT = `Ets un professor de català molt pacient i natural. L'usuari està practicant català parlat. La seva resposta t'arriba transcrita per reconeixement de veu, per tant pot tenir petites imprecisions de transcripció (homòfons, accents). Si sembla un error de transcripció, no ho corregeixis; només corregeix errors lingüístics reals.

Funcionament:
1. Analitza la resposta de l'usuari a la pregunta anterior.
2. Dona feedback lingüístic breu: corregeix errors de gramàtica, vocabulari, pronunciació (si es detecta pel text), castellanismes, ordre de paraules, pronoms febles, etc.
3. Llança una pregunta nova, engrescadora, adaptada al nivell i al tema, i que convidi a respondre amb frases completes. Varia el tipus de pregunta (opinió, narració, descripció, hipòtesi).
4. Si veus errors recurrents al perfil, de tant en tant introdueix preguntes que facin servir aquestes estructures per practicar-les.

Has de respondre sempre amb un JSON que segueixi aquest esquema:
{
  "feedback": {
    "corrections": [
      { "wrong": "text incorrecte de l'usuari", "right": "forma correcta", "category": "gramàtica|vocabulari|castellanisme|pronoms|ortografia|altres", "note": "explicació breu en català" }
    ],
    "tip": "consell curt opcional en català, o cadena buida"
  },
  "next_question": "la següent pregunta en català"
}

Si la resposta de l'usuari és perfecta, deixa "corrections" com a array buit. Mantén "note" curt (màxim una frase). La "next_question" ha de ser en català clar i adequat al nivell.`;

// Esquema JSON per forçar l'estructura de sortida de Gemini.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    feedback: {
      type: 'object',
      properties: {
        corrections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              wrong: { type: 'string' },
              right: { type: 'string' },
              category: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['right', 'category'],
          },
        },
        tip: { type: 'string' },
      },
      required: ['corrections', 'tip'],
    },
    next_question: { type: 'string' },
  },
  required: ['feedback', 'next_question'],
};

// Converteix l'historial intern (role: user|assistant, content: string)
// al format de Gemini (role: user|model, parts: [{text}]).
function toGeminiContents(history) {
  return history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

async function callGemini(userUtterance) {
  if (!state.apiKey) {
    throw new Error('Falta la clau API. Obre la configuració (⚙️) i afegeix-la.');
  }

  const userBlock = state.lastQuestion
    ? `Pregunta anterior: "${state.lastQuestion}"\n\nResposta de l'usuari (transcrita): "${userUtterance}"`
    : `Inici de la sessió. L'usuari ha dit: "${userUtterance}". Dona una benvinguda breu i llança la primera pregunta.`;

  const contextBlock = `Nivell de l'usuari: ${state.level}
Tema preferit: ${state.topic || 'conversa general'}
Torns totals acumulats: ${state.profile.totalTurns}

Perfil d'errors recurrents de l'usuari (per prioritzar):
${profileSummary()}`;

  const contents = [
    ...toGeminiContents(state.history.slice(-MAX_HISTORY_TURNS * 2)),
    { role: 'user', parts: [{ text: `${contextBlock}\n\n${userBlock}` }] },
  ];

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(state.model)}:generateContent?key=${encodeURIComponent(state.apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error API (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();

  if (!text) {
    const blockReason = data.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Resposta bloquejada: ${blockReason}` : 'Resposta buida del model.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No s\'ha pogut interpretar la resposta: ' + text.slice(0, 200));
    parsed = JSON.parse(jsonMatch[0]);
  }

  return { parsed, rawAssistantText: text };
}

// ---------- Flux principal ----------
async function handleUserUtterance(utterance) {
  if (!utterance || state.busy) return;
  state.busy = true;
  setMicEnabled(false);

  addMessage('user', utterance, { label: 'Tu' });
  state.history.push({ role: 'user', content: utterance });

  const thinkingEl = addThinking();

  try {
    const { parsed } = await callGemini(utterance);
    thinkingEl.remove();

    const fb = parsed.feedback || { corrections: [], tip: '' };
    const nextQ = parsed.next_question || 'Pots tornar a dir-ho?';

    updateProfile(fb.corrections);

    addMessage('assistant', nextQ, {
      label: 'Professora',
      feedback: renderFeedback(fb),
    });

    state.history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    saveHistory();

    state.lastQuestion = nextQ;
    speak(nextQ);
  } catch (err) {
    thinkingEl.remove();
    addMessage('system', '⚠️ ' + err.message);
  } finally {
    state.busy = false;
    setMicEnabled(true);
  }
}

// ---------- TTS ----------
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ca-ES';
    u.rate = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const cat = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('ca'));
    if (cat) u.voice = cat;
    window.speechSynthesis.speak(u);
  } catch {}
}

// ---------- STT ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

// Text acumulat entre reinicis (alguns navegadors, sobretot mòbils,
// tanquen el reconeixement en silenci encara que sigui continuous).
let accumulatedFinal = '';
// Quan l'usuari prem aturar, posem aquesta bandera per no tornar a reiniciar.
let userStopped = false;
// Indica si el reconeixement està actiu (o en procés de rearrencar)
// des del punt de vista de l'usuari.
let sessionActive = false;

function initRecognition() {
  if (!SR) {
    micBtn.disabled = true;
    micLabel.textContent = 'Reconeixement de veu no suportat';
    return;
  }
  recognition = new SR();
  recognition.lang = 'ca-ES';
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.recognizing = true;
    micBtn.classList.add('recording');
    micLabel.textContent = 'Prémer per aturar';
    if (!accumulatedFinal) transcriptEl.textContent = 'Escoltant…';
  };

  recognition.onresult = (e) => {
    let interim = '';
    let newFinal = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) newFinal += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (newFinal) accumulatedFinal += (accumulatedFinal ? ' ' : '') + newFinal.trim();
    transcriptEl.textContent = (accumulatedFinal + ' ' + interim).trim() || '…';
  };

  recognition.onerror = (e) => {
    // 'no-speech' i 'aborted' són recuperables: els ignorem perquè
    // onend ja s'encarregarà de reiniciar si cal.
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    // 'not-allowed' o 'service-not-allowed' són permanents.
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      userStopped = true;
      sessionActive = false;
      transcriptEl.textContent = 'Permís de micròfon denegat.';
      return;
    }
    transcriptEl.textContent = 'Error: ' + e.error;
  };

  recognition.onend = () => {
    state.recognizing = false;
    // Si l'usuari no ha aturat i la sessió encara és activa,
    // rearrenquem el reconeixement per mantenir-lo obert.
    if (sessionActive && !userStopped) {
      try {
        recognition.start();
        return;
      } catch {
        // Si no es pot reiniciar immediatament, ho provem en un tick.
        setTimeout(() => {
          if (sessionActive && !userStopped) {
            try { recognition.start(); } catch {}
          }
        }, 150);
        return;
      }
    }

    // Aturada real: processem el text acumulat.
    micBtn.classList.remove('recording');
    micLabel.textContent = 'Prémer per parlar';
    const text = accumulatedFinal.trim();
    if (text) {
      transcriptEl.textContent = '';
      handleUserUtterance(text);
    } else if (!transcriptEl.textContent.startsWith('Error') &&
               !transcriptEl.textContent.startsWith('Permís')) {
      transcriptEl.textContent = 'No s\'ha detectat veu.';
    }
  };
}

function startRecording() {
  if (!recognition || state.busy) return;
  accumulatedFinal = '';
  userStopped = false;
  sessionActive = true;
  try {
    window.speechSynthesis && window.speechSynthesis.cancel();
    recognition.start();
  } catch (e) {
    // already started
  }
}

function stopRecording() {
  if (!recognition) return;
  userStopped = true;
  sessionActive = false;
  try { recognition.stop(); } catch {}
}

function setMicEnabled(enabled) {
  micBtn.disabled = !enabled;
}

// ---------- Event wiring ----------
micBtn.addEventListener('click', () => {
  if (state.recognizing) stopRecording();
  else startRecording();
});

nextBtn.addEventListener('click', () => {
  if (state.busy) return;
  handleUserUtterance('(l\'usuari demana una pregunta nova sense respondre)');
});

repeatBtn.addEventListener('click', () => {
  if (state.lastQuestion) speak(state.lastQuestion);
});

settingsBtn.addEventListener('click', () => {
  apiKeyInput.value = state.apiKey;
  modelSelect.value = state.model;
  levelSelect.value = state.level;
  topicInput.value = state.topic;
  profilePreview.textContent = profileSummary();
  settingsDialog.showModal();
});

settingsForm.addEventListener('submit', () => {
  state.apiKey = apiKeyInput.value.trim();
  state.model = modelSelect.value;
  state.level = levelSelect.value;
  state.topic = topicInput.value.trim();
  localStorage.setItem(LS_KEYS.apiKey, state.apiKey);
  localStorage.setItem(LS_KEYS.model, state.model);
  localStorage.setItem(LS_KEYS.level, state.level);
  localStorage.setItem(LS_KEYS.topic, state.topic);
});

resetProfileBtn.addEventListener('click', () => {
  if (!confirm('Segur que vols esborrar tot el perfil d\'errors i l\'historial?')) return;
  state.profile = { errors: [], totalTurns: 0, startedAt: new Date().toISOString() };
  state.history = [];
  state.lastQuestion = '';
  localStorage.removeItem(LS_KEYS.profile);
  localStorage.removeItem(LS_KEYS.history);
  profilePreview.textContent = profileSummary();
  chatEl.innerHTML = '';
  bootstrap();
});

// ---------- Arrencada ----------
async function bootstrap() {
  initRecognition();

  if (!state.apiKey) {
    addMessage('system', 'Benvingut! Per començar, obre la configuració (⚙️) i introdueix la teva clau API d\'Anthropic.');
    addMessage('assistant', 'Hola! Quan tinguis la clau configurada, prem el micròfon i digues alguna cosa per començar la conversa.', { label: 'Professora' });
    state.lastQuestion = 'Hola! Com estàs avui? Què has fet?';
    return;
  }

  // Primera pregunta: si hi ha historial, reprenem; si no, iniciem.
  if (state.history.length > 0) {
    const lastAssistant = [...state.history].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) {
      try {
        const parsed = JSON.parse(lastAssistant.content);
        if (parsed.next_question) {
          addMessage('system', 'Reprenent la sessió…');
          addMessage('assistant', parsed.next_question, { label: 'Professora' });
          state.lastQuestion = parsed.next_question;
          return;
        }
      } catch {}
    }
  }

  // Iniciar amb una pregunta d'obertura feta per Claude.
  state.busy = true;
  const thinkingEl = addThinking();
  try {
    const { parsed } = await callGemini('(inici de sessió, dona la benvinguda i la primera pregunta)');
    thinkingEl.remove();
    const nextQ = parsed.next_question || 'Com estàs avui?';
    addMessage('assistant', nextQ, { label: 'Professora' });
    state.history.push({ role: 'user', content: '(inici)' });
    state.history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    saveHistory();
    state.lastQuestion = nextQ;
    speak(nextQ);
  } catch (err) {
    thinkingEl.remove();
    addMessage('system', '⚠️ ' + err.message);
  } finally {
    state.busy = false;
  }
}

// Service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Carrega veus (algunes plataformes necessiten aquest esdeveniment)
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

bootstrap();
