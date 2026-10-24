// Visitas: cuánta gente entra, si vuelve y qué mira, sin cookies y sin guardar
// nada de quién es quién. La web (app.js) manda sus avisos a /api/contar, una
// petición al entrar y otra al irse, y aquí se suman por día de Lima en la tabla
// visitas: una fila por contador (tipo, clave). /visitas?token=... los enseña
// (y /api/visitas?token=..., en JSON). En Render no existe: /api/contar no hace nada.
//
// Lo que manda la web, en una lista:
//   {t: "entrada", v: "nuevo"|"vuelve"|"repite", hace: días, d: "movil"|..., o: host}
//   {t: "partido", id: 123}          abrió el detalle de un partido
//   {t: "liga", c: "PD"}             entró en una liga
//   {t: "busqueda"}                  buscó un equipo
//   {t: "pestana", p: "panorama"}    cambió de pestaña en el móvil
//   {t: "compartir", id: 123}        pulsó Compartir en un partido
//   {t: "favorito"}                  marcó un equipo con la estrella
//   {t: "instalada"}                 instaló la web como app
// "nuevo", "vuelve" y "repite" los decide el navegador, que guarda solo el día de
// su última visita: un visitante es un navegador en un día. hace: días desde esa
// visita. o: el dominio de la página de la que llegó (vacío si no se sabe).
// via: "partido" si entró por un enlace compartido (/partido/123). f: 1 si sigue
// a algún equipo. app: 1 si la abrió desde la app instalada.
//
// Todo lo que llega se coteja con listas fijas: nadie puede meter una clave
// inventada. Y como cada aviso es una escritura en D1 (100.000 al día en el plan
// gratis, las mismas que necesita la actualización), las visitas tienen un tope
// diario (MAX_VISITAS_DIA, 20.000): si alguien machaca /api/contar, se pierden
// las cuentas de ese día, no las predicciones.

import { COMPETICIONES, ajustes } from "./config.js";
import { Reloj, sumarDias } from "./tiempo.js";
import { mismoSitio, resumenCuentas } from "./cuentas.js";

const MAX_CUERPO = 4096;
const MAX_EVENTOS = 30;
// Los bots que ejecutan JavaScript (Googlebot, Bingbot, navegadores sin ventana)
// también mandarían avisos. "bot/" y no "bot": hay móviles CUBOT.
const BOTS = /[a-z]bot\/|headless|lighthouse|crawl|spider|slurp/i;
const DISPOSITIVOS = new Set(["movil", "intermedio", "escritorio"]);
const PESTANAS = new Set(["partidos", "panorama", "ligas"]);
const CODIGOS = new Set(Object.values(COMPETICIONES));

