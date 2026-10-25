// El cifrado y la firma de los avisos (worker/push.js), sin red: el ejemplo resuelto
// de RFC 8291 (apéndice A) tiene que salir byte a byte; un mensaje cifrado al azar se
// descifra con la clave del navegador; y la firma VAPID se verifica con la pública. Y la
// hora de cada aviso (worker/avisos.js): 2 h antes, o las 22:00 de la noche anterior si
// eso cae de madrugada en Lima.
// Uso: node pruebas/push.mjs
import assert from "node:assert/strict";
import { autorizacionVapid, b64u, cifrar, clavesValidas, clavesVapidNuevas, deB64u } from "../worker/push.js";
import { descifrar } from "./push_descifrar.mjs";
import { endpointValido, momentoPrevio } from "../worker/avisos.js";
import { Reloj } from "../worker/tiempo.js";

const EC = { name: "ECDH", namedCurve: "P-256" };
// una clave privada de los ejemplos, como CryptoKey (con su pública, 04 || x || y)
async function parDe(privada, publica) {
  const p = deB64u(publica);
  const jwk = { kty: "EC", crv: "P-256", d: privada, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)), ext: true };
  return { privateKey: await crypto.subtle.importKey("jwk", jwk, EC, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", p, EC, true, []) };
}

// RFC 8291, apéndice A
const A = {
  texto: "When I grow up, I want to be a watermelon",
  asPublica: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivada: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublica: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivada: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  sal: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  cuerpo: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const par = await parDe(A.asPrivada, A.asPublica);
const cuerpo = await cifrar(A.texto, A.uaPublica, A.auth, { par, sal: deB64u(A.sal) });
assert.equal(b64u(cuerpo), A.cuerpo);
const ua = await parDe(A.uaPrivada, A.uaPublica);
assert.equal(await descifrar(cuerpo, ua.privateKey, A.uaPublica, A.auth), A.texto);
console.log("cifrado: el ejemplo de RFC 8291 sale byte a byte, y se descifra");

// un mensaje cualquiera, con claves al azar (como en producción)
const nav = await crypto.subtle.generateKey(EC, true, ["deriveBits"]);
const navPublica = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", nav.publicKey)));
const navAuth = b64u(crypto.getRandomValues(new Uint8Array(16)));
const mensaje = JSON.stringify({ titulo: "Real Madrid – FC Barcelona", cuerpo: "Hoy a las 14:00 · ñ y tildes" });
const c1 = await cifrar(mensaje, navPublica, navAuth), c2 = await cifrar(mensaje, navPublica, navAuth);
assert.notEqual(b64u(c1), b64u(c2));   // sal y claves nuevas en cada mensaje
assert.equal(await descifrar(c1, nav.privateKey, navPublica, navAuth), mensaje);
assert.ok(clavesValidas(navPublica, navAuth));
assert.ok(!clavesValidas(navAuth, navPublica) && !clavesValidas("", "") && !clavesValidas("no*vale", navAuth));
console.log("cifrado: con claves al azar, cada mensaje distinto y legible solo con la del navegador");

// VAPID: un JWT ES256 que se verifica con la clave pública que recibe el navegador
const vapid = await clavesVapidNuevas();
assert.equal(deB64u(vapid.publica).length, 65);
const ahora = Date.UTC(2026, 9, 25, 12, 0, 0);
const cab = await autorizacionVapid("https://fcm.googleapis.com/fcm/send/abc:def", vapid, "https://ejemplo.dev", ahora);
const m = cab.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
assert.ok(m, cab);
assert.equal(m[4], vapid.publica);
assert.deepEqual(JSON.parse(new TextDecoder().decode(deB64u(m[1]))), { typ: "JWT", alg: "ES256" });
assert.deepEqual(JSON.parse(new TextDecoder().decode(deB64u(m[2]))),
  { aud: "https://fcm.googleapis.com", exp: ahora / 1000 + 12 * 3600, sub: "https://ejemplo.dev" });
const pub = await crypto.subtle.importKey("raw", deB64u(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, deB64u(m[3]),
  new TextEncoder().encode(m[1] + "." + m[2])));
console.log("VAPID: el JWT va para el servicio, caduca en 12 h y se verifica con la clave pública");

// la hora del aviso de antes del partido, en hora de Lima (UTC-5)
const reloj = new Reloj("America/Lima");
const lima = (iso) => Date.parse(iso + "-05:00");
const aviso = (iso) => reloj.iso(momentoPrevio(lima(iso), 120, reloj)).slice(0, 16);
assert.equal(aviso("2026-10-25T20:00"), "2026-10-25T18:00");   // 2 h antes
assert.equal(aviso("2026-10-25T09:00"), "2026-10-25T07:00");   // justo al acabar la madrugada
assert.equal(aviso("2026-10-25T08:59"), "2026-10-24T22:00");   // 6:59: la noche antes
assert.equal(aviso("2026-10-25T06:30"), "2026-10-24T22:00");   // la Premier de las 12:30 de Londres
assert.equal(aviso("2026-10-26T01:00"), "2026-10-25T22:00");   // 23:00: también
assert.equal(aviso("2026-10-26T00:59"), "2026-10-25T22:59");   // 22:59 aún no es madrugada
console.log("hora del aviso: 2 h antes; de 23:00 a 6:59 de Lima, a las 22:00 de la noche anterior");

// solo los servicios de avisos de los navegadores
const aj = { pushPrueba: "" };
for (const e of ["https://fcm.googleapis.com/fcm/send/abc:XYZ", "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
  "https://web.push.apple.com/QGx1", "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA"]) assert.ok(endpointValido(e, aj), e);
for (const e of ["http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com.evil.com/x", "https://evil.com/fcm.googleapis.com/",
  "https://notify.windows.com.evil.com/x", "https://a.b.notify.windows.com/x", "https://web.push.apple.com/a b",
  "https://fcm.googleapis.com/" + "x".repeat(1100), 7, null]) assert.ok(!endpointValido(e, aj), String(e).slice(0, 60));
assert.ok(!endpointValido("http://127.0.0.1:5091/push/x", aj));
assert.ok(endpointValido("http://127.0.0.1:5091/push/x", { pushPrueba: "http://127.0.0.1:5091" }));
console.log("servicios: solo los de Google, Mozilla, Apple y Microsoft (y el de mentira, en las pruebas)");
console.log("push: OK");
