(() => {
  const root = document.documentElement;
  let focusScrollTimer = 0;

  const keepFocusedControlVisible = () => {
    const active = document.activeElement;
    if (!active || !active.matches("input, textarea, select")) return;
    if (!active.closest(".screen, .admin-wrap, .staff-page")) return;
    const viewport = window.visualViewport;
    const visibleTop = viewport ? viewport.offsetTop : 0;
    const visibleBottom = visibleTop + (viewport ? viewport.height : window.innerHeight);
    const rect = active.getBoundingClientRect();
    const margin = 16;
    if (rect.top < visibleTop + margin || rect.bottom > visibleBottom - margin) {
      active.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  };

  const scheduleFocusScroll = () => {
    window.clearTimeout(focusScrollTimer);
    focusScrollTimer = window.setTimeout(() => window.requestAnimationFrame(keepFocusedControlVisible), 90);
  };

  const update = () => {
    const viewport = window.visualViewport;
    const visibleHeight = viewport ? viewport.height : window.innerHeight;
    const visibleTop = viewport ? viewport.offsetTop : 0;
    const keyboardInset = viewport ? Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop)) : 0;
    root.style.setProperty("--em-visible-height", visibleHeight + "px");
    root.style.setProperty("--em-visible-top", visibleTop + "px");
    root.style.setProperty("--em-keyboard-inset", keyboardInset + "px");
  };

  update();
  document.addEventListener("focusin", scheduleFocusScroll);
  window.addEventListener("resize", update, { passive: true });
  window.addEventListener("orientationchange", update, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      update();
      scheduleFocusScroll();
    }, { passive: true });
    window.visualViewport.addEventListener("scroll", update, { passive: true });
  }
})();