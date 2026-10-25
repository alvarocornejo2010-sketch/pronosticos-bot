// Revisión de la interfaz con un navegador de verdad (Playwright), contra el Worker
// local ya lleno con la API falsa (lo deja así e2e.sh). En 13 vistas y 7 anchos,
// de 360 a 1920 px, busca:
//   - texto que se sale de su caja sin recortarse (scrollWidth > clientWidth);
//   - piezas de una misma fila que se pisan (la hora, el escudo, los números...);
//   - errores de JavaScript;
// que la imagen para historias sale (un PNG de 1080x1920 al menú de compartir), que
// Mis equipos ofrece los avisos (y que activarlos y quitarlos funciona contra el Worker,
// con el servicio de avisos del navegador de mentira: sin red, Chromium no puede
// suscribirse), que el detalle de un partido de un equipo seguido los propone y que sus
// nombres enlazan con la página de cada equipo, y pasa axe-core (accesibilidad) por la
// semana, Mis equipos, el detalle, la tabla y la página de un equipo, en el móvil y en
// escritorio. Así se vio en oct 2026 que la fecha se metía bajo el escudo y
// que "Seguir" no cabía en el móvil.
// Uso: node pruebas/interfaz.mjs PUERTO_WORKER PUERTO_API
// Las fuentes vienen de Google; sin red, FUENTES=carpeta con fuentes.css, mapa.txt
// (URL de cada woff2 y su archivo) y los woff2.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const W = `http://127.0.0.1:${process.argv[2]}`;
const API = `http://127.0.0.1:${process.argv[3]}`;   // su /push/... es el servicio de avisos de mentira (PUSH_PRUEBA)
const AXE = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const FUENTES = process.env.FUENTES;
const mapa = FUENTES ? Object.fromEntries(fs.readFileSync(path.join(FUENTES, "mapa.txt"), "utf8").trim().split("\n")
  .map((l) => l.split(" "))) : null;

const estado = await (await fetch(W + "/api/estado")).json();
const conPartidos = estado.dias.filter((d) => d.partidos.length);
if (conPartidos.length < 3) throw new Error("hacen falta partidos en al menos 3 días");
// los equipos que más juegan, para "Mis equipos"
const veces = new Map();
for (const d of estado.dias) for (const p of d.partidos) for (const e of [p.local, p.visita]) veces.set(e, (veces.get(e) || 0) + 1);
const FAVORITOS = [...veces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e);
// un equipo de LaLiga para su página (tiene tabla, fuerza y forma)
const EQUIPO = estado.dias.flatMap((d) => d.partidos).find((p) => p.liga_codigo === "PD").local_id;

const VISTAS = [
  ["semana", "#/semana"], ["día", "#/dia/" + conPartidos[1].fecha], ["liga", "#/liga/PD"],
  ["liga por claros", "#/liga/PD", "claros"], ["semana por claros", "#/semana", "claros"],
  ["día por reñidos", "#/dia/" + conPartidos[2].fecha, "renidos"], ["búsqueda", "#/semana", "buscar"],
  ["mis equipos", "#/favoritos"], ["mis equipos por claros", "#/favoritos", "claros"],
  ["detalle", "#/dia/" + conPartidos[1].fecha, "abrir"], ["tabla", "#/liga/PD/tabla", "tabla"],
  ["detalle de mis equipos", "#/favoritos", "abrir-fav"], ["equipo", "#/equipo/" + EQUIPO, "equipo"],
];
const ANCHOS = [[360, 780], [390, 844], [768, 1024], [1024, 768], [1180, 820], [1440, 900], [1920, 1080]];
const AXE_EN = new Set(["390/semana", "390/detalle", "390/tabla", "390/mis equipos", "390/detalle de mis equipos",
  "1440/semana", "1440/detalle", "1440/tabla", "1440/mis equipos", "1440/detalle de mis equipos", "390/equipo", "1440/equipo"]);

// El servicio de avisos del navegador, de mentira: una suscripción con claves de verdad
// (el Worker comprueba que son un punto de la curva) y una dirección del servicio de
// mentira, y el permiso concedido al pedirlo.
function avisosDeMentira(api) {
  let permiso = "default", sub = null;
  const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const nueva = async (clave) => {
    const par = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const keys = { p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey))),
      auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
    const endpoint = api + "/push/interfaz-" + keys.auth;
    return { endpoint, options: { applicationServerKey: clave.buffer }, toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => { sub = null; return true; } };
  };
  const pm = { getSubscription: async () => sub, subscribe: async (o) => (sub = await nueva(o.applicationServerKey)) };
  const reg = { pushManager: pm };
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(reg),
    getRegistration: async () => reg, register: async () => reg } });
  Object.defineProperty(Notification, "permission", { get: () => permiso, configurable: true });
  Notification.requestPermission = async () => (permiso = "granted");
}

