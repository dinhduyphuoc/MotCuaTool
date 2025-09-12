(() => {
/***** ========= CONFIG ========= *****/
// Tổng số máy và residue (số thứ tự máy này trong [0..MOD-1])
const MOD = 4;
const RESIDUE = 0; // <-- đổi 0,1,2,3 tùy từng máy

// XPaths theo bạn cung cấp
const FIELD_XPATH = '//*[@id="app_user_profile"]/div[11]/main/div/div/div[2]/form/div[4]/div[2]/div[2]/div/div[1]/div/input';
const FIELD_FALLBACK_XPATH = '//*[@id="app_user_profile"]//input[@jf-ext-cache-id="10"]';
const SAVE_BTN_XPATH = '//*[@id="app_user_profile"]/div[13]/main/div/div/div[3]/button[2]/div';

// Selector phụ trợ (phòng khi nút lưu đổi class)
const SUBMIT_SELECTOR = 'button[jf-ext-button-ct="lưu lại"], .v-btn.primary--text, .v-btn.primary';

// Redirect (tùy chọn)
const REDIRECT_URL = 'https://motcua.mod.gov.vn/web/mot-cua-bo-quoc-phong/qlkdl#/all/them-moi-giay-to';
const REDIRECT_DELAY_MS = 1200;

// Retry khi trùng mã
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 350;

// Mẫu text có thể xuất hiện khi trùng mã
const ERROR_TEXT_REGEX = /đã được sử dụng|đã tồn tại|mã (?:hồ\s*sơ|hs)\s*đã\s*dùng|trùng|duplicate|already\s*(?:used|exists)/i;


/***** ========= GLOBAL STATE (không lưu qua reload) ========= *****/
let AUTO_REDIRECT = false;   // OFF mặc định mỗi lần tải trang
let _redirectTimer = null;   // chỉ khai báo duy nhất 1 lần
let _retryCount = 0;


/***** ========= UTILS ========= *****/
function xEval(xpath, context=document) {
  try {
    return document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
  } catch { return null; }
}
function waitFor(fn, {timeout=20000, interval=120} = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const it = setInterval(() => {
      try {
        const v = fn();
        if (v) { clearInterval(it); resolve(v); }
        else if (Date.now() - t0 > timeout) { clearInterval(it); resolve(null); }
      } catch { clearInterval(it); resolve(null); }
    }, interval);
  });
}
function hasPattern(v) { return /-\d{6}-\d+$/.test(v || ''); }
function parseXXXX(fullCode) { const m = String(fullCode || '').match(/(\d+)\s*$/); return m ? parseInt(m[1],10) : null; }
function replaceXXXX(fullCode, newXXXX) {
  const padded = String(newXXXX).padStart(4, '0'); // luôn 4 chữ số
  return String(fullCode || '').replace(/(\d+)\s*$/, padded);
}

// Số nhỏ nhất > fromExclusive và ≡ RESIDUE (mod MOD)
function nextByMod(fromExclusive, MOD, RESIDUE) {
  const start = fromExclusive + 1;
  const delta = (RESIDUE - (start % MOD) + MOD) % MOD;
  return start + delta;
}
function fillInput(input, val) {
  input.focus();
  input.value = val;
  input.dispatchEvent(new Event('input',  {bubbles:true}));
  input.dispatchEvent(new Event('change', {bubbles:true}));
}
function getField() { return xEval(FIELD_XPATH) || xEval(FIELD_FALLBACK_XPATH) || null; }


/***** ========= DRAG (kéo panel) ========= *****/
function makeDraggable(box, handle) {
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  handle.style.cursor = 'grab';
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.style.cursor = 'grabbing';

    const rect = box.getBoundingClientRect();
    box.style.left = `${rect.left}px`;
    box.style.top  = `${rect.top}px`;
    box.style.right = 'auto';
    box.style.bottom = 'auto';

    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop  = rect.top;

    e.preventDefault();
    e.stopPropagation();

    const onMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let newLeft = startLeft + dx;
      let newTop  = startTop + dy;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bw = box.offsetWidth;
      const bh = box.offsetHeight;
      const pad = 4;
      newLeft = Math.max(pad, Math.min(vw - bw - pad, newLeft));
      newTop  = Math.max(pad, Math.min(vh - bh - pad, newTop));

      box.style.left = `${newLeft}px`;
      box.style.top  = `${newTop}px`;
    };

    const onUp = (ev) => {
      dragging = false;
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      handle.style.cursor = 'grab';
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }, { passive: false });
}


