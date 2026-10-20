(() => {
  const root = document.documentElement;
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
  window.addEventListener("resize", update, { passive: true });
  window.addEventListener("orientationchange", update, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update, { passive: true });
    window.visualViewport.addEventListener("scroll", update, { passive: true });
  }
})();