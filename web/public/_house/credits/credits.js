// Runs the credits animations only while the card is on screen (adds .is-live).
const el = document.querySelector(".creator");
if (el) {
  if (!window.IntersectionObserver) el.classList.add("is-live");
  else new IntersectionObserver(([e]) => el.classList.toggle("is-live", e.isIntersecting)).observe(el);
}
