(() => {
  // Đọc Liferay globals an toàn (nếu có)
  function safe(fn, dflt=""){ try { return fn(); } catch(e){ return dflt; } }
  const token     = safe(()=> window.Liferay?.authToken, "");
  const groupId   = safe(()=> window.themeDisplay?.getScopeGroupId?.().toString(), "");
  const companyId = safe(()=> window.themeDisplay?.getCompanyId?.().toString(), "");

  window.postMessage({
    type: "MCT_PAGE_CONTEXT",
    payload: { token, groupId, companyId }
  }, "*");
})();
