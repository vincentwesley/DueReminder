// Pre-paint: apply the saved Vin's Atelier logo form before first render (external file: strict CSP, no inline scripts).
try { var logo = localStorage.getItem("logo-form"); if (logo === "short" || logo === "middle" || logo === "long") document.documentElement.setAttribute("data-logo", logo); } catch (e) {}