// De dónde llega la gente, por el dominio de la página anterior. WhatsApp y las
// demás apps de mensajería casi nunca lo dicen: lo que llega de ahí cuenta como
// directo. Las apps de Android llegan como com.google.android...: cuentan como Google.
const ORIGENES = [
  ["google", /(^|\.)google\./],
  ["buscador", /(^|\.)(bing|duckduckgo|yahoo|ecosia|yandex|qwant)\.|^search\.brave\.com$/],
  ["whatsapp", /(^|\.)(whatsapp\.com|wa\.me)$/],
  ["facebook", /(^|\.)(facebook\.com|fb\.com|messenger\.com)$/],
  ["instagram", /(^|\.)instagram\.com$/],
  ["x", /^t\.co$|(^|\.)(twitter|x)\.com$/],
  ["telegram", /^t\.me$|(^|\.)telegram\.org$/],
  ["reddit", /(^|\.)reddit\.com$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
  ["youtube", /(^|\.)youtube\.com$/],
];

export function origen(host, propio) {
  const h = String(host || "").toLowerCase();
  if (!h || h === propio) return "directo";
  for (const [nombre, patron] of ORIGENES) if (patron.test(h)) return nombre;
  return "otro";
}

export function tramoVuelta(dias) {
  return dias <= 1 ? "1" : dias <= 7 ? "2-7" : dias <= 30 ? "8-30" : "31+";
}

// Los avisos, sumados por (tipo, clave). Los partidos (abiertos o compartidos)
// solo cuentan si el partido existe (lo comprueba la propia sentencia).
export function contadores(eventos, propio, hora) {
  const sumas = new Map();
  const sumar = (tipo, clave) => {
    const k = tipo + "\u0000" + clave;
    const s = sumas.get(k);
    if (s) s.n += 1; else sumas.set(k, { tipo, clave, n: 1 });
  };
  let entrada = false;
  for (const e of eventos.slice(0, MAX_EVENTOS)) {
    if (!e || typeof e !== "object") continue;
    if (e.t === "entrada" && !entrada) {
      entrada = true;   // una por petición: la web manda una sola al cargar
      sumar("visitas", "");
      sumar("hora", hora);
      if (e.via === "partido") sumar("enlace", "partido");
      if (e.v !== "nuevo" && e.v !== "vuelve") continue;
      sumar("visitantes", e.v);
      if (e.f === 1) sumar("con_favoritos", "");
      if (e.app === 1) sumar("en_app", "");
      if (DISPOSITIVOS.has(e.d)) sumar("dispositivo", e.d);
      sumar("origen", origen(e.o, propio));
      if (e.v === "vuelve" && Number.isSafeInteger(e.hace) && e.hace >= 1) sumar("vuelta", tramoVuelta(e.hace));
    } else if ((e.t === "partido" || e.t === "compartir") && Number.isSafeInteger(e.id) && e.id > 0) {
      sumar(e.t, String(e.id));
    } else if (e.t === "favorito" || e.t === "instalada") {
      sumar(e.t, "");
    } else if (e.t === "liga" && CODIGOS.has(e.c)) {
      sumar("liga", e.c);
    } else if (e.t === "busqueda") {
      sumar("busqueda", "");
    } else if (e.t === "pestana" && PESTANAS.has(e.p)) {
      sumar("pestana", e.p);
    }
  }
  return [...sumas.values()];
}

// Suma n a un contador, solo si el día no ha llegado al tope. Una fila escrita por
// sentencia: la tabla es WITHOUT ROWID, sin índice aparte. "escrituras" lleva la
// cuenta de lo escrito cada día.
const BAJO_TOPE = "COALESCE((SELECT n FROM visitas WHERE dia = ?1 AND tipo = 'escrituras' AND clave = ''), 0) < ?5";
const SUMAR = `INSERT INTO visitas (dia, tipo, clave, n) SELECT ?1, ?2, ?3, ?4 WHERE ${BAJO_TOPE}
  ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + excluded.n`;
const SUMAR_PARTIDO = `INSERT INTO visitas (dia, tipo, clave, n) SELECT ?1, ?2, ?3, ?4 WHERE ${BAJO_TOPE}
  AND EXISTS (SELECT 1 FROM predicciones WHERE id = ?6)
  ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + excluded.n`;

const nada = (cabeceras) => new Response(null, { status: 204, headers: cabeceras });

export async function contar(request, env, almacen, cabeceras, ahora = Date.now()) {
  const url = new URL(request.url);
  // Desde otra web no se cuenta (mismoSitio, en cuentas.js); de un bot, tampoco.
  if (!mismoSitio(request, url)) return nada(cabeceras);
  if (BOTS.test(request.headers.get("User-Agent") || "")) return nada(cabeceras);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_CUERPO) return nada(cabeceras);
  const texto = await request.text();
  if (texto.length > MAX_CUERPO) return nada(cabeceras);
  let eventos;
  try { eventos = JSON.parse(texto); } catch { return nada(cabeceras); }
  if (!Array.isArray(eventos)) return nada(cabeceras);

  const aj = ajustes(env);
  const { fecha, hora } = new Reloj(aj.tz).local(ahora);
  const sumas = contadores(eventos, url.hostname, hora.slice(0, 2));
  if (!sumas.length) return nada(cabeceras);
  const db = almacen.db;
  const sentencias = sumas.map((s) => s.tipo === "partido" || s.tipo === "compartir"
    ? db.prepare(SUMAR_PARTIDO).bind(fecha, s.tipo, s.clave, s.n, aj.maxVisitasDia, Number(s.clave))
    : db.prepare(SUMAR).bind(fecha, s.tipo, s.clave, s.n, aj.maxVisitasDia));
  // la última, para que todas miren el tope de antes de esta petición
  sentencias.push(db.prepare(SUMAR).bind(fecha, "escrituras", "", sumas.length + 1, aj.maxVisitasDia));
  await almacen.escribir(sentencias);
  return nada(cabeceras);
}

