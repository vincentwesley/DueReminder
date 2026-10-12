// Applies the saved theme (dark by default) to the static legal pages.
try { document.documentElement.dataset.theme = localStorage.getItem('rs.theme') === 'light' ? 'light' : 'dark'; } catch (e) { document.documentElement.dataset.theme = 'dark'; }
