// Lo que hace el navegador con un aviso al llegar (RFC 8291 y RFC 8188), escrito aparte
// de worker/push.js para comprobarlo desde el otro lado: pruebas/push.mjs y
// pruebas/avisos.mjs descifran con esto lo que manda el Worker.
import { deB64u } from "../worker/push.js";

const te = new TextEncoder();
const hmac = async (clave, datos) => new Uint8Array(await crypto.subtle.sign("HMAC",
  await crypto.subtle.importKey("raw", clave, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), datos));
const unir = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export async function descifrar(cuerpo, uaPrivada, uaPublicaB64, authB64) {
  const sal = cuerpo.slice(0, 16);
  const largo = cuerpo[20];
  const asPublica = cuerpo.slice(21, 21 + largo);
  const cifrado = cuerpo.slice(21 + largo);
  if (new DataView(cuerpo.buffer, cuerpo.byteOffset).getUint32(16) < cifrado.length) throw new Error("registro mayor que rs");
  const uaPublica = deB64u(uaPublicaB64);
  const asClave = await crypto.subtle.importKey("raw", asPublica, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asClave }, uaPrivada, 256));
  const ikm = await hmac(await hmac(deB64u(authB64), ecdh),
    unir(te.encode("WebPush: info\0"), uaPublica, asPublica, [1]));
  const prk = await hmac(sal, ikm);
  const cek = (await hmac(prk, unir(te.encode("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, unir(te.encode("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const claro = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, cifrado));
  let fin = claro.length - 1;
  while (fin >= 0 && claro[fin] === 0) fin--;   // relleno
  if (claro[fin] !== 2) throw new Error("falta el delimitador del último registro");
  return new TextDecoder().decode(claro.slice(0, fin));
}