// ---------- lo que enseña /visitas ----------

const vacio = () => ({ visitas: 0, visitantes: 0, nuevos: 0, vuelven: 0, partidos: 0, busquedas: 0,
  compartidos: 0, llegadas: 0, estrellas: 0, con_favoritos: 0, instaladas: 0, en_app: 0 });

function sumarDias7(dias) {
  const s = vacio();
  for (const d of dias) for (const k of Object.keys(s)) s[k] += d[k];
  return s;
}

export async function resumenVisitas(almacen, env, ahora = Date.now()) {
  const aj = ajustes(env);
  const reloj = new Reloj(aj.tz);
  const hoy = reloj.local(ahora).fecha;
  const desde30 = sumarDias(hoy, -29), desde7 = sumarDias(hoy, -6);
  const db = almacen.db;
  const [serie, desglose, top] = await almacen.consultar(() => db.batch([
    db.prepare(`SELECT dia, tipo, CASE WHEN tipo IN ('partido', 'compartir') THEN '' ELSE clave END AS c, SUM(n) AS n
      FROM visitas WHERE dia >= ?1 AND tipo IN ('visitas', 'visitantes', 'partido', 'busqueda', 'escrituras',
        'compartir', 'enlace', 'favorito', 'con_favoritos', 'instalada', 'en_app')
      GROUP BY dia, tipo, c`).bind(desde30),
    db.prepare(`SELECT tipo, clave, SUM(n) AS n FROM visitas
      WHERE dia >= ?1 AND tipo IN ('origen', 'dispositivo', 'vuelta', 'hora', 'liga', 'pestana')
      GROUP BY tipo, clave`).bind(desde7),
    db.prepare(`SELECT v.clave AS id, SUM(v.n) AS n, p.liga AS liga, p.utc AS utc,
        json_extract(p.base, '$.local') AS local, json_extract(p.base, '$.visita') AS visita,
        json_extract(p.base, '$.local_corto') AS local_corto, json_extract(p.base, '$.visita_corto') AS visita_corto
      FROM visitas v LEFT JOIN predicciones p ON p.id = CAST(v.clave AS INTEGER)
      WHERE v.dia >= ?1 AND v.tipo = 'partido'
      GROUP BY v.clave ORDER BY n DESC, v.clave LIMIT 15`).bind(desde7),
  ]));

  const dias = [];
  const porDia = new Map();
  for (let i = 29; i >= 0; i--) {
    const d = { dia: sumarDias(hoy, -i), ...vacio(), escrituras: 0 };
    dias.push(d);
    porDia.set(d.dia, d);
  }
  const CAMPO = { visitas: "visitas", partido: "partidos", busqueda: "busquedas", escrituras: "escrituras",
    compartir: "compartidos", enlace: "llegadas", favorito: "estrellas", con_favoritos: "con_favoritos",
    instalada: "instaladas", en_app: "en_app" };
  for (const f of serie.results) {
    const d = porDia.get(f.dia);
    if (!d) continue;
    if (f.tipo === "visitantes") d[f.c === "nuevo" ? "nuevos" : "vuelven"] += f.n;
    else d[CAMPO[f.tipo]] += f.n;
  }
  for (const d of dias) d.visitantes = d.nuevos + d.vuelven;

  const partes = {};
  for (const t of ["origen", "dispositivo", "vuelta", "hora", "liga", "pestana"]) partes[t] = {};
  for (const f of desglose.results) partes[f.tipo][f.clave] = f.n;

  return {
    hoy,
    hora: reloj.local(ahora).hora,
    cuentas: await resumenCuentas(almacen, desde7, ahora),
    tope: aj.maxVisitasDia,
    tope_alcanzado: dias.filter((d) => d.escrituras >= aj.maxVisitasDia).map((d) => d.dia),
    semana: sumarDias7(dias.slice(-7)),
    semana_anterior: sumarDias7(dias.slice(-14, -7)),
    dias,
    desglose: partes,
    partidos: top.results.map((f) => ({
      id: Number(f.id), n: f.n, liga: f.liga ?? null, utc: f.utc ?? null,
      fecha: f.utc ? reloj.local(Date.parse(f.utc)).fecha : null,
      local: f.local_corto || f.local || null, visita: f.visita_corto || f.visita || null,
    })),
  };
}

