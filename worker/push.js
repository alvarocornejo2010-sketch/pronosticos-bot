// Web Push sin dependencias, con WebCrypto: el cifrado del mensaje (RFC 8291, con el
// formato aes128gcm de RFC 8188) y la firma VAPID que identifica a esta web ante el
// servicio de avisos del navegador (RFC 8292). Lo usa avisos.js; lo prueba
// pruebas/push.mjs con el ejemplo resuelto de RFC 8291 (apéndice A).
//
// Cada navegador manda sus avisos por un servicio suyo (Google, Mozilla, Apple,
// Microsoft): la web le da al navegador la clave pública VAPID, el navegador da una
// dirección (endpoint) y dos claves suyas (p256dh, auth), y para avisarle se hace un
// POST a esa dirección con el mensaje cifrado para esas claves y firmado con la VAPID.
// El servicio no puede leer el mensaje.

const te = new TextEncoder();

export function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deB64u(texto) {
  const s = atob(String(texto).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function juntar(...partes) {
  const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}

// HKDF de SHA-256 (RFC 5869) con WebCrypto: extraer con la sal y expandir con info.
const bits = async (clave, sal, info, n) =>
  new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sal, info }, clave, n));
async function hkdf(secreto, sal, info, n) {
  return bits(await crypto.subtle.importKey("raw", secreto, "HKDF", false, ["deriveBits"]), sal, info, n);
}

const INFO_CLAVE = te.encode("WebPush: info\0");
const INFO_CEK = te.encode("Content-Encoding: aes128gcm\0");
const INFO_NONCE = te.encode("Content-Encoding: nonce\0");
const TAM_REGISTRO = 4096;

// Las claves de una suscripción: p256dh, un punto P-256 sin comprimir (65 bytes), y
// auth, 16 bytes, las dos en base64url. false si no lo son.
export function clavesValidas(p256dh, auth) {
  try {
    const p = deB64u(p256dh), a = deB64u(auth);
    return p.length === 65 && p[0] === 4 && a.length === 16;
  } catch { return false; }
}

// El cuerpo del POST: el mensaje cifrado para esa suscripción, en un solo registro
// aes128gcm. Cada mensaje lleva su propio par de claves y su sal, al azar; `fijo`
// ({ par, sal }) solo sirve para reproducir el ejemplo de RFC 8291.
export async function cifrar(mensaje, p256dh, auth, fijo = null) {
  const uaPublica = deB64u(p256dh), secreto = deB64u(auth);
  const par = fijo ? fijo.par : await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  const uaClave = await crypto.subtle.importKey("raw", uaPublica, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaClave }, par.privateKey, 256));
  const sal = fijo ? fijo.sal : crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(ecdh, secreto, juntar(INFO_CLAVE, uaPublica, asPublica), 256);
  const clave = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = await bits(clave, sal, INFO_CEK, 128);
  const nonce = await bits(clave, sal, INFO_NONCE, 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const claro = juntar(te.encode(mensaje), Uint8Array.of(2));   // 2: el último (y único) registro
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, claro));
  const cabecera = new Uint8Array(16 + 4 + 1 + asPublica.length);
  cabecera.set(sal, 0);
  new DataView(cabecera.buffer).setUint32(16, TAM_REGISTRO);
  cabecera[20] = asPublica.length;
  cabecera.set(asPublica, 21);
  return juntar(cabecera, cifrado);
}

// Un par de claves VAPID nuevo: la privada en JWK (para firmar) y la pública en
// base64url (la que se le da al navegador).
export async function clavesVapidNuevas() {
  const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", par.privateKey);
  return { jwk: { kty, crv, x, y, d }, publica: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey))) };
}

// La cabecera Authorization de VAPID para el servicio de esa dirección: un JWT ES256
// con el servicio (aud), hasta cuándo vale (como mucho 24 h) y un contacto (sub). La
// firma de WebCrypto ya viene como la quiere JWS (r y s, 64 bytes).
export async function autorizacionVapid(endpoint, vapid, contacto, ahoraMs, horas = 12) {
  const aud = new URL(endpoint).origin;
  const cab = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const datos = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(ahoraMs / 1000) + horas * 3600, sub: contacto })));
  const k = await crypto.subtle.importKey("jwk", vapid.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, te.encode(cab + "." + datos)));
  return `vapid t=${cab}.${datos}.${b64u(firma)}, k=${vapid.publica}`;
}
