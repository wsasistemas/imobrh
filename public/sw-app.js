// Service worker do App do solicitante (escopo /app): deixa o app abrir sem rede para o rascunho financeiro salvo no aparelho
// (Solicitações Financeiras, Fase 6). Página: rede primeiro, cópia guardada se não houver rede. Arquivos de /assets/
// (nome com hash, imutáveis): cópia guardada primeiro. Supabase e outros domínios passam direto, sem cópia.
var VERSAO = "solicitante-v1";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.filter(function (n) { return n.indexOf("solicitante-") === 0 && n !== VERSAO; }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    ev.respondWith(
      fetch(req).then(function (resp) {
        if (resp.ok) {
          var copia = resp.clone();
          caches.open(VERSAO).then(function (c) { c.put("/app", copia); });
        }
        return resp;
      }).catch(function () {
        return caches.match("/app").then(function (r) { return r || Response.error(); });
      })
    );
    return;
  }

  if (url.pathname.indexOf("/assets/") === 0 || /\.(webp|svg|png|woff2?)$/.test(url.pathname)) {
    ev.respondWith(
      caches.match(req).then(function (guardado) {
        if (guardado) return guardado;
        return fetch(req).then(function (resp) {
          if (resp.ok) {
            var copia = resp.clone();
            caches.open(VERSAO).then(function (c) { c.put(req, copia); });
          }
          return resp;
        });
      })
    );
  }
});