// ---------- el panel en HTML (sin JavaScript: lo sirve el Worker ya pintado) ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const miles = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const fechaCorta = (f) => `${+f.slice(8, 10)} ${MESES[+f.slice(5, 7) - 1]}`;
const diaSemana = (f) => DIAS[new Date(f + "T00:00:00Z").getUTCDay()];

const NOMBRES = {
  origen: { directo: "Directo o desde una app", google: "Google", buscador: "Otros buscadores", whatsapp: "WhatsApp web",
    facebook: "Facebook", instagram: "Instagram", x: "X / Twitter", telegram: "Telegram", reddit: "Reddit",
    tiktok: "TikTok", youtube: "YouTube", otro: "Otras webs" },
  dispositivo: { movil: "Móvil", intermedio: "Tableta o ventana estrecha", escritorio: "Escritorio" },
  vuelta: { 1: "Al día siguiente", "2-7": "En la misma semana", "8-30": "En el mismo mes", "31+": "Después de un mes" },
  pestana: { partidos: "Partidos", panorama: "Panorama", ligas: "Ligas" },
};
const NOMBRE_LIGA = Object.fromEntries(Object.entries(COMPETICIONES).map(([n, c]) => [c, n]));

function variacion(ahora, antes) {
  if (!antes) return ahora ? "sin datos de la semana anterior" : "";
  const d = Math.round((100 * (ahora - antes)) / antes);
  return (d > 0 ? "+" : d < 0 ? "−" : "±") + Math.abs(d) + "% frente a los 7 días anteriores";
}

const par = (n, texto) => `<p><b>${miles(n)}</b> <span>${esc(texto)}</span></p>`;

function cifra(titulo, valor, nota) {
  return `<div class="cifra"><span class="eti">${esc(titulo)}</span><span class="num">${esc(valor)}</span>`
    + `<span class="nota">${esc(nota)}</span></div>`;
}

// Barras horizontales, de mayor a menor (o en el orden de las claves dadas).
function lista(titulo, valores, nombres, orden = null) {
  const claves = orden || Object.keys(valores).sort((a, b) => valores[b] - valores[a] || a.localeCompare(b));
  const total = claves.reduce((s, k) => s + (valores[k] || 0), 0);
  const max = Math.max(1, ...claves.map((k) => valores[k] || 0));
  const filas = claves.map((k) => {
    const n = valores[k] || 0;
    return `<li><span class="nom">${esc((nombres && nombres[k]) || k)}</span>`
      + `<span class="barra"><i style="width:${((100 * n) / max).toFixed(1)}%"></i></span>`
      + `<span class="val">${miles(n)}</span><span class="pc">${pct(n, total)}</span></li>`;
  }).join("");
  return `<section class="tablero"><h2>${esc(titulo)}</h2>`
    + (total ? `<ul class="barras">${filas}</ul>` : '<p class="vacia">Sin datos esta semana.</p>') + "</section>";
}

