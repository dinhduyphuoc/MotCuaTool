(() => {
  const els = {};
  const DEF = {
    MOD: 4,
    RESIDUE: 0,
    XPATH: '//*[@id="app_user_profile"]/div[11]/main/div/div/div[2]/form/div[4]/div[2]/div[2]/div/div[1]/div/input',
    SUBMIT_SELECTOR: "button[jf-ext-button-ct='lưu lại'], button[jf-ext-button-ct='lưu lại']",
    AUTO_RESUBMIT: true,
    REDIRECT_AFTER_SAVE: false
  };

  function $(id) { return document.getElementById(id); }

  function restore() {
    chrome.storage.sync.get("MCT_CONFIG", (wrap) => {
      const data = Object.assign({}, DEF, (wrap && wrap.MCT_CONFIG) || {});
      els.MOD.value               = data.MOD;
      els.RESIDUE.value           = data.RESIDUE;
      els.XPATH.value             = data.XPATH || "";
      els.submitSelector.value    = data.SUBMIT_SELECTOR || DEF.SUBMIT_SELECTOR;
      els.autoResubmit.checked    = !!(data.AUTO_RESUBMIT ?? DEF.AUTO_RESUBMIT);
      els.redirectAfterSave.checked = !!(data.REDIRECT_AFTER_SAVE ?? DEF.REDIRECT_AFTER_SAVE);
    });
  }

  function save() {
    const mod = Number(els.MOD.value || 4);
    const residue = Number(els.RESIDUE.value || 0);
    if (!Number.isFinite(mod) || mod < 1) return setStatus("MOD không hợp lệ (>=1).", true);
    if (!Number.isFinite(residue) || residue < 0 || residue >= mod)
      return setStatus("Residue phải trong [0..MOD-1].", true);

    const payload = {
      MOD: mod,
      RESIDUE: residue,
      XPATH: (els.XPATH.value || "").trim(),
      SUBMIT_SELECTOR: (els.submitSelector.value || "").trim(),
      REDIRECT_AFTER_SAVE: !!els.redirectAfterSave.checked,
      tableSelector: (els.tableSelector.value || "").trim()
    };

    chrome.storage.sync.set({ MCT_CONFIG: payload }, () => {
      if (chrome.runtime.lastError) setStatus("Lỗi lưu: " + chrome.runtime.lastError.message, true);
      else setStatus("Đã lưu ✔", false);
    });
  }

  let clearTimer;
  function setStatus(msg, isErr) {
    els.status.textContent = msg;
    els.status.className = isErr ? "err" : "ok";
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => (els.status.textContent = "", els.status.className = ""), 2200);
  }

  document.addEventListener("DOMContentLoaded", () => {
    els.MOD = $("MOD");
    els.RESIDUE = $("RESIDUE");
    els.XPATH = $("XPATH");
    els.submitSelector = $("submitSelector");
    els.redirectAfterSave = $("redirectAfterSave");
    els.save = $("save");
    els.status = $("status");
    els.save.addEventListener("click", save);
    restore();
  });
})();
