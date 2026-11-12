// Item photo gallery lightbox (THI-678, fixes THI-677). CSP-safe static
// script, same pattern as share.js / photos.js: no inline handlers, no
// HTML-string sinks — setAttribute and textContent writes only. The markup
// it wires is server-rendered by itemPage() (src/web-pages.ts): a hero
// button (data-idx="0"), a thumbnail strip of the remaining photos
// (data-idx="1..n-1", rendered only when n>1) and a hidden lightbox dialog.
// Photos have a single size (no thumbnail variants, src/images.ts), so the
// lightbox reuses URLs the browser has already cached — opening is instant.
(() => {
  const gallery = document.getElementById("item-gallery");
  const lightbox = document.getElementById("item-lightbox");
  if (!gallery || !lightbox) return; // zero-photo pages render the placeholder only

  const img = lightbox.querySelector(".lb-img");
  const count = lightbox.querySelector(".lb-count");
  const prevBtn = lightbox.querySelector(".lb-prev");
  const nextBtn = lightbox.querySelector(".lb-next");
  const closeBtn = lightbox.querySelector(".lb-close");
  const triggers = Array.from(gallery.querySelectorAll("[data-idx]"));
  if (!img || !count || !prevBtn || !nextBtn || !closeBtn || triggers.length === 0) return;

  const photos = triggers.map((trigger) => {
    const shot = trigger.querySelector("img");
    return {
      src: shot ? shot.getAttribute("src") : "",
      alt: shot ? shot.getAttribute("alt") : "",
    };
  });

  let current = 0;
  let restoreFocus = null;

  const render = () => {
    img.setAttribute("src", photos[current].src);
    img.setAttribute("alt", photos[current].alt);
    count.textContent = `${current + 1} / ${photos.length}`;
    // With a single photo there is nothing to step through — hide the arrows.
    const many = photos.length > 1;
    prevBtn.hidden = !many;
    nextBtn.hidden = !many;
    // Mirror the lightbox position onto the strip (hero + thumbs) so the
    // marker moves as the user steps through the photos.
    triggers.forEach((trigger, i) => trigger.setAttribute("aria-current", i === current ? "true" : "false"));
  };

  const open = (index) => {
    current = index;
    render();
    restoreFocus = document.activeElement;
    lightbox.hidden = false;
    document.body.classList.add("lb-lock"); // freeze page scroll while open
    closeBtn.focus();
  };

  const close = () => {
    lightbox.hidden = true;
    document.body.classList.remove("lb-lock");
    img.removeAttribute("src"); // drop the decoded bitmap while hidden
    if (restoreFocus && typeof restoreFocus.focus === "function") restoreFocus.focus();
    restoreFocus = null;
  };

  const step = (delta) => {
    current = (current + delta + photos.length) % photos.length;
    render();
  };

  triggers.forEach((trigger, i) => trigger.addEventListener("click", () => open(i)));
  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  closeBtn.addEventListener("click", close);
  // Backdrop: a click that hit the overlay itself (not the photo or a
  // button) closes — e.target === lightbox.
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });
  document.addEventListener("keydown", (event) => {
    if (lightbox.hidden) return;
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
  });
})();