function graficoDias(dias) {
  const max = Math.max(1, ...dias.map((d) => d.visitantes));
  const cols = dias.map((d) => {
    const alto = (n) => ((100 * n) / max).toFixed(1);
    const tip = `${diaSemana(d.dia)} ${fechaCorta(d.dia)}: ${d.visitantes} visitantes (${d.nuevos} nuevos, `
      + `${d.vuelven} vuelven), ${d.visitas} visitas, ${d.partidos} partidos abiertos`;
    const lunes = new Date(d.dia + "T00:00:00Z").getUTCDay() === 1;
    return `<div class="col" title="${esc(tip)}"><div class="pila">`
      + `<i class="nuevos" style="height:${alto(d.nuevos)}%"></i><i class="vuelven" style="height:${alto(d.vuelven)}%"></i>`
      + `</div><span class="eje">${lunes ? fechaCorta(d.dia) : ""}</span></div>`;
  }).join("");
  return `<div class="grafico" role="img" aria-label="Visitantes por día, últimos 30 días (máximo ${max})">`
    + `<span class="max">${miles(max)}</span>${cols}</div>`;
}

function graficoHoras(horas) {
  const max = Math.max(1, ...Object.values(horas));
  let cols = "";
  for (let h = 0; h < 24; h++) {
    const k = String(h).padStart(2, "0"), n = horas[k] || 0;
    cols += `<div class="col" title="${k}:00–${k}:59 · ${n} visitas"><div class="pila">`
      + `<i class="vuelven" style="height:${((100 * n) / max).toFixed(1)}%"></i></div>`
      + `<span class="eje">${h % 6 === 0 ? k + "h" : ""}</span></div>`;
  }
  return `<section class="tablero"><h2>A qué hora entran <small>hora de Lima, visitas</small></h2>`
    + `<div class="grafico horas" role="img" aria-label="Visitas por hora del día">${cols}</div></section>`;
}