// Lo que se sale y lo que se pisa (se corre dentro de la página).
function revisar() {
  const fuera = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" || cs.textOverflow === "ellipsis" || cs.display === "inline") continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && el.textContent.trim()) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > innerHeight * 3) continue;
      fuera.push((typeof el.className === "string" && el.className ? "." + el.className.split(" ").join(".") : el.tagName)
        + " [" + el.textContent.trim().replace(/\s+/g, " ").slice(0, 40) + "] " + el.clientWidth + "<" + el.scrollWidth);
    }
  }
  const caja = (el) => {   // lo que pinta: la caja del elemento y las de sus hijos
    const rs = [el, ...el.querySelectorAll("*")].map((h) => h.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    return rs.length ? { l: Math.min(...rs.map((r) => r.left)), r: Math.max(...rs.map((r) => r.right)),
      t: Math.min(...rs.map((r) => r.top)), b: Math.max(...rs.map((r) => r.bottom)) } : null;
  };
  const pisadas = [];
  for (const fila of document.querySelectorAll(".fila, .prox, .claro, .res, .dia-celda, .liga-fila, .det-cab, .tabla-liga tr, .eq-cab, .eq-fz")) {
    const hijos = [...fila.children].filter((h) => getComputedStyle(h).display !== "none" && getComputedStyle(h).visibility !== "hidden");
    const cajas = hijos.map(caja);
    for (let i = 0; i < hijos.length; i++) for (let j = i + 1; j < hijos.length; j++) {
      const a = cajas[i], c = cajas[j];
      if (!a || !c) continue;
      const x = Math.min(a.r, c.r) - Math.max(a.l, c.l), y = Math.min(a.b, c.b) - Math.max(a.t, c.t);
      if (x > 1 && y > 1) pisadas.push(fila.className + ": " + hijos[i].className + " / " + hijos[j].className + " (" + Math.round(x) + "px)");
    }
  }
  return { fuera: [...new Set(fuera)].slice(0, 15), pisadas: [...new Set(pisadas)].slice(0, 15) };
}

