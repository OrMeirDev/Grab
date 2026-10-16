// Popup: connection status, the current page's video candidates, and "Send to GRAB".
// "Sent" only means the desktop app accepted the request; the final result is shown only when
// the app reports it (completed / failed / cancelled).
const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);

const CONN_TEXT = {
  connected: ['מחובר ל-Grab', 'ok'],
  connecting: ['מתחבר…', 'warn'],
  app_offline: ['Grab לא פועל', 'warn'],
  idle: ['מתחבר…', 'warn'],
  disconnected: ['לא מחובר', 'bad'],
  incompatible: ['גרסה לא תואמת', 'bad'],
  rejected: ['נדחה', 'bad'],
};
const CONN_HELP = {
  app_offline: 'פתח את Grab כדי להמשיך. החיבור יתבצע לבד.',
  host_missing: 'ההתקנה של Grab בדפדפן לא הושלמה. ב-Grab: הגדרות ← דפדפן ← חיבור/תיקון.',
  origin_forbidden: 'מזהה ההרחבה לא תואם להתקנה של Grab. ב-Grab: הגדרות ← דפדפן ← תיקון.',
  host_exited: 'רכיב החיבור של Grab נעצר. נסה "התחבר מחדש", ואם זה חוזר, תקן ב-Grab.',
  host_start_failed: 'הדפדפן לא הצליח להפעיל את רכיב החיבור של Grab. ב-Grab: הגדרות ← דפדפן ← תיקון.',
  protocol_version: 'גרסת ההרחבה אינה תואמת ל-Grab. ב-Grab: הגדרות ← דפדפן ← תיקון, ואז טען מחדש את ההרחבה.',
};
const SEND_TEXT = { accepted: 'התקבל ב-Grab. ההורדה מתחילה…', duplicate: 'הסרטון הזה כבר בתור של Grab.', rejected: 'Grab דחה את הבקשה.', offline: 'Grab לא מחובר.', timeout: 'Grab לא ענה בזמן.' };
const PHASE_TEXT = { queued: 'בתור', resolving: 'מזהה את הסרטון…', discovering: 'מזהה את הסרטון…', downloading: 'מוריד…', finalizing: 'מסיים…' };

let tabId = null;
let status = null;

function renderConn() {
  const [text, cls] = CONN_TEXT[status.conn.state] || ['לא מחובר', 'bad'];
  const pill = $('conn');
  pill.textContent = text;
  pill.className = 'pill ' + cls;
  const help = CONN_HELP[status.conn.errorKind] || (status.conn.state === 'app_offline' ? CONN_HELP.app_offline : '');
  $('connHelp').hidden = !help;
  $('connHelp').textContent = help;
  $('sendPage').disabled = status.conn.state !== 'connected';
}

function showSend(send) {
  const out = $('sendResult');
  if (!send) { out.hidden = true; return; }
  out.hidden = false;
  out.className = 'result';
  if (send.terminal === 'completed') { out.textContent = 'ההורדה הסתיימה ✓'; out.classList.add('ok'); }
  else if (send.terminal === 'failed') { out.textContent = 'ההורדה נכשלה. פרטים ב-Grab.'; out.classList.add('bad'); }
  else if (send.terminal === 'cancelled') { out.textContent = 'ההורדה בוטלה.'; }
  else out.textContent = PHASE_TEXT[send.phase] || SEND_TEXT.accepted;
}

async function scan() {
  const info = await ask({ type: 'popup:scan', tabId });
  if (!info || !info.ok || !/^https?:/i.test(info.url || '')) { $('page').hidden = true; $('unsupported').hidden = false; return; }
  $('unsupported').hidden = true;
  $('page').hidden = false;
  $('pageTitle').textContent = info.title || info.url;
  const list = $('candidates');
  list.textContent = '';
  if (info.ambiguous) {
    for (const c of info.candidates) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.className = 'what';
      try { what.textContent = c.kind.toUpperCase() + ' · ' + new URL(c.url).host + new URL(c.url).pathname; } catch { what.textContent = c.kind; }
      const btn = document.createElement('button');
      btn.className = 'small'; btn.type = 'button'; btn.textContent = 'שלח';
      btn.addEventListener('click', () => send(c.url));
      li.append(what, btn);
      list.append(li);
    }
  }
  const note = $('pageNote');
  note.hidden = true;
  if (info.ambiguous) { note.hidden = false; note.textContent = 'נמצאו כמה סרטונים בעמוד. בחר את הנכון, או שלח את העמוד ו-Grab יזהה.'; }
  else if (!info.candidates.length && info.blob) { note.hidden = false; note.textContent = 'הנגן משתמש במקור פנימי של הדפדפן. Grab יפעיל ויזהה את הסרטון אחרי השליחה.'; }
  else if (!info.candidates.length) { note.hidden = false; note.textContent = 'עוד לא זוהה סרטון בעמוד הזה. אפשר לשלוח את העמוד ו-Grab ינסה לזהות.'; }
  showSend(info.send);
}

async function send(candidateUrl) {
  $('sendPage').disabled = true;
  const out = $('sendResult');
  out.hidden = false; out.className = 'result'; out.textContent = 'שולח…';
  const res = await ask({ type: 'popup:send', tabId, candidateUrl });
  const r = (res && res.result) || { status: 'offline' };
  out.textContent = SEND_TEXT[r.status] || 'שגיאה בשליחה.';
  out.classList.add(r.status === 'accepted' || r.status === 'duplicate' ? 'ok' : 'bad');
  $('sendPage').disabled = false;
  poll();
}

let pollTimer = null;
function poll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const info = await ask({ type: 'popup:scan', tabId });
    if (info && info.ok && info.send) { showSend(info.send); if (info.send.terminal) clearInterval(pollTimer); }
  }, 1500);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  status = await ask({ type: 'popup:status' });
  $('alias').value = status.alias || '';
  renderConn();
  if (tabId != null) await scan();
  else $('unsupported').hidden = false;
}

$('sendPage').addEventListener('click', () => send());
$('reconnect').addEventListener('click', async () => { await ask({ type: 'popup:reconnect' }); setTimeout(async () => { status = await ask({ type: 'popup:status' }); renderConn(); }, 1200); });
$('alias').addEventListener('change', () => ask({ type: 'popup:alias', alias: $('alias').value.trim() }));
init();
