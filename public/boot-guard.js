// Rede de segurança antes do React subir (antes ficava inline no index.html; saiu por causa da CSP).
// Rede de segurança antes do React subir: um erro ao carregar ou iniciar o app mostraria só a
// página em branco. Aqui ele recarrega uma vez (build antigo em cache) e, se persistir, mostra o motivo.
(function () {
  var KEY = "imobdesk-app:stale-build-reload";
  var shown = false;
  function show(detail) {
    if (window.__appBooted || shown) return;
    var root = document.getElementById("root");
    if (!root || root.childElementCount > 0) return;
    try {
      var last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last > 30000) {
        sessionStorage.setItem(KEY, String(Date.now()));
        location.reload();
        return;
      }
    } catch (e) {}
    shown = true;
    root.innerHTML =
      '<main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#f5f6f8;font-family:Inter,system-ui,sans-serif">' +
      '<div style="max-width:460px;width:100%;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:32px 28px;text-align:center">' +
      '<h1 style="margin:0 0 8px;font-size:20px;color:#18181b">Não foi possível iniciar o sistema</h1>' +
      '<p style="margin:0;font-size:14px;line-height:1.55;color:#5f6068">Recarregue a página. Se continuar, limpe os dados do site no navegador ou envie o detalhe abaixo para o suporte.</p>' +
      '<button id="boot-reload" type="button" style="margin-top:22px;padding:10px 20px;font:inherit;font-weight:600;color:#fff;background:#d6293b;border:0;border-radius:8px;cursor:pointer">Recarregar</button>' +
      '<pre id="boot-detail" style="margin:22px 0 0;padding:10px;text-align:left;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#5f6068;background:#f5f6f8;border-radius:6px"></pre>' +
      "</div></main>";
    document.getElementById("boot-detail").textContent = detail;
    // Sem onclick inline: a Content-Security-Policy (vercel.json) não permite script inline.
    document.getElementById("boot-reload").addEventListener("click", function () {
      location.reload();
    });
  }
  window.addEventListener(
    "error",
    function (event) {
      var target = event.target;
      if (target && target !== window) {
        // Só os arquivos do próprio build contam; fonte externa bloqueada não impede o sistema.
        var url = String(target.src || target.href || "");
        if (url.indexOf(location.origin + "/assets/") === 0) show("Arquivo não carregou: " + url);
      } else {
        show(String((event.error && event.error.message) || event.message || "Erro desconhecido"));
      }
    },
    true,
  );
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    show(String((reason && reason.message) || reason || "Erro desconhecido"));
  });
  setTimeout(function () {
    show("O sistema não respondeu em 30 segundos.");
  }, 30000);
})();
