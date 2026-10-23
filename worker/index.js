// pronosticos-bot en Cloudflare Workers. Las mismas rutas que app.py:
//
//   /                 la web: public/index.html, la sirve Cloudflare sin pasar por aquí
//   /api/estado       los partidos con sus números (lo que pinta la web)
//   /api/ligas        qué ancla y qué media usa cada liga
//   /api/validacion   el resultado del backtest
//   /api/registro     el registro en vivo: lo publicado contra lo que pasó
//   /salud            estado de un vistazo
//   /actualizar?token=...&forzar=1   rehacer la pasada sin esperar
//   /validar?token=...[&temporada=N] lanzar el backtest
//   /api/contar       POST: los avisos de visita de la web (visitas.js)
//   /visitas?token=...       el panel de visitas (y /api/visitas?token=..., en JSON)
//
// El trabajo de verdad lo hace el cron (planificador.js), una vez por minuto.

import { COMPETICIONES, ajustes } from "./config.js";
import { Almacen } from "./almacen.js";
import { redondear } from "./modelo.js";
import { SIN_EJECUTAR } from "./validacion.js";
import { REGISTRO_VACIO } from "./registro.js";
import { tick, tocaActualizar } from "./planificador.js";
import { Reloj } from "./tiempo.js";
import { contar, resumenVisitas, htmlVisitas } from "./visitas.js";

// Las mismas cabeceras que pone app.py a sus respuestas JSON (la web y app.js
// llevan las suyas en public/_headers). no-store: el JSON cambia cada pocos
// segundos, y la web tiene que verse nueva justo después de un despliegue.
const CABECERAS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, must-revalidate",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
};

const respuesta = (texto, status = 200) => new Response(texto, {
  status, headers: { ...CABECERAS, "Content-Type": "application/json; charset=utf-8" },
});
const json = (obj, status = 200) => respuesta(JSON.stringify(obj), status);

const ESTADO_VACIO = { estado: "sin_datos", dias: [], total: 0, pendientes: 0, ultima_actualizacion: null,
  plataforma: "cloudflare" };

