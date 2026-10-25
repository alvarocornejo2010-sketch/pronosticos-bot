// El service worker de la web. Sirve para tres cosas: que el móvil la pueda instalar
// como app (manifest.webmanifest), que, sin red, salga una página que lo diga en vez
// del error del navegador, y enseñar los avisos de Mis equipos (worker/avisos.js). No
// guarda nada en caché: la web tiene que verse siempre al día (va con no-store) y los
// números cambian cada minuto. De las peticiones, solo toca las navegaciones (abrir la
// página); lo demás va como sin él.

const SIN_CONEXION = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b130f"><title>Sin conexión · Pronósticos</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
         box-sizing: border-box; background: #070d0a; color: #f4f7f5;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; }
  main { max-width: 26rem; display: grid; justify-items: center; gap: 14px; }
  svg { width: 56px; height: 56px; }
  h1 { margin: 0; font-size: 1.5rem; }
  p { margin: 0; color: #b8c5bd; }
  a { margin-top: 8px; padding: 12px 22px; border-radius: 999px; background: #f4f7f5; color: #0a120e;
      font-weight: 700; text-decoration: none; }
</style></head><body><main>
<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="8.5" width="7.6" height="15" rx="2" fill="#ffd24c"/>
<rect x="12.2" y="8.5" width="7.6" height="15" rx="2" fill="#a18047"/>
<rect x="21.4" y="8.5" width="7.6" height="15" rx="2" fill="#594d39"/></svg>
<h1>Sin conexión</h1>
<p>Los pronósticos se calculan en el servidor cada pocos minutos, así que sin internet no hay números que enseñar.</p>
<a href="/">Reintentar</a>
</main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(SIN_CONEXION, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  })));
});

// Un aviso de Mis equipos: el navegador lo trae ya descifrado ({titulo, cuerpo, url,
// tag}). La etiqueta es la del partido: el del resultado sustituye al de antes.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { /* sin texto: el aviso genérico */ }
  const url = typeof d.url === "string" && /^\/(?!\/)/.test(d.url) ? d.url : "/";
  e.waitUntil(self.registration.showNotification(d.titulo || "Pronósticos", {
    body: d.cuerpo || "", tag: d.tag || "", renotify: Boolean(d.tag), lang: "es",
    icon: "/icono-192.png", badge: "/insignia-96.png", data: { url },
  }));
});

// Al tocarlo: la web, en la pestaña que ya estuviera abierta si la hay.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
    const abierta = lista.find((c) => new URL(c.url).origin === self.location.origin && "focus" in c);
    if (!abierta) return self.clients.openWindow(url);
    // primero al frente (el permiso para hacerlo dura poco) y luego al partido
    return abierta.focus().then((c) => (c || abierta).navigate(url)).catch(() => null);
  }));
});