const navegador = await chromium.launch();
let fallos = 0;
const fallo = (txt) => { fallos++; console.log("  ✗ " + txt); };
for (const [ancho, alto] of ANCHOS) {
  const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, timezoneId: "America/Lima",
    serviceWorkers: "block", deviceScaleFactor: ancho < 500 ? 2 : 1, isMobile: ancho < 500, hasTouch: ancho < 500 });
  if (FUENTES) {
    await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ contentType: "text/css",
      body: fs.readFileSync(path.join(FUENTES, "fuentes.css"), "utf8") }));
    await ctx.route("https://fonts.gstatic.com/**", (r) => {
      const f = mapa[r.request().url()];
      return f ? r.fulfill({ contentType: "font/woff2", body: fs.readFileSync(path.join(FUENTES, f)) }) : r.abort();
    });
  }
  await ctx.route("https://crests.football-data.org/**", (r) => r.abort());   // sin escudo: el monograma
  await ctx.addInitScript((fav) => {   // también corre en about:blank, que no tiene localStorage
    if (location.protocol.startsWith("http")) localStorage.setItem("pronosticos.favoritos", JSON.stringify(fav));
    // sin ventana, Chromium da siempre los avisos por bloqueados ("denied"): aquí, sin
    // decidir, como para quien entra por primera vez
    Object.defineProperty(Notification, "permission", { get: () => "default", configurable: true });
  }, FAVORITOS);
  const p = await ctx.newPage();
  const errores = [];
  p.on("pageerror", (e) => errores.push(e.message));
  for (const [nombre, hash, extra] of VISTAS) {
    await p.goto("about:blank");   // cada vista desde cero: cambiar solo el hash no recarga (la búsqueda seguiría puesta)
    await p.goto(W + "/" + hash);
    await p.waitForSelector(extra === "tabla" ? ".tabla-liga" : ".fila", { timeout: 15000 });
    if (hash === "#/favoritos") await p.waitForSelector(".avisos-tarjeta", { timeout: 15000 });
    if (extra === "tabla") await p.waitForFunction(() => !document.querySelector(".tabla-sim"), null, { timeout: 30000 });
    if (extra === "equipo") {
      // su ficha entera: la fuerza (de /api/equipo) y la proyección ya simulada
      await p.waitForFunction(() => document.querySelector(".eq-fuerza") && document.querySelector(".eq-proy b"), null, { timeout: 30000 });
      if (await p.locator(".eq-forma li").count() !== 5) fallo(`${ancho}px: la página del equipo no trae su forma`);
    }
    await p.evaluate(() => document.fonts.ready);
    if (extra === "claros" || extra === "renidos") {
      const b = p.locator(`[data-orden="${extra}"]:visible`).first();
      if (await b.count()) await b.click(); else await p.evaluate((o) => { orden = o; render(); }, extra);
    }
    if (extra === "buscar") await p.evaluate(() => { busqueda = "a"; render(); });
    if (extra === "abrir" || extra === "abrir-fav") await p.locator(".partido:not(.pendiente) .fila").first().click();
    if (extra === "abrir" && !(await p.locator('.det-eq a.n[href^="#/equipo/"]').count())) {
      fallo(`${ancho}px: los nombres del detalle no enlazan con la página de su equipo`);
    }
    if (extra === "abrir-fav" && !(await p.locator(".det-avisos [data-avisos=activar]").count())) {
      fallo(`${ancho}px: el detalle de un partido de Mis equipos no propone los avisos`);
    }
    if (nombre === "mis equipos" && ancho === 1440) {
      // activar y quitar, contra el Worker de verdad
      await p.evaluate(avisosDeMentira, API);
      const tarjeta = p.locator(".avisos-tarjeta");
      await tarjeta.locator("[data-avisos=activar]").click();
      await tarjeta.locator("h2", { hasText: "Avisos activados en este aparato" }).waitFor({ timeout: 15000 });
      await tarjeta.locator("[data-avisos=desactivar]").click();
      await tarjeta.locator("[data-avisos=activar]").waitFor({ timeout: 15000 });
    }
    if (extra === "abrir" && (ancho === 390 || ancho === 1440)) {
      // la imagen para historias: lo que llegaría al menú de compartir del sistema
      await p.evaluate(() => {
        navigator.canShare = () => true;
        navigator.share = async ({ files }) => {
          const b = await createImageBitmap(files[0]);
          window.__imagen = { tipo: files[0].type, nombre: files[0].name, bytes: files[0].size, w: b.width, h: b.height };
        };
      });
      await p.locator("[data-imagen]").first().click();
      await p.waitForFunction(() => window.__imagen, null, { timeout: 15000 });
      const im = await p.evaluate(() => window.__imagen);
      if (im.tipo !== "image/png" || im.w !== 1080 || im.h !== 1920 || im.bytes < 30000 || !/^pronostico-[a-z0-9-]+\.png$/.test(im.nombre)) {
        fallo(`${ancho}px: la imagen para historias no es la esperada: ${JSON.stringify(im)}`);
      }
    }
    await p.waitForTimeout(200);
    const r = await p.evaluate(revisar);
    for (const x of r.fuera) fallo(`${ancho}px, ${nombre}: se sale ${x}`);
    for (const x of r.pisadas) fallo(`${ancho}px, ${nombre}: se pisan ${x}`);
    if (AXE_EN.has(`${ancho}/${nombre}`)) {
      await p.evaluate(AXE);   // por evaluate: la CSP de la web no deja un <script> en línea
      const v = await p.evaluate(async () => (await axe.run(document, { resultTypes: ["violations"] })).violations
        .map((x) => `${x.impact} ${x.id} (${x.nodes.length}): ${x.nodes[0].target.join(" ")}`));
      for (const x of v) fallo(`${ancho}px, ${nombre}: accesibilidad ${x}`);
    }
  }
  for (const e of errores) fallo(`${ancho}px: error de JavaScript: ${e}`);
  await ctx.close();
}
await navegador.close();
console.log(`interfaz: ${VISTAS.length} vistas × ${ANCHOS.length} anchos, axe en ${AXE_EN.size}: ${fallos ? fallos + " fallos" : "todo bien"}`);
process.exit(fallos ? 1 : 0);
