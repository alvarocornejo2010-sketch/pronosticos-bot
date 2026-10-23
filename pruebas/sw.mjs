// El service worker (public/sw.js): sin red, una navegación recibe la página "Sin
// conexión" (503, con su CSP); con red, la respuesta de verdad; y lo que no es una
// navegación no lo toca. Se corre en un contexto aislado con un "self" de mentira.
// Uso: node pruebas/sw.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const codigo = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const manejadores = {};
let red = null;   // lo que hace fetch: devolver una respuesta o fallar
const self = { addEventListener: (tipo, fn) => { manejadores[tipo] = fn; }, skipWaiting() {}, clients: { claim() {} } };
vm.runInNewContext(codigo, { self, Response, fetch: (...a) => red(...a) });
assert.ok(manejadores.install && manejadores.activate && manejadores.fetch);

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
console.log("sw: OK");