/***** ========= PANEL ========= *****/
function ensurePanel() {
  if (document.getElementById('idmod-panel')) return;
  const div = document.createElement('div');
  div.id = 'idmod-panel';
  div.style.cssText = `
    position:fixed;bottom:16px;right:16px;z-index:2147483647;
    background:#111;color:#fff;font:13px/1.45 system-ui,sans-serif;
    padding:0;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:380px;
    user-select:none; -webkit-user-select:none;
  `;
  div.innerHTML = `
    <div id="idmod-handle" style="
      display:flex;align-items:center;justify-content:space-between;
      padding:10px 12px;border-radius:10px 10px 0 0;background:#1f2937;
      border-bottom:1px solid rgba(255,255,255,.08);
    ">
      <div style="font-weight:700;">MotCuaTool</div>
      <div style="opacity:.85;font-size:12px;">Tổng máy=${MOD}, ID máy=${RESIDUE}</div>
    </div>
    <div style="padding:10px 12px;">
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer">
        <input id="idmod-autoredirect" type="checkbox" style="accent-color:#4ade80;cursor:pointer">
        <span>Tự về lại form sau khi bấm “Lưu lại”</span>
      </label>
      <div style="font-size:12px;margin-bottom:6px">
        <div>Trước khi tăng: <code id="idmod-prev">—</code></div>
        <div>Đã tăng thành: <code id="idmod-now">—</code></div>
        <div>Kế tiếp (nếu cần): <code id="idmod-next">—</code></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="idmod-bump1" style="padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:#374151;color:#fff">Tăng thêm 1 bước</button>
        <button id="idmod-refresh" style="padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:#374151;color:#fff">Tính lại</button>
      </div>
    </div>
  `;
  document.body.appendChild(div);

  makeDraggable(div, div.querySelector('#idmod-handle'));

  document.getElementById('idmod-autoredirect')?.addEventListener('change', (e) => {
    AUTO_REDIRECT = !!e.target.checked; // reset mỗi reload, không lưu state
  });
}
function updatePanel(prev, now, next) {
  const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '—'; };
  s('idmod-prev', prev || '—');
  s('idmod-now',  now  || '—');
  s('idmod-next', next || '—');
}


/***** ========= CORE ========= *****/
async function main() {
  ensurePanel();

  // 1) Chờ ô input xuất hiện và có dạng "...-YYMMDD-XXXX"
  const input = await waitFor(() => getField(), { timeout: 20000 });
  if (!input || input.tagName !== 'INPUT') { updatePanel('—', 'Không thấy input theo XPath', '—'); return; }

  const ok = await waitFor(() => hasPattern(input.value), { timeout: 20000 });
  if (!ok) { updatePanel('—', 'Field chưa có dạng -YYMMDD-XXXX', '—'); return; }

  // 2) Auto bump ngay khi tải trang (không dùng state cũ)
  const baseline = String(input.value);
  const curXXXX = parseXXXX(baseline);
  if (curXXXX == null) { updatePanel(baseline, 'Không đọc được XXXX', '—'); return; }

  const nextXXXX = nextByMod(curXXXX, MOD, RESIDUE);
  const bumped   = replaceXXXX(baseline, nextXXXX);
  fillInput(input, bumped);

  const nextXXXX2 = nextByMod(nextXXXX, MOD, RESIDUE);
  updatePanel(baseline, bumped, replaceXXXX(bumped, nextXXXX2));

  // Nút thao tác tay
  document.getElementById('idmod-bump1')?.addEventListener('click', () => {
    const nowFull = String(input.value || '');
    const nowXXXX = parseXXXX(nowFull); if (nowXXXX == null) return;
    const nx = nextByMod(nowXXXX, MOD, RESIDUE);
    const nfull = replaceXXXX(nowFull, nx);
    fillInput(input, nfull);
    const nx2 = nextByMod(nx, MOD, RESIDUE);
    updatePanel(baseline, nfull, replaceXXXX(nfull, nx2));
  });
  document.getElementById('idmod-refresh')?.addEventListener('click', () => {
    const nowFull = String(input.value || '');
    const nowXXXX = parseXXXX(nowFull);
    if (nowXXXX == null) { updatePanel(baseline, nowFull, '—'); return; }
    const nx = nextByMod(nowXXXX, MOD, RESIDUE);
    updatePanel(baseline, nowFull, replaceXXXX(nowFull, nx));
  });

  input.addEventListener('input',  () => document.getElementById('idmod-refresh')?.click(), true);
  input.addEventListener('change', () => document.getElementById('idmod-refresh')?.click(), true);

  attachSubmitHandlers();
}


