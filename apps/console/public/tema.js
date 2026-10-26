// Aparência antes da primeira pintura (sem piscar o tema claro): lê a escolha guardada neste navegador.
// Arquivo externo por causa da CSP (script inline é bloqueado). Mesma chave de src/components/tema.ts.
(function () {
  var tema = "claro";
  try {
    tema = localStorage.getItem("imobrh:tema") || "claro";
  } catch {
    // navegador sem armazenamento: fica o claro
  }
  var escuro = tema === "escuro" || (tema === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.tema = escuro ? "escuro" : "claro";
})();
