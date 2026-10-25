// El service worker (public/sw.js): sin red, una navegación recibe la página "Sin
// conexión" (503, con su CSP); con red, la respuesta de verdad; y lo que no es una
// navegación no lo toca. Un aviso de Mis equipos se enseña con su texto, su etiqueta y
// adónde lleva (solo a esta web), y al tocarlo se abre ese partido, en la pestaña que
// ya estuviera abierta si la hay. Se corre en un contexto aislado con un "self" de mentira.
// Uso: node pruebas/sw.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const codigo = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const manejadores = {};
let red = null;   // lo que hace fetch: devolver una respuesta o fallar
const enseñados = [], abiertas = [], ventanas = [];
const self = { addEventListener: (tipo, fn) => { manejadores[tipo] = fn; }, skipWaiting() {},
  clients: { claim() {}, matchAll: async () => ventanas, openWindow: async (u) => { abiertas.push(u); } },
  registration: { showNotification: async (titulo, op) => { enseñados.push({ titulo, ...op }); } },
  location: { origin: "https://web.test" } };
vm.runInNewContext(codigo, { self, Response, URL, fetch: (...a) => red(...a) });
assert.ok(manejadores.install && manejadores.activate && manejadores.fetch && manejadores.push && manejadores.notificationclick);

async function pedir(modo) {
  let respuesta = null;
  manejadores.fetch({ request: { mode: modo, url: "https://x/" }, respondWith: (p) => { respuesta = p; } });
  return respuesta && (await respuesta);
}

red = () => Promise.reject(new TypeError("Failed to fetch"));
const sin = await pedir("navigate");
assert.equal(sin.status, 503);
assert.match(sin.headers.get("Content-Security-Policy"), /default-src 'none'/);
assert.match(await sin.text(), /<h1>Sin conexión<\/h1>/);
console.log("sin red: la página «Sin conexión» (503), con su CSP");

red = () => Promise.resolve(new Response("la web", { status: 200 }));
const con = await pedir("navigate");
assert.equal(await con.text(), "la web");
assert.equal(await pedir("cors"), null);
assert.equal(await pedir("no-cors"), null);
console.log("con red, la web; lo que no es una navegación, sin tocar");

// los avisos
async function llega(data) {
  let espera = null;
  manejadores.push({ data, waitUntil: (p) => { espera = p; } });
  await espera;
  return enseñados.pop();
}
const conDatos = (d) => ({ json: () => (typeof d === "string" ? JSON.parse(d) : d) });
let n = await llega(conDatos({ titulo: "Real Madrid – Barcelona", cuerpo: "Hoy a las 14:00", url: "/partido/7", tag: "p7" }));
assert.deepEqual(JSON.parse(JSON.stringify(n)), { titulo: "Real Madrid – Barcelona", body: "Hoy a las 14:00", tag: "p7",
  renotify: true, lang: "es", icon: "/icono-192.png", badge: "/insignia-96.png", data: { url: "/partido/7" } });
for (const url of ["https://otra.web/x", "//otra.web/x", "javascript:alert(1)", 7]) {
  assert.equal((await llega(conDatos({ titulo: "x", url }))).data.url, "/", String(url));
}
n = await llega(null);
assert.equal(n.titulo, "Pronósticos");
assert.equal(n.renotify, false);
assert.equal((await llega(conDatos("{no es json"))).titulo, "Pronósticos");
console.log("aviso: con su texto, su etiqueta y su enlace; un enlace a otra web, o sin datos, lleva a la portada");

async function toca(url) {
  let espera = null, cerrado = false;
  manejadores.notificationclick({ notification: { data: { url }, close: () => { cerrado = true; } },
    waitUntil: (p) => { espera = p; } });
  await espera;
  assert.ok(cerrado);
}
await toca("/partido/7");
assert.deepEqual(abiertas, ["https://web.test/partido/7"]);
const ventana = { url: "https://web.test/#/semana", vista: null, focus: async () => ventana,
  navigate: async (u) => { ventana.vista = u; return ventana; } };
ventanas.push({ url: "https://otra.web/", focus: async () => assert.fail("otra web") }, ventana);
await toca("/");
assert.equal(ventana.vista, "https://web.test/");
assert.equal(abiertas.length, 1);
console.log("al tocarlo: el partido, en la pestaña de la web que ya estaba abierta, o en una nueva");
console.log("sw: OK");