/***** ========= SUBMIT & DUPLICATE HANDLER ========= *****/
function safeNextFromField(input) {
  const nowFull = String(input.value || '');
  const nowXXXX = parseXXXX(nowFull);
  if (nowXXXX == null) throw new Error('Không đọc được XXXX hiện tại');
  const nx = nextByMod(nowXXXX, MOD, RESIDUE);
  return replaceXXXX(nowFull, nx);
}
function clickSubmit() {
  const xp = xEval(SAVE_BTN_XPATH);
  const el = xp?.closest('button') || document.querySelector(SUBMIT_SELECTOR) || xp;
  if (el && !el.disabled) el.click();
}

function scheduleRedirect() {
  if (!AUTO_REDIRECT) return;
  clearTimeout(_redirectTimer);
  _redirectTimer = setTimeout(() => { location.href = REDIRECT_URL; }, REDIRECT_DELAY_MS);
}
function cancelRedirect() { clearTimeout(_redirectTimer); _redirectTimer = null; }

function handleDuplicateFound(where='DOM') {
  cancelRedirect();
  if (_retryCount >= MAX_RETRIES) return;

  const input = getField();
  if (!input) return;

  try {
    const bumped = safeNextFromField(input);
    fillInput(input, bumped);
    document.getElementById('idmod-refresh')?.click();
    _retryCount++;

    setTimeout(() => {
      clickSubmit();
      scheduleRedirect();
    }, RETRY_DELAY_MS);
  } catch(_) {}
}

function attachSubmitHandlers() {
  // 1) Trước khi gửi: bump thêm 1 bước
  document.addEventListener('click', (e) => {
    const isSave =
      e.target?.closest(SUBMIT_SELECTOR) ||
      e.target === xEval(SAVE_BTN_XPATH) ||
      e.target?.closest('button') === xEval(SAVE_BTN_XPATH)?.closest('button');
    if (!isSave) return;

    const input = getField();
    if (!input) return;
    try {
      const bumped = safeNextFromField(input);
      fillInput(input, bumped);
      document.getElementById('idmod-refresh')?.click();
    } catch(_) {}

    // Đặt lịch redirect (nếu bật). Nếu phát hiện duplicate -> cancel rồi retry.
    scheduleRedirect();
  }, true);

  // 2) Quan sát DOM để bắt thông điệp lỗi (kể cả toast)
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        const txt = (node.innerText || node.textContent || '').trim();
        if (txt && ERROR_TEXT_REGEX.test(txt)) {
          handleDuplicateFound('DOM');
          return;
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // 3) Bắt lỗi từ response (fetch / XHR)
  const _fetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const res = await _fetch.apply(this, args);
      const clone = res.clone();
      clone.text().then(t => { if (ERROR_TEXT_REGEX.test(t)) handleDuplicateFound('fetch'); }).catch(()=>{});
      return res;
    } catch (err) { return Promise.reject(err); }
  };

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(...args) { this.__url = args[1]; return _open.apply(this, args); };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const text = this.responseText || '';
        if (ERROR_TEXT_REGEX.test(text)) handleDuplicateFound('xhr');
      } catch(_) {}
    });
    return _send.apply(this, args);
  };

  // 4) Reset khi chuyển route SPA
  window.addEventListener('hashchange', () => { _retryCount = 0; cancelRedirect(); });
}


/***** ========= BOOT ========= *****/
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => main());
} else {
  main();
}
// SPA hash routing: khởi lại logic, không giữ state
window.addEventListener('hashchange', () => setTimeout(() => main(), 0));
})();