export function htmlVisitas(r) {
  const s = r.semana, a = r.semana_anterior;
  const tabla = r.dias.slice().reverse().map((d) => `<tr><td>${diaSemana(d.dia)} ${fechaCorta(d.dia)}</td>`
    + `<td>${miles(d.visitantes)}</td><td>${miles(d.nuevos)}</td><td>${miles(d.vuelven)}</td>`
    + `<td>${miles(d.visitas)}</td><td>${miles(d.partidos)}</td><td>${miles(d.busquedas)}</td></tr>`).join("");
  const partidos = r.partidos.length
    ? '<ol class="top">' + r.partidos.map((p) => `<li><span class="nom">${p.local
      ? esc(p.local) + " – " + esc(p.visita) : "Partido " + p.id}</span>`
      + `<span class="liga">${esc(NOMBRE_LIGA[p.liga] || p.liga || "")}${p.fecha ? " · " + fechaCorta(p.fecha) : ""}</span>`
      + `<span class="val">${miles(p.n)}</span></li>`).join("") + "</ol>"
    : '<p class="vacia">Nadie ha abierto un partido esta semana.</p>';
  const hoy = r.dias[r.dias.length - 1];
  const tope = r.tope_alcanzado.length
    ? `<p class="aviso">Días en que se llegó al tope de ${miles(r.tope)} escrituras (y se dejó de contar): `
      + `${r.tope_alcanzado.map(fechaCorta).join(", ")}. Suele ser alguien machacando /api/contar.</p>`
    : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Visitas · Pronósticos</title><style>${CSS}</style></head><body><main>
<header><h1>Visitas</h1><p>Últimos 7 días, hasta hoy ${fechaCorta(r.hoy)} a las ${esc(r.hora)} (hora de Lima)</p></header>
${tope}
<div class="cifras">
${cifra("Visitantes", miles(s.visitantes), variacion(s.visitantes, a.visitantes))}
${cifra("Vuelven", pct(s.vuelven, s.visitantes), `${miles(s.vuelven)} ya habían venido otro día`)}
${cifra("Visitas", miles(s.visitas), (s.visitantes ? (s.visitas / s.visitantes).toFixed(1).replace(".", ",") : "0") + " por visitante")}
${cifra("Partidos abiertos", miles(s.partidos), (s.visitantes ? (s.partidos / s.visitantes).toFixed(1).replace(".", ",") : "0") + " por visitante")}
</div>
<section class="tablero ancho"><h2>Visitantes por día <small>últimos 30 días</small></h2>
<p class="leyenda"><span><i class="nuevos"></i>Nuevos</span><span><i class="vuelven"></i>Vuelven</span></p>
${graficoDias(r.dias)}
<details><summary>Ver la tabla</summary><div class="desliza"><table><thead><tr><th>Día</th><th>Visitantes</th>
<th>Nuevos</th><th>Vuelven</th><th>Visitas</th><th>Partidos abiertos</th><th>Búsquedas</th></tr></thead>
<tbody>${tabla}</tbody></table></div></details></section>
<div class="rejilla">
${lista("De dónde llegan", r.desglose.origen, NOMBRES.origen)}
${lista("Desde qué pantalla", r.desglose.dispositivo, NOMBRES.dispositivo, ["movil", "intermedio", "escritorio"])}
${lista("Cuándo vuelven", r.desglose.vuelta, NOMBRES.vuelta, ["1", "2-7", "8-30", "31+"])}
${graficoHoras(r.desglose.hora)}
${lista("Ligas que más se abren", r.desglose.liga, NOMBRE_LIGA)}
<section class="tablero"><h2>Partidos más abiertos</h2>${partidos}</section>
${lista("Pestañas en el móvil", r.desglose.pestana, NOMBRES.pestana, ["partidos", "panorama", "ligas"])}
<section class="tablero"><h2>Búsquedas</h2><p class="grande">${miles(s.busquedas)}</p>
<p class="vacia">veces que alguien buscó un equipo esta semana</p></section>
<section class="tablero"><h2>Compartir, favoritos y app</h2><div class="pares">
${par(s.compartidos, "veces que se pulsó Compartir en un partido")}
${par(s.llegadas, "visitas que llegaron por un enlace compartido")}
${par(s.estrellas, "equipos marcados con la estrella")}
${par(s.con_favoritos, `visitantes que siguen a algún equipo (${pct(s.con_favoritos, s.visitantes)})`)}
${par(s.instaladas, "veces que se instaló como app")}
${par(s.en_app, `visitantes que entraron desde la app (${pct(s.en_app, s.visitantes)})`)}
</div></section>
<section class="tablero"><h2>Cuentas</h2><div class="pares">
${par(r.cuentas.total, "cuentas en total")}
${par(r.cuentas.creadas, "cuentas creadas esta semana (también las ya borradas)")}
${par(r.cuentas.activas, "cuentas que entraron esta semana")}
${par(r.cuentas.con_equipos, "cuentas que siguen a algún equipo")}
</div></section>
</div>
<footer><h2>Cómo se cuenta</h2><ul>
<li>Sin cookies y sin guardar IPs: cada navegador recuerda solo el día de su última visita. Un visitante es un navegador en un día; quien entra desde el móvil y el ordenador cuenta dos veces, y quien borra los datos del navegador vuelve a ser nuevo.</li>
<li>Una visita es cada vez que se carga la página. "Vuelven" son los que ya habían entrado otro día.</li>
<li>WhatsApp y las demás apps casi nunca dicen de dónde viene la gente: lo que se comparte por ahí sale como "Directo o desde una app".</li>
<li>Los bots no cuentan. Tope diario: ${miles(r.tope)} escrituras en la base (hoy van ${miles(hoy.escrituras)}), para que nadie pueda gastar las que necesitan las predicciones.</li>
</ul></footer></main></body></html>`;
}

// Oscuro, como la web, sin fuentes de fuera. El oro es la probabilidad en la web:
// aquí las barras van en verde.
const CSS = `
:root { --fondo: #070d0a; --panel: #111a15; --linea: #1f2b25; --tinta: #f4f7f5; --tinta-2: #b8c5bd;
  --tinta-3: #87968c; --nuevos: #4f8a72; --vuelven: #a6e3c9; --aviso: #e5484d; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--fondo); color: var(--tinta); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 16px; }
h1 { margin: 0; font-size: 1.9rem; line-height: 1.1; }
h2 { margin: 0 0 12px; font-size: 1rem; text-wrap: balance; }
h2 small, header p { color: var(--tinta-3); font-weight: 400; font-size: .85rem; }
header p { margin: 4px 0 0; }
.cifras { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.cifra, .tablero { background: var(--panel); border: 1px solid var(--linea); border-radius: 14px; padding: 16px; min-width: 0; }
.cifra { display: grid; gap: 2px; }
.eti { color: var(--tinta-2); font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; }
.num, .grande { font-size: 2.2rem; font-weight: 700; line-height: 1.1; margin: 0; }
.nota, .vacia { color: var(--tinta-3); font-size: .85rem; margin: 0; }
.rejilla { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.barras, .top { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.barras li { display: grid; grid-template-columns: minmax(0, 1fr) 30% 3.5em 3em; gap: 8px; align-items: center; }
.nom { overflow-wrap: anywhere; }
.barra { height: 8px; background: var(--linea); border-radius: 4px; overflow: hidden; }
.barra i { display: block; height: 100%; background: var(--vuelven); border-radius: 4px; }
.val, .pc { text-align: right; }
.pc { color: var(--tinta-3); font-size: .85rem; }
.top li { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; }
.top .liga { grid-column: 1; color: var(--tinta-3); font-size: .8rem; }
.top .val { grid-row: 1 / span 2; grid-column: 2; align-self: center; font-weight: 700; }
.leyenda { display: flex; gap: 16px; margin: 0 0 8px; color: var(--tinta-2); font-size: .85rem; }
.leyenda i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.nuevos { background: var(--nuevos); }
.vuelven { background: var(--vuelven); }
.grafico { position: relative; display: flex; gap: 2px; height: 180px; padding-top: 18px; }
.grafico.horas { height: 120px; padding-top: 0; }
.grafico .max { position: absolute; top: 0; left: 0; color: var(--tinta-3); font-size: .75rem; }
.col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.pila { flex: 1; display: flex; flex-direction: column-reverse; gap: 2px; border-bottom: 1px solid var(--linea); }
.pila i { display: block; border-radius: 3px 3px 0 0; min-height: 0; }
.pila i.nuevos { border-radius: 0; }
.eje { height: 18px; font-size: .7rem; color: var(--tinta-3); white-space: nowrap; overflow: visible; }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--tinta-2); }
.desliza { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: .85rem; }
th, td { padding: 4px 8px; text-align: right; border-bottom: 1px solid var(--linea); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--tinta-2); font-weight: 600; }
.pares { display: grid; gap: 8px; }
.pares p { margin: 0; display: grid; grid-template-columns: 4.5em minmax(0, 1fr); gap: 8px; align-items: baseline; }
.pares b { font-size: 1.4rem; text-align: right; }
.pares span { color: var(--tinta-2); font-size: .9rem; }
.aviso { margin: 0; padding: 12px 16px; border: 1px solid var(--aviso); border-radius: 14px; }
footer { color: var(--tinta-2); font-size: .85rem; }
footer h2 { font-size: .9rem; }
footer ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; max-width: 75ch; }
`;