// Compara en tiempo constante, como hmac.compare_digest: se comparan los hashes,
// que siempre miden lo mismo. null = el secreto no está configurado.
async function tokenValido(recibido, secreto) {
  if (!secreto || secreto.length < 12) return null;
  const cod = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", cod.encode(recibido || "")),
    crypto.subtle.digest("SHA-256", cod.encode(secreto)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function exigirToken(url, env) {
  const ok = await tokenValido(url.searchParams.get("token"), env.UPDATE_SECRET);
  if (ok === null) {
    return json({ error: "falta el secreto UPDATE_SECRET (mínimo 12 caracteres) en Cloudflare: "
      + "Workers & Pages → pronosticos-bot → Settings → Variables and Secrets" }, 503);
  }
  return ok ? null : json({ error: "token inválido" }, 403);
}

async function apiLigas(almacen) {
  const cache = await almacen.cargarCache(["priors", "ligas"]);
  const priors = cache.seccion("priors");
  const ligas = cache.seccion("ligas");
  const r3 = (x) => redondear(x ?? 0, 3) || null;
  const salida = {};
  for (const [nombre, codigo] of Object.entries(COMPETICIONES)) {
    const p = priors[codigo], m = ligas[codigo];
    salida[codigo] = {
      nombre,
      ancla: (p && p.origen) ?? "sin calcular",
      ancla_local: r3(p && p.avg_local),
      ancla_visita: r3(p && p.avg_visita),
      ancla_partidos: (p && p.partidos) ?? null,
      media_usada_local: r3(m && m.avg_local),
      media_usada_visita: r3(m && m.avg_visita),
      partidos_esta_temporada: (m && m.partidos) ?? null,
    };
  }
  return salida;
}

async function actualizar(url, env, almacen) {
  const no = await exigirToken(url, env);
  if (no) return no;
  // &forzar=1 rehace la pasada sin esperar los 25 minutos y vuelve a bajar los
  // calendarios ignorando la caché. La lanza el cron: un Worker no puede tener
  // una petición web abierta el minuto largo que dura una pasada.
  if (["1", "true", "si"].includes(url.searchParams.get("forzar"))) {
    await almacen.escribir([almacen.sentenciaDoc("pedido_forzar", { pedido: new Date().toISOString() })]);
    return json({ mensaje: "actualización forzada: arranca en el próximo minuto" });
  }
  const aj = ajustes(env);
  const resumen = (await almacen.leerDoc("resumen")) || { estado: "sin_datos" };
  const ahora = Date.now();
  const motivo = tocaActualizar(resumen, aj, ahora);
  if (motivo) return json({ mensaje: `actualización en marcha (${motivo}): el cron la sigue cada minuto` });
  const min = (ahora - Date.parse(resumen.ultima_actualizacion)) / 60000;
  return json({ mensaje: `actualización reciente hace ${Math.trunc(min)} min. `
    + `Espera ${Math.trunc(aj.minMinutosActualizacion - min)} min más para evitar gastar cuota de más.` });
}

async function validar(url, env, almacen) {
  const no = await exigirToken(url, env);
  if (no) return no;
  const val = await almacen.leerDoc("validacion_resumen");
  if (val && val.estado === "calculando") return json({ mensaje: "ya hay una validación en curso" });
  const t = url.searchParams.get("temporada");
  const temporada = t !== null && /^\d+$/.test(t) ? Number(t) : null;
  await almacen.escribir([almacen.sentenciaDoc("pedido_validar", { temporada })]);
  return json({ mensaje: "validación iniciada: avanza una liga por minuto cuando la web está al día",
    consulta: "/api/validacion" });
}

// El panel de visitas va ya pintado, sin JavaScript: su CSP solo deja los estilos
// en línea. noindex: no tiene que salir en Google.
async function panelVisitas(url, env, almacen) {
  const no = await exigirToken(url, env);
  if (no) return no;
  const html = htmlVisitas(await resumenVisitas(almacen, env));
  return new Response(html, { headers: { ...CABECERAS, "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; "
      + "form-action 'none'; frame-ancestors 'none'",
    "X-Robots-Tag": "noindex" } });
}

async function apiVisitas(url, env, almacen) {
  const no = await exigirToken(url, env);
  return no || json(await resumenVisitas(almacen, env));
}

async function salud(almacen, env) {
  const e = (await almacen.leerDoc("resumen")) || {};
  return {
    ok: true,
    estado: e.estado ?? "sin_datos",
    total: e.total ?? 0,
    pendientes: e.pendientes ?? 0,
    ultima_actualizacion: e.ultima_actualizacion ?? null,
    hora: new Reloj(ajustes(env).tz).iso(Date.now()),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rutas = {
      "/api/estado": async (almacen) =>
        respuesta((await almacen.leerDocTexto("estado")) ?? JSON.stringify(ESTADO_VACIO)),
      "/api/ligas": async (almacen) => json(await apiLigas(almacen)),
      "/api/validacion": async (almacen) =>
        respuesta((await almacen.leerDocTexto("validacion")) ?? JSON.stringify(SIN_EJECUTAR)),
      "/api/registro": async (almacen) =>
        respuesta((await almacen.leerDocTexto("registro_publico")) ?? JSON.stringify(REGISTRO_VACIO)),
      "/salud": async (almacen) => json(await salud(almacen, env)),
      "/actualizar": (almacen) => actualizar(url, env, almacen),
      "/validar": (almacen) => validar(url, env, almacen),
      "/api/contar": (almacen) => contar(request, env, almacen, CABECERAS),
      "/api/visitas": (almacen) => apiVisitas(url, env, almacen),
      "/visitas": (almacen) => panelVisitas(url, env, almacen),
    };
    const ruta = rutas[url.pathname];
    if (!ruta) return env.ASSETS.fetch(request);   // lo demás: los archivos de public/
    const metodos = url.pathname === "/api/contar" ? ["POST"] : ["GET", "HEAD"];
    if (!metodos.includes(request.method)) {
      return new Response("Método no permitido", { status: 405, headers: { ...CABECERAS, Allow: metodos.join(", ") } });
    }
    try {
      return await ruta(new Almacen(env.DB));
    } catch (e) {
      // El detalle va a los logs, no a la respuesta: puede llevar SQL o rutas internas.
      console.error(`${url.pathname}: ${(e && e.stack) || e}`);
      return json({ error: "error interno" }, 500);
    }
  },

  // El runtime espera a la promesa que devuelve scheduled() (hasta 15 minutos).
  async scheduled(controller, env) {
    const r = await tick(env);
    if (r.tarea) console.log(JSON.stringify(r));
  },
};
