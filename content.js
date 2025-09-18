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
    SUBMIT_SELECTOR: "button[jf-ext-button-ct='lưu lại'], button[jf-ext-button-ct='lưu lại']",
    REDIRECT_AFTER_SAVE: false,
    PRECOMPUTE_BEFORE_SUBMIT: true,
    API_PATH: "/o/rest/v2/filestoregov/suggest-dossierno",
    REDIRECT_URL: "https://motcua.mod.gov.vn/web/mot-cua-bo-quoc-phong/qlkdl#/all/them-moi-giay-to",
  };

  // state runtime
  const STATE = {
    cfg: { ...CONFIG_DEFAULTS },
    ctx: { token: "", groupId: "", companyId: "" },
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
    try { ensure && ensure(); } catch (_) { }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3) HELPERS: debounce, wait, selectors (CSS & XPath)
  // ─────────────────────────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function waitFor(selOrFn, timeout = 15000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const el = typeof selOrFn === "string" ? document.querySelector(selOrFn) : selOrFn();
        if (el) return el;
      } catch { }
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

  const getCodeInput = () => queryXPath(STATE.cfg.XPATH);

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
  (function initContextBridge() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("injected.js");
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { console.warn("[MCT] inject failed:", e); }
    window.addEventListener("message", (ev) => {
      if (ev?.data?.type === "MCT_PAGE_CONTEXT" && ev.data.payload) {
        STATE.ctx = ev.data.payload;
      }
    });
  })();
  function waitPageCtx(timeout = 2000) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      (function poll() {
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
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Token": ctx.token || "",
        "Groupid": ctx.groupId || "",
        ...(ctx.companyId ? { "CompanyId": ctx.companyId } : {}),
      }
    });

    // Nếu không OK → throw với status
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    // Thử parse JSON, nếu fail thì throw
    try {
      return await res.json();
    } catch {
      throw new Error("Server did not return valid JSON");
    }
  }

  async function getServerLatest() {
    const ctx = await waitPageCtx();
    const data = await callSuggest(ctx);
    const latest = data?.generateDossierNo || "";
    if (!latest) throw new Error("Không nhận được generateDossierNo");
    return latest;
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

    // Không ghi nếu trùng
    if ((input.value || "").trim() === newVal) {
      UI.setLabels(latest, newVal);
      return false;
    }

    // Ghi bằng native setter
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, newVal); else input.value = newVal;

    // Kích hoạt event cho React/Vue
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    UI.setLabels(latest, newVal);
    return true;
  }

  async function applyLatestToField() {
    const myEpoch = ++STATE.epoch;
    const latest = await getServerLatest().catch(() => null);
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

      body = panel.querySelector("#mct-b");
      headerBtn = panel.querySelector("#mct-min");
      lblLatest = panel.querySelector("#mct-latest");
      lblUpdated = panel.querySelector("#mct-updated");
      btnUpdate = panel.querySelector("#mct-step");
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
        try { await applyLatestToField(); } finally {
          btnUpdate.textContent = "Cập nhật";
          btnUpdate.disabled = false;
        }
      });

      // toggles → ghi vào storage
      cbRedirect.checked = !!STATE.cfg.REDIRECT_AFTER_SAVE;
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
      if (cbRedirect) cbRedirect.checked = !!STATE.cfg.REDIRECT_AFTER_SAVE;
      if (cbPrecompute) cbPrecompute.checked = !!STATE.cfg.PRECOMPUTE_BEFORE_SUBMIT;
    }

    function setLabels(latest, updated) {
      if (lblLatest) lblLatest.textContent = latest || "-";
      if (lblUpdated) lblUpdated.textContent = updated || "-";
    }

    function makeDraggable(box, handle) {
      let isDown = false, relX = 0, relY = 0;
      handle.style.cursor = "move";

      // Bắt đầu kéo
      handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // chỉ chuột trái
        const minBtn = box.querySelector("#mct-min");
        if (minBtn && (e.target === minBtn || minBtn.contains(e.target))) return;

        isDown = true;
        const r = box.getBoundingClientRect();
        relX = e.clientX - r.left;
        relY = e.clientY - r.top;
        box.style.position = "fixed";
        e.preventDefault();
      });

      // Đang kéo
      document.addEventListener("mousemove", (e) => {
        if (!isDown) return;

        const boxW = box.offsetWidth;
        const boxH = box.offsetHeight;
        const maxX = window.innerWidth - boxW;
        const maxY = window.innerHeight - boxH;

        let newX = e.clientX - relX;
        let newY = e.clientY - relY;

        // Giới hạn trong màn hình
        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));

        box.style.left = newX + "px";
        box.style.top = newY + "px";
      });

      // Thả chuột → lưu vị trí
      document.addEventListener("mouseup", (e) => {
        if (e.button !== 0) return;
        if (!isDown) return;
        isDown = false;

        STATE.pos = { left: box.style.left, top: box.style.top };
        chrome.storage.sync.set({ MCT_PANEL_POS: STATE.pos });
      });

      // Khôi phục vị trí khi load lại
      chrome.storage.sync.get("MCT_PANEL_POS", ({ MCT_PANEL_POS }) => {
        if (MCT_PANEL_POS) {
          STATE.pos = MCT_PANEL_POS;

          // Chống trường hợp lưu ngoài màn hình
          const boxW = box.offsetWidth;
          const boxH = box.offsetHeight;
          const maxX = window.innerWidth - boxW;
          const maxY = window.innerHeight - boxH;

          let newX = parseInt(STATE.pos.left) || 0;
          let newY = parseInt(STATE.pos.top) || 0;

          newX = Math.max(0, Math.min(newX, maxX));
          newY = Math.max(0, Math.min(newY, maxY));

          box.style.left = newX + "px";
          box.style.top = newY + "px";
          box.style.position = "fixed";
        }
      });
    }

    return { build, updateHeader, syncCheckboxes, setLabels };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 9) ROUTER & DOM WATCHERS
  // ─────────────────────────────────────────────────────────────────────────────
  function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  const ensure = debounce(() => applyLatestToField().catch(()=>{}), 150);

  function hookRouter() {
    window.addEventListener("hashchange", ensure);
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function () { const r = _ps.apply(this, arguments); ensure(); return r; };
    history.replaceState = function () { const r = _rs.apply(this, arguments); ensure(); return r; };
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 11) BOOTSTRAP
  // ─────────────────────────────────────────────────────────────────────────────
  (async function bootstrap() {
    await loadConfig();
    UI.build();
    UI.updateHeader();
    hookRouter();
    startFormObserver();
    hookSubmitOnce();
    ensure();
  })();
})();
