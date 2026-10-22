const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const ease = "cubic-bezier(.22, 1, .36, 1)";
const previews = new WeakMap();

export function openPreview(dialog) {
  previews.get(dialog)?.cancel();
  dialog.showModal();
  if (reduced.matches) return;
  const animation = dialog.animate(
    [{ opacity: 0, transform: "translateY(24px) scale(.96)" },
      { opacity: 1, transform: "translateY(0) scale(1)" }],
    { duration: 420, easing: ease },
  );
  previews.set(dialog, animation);
}

export function closePreview(dialog) {
  if (!dialog.open || dialog.dataset.closing !== undefined) return;
  previews.get(dialog)?.cancel();
  if (reduced.matches) return dialog.close();
  dialog.dataset.closing = "";
  // Keep the native modal and focus trap alive until the exit completes.
  const animation = dialog.animate(
    [{ opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "translateY(12px) scale(.98)" }],
    { duration: 180, easing: "ease-in" },
  );
  previews.set(dialog, animation);
  const finish = () => {
    delete dialog.dataset.closing;
    dialog.close();
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
}

export function enhanceMotion() {
  const nav = document.querySelector(".header nav");
  if (nav) {
    const marker = document.createElement("span");
    marker.className = "nav-marker";
    marker.setAttribute("aria-hidden", "true");
    nav.prepend(marker);
    const current = nav.querySelector("[aria-current]");
    const move = (link) => {
      if (!link) return;
      marker.style.width = `${link.offsetWidth}px`;
      marker.style.transform = `translateX(${link.offsetLeft}px)`;
    };
    nav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("pointerenter", () => move(link));
      link.addEventListener("focus", () => move(link));
    });
    nav.addEventListener("pointerleave", () => move(nav.querySelector(":focus") || current));
    nav.addEventListener("focusout", () => requestAnimationFrame(() => move(nav.querySelector(":focus") || current)));
    new ResizeObserver(() => move(current)).observe(nav);
    move(current);
  }

  document.querySelectorAll(".faq-section details").forEach((details) => {
    const summary = details.querySelector("summary");
    let animation;
    let targetOpen = details.open;
    const reset = () => {
      animation?.cancel();
      animation = undefined;
      details.open = targetOpen;
      details.style.height = "";
      details.style.overflow = "";
    };
    summary.addEventListener("click", (event) => {
      if (reduced.matches) return;
      event.preventDefault();
      const start = details.getBoundingClientRect().height;
      animation?.cancel();
      targetOpen = !targetOpen;
      details.style.height = "";
      details.open = targetOpen;
      const end = details.getBoundingClientRect().height;
      details.open = true;
      details.style.overflow = "hidden";
      details.dataset.expanded = String(targetOpen);
      animation = details.animate(
        [{ height: `${start}px` }, { height: `${end}px` }],
        { duration: 360, easing: ease },
      );
      animation.onfinish = reset;
    });
    details.addEventListener("toggle", () => {
      if (!animation) targetOpen = details.open;
      details.dataset.expanded = String(targetOpen);
    });
    reduced.addEventListener("change", reset);
  });

  const stage = document.querySelector(".device-stage");
  if (!stage) return;
  let visible = false;
  let frame = 0;
  const render = () => {
    frame = 0;
    if (!visible || reduced.matches || innerWidth < 760) {
      stage.style.removeProperty("--depth");
      return;
    }
    const rect = stage.getBoundingClientRect();
    const progress = Math.max(-1, Math.min(1, (innerHeight / 2 - rect.top - rect.height / 2) / innerHeight));
    stage.style.setProperty("--depth", `${progress * 48}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  }).observe(stage);
  window.addEventListener("scroll", () => { if (visible) schedule(); }, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  reduced.addEventListener("change", schedule);
}
