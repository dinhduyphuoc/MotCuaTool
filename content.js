// ========================= MotCuaTool — Clean, Modular, API-only =========================
(() => {
  // ─────────────────────────────────────────────────────────────────────────────
  // 0) GUARD (chống nạp trùng)
  // ─────────────────────────────────────────────────────────────────────────────
  if (!window.__MCT__) window.__MCT__ = {};
  if (window.__MCT__.booted) return;
  window.__MCT__.booted = true;

  // ─────────────────────────────────────────────────────────────────────────────
  // 1) CONFIG — CHỈNH Ở ĐÂY (hoặc ghi đè qua chrome.storage.sync key: "MCT_CONFIG")
  // ─────────────────────────────────────────────────────────────────────────────
  const CONFIG_DEFAULTS = {
    MOD: 4,                      // tổng số "máy"
    RESIDUE: 0,                  // id máy hiện tại [0..MOD-1]
    // Ưu tiên dùng XPath bạn cung cấp cho ô Mã hồ sơ
    XPATH: '//*[@id="app_user_profile"]/div[11]/main/div/div/div[2]/form/div[4]/div[2]/div[2]/div/div[1]/div/input',
    CODE_FIELD_SELECTOR: 'input[jf-ext-cache-id="10"]', // fallback (CSS selector)
    SUBMIT_SELECTOR: "button[jf-ext-button-ct='lưu lại'], button[jf-ext-button-ct='lưu lại']",
    REDIRECT_AFTER_SAVE: false,
    PRECOMPUTE_BEFORE_SUBMIT: true,
    AUTO_RESUBMIT: false,
    ERROR_TEXT_REGEX: "(mã hồ sơ|đã được sử dụng|trùng)",
    API_PATH: "/o/rest/v2/filestoregov/suggest-dossierno",
    REDIRECT_URL: "https://motcua.mod.gov.vn/web/mot-cua-bo-quoc-phong/qlkdl#/all/them-moi-giay-to",
    CACHE_TTL_MS: 5000,
    DEBOUNCE_MS: 200,
    WRITELOCK_MS: 120,
    APPLY_WINDOW_MS: 1000,
  };

  // state runtime
  const STATE = {
    cfg: { ...CONFIG_DEFAULTS },
    ctx: { token: "", groupId: "", companyId: "" },
    latestCache: { value: null, ts: 0, inflight: null },
    pos: null,
    writeLock: false,
    lastApplied: "",
    applyGuard: { to: "", ts: 0 },
    epoch: 0,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 2) STORAGE — load/patch cấu hình
  // ─────────────────────────────────────────────────────────────────────────────
  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get("MCT_CONFIG", (data) => {
        if (data && data.MCT_CONFIG && typeof data.MCT_CONFIG === "object") {
          Object.assign(STATE.cfg, data.MCT_CONFIG);
        }
        resolve(STATE.cfg);
      });
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.MCT_CONFIG) return;
    const next = changes.MCT_CONFIG.newValue || {};
    Object.assign(STATE.cfg, next);
    UI.updateHeader();
    UI.syncCheckboxes();
    // Áp cấu hình mới ngay
    try { ensure && ensure(); } catch (_) {}
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3) HELPERS: debounce, wait, selectors (CSS & XPath)
  // ─────────────────────────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const debounce = (fn, ms = STATE.cfg.DEBOUNCE_MS) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
  async function waitFor(selOrFn, timeout = 15000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const el = typeof selOrFn === "string" ? document.querySelector(selOrFn) : selOrFn();
        if (el) return el;
      } catch {}
      await sleep(interval);
    }
    return null;
  }

  function queryXPath(xpath, root = document) {
    if (!xpath) return null;
    try {
      const r = document.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = r.singleNodeValue;
      if (!node) return null;
      if (node instanceof HTMLInputElement) return node;
      const inner = node.querySelector?.("input");
      return inner instanceof HTMLInputElement ? inner : null;
    } catch (e) {
      console.warn("[MCT] Invalid XPATH:", xpath, e);
      return null;
    }
  }

  const getCodeInput = () => {
    // 1) Ưu tiên XPATH trong config
    const byXPath = queryXPath(STATE.cfg.XPATH);
    if (byXPath && byXPath.offsetParent !== null) return byXPath;

    // 2) Fallback: CSS selector trong config
    const sel = STATE.cfg.CODE_FIELD_SELECTOR;
    if (sel) {
      try {
        const byCss = document.querySelector(sel);
        if (byCss && byCss.offsetParent !== null) return byCss;
      } catch (e) {
        console.warn("[MCT] Invalid CODE_FIELD_SELECTOR:", sel, e);
      }
    }

    // 3) Fallback heuristics
    const candidates = [
      "input[jf-ext-cache-id='10']",
      "input[placeholder*='Mã hồ sơ' i]",
      "input[aria-label*='Mã hồ sơ' i]",
      "input[name*='ma_ho_so' i]",
      "input[name*='mahoso' i]",
      "input[id*='mahoso' i]",
    ];
    for (const c of candidates) {
      try {
        const el = document.querySelector(c);
        if (el && el.offsetParent !== null) return el;
      } catch {}
    }

    // 4) Theo label
    const labels = Array.from(document.querySelectorAll("label"))
      .filter(l => /mã\s*hồ\s*sơ/i.test(l.textContent || ""));
    for (const lb of labels) {
      const forId = lb.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el && el.tagName === "INPUT" && el.offsetParent !== null) return el;
      }
      const near = lb.querySelector("input") || lb.parentElement?.querySelector("input");
      if (near && near.offsetParent !== null) return near;
    }
    return null;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 4) NUMBERING
  // ─────────────────────────────────────────────────────────────────────────────
  const parseXXXX = (code) => {
    const m = String(code || "").match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const replaceXXXX = (fullCode, newXXXX) =>
    String(fullCode || "").replace(/(\d+)\s*$/, String(newXXXX).padStart(4, "0"));
  function nextByMod(x, mod, residue) {
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(mod) || mod < 1) mod = 1;
    if (!Number.isFinite(residue)) residue = 0;
    residue = ((residue % mod) + mod) % mod;
    const k = Math.floor((x - residue) / mod) + 1; // y > x & y ≡ residue (mod)
    return k * mod + residue;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5) CONTEXT BRIDGE
  // ─────────────────────────────────────────────────────────────────────────────
  (function initContextBridge(){
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("injected.js");
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch(e) { console.warn("[MCT] inject failed:", e); }
    window.addEventListener("message", (ev) => {
      if (ev?.data?.type === "MCT_PAGE_CONTEXT" && ev.data.payload) {
        STATE.ctx = ev.data.payload;
      }
    });
  })();
  function waitPageCtx(timeout = 2000) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      (function poll(){
        const { token, groupId } = STATE.ctx || {};
        if (token && groupId) return resolve(STATE.ctx);
        if (Date.now() - t0 > timeout) return reject(new Error("Timeout PAGE_CTX"));
        setTimeout(poll, 100);
      })();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6) API CLIENT (cache 5s, dedupe inflight)
  // ─────────────────────────────────────────────────────────────────────────────
  async function callSuggest(ctx) {
    const res = await fetch(STATE.cfg.API_PATH, {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Token": ctx.token || "",
        "Groupid": ctx.groupId || "",
        ...(ctx.companyId ? { "CompanyId": ctx.companyId } : {}),
      }
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) {
      const body = ct.includes("application/json") ? await res.json().catch(()=>null) : await res.text().catch(()=> "");
      throw new Error(`HTTP ${res.status} ${res.statusText} | Body: ${typeof body === "string" ? body.slice(0,200) : JSON.stringify(body).slice(0,200)}`);
    }
    if (!ct.includes("application/json")) {
      const html = await res.text().catch(()=> "");
      throw new Error(`Unexpected content-type: ${ct} | Body: ${html.slice(0,200)}`);
    }
    return res.json();
  }
  async function getServerLatest(force = false) {
    const now = Date.now();
    const c = STATE.latestCache;
    if (!force && c.value && now - c.ts < STATE.cfg.CACHE_TTL_MS) return c.value;
    if (c.inflight) return c.inflight;

    const run = (async () => {
      const ctx = await waitPageCtx();
      const data = await callSuggest(ctx);
      const latest = data?.generateDossierNo || "";
      if (!latest) throw new Error("Không nhận được generateDossierNo");
      c.value = latest; c.ts = Date.now(); c.inflight = null;
      return latest;
    })();

    c.inflight = run;
    try { return await run; } finally { c.inflight = null; }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 7) APPLY SERVICE (native setter + anti-revert)
  // ─────────────────────────────────────────────────────────────────────────────
  function safeApplyToInput(latest, mod, residue) {
    const input = getCodeInput();
    if (!input) return false;

    const cur = parseXXXX(latest);
    const next = nextByMod(cur, mod, residue);
    const newVal = replaceXXXX(latest, next);

    // Không ghi nếu trùng giá trị
    const trimmed = (input.value || "").trim();
    if (trimmed === newVal || STATE.lastApplied === newVal) {
      UI.setLabels(latest, newVal);
      return false;
    }

    // Tránh ghi đè lẫn nhau trong thời gian ngắn
    if (STATE.writeLock) return false;
    STATE.writeLock = true;

    // Ghi bằng native setter để React/Vue nhận biết
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, newVal); else input.value = newVal;
    // Thông báo cho framework cập nhật state
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    STATE.lastApplied = newVal;
    STATE.applyGuard = { to: newVal, ts: Date.now() };
    UI.setLabels(latest, newVal);

    setTimeout(() => { STATE.writeLock = false; }, STATE.cfg.WRITELOCK_MS);

    // Anti-revert window: nếu bị đè ngược nhanh → set lại 1 lần
    const guardUntil = Date.now() + (STATE.cfg.APPLY_WINDOW_MS || 1000);
    const tryFix = () => {
      if (Date.now() > guardUntil) return;
      if (((input.value || "").trim()) !== newVal) {
        const setter2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter2) setter2.call(input, newVal); else input.value = newVal;
        input.dispatchEvent(new Event("input",  { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    setTimeout(tryFix, 0);
    setTimeout(tryFix, 120);

    return true;
  }

  async function applyLatestToField(force = false) {
    const myEpoch = ++STATE.epoch;
    const latest = await getServerLatest(force).catch(()=>null);
    if (!latest) return false;
    if (myEpoch !== STATE.epoch) return false;

    const input = await waitFor(() => getCodeInput(), 15000, 150);
    if (!input) return false;

    // Ổn định 2 frame trước khi set (tránh framework patch ngược)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (myEpoch !== STATE.epoch) return false;

    return safeApplyToInput(latest, STATE.cfg.MOD, STATE.cfg.RESIDUE);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 8) UI PANEL
  // ─────────────────────────────────────────────────────────────────────────────
  const UI = (() => {
    let panel, body, headerBtn, lblLatest, lblUpdated, btnUpdate, cbRedirect, cbPrecompute;

    function build() {
      if (panel) return panel;
      panel = document.createElement("div");
      Object.assign(panel.style, {
        position: "fixed", top: "12px", right: "12px", zIndex: 2147483647,
        background: "#111", color: "#fff", padding: "10px 12px",
        borderRadius: "10px", boxShadow: "0 10px 30px rgba(0,0,0,.35)",
        width: "320px", font: "13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        userSelect: "none",
      });
      panel.innerHTML = `
        <div id="mct-h" style="display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:6px;cursor:move">
          <span>MotCuaTool</span>
          <button id="mct-min" style="cursor:pointer;border:none;background:#222;color:#fff;padding:2px 8px;border-radius:6px;font-weight:700">–</button>
        </div>
        <div id="mct-b">
          <div id="mct-sub" style="opacity:.85;margin-bottom:6px"></div>

          <div class="mct-row">
            <span class="mct-label">Mới nhất:</span>
            <code id="mct-latest" class="mct-pill mct-pill-warn">-</code>
          </div>
          <div class="mct-row">
            <span class="mct-label">Đã cập nhật:</span>
            <code id="mct-updated" class="mct-pill mct-pill-ok">-</code>
          </div>

          <div style="margin-top:8px;display:flex;gap:10px">
            <button id="mct-step" class="mct-btn">Cập nhật</button>
          </div>

          <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #444;display:grid;gap:6px">
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input id="mct-cb-redirect" type="checkbox" />
              <span>Tự động mở lại form sau khi lưu</span>
            </label>
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input id="mct-cb-precompute" type="checkbox" />
              <span>Tự cập nhật mã ngay trước khi lưu</span>
            </label>
          </div>
        </div>
      `;
      const css = document.createElement("style");
      css.textContent = `
        .mct-btn{flex:1;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:600;font-size:13px;transition:background .2s,transform .1s}
        .mct-btn:hover{background:#1d4ed8}.mct-btn:active{transform:scale(.96)}
        .mct-row{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:nowrap}
        .mct-label{min-width:90px;color:#e5e7eb}
        .mct-pill{padding:2px 8px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
        .mct-pill-warn{background:#fff3cd;color:#7a5500}
        .mct-pill-ok{background:#d1e7dd;color:#0a3622}
      `;
      panel.appendChild(css);
      document.body.appendChild(panel);

      body       = panel.querySelector("#mct-b");
      headerBtn  = panel.querySelector("#mct-min");
      lblLatest  = panel.querySelector("#mct-latest");
      lblUpdated = panel.querySelector("#mct-updated");
      btnUpdate  = panel.querySelector("#mct-step");
      cbRedirect = panel.querySelector("#mct-cb-redirect");
      cbPrecompute = panel.querySelector("#mct-cb-precompute");

      // minimize
      headerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const hidden = body.style.display === "none";
        body.style.display = hidden ? "" : "none";
        headerBtn.textContent = hidden ? "–" : "+";
      });

      // update ngay
      btnUpdate.addEventListener("click", async () => {
        btnUpdate.disabled = true;
        btnUpdate.textContent = "Đang cập nhật...";
        try { await applyLatestToField(true); } finally {
          btnUpdate.textContent = "Cập nhật";
          btnUpdate.disabled = false;
        }
      });

      // toggles → ghi vào storage
      cbRedirect.checked   = !!STATE.cfg.REDIRECT_AFTER_SAVE;
      cbPrecompute.checked = !!STATE.cfg.PRECOMPUTE_BEFORE_SUBMIT;
      cbRedirect.addEventListener("change", () => saveCfg({ REDIRECT_AFTER_SAVE: !!cbRedirect.checked }));
      cbPrecompute.addEventListener("change", () => saveCfg({ PRECOMPUTE_BEFORE_SUBMIT: !!cbPrecompute.checked }));

      // drag
      makeDraggable(panel, panel.querySelector("#mct-h"));

      updateHeader();
      return panel;
    }

    function saveCfg(patch) {
      const next = { ...STATE.cfg, ...patch };
      chrome.storage.sync.set({ MCT_CONFIG: next });
    }

    function updateHeader() {
      const sub = panel?.querySelector("#mct-sub");
      if (!sub) return;
      sub.textContent = `Tổng máy=${STATE.cfg.MOD}, Máy hiện tại=${STATE.cfg.RESIDUE}`;
    }

    function syncCheckboxes() {
      if (cbRedirect)   cbRedirect.checked   = !!STATE.cfg.REDIRECT_AFTER_SAVE;
      if (cbPrecompute) cbPrecompute.checked = !!STATE.cfg.PRECOMPUTE_BEFORE_SUBMIT;
    }

    function setLabels(latest, updated) {
      if (lblLatest)  lblLatest.textContent  = latest  || "-";
      if (lblUpdated) lblUpdated.textContent = updated || "-";
    }

    function makeDraggable(box, handle) {
      let isDown = false, relX = 0, relY = 0;
      handle.style.cursor = "move";
      handle.addEventListener("mousedown", (e) => {
        const minBtn = box.querySelector("#mct-min");
        if (minBtn && (e.target === minBtn || minBtn.contains(e.target))) return;
        if (e.button !== 0) return;
        isDown = true;
        const r = box.getBoundingClientRect();
        relX = e.clientX - r.left;
        relY = e.clientY - r.top;
        Object.assign(box.style, { right: "auto", position: "fixed" });
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!isDown) return;
        box.style.left = (e.clientX - relX) + "px";
        box.style.top  = (e.clientY - relY) + "px";
        e.preventDefault();
      });
      document.addEventListener("mouseup", (e) => {
        if (e.button !== 0) return;
        if (!isDown) return;
        isDown = false;
        STATE.pos = { left: box.style.left, top: box.style.top };
        chrome.storage.sync.set({ MCT_PANEL_POS: STATE.pos });
        e.preventDefault();
      });
      // restore pos
      chrome.storage.sync.get("MCT_PANEL_POS", ({ MCT_PANEL_POS }) => {
        if (MCT_PANEL_POS) {
          STATE.pos = MCT_PANEL_POS;
          Object.assign(box.style, { left: STATE.pos.left, top: STATE.pos.top });
        }
      });
    }

    return { build, updateHeader, syncCheckboxes, setLabels };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 9) ROUTER & DOM WATCHERS
  // ─────────────────────────────────────────────────────────────────────────────
  const ensure = debounce(() => applyLatestToField(false).catch(()=>{}), STATE.cfg.DEBOUNCE_MS);

  function hookRouter() {
    window.addEventListener("hashchange", ensure);
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function(){ const r=_ps.apply(this, arguments); ensure(); return r; };
    history.replaceState = function(){ const r=_rs.apply(this, arguments); ensure(); return r; };
  }
  function startFormObserver() {
    const root = document.getElementById("app_user_profile") || document.body;
    new MutationObserver(() => { if (getCodeInput()) ensure(); })
      .observe(root, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 10) SUBMIT & TOAST
  // ─────────────────────────────────────────────────────────────────────────────
  function findSubmitButton() {
    const byCfg = Array.from(document.querySelectorAll(STATE.cfg.SUBMIT_SELECTOR || ""))
      .find(b => b && b.offsetParent !== null);
    if (byCfg) return byCfg;
    return Array.from(document.querySelectorAll("button,[role='button']"))
      .find(b => /lưu lại/i.test(b.textContent || ""));
  }
  async function hookSubmitOnce() {
    const btn = await waitFor(() => findSubmitButton(), 15000, 200);
    if (!btn || btn.__mctHooked) return;
    btn.__mctHooked = true;
    btn.addEventListener("click", async () => {
      if (STATE.cfg.PRECOMPUTE_BEFORE_SUBMIT) {
        // Ép bỏ cache để lấy latest thật sự trước khi submit
        await applyLatestToField(true).catch(()=>{ /* ignore */ });
      }
      if (STATE.cfg.REDIRECT_AFTER_SAVE) {
        setTimeout(() => location.assign(STATE.cfg.REDIRECT_URL), 1000);
      }
    }, true);
  }
  function keepHookingSubmit() { hookSubmitOnce(); setInterval(hookSubmitOnce, 2000); }

  function startToastObserver() {
    const re = new RegExp(STATE.cfg.ERROR_TEXT_REGEX || "(mã hồ sơ|đã được sử dụng|trùng)", "i");
    const obs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const t = n.textContent?.trim() || "";
        if (!t || !re.test(t)) continue;

        (async () => {
          await applyLatestToField(true).catch(()=>{});
          if (STATE.cfg.AUTO_RESUBMIT) {
            setTimeout(() => findSubmitButton()?.click(), 200);
          }
        })();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 11) BOOTSTRAP
  // ─────────────────────────────────────────────────────────────────────────────
  (async function bootstrap(){
    await loadConfig();
    UI.build();
    UI.updateHeader();
    hookRouter();
    startFormObserver();
    startToastObserver();
    keepHookingSubmit();
    ensure(); // chạy 1 lần khi vào trang
  })();
})();
