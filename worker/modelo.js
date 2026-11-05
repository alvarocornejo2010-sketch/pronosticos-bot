// El modelo, el mismo de app.py: fuerzas de ataque y defensa de cada equipo
// con un filtro de Kalman de sus goles y sus tiros a puerta (ajustarFuerzas, con
// casarTiros y filasTiros para los tiros), Poisson con la corrección de
// Dixon-Coles para el 1X2 (RHO_EMPATES) y los mercados de goles con el total de
// goles esperados acercado a la media (ENCOGER_TOTAL) y el 0 de cada equipo algo más
// bajo (MENOS_CEROS).
//
// Cada función hace las mismas operaciones y en el mismo orden que su gemela de
// Python, así que salen los mismos números. test_paridad.py lo comprueba con
// miles de casos: si cambias algo aquí, cámbialo también en app.py.

import {
  ATAQUE_DESCENDIDO, ATAQUE_RECIEN_LLEGADO, DEFENSA_DESCENDIDO, DEFENSA_RECIEN_LLEGADO, DIVISION_TIROS,
  ENCOGER_TOTAL, ESCALA_CHAMPIONS, EXPONENTE_FUERZA_CHAMPIONS, EXPONENTE_FUERZAS, K_HISTORIAL_CHAMPIONS, K_LIGA,
  KALMAN_DERIVA, KALMAN_INICIO, KALMAN_NUEVO, KALMAN_TEMPORADA, LIMITE_GOLES, MENOS_CEROS, PESO_TIROS,
  PRIOR_AVG_LOCAL, PRIOR_AVG_VISITA, RHO_EMPATES,
} from "./config.js";

// ------------------------------------------
// Redondeo como round() de Python
// ------------------------------------------
// round() de Python redondea el valor binario exacto y, en un empate exacto, al
// par. Math.round sube los empates y x*100 arrastra error, así que hace falta
// esto para que los porcentajes coincidan cifra a cifra.
const POTENCIAS = [1, 10, 100, 1000, 10000, 100000];

export function redondear(x, cifras = 0) {
  if (!Number.isFinite(x)) return x;
  const f = POTENCIAS[cifras] ?? 10 ** cifras;
  const t = x * f;
  const frac = t - Math.floor(t);
  // lejos de un empate el entero más cercano no tiene ambigüedad
  if (Math.abs(frac - 0.5) > 1e-6) return Math.round(t) / f;
  return redondearExacto(x, cifras);
}

function redondearExacto(x, cifras) {
  const a = Math.abs(x);
  // toFixed(100) da la expansión decimal exacta del double para cualquier
  // valor de esta app (sus decimales binarios terminan mucho antes)
  const s = a.toFixed(100);
  const p = s.indexOf(".");
  const entero = s.slice(0, p);
  const dec = s.slice(p + 1);
  const cabeza = dec.slice(0, cifras);
  const cola = dec.slice(cifras);
  let subir;
  if (cola[0] > "5") subir = true;
  else if (cola[0] < "5") subir = false;
  else if (/[1-9]/.test(cola.slice(1))) subir = true;
  else {
    // empate exacto: al par, como Python
    const ultima = cifras > 0 ? cabeza[cifras - 1] : entero[entero.length - 1];
    subir = Number(ultima) % 2 === 1;
  }
  let n = BigInt(entero + cabeza);
  if (subir) n += 1n;
  const r = Number(n) / 10 ** cifras;
  return x < 0 ? -r : r;
}

// Suma de floats como sum() de Python 3.12+, que compensa el error (Neumaier).
// Se puede llevar sumando de a poco (y guardar s y c entre medias): el
// resultado es el mismo que sumar la lista entera de una vez.
export class Suma {
  constructor(s = 0, c = 0) {
    this.s = s; this.c = c;
  }

  add(v) {
    const t = this.s + v;
    this.c += Math.abs(this.s) >= Math.abs(v) ? (this.s - t) + v : (v - t) + this.s;
    this.s = t;
  }

  valor() {
    return this.s + this.c;
  }
}

export function sumar(valores) {
  const s = new Suma();
  for (const v of valores) s.add(v);
  return s.valor();
}

// ------------------------------------------
// Poisson
// ------------------------------------------
const LOG_FACTORIAL = [0];
for (let k = 1; k <= 64; k++) LOG_FACTORIAL.push(LOG_FACTORIAL[k - 1] + Math.log(k));

// Como scipy.stats.poisson.pmf: exp(k·log(mu) − log(k!) − mu).
export function pmfPoisson(k, mu) {
  if (mu === 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(mu) - LOG_FACTORIAL[k] - mu);
}

// Las de 0 a limite goles de una vez (el log se calcula una sola vez; los
// valores son los mismos que pmfPoisson uno a uno).
function pmfs(mu, limite, out = new Float64Array(limite + 1)) {
  if (mu === 0) {
    out.fill(0);
    out[0] = 1;
    return out;
  }
  const lm = Math.log(mu);
  for (let k = 0; k <= limite; k++) out[k] = Math.exp(k * lm - LOG_FACTORIAL[k] - mu);
  return out;
}

// Memoria de trabajo para la rejilla de siempre (LIMITE_GOLES): las funciones
// son síncronas, así que se puede reutilizar entre llamadas sin reservar nada.
const PL = new Float64Array(LIMITE_GOLES + 1);
const PV = new Float64Array(LIMITE_GOLES + 1);
const REJILLA = new Float64Array((LIMITE_GOLES + 1) ** 2);
const pc = (v) => redondear(v * 100, 2);

// ------------------------------------------
// Fuerzas: ataque y defensa ajustados por el rival
// ------------------------------------------
// ------------------------------------------
// exp y log exactas (exp_exacto y log_exacto en app.py)
// ------------------------------------------
// Con sumas, productos y divisiones (y la potencia de 2, exacta): Math.exp y math.exp
// de Python pueden diferir en el último bit, y el filtro de Kalman encadena cientos.
const LN2 = 0.6931471805599453;
const LN2_ALTO = 0.6931471803691238;
const LN2_BAJO = 1.9082149292705877e-10;

// 2^-64 a 2^64, multiplicando de dos en dos: exactas (como ldexp en Python)
const POT2 = new Float64Array(129);
POT2[64] = 1.0;
for (let k = 1; k <= 64; k++) { POT2[64 + k] = POT2[63 + k] * 2.0; POT2[64 - k] = POT2[65 - k] * 0.5; }

export function expExacto(x) {
  let n = Math.floor(x / LN2 + 0.5);
  const r = (x - n * LN2_ALTO) - n * LN2_BAJO;
  let s = 1.0;
  for (let k = 13; k > 0; k--) s = 1.0 + s * r / k;
  if (n >= -64 && n <= 64) return s * POT2[n + 64];
  while (n > 0) { s *= 2.0; n -= 1; }
  while (n < 0) { s *= 0.5; n += 1; }
  return s;
}

export function logExacto(x) {
  let e = 0;
  while (x > 1.4142135623730951) { x *= 0.5; e += 1; }
  while (x < 0.7071067811865476) { x *= 2.0; e -= 1; }
  const z = (x - 1.0) / (x + 1.0);
  const z2 = z * z;
  let s = 0.0;
  for (let k = 29; k > 0; k -= 2) s = 1.0 / k + z2 * s;
  return 2.0 * z * s + e * LN2;
}

// ------------------------------------------
// Tiros a puerta (football-data.co.uk)
// ------------------------------------------
// El nombre de un equipo sin mayúsculas ni nada que no sea letra o número (clave_tiros).
export const claveTiros = (nombre) => nombre.toLowerCase().replace(/[^a-z0-9]/g, "");

const entero = (texto) => {
  const t = texto.trim();
  return /^[0-9]{1,6}$/.test(t) ? Number(t) : null;
};

const MS_DIA_TIROS = 86400000;

// Los primeros n campos de una línea separada por comas, sin mirar el resto (los CSV de
// verdad traen ~100 columnas, casi todas de cuotas): como linea.split(",", n)[:n] en Python.
function campos(linea, n) {
  const out = [];
  let desde = 0;
  while (out.length < n) {
    const i = linea.indexOf(",", desde);
    if (i < 0) { out.push(linea.slice(desde)); break; }
    out.push(linea.slice(desde, i));
    desde = i + 1;
  }
  return out;
}

// [[día, local, visita, gl, gv, tiros a puerta local, visita], ...] de un CSV de
// resultados de football-data.co.uk (filas_tiros en app.py, mismas reglas).
export function filasTiros(texto) {
  const lineas = texto.replace(/\r/g, "").split("\n");
  const cab = lineas[0].split(",").map((c) => c.trim().replace(/^﻿/, ""));
  const col = new Map();
  cab.forEach((c, i) => { if (!col.has(c)) col.set(c, i); });
  const indice = (...nombres) => {
    for (const n of nombres) if (col.has(n)) return col.get(n);
    return null;
  };
  const iF = indice("Date"), iL = indice("HomeTeam", "Home"), iV = indice("AwayTeam", "Away");
  const iGl = indice("FTHG", "HG"), iGv = indice("FTAG", "AG"), iPl = indice("HST"), iPv = indice("AST");
  if ([iF, iL, iV, iGl, iGv].includes(null)) return [];
  const necesita = Math.max(iF, iL, iV, iGl, iGv);
  const hasta = Math.max(necesita, iPl ?? 0, iPv ?? 0) + 1;
  const out = [];
  for (let r = 1; r < lineas.length; r++) {
    const c = campos(lineas[r], hasta);
    if (c.length <= necesita) continue;
    const partes = c[iF].trim().split("/");
    const gl = entero(c[iGl]), gv = entero(c[iGv]);
    const local = claveTiros(c[iL]), visita = claveTiros(c[iV]);
    if (partes.length !== 3 || gl === null || gv === null || !local || !visita) continue;
    const d = entero(partes[0]), m = entero(partes[1]);
    let a = entero(partes[2]);
    if (d === null || m === null || a === null || m < 1 || m > 12 || d < 1 || d > 31) continue;
    if (a < 100) a += 2000;
    if (a < 1 || a > 9999) continue;
    const ms = Date.UTC(a, m - 1, d);
    const f = new Date(ms);
    if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) continue;   // 31/02
    const pl = iPl !== null && iPl < c.length ? entero(c[iPl]) : null;
    const pv = iPv !== null && iPv < c.length ? entero(c[iPv]) : null;
    out.push([Math.floor(ms / MS_DIA_TIROS), local, visita, gl, gv, pl, pv]);
  }
  return out;
}

// La lista de partidos compactos con los tiros a puerta de cada uno cuando
// football-data.co.uk los trae (casar_tiros en app.py, mismo orden): cada equipo toma
// el nombre que más veces le dan los partidos que solo pueden ser uno (mismo marcador el
// mismo día, o uno antes o después), y cada partido, el del mismo cruce y marcador más
// cercano a menos de 4 días.
export function casarTiros(partidos, filas) {
  if (!filas || !filas.length) return partidos.map((p) => p.slice(0, 5));
  // claves numéricas: día y marcador; y los nombres, por su número de orden
  const clave = (d, gl, gv) => (d * 100 + gl) * 100 + gv;
  const num = new Map();
  const numDe = (n) => {
    let k = num.get(n);
    if (k === undefined) { k = num.size; num.set(n, k); }
    return k;
  };
  const porMarcador = new Map(), porCruce = new Map();
  for (let r = 0; r < filas.length; r++) {
    const f = filas[r];
    const km = clave(f[0], f[3], f[4]);
    let a = porMarcador.get(km);
    if (a === undefined) { a = []; porMarcador.set(km, a); }
    a.push(f);
    const kc = ((numDe(f[1]) * 4096 + numDe(f[2])) * 100 + f[3]) * 100 + f[4];
    let b = porCruce.get(kc);
    if (b === undefined) { b = []; porCruce.set(kc, b); }
    b.push(f);
  }
  const votos = new Map();
  const votar = (t, nombre) => {
    let v = votos.get(t);
    if (v === undefined) { v = new Map(); votos.set(t, v); }
    v.set(nombre, (v.get(nombre) || 0) + 1);
  };
  for (let r = 0; r < partidos.length; r++) {
    const p = partidos[r];
    const c0 = porMarcador.get(clave(p[0], p[3], p[4]));
    const c1 = porMarcador.get(clave(p[0] - 1, p[3], p[4]));
    const c2 = porMarcador.get(clave(p[0] + 1, p[3], p[4]));
    const n0 = c0 ? c0.length : 0, n1 = c1 ? c1.length : 0, n2 = c2 ? c2.length : 0;
    if (n0 + n1 + n2 !== 1) continue;
    const f = n0 ? c0[0] : n1 ? c1[0] : c2[0];
    votar(p[1], f[1]);
    votar(p[2], f[2]);
  }
  const nombreDe = new Map();
  for (const [t, v] of votos) {
    let mejor = null, n = 0;
    for (const [nombre, k] of v) if (k > n) { mejor = nombre; n = k; }
    nombreDe.set(t, mejor);
  }
  const out = new Array(partidos.length);
  for (let r = 0; r < partidos.length; r++) {
    const p = partidos[r];
    const nl = nombreDe.get(p[1]), nv = nombreDe.get(p[2]);
    let mejor = null;
    if (nl != null && nv != null) {
      const cand = porCruce.get(((num.get(nl) * 4096 + num.get(nv)) * 100 + p[3]) * 100 + p[4]);
      if (cand) {
        for (let k = 0; k < cand.length; k++) {
          const f = cand[k];
          if (Math.abs(f[0] - p[0]) <= 3 && (mejor === null || Math.abs(f[0] - p[0]) < Math.abs(mejor[0] - p[0]))) mejor = f;
        }
      }
    }
    out[r] = mejor !== null && mejor[5] !== null && mejor[6] !== null
      ? [p[0], p[1], p[2], p[3], p[4], mejor[5], mejor[6]] : [p[0], p[1], p[2], p[3], p[4]];
  }
  return out;
}

// El CSV de una temporada de una liga (url_tiros en app.py).
export function urlTiros(base, codigo, season) {
  const s = season % 100;
  const dos = (x) => String(x).padStart(2, "0");
  return `${base}/mmz4281/${dos(s)}${dos((s + 1) % 100)}/${DIVISION_TIROS[codigo]}.csv`;
}

// ------------------------------------------
// Fuerzas: un filtro de Kalman, partido a partido (ajustar_fuerzas en app.py)
// ------------------------------------------
// Ataque y defensa de todos los equipos de una liga con sus partidos de la temporada
// anterior y lo jugado de esta ([[día, local, visita, gl, gv(, tiros local, visita)], ...]):
// cada log-fuerza con su varianza, que crece con los días sin jugar y baja con cada
// partido, corregida con lo observado (la mitad de los goles y la mitad de lo que valen
// sus tiros a puerta) menos lo esperado. Mismas operaciones y en el mismo orden que en
// Python, con expExacto y logExacto: sale el mismo double.
export function ajustarFuerzas(previa, actual, codigo = null, deArriba = []) {
  const conPrevia = previa.length > 0;
  const arribaLista = [...new Set(deArriba)];
  if (!previa.length && !actual.length) {
    return { equipos: {}, con_previa: conPrevia, codigo, de_arriba: arribaLista, dia: null, exponente: 1.0, con_tiros: 0 };
  }
  const arriba = new Set(arribaLista);
  const previos = new Set();
  for (let r = 0; r < previa.length; r++) { previos.add(previa[r][1]); previos.add(previa[r][2]); }
  let al, av;
  if (previa.length >= 100) {
    let sl = 0, sv = 0;
    for (let r = 0; r < previa.length; r++) { sl += previa[r][3]; sv += previa[r][4]; }
    al = sl / previa.length; av = sv / previa.length;
  } else {
    al = PRIOR_AVG_LOCAL; av = PRIOR_AVG_VISITA;
  }
  let kl = 0.0, kv = 0.0;
  for (const lista of [previa, actual]) {
    let gl = 0, gv = 0, tl = 0, tv = 0;
    for (let r = 0; r < lista.length; r++) {
      const p = lista[r];
      if (p.length > 5) { gl += p[3]; gv += p[4]; tl += p[5]; tv += p[6]; }
    }
    if (tl > 0 && tv > 0) { kl = gl / tl; kv = gv / tv; break; }
  }
  const W = PESO_TIROS;
  const estado = new Map(), orden = [];
  // el estado de un equipo ([log-ataque, log-defensa, sus varianzas, último día, partidos]),
  // con la varianza que ganó desde su último partido
  const equipo = (t, d, enActual) => {
    let e = estado.get(t);
    if (e === undefined) {
      if (enActual && conPrevia && !previos.has(t)) {
        const pr = priorRecienLlegado(codigo, t, arriba);
        e = [logExacto(pr[0]), logExacto(pr[1]), KALMAN_NUEVO, KALMAN_NUEVO, d, 0];
      } else {
        e = [0.0, 0.0, KALMAN_INICIO, KALMAN_INICIO, d, 0];
      }
      estado.set(t, e);
      orden.push(t);
    }
    if (d > e[4]) {
      e[2] += KALMAN_DERIVA * (d - e[4]);
      e[3] += KALMAN_DERIVA * (d - e[4]);
      e[4] = d;
    }
    e[5] += 1;
    return e;
  };
  // lo observado (y) frente a lo esperado (lam) corrige el ataque de uno y la defensa del otro
  const corregir = (at, de, lam, y) => {
    const pa = at[2], pd = de[3];
    const den = 1 + lam * (pa + pd);
    at[0] += pa * (y - lam) / den;
    de[1] += pd * (y - lam) / den;
    at[2] = pa - lam * pa * pa / den;
    de[3] = pd - lam * pd * pd / den;
  };
  let conTiros = 0;
  let glT = 0, gvT = 0, nT = 0, pendL = 0, pendV = 0, pendN = 0, diaT = null;
  const todos = previa.concat(actual);
  let ultimo = -Infinity;
  for (let i = 0; i < todos.length; i++) {
    const p = todos[i];
    const d = p[0], loc = p[1], vis = p[2], gl = p[3], gv = p[4];
    if (d > ultimo) ultimo = d;
    const enActual = i >= previa.length;
    let ml, mv;
    if (enActual) {
      if (i === previa.length) {
        for (const t of orden) { const e = estado.get(t); e[2] += KALMAN_TEMPORADA; e[3] += KALMAN_TEMPORADA; }
      }
      if (d !== diaT) {
        glT += pendL; gvT += pendV; nT += pendN;
        pendL = 0; pendV = 0; pendN = 0;
        diaT = d;
      }
      ml = (glT + K_LIGA * al) / (nT + K_LIGA);
      mv = (gvT + K_LIGA * av) / (nT + K_LIGA);
    } else {
      ml = al; mv = av;
    }
    const el = equipo(loc, d, enActual), ev = equipo(vis, d, enActual);
    const lamL = ml * expExacto(el[0] + ev[1]);
    const lamV = mv * expExacto(ev[0] + el[1]);
    let yL, yV;
    if (p.length > 5 && kl > 0) {
      yL = (1 - W) * gl + W * kl * p[5];
      yV = (1 - W) * gv + W * kv * p[6];
      conTiros += 1;
    } else {
      yL = gl; yV = gv;
    }
    corregir(el, ev, lamL, yL);
    corregir(ev, el, lamV, yV);
    if (enActual) { pendL += gl; pendV += gv; pendN += 1; }
  }
  const b = 1 + (EXPONENTE_FUERZAS - 1) * (conTiros / todos.length);
  const equipos = {};
  for (const t of orden) {
    const e = estado.get(t);
    equipos[String(t)] = [expExacto(b * e[0]), expExacto(b * e[1]), e[5]];
  }
  return { equipos, con_previa: conPrevia, codigo, de_arriba: arribaLista, dia: ultimo, exponente: b, con_tiros: conTiros };
}

// [ataque, defensa] de los que parte un equipo que no estaba en la liga la
// temporada anterior: el de un descendido si viene de la liga de arriba
// (deArriba, ver LIGA_DE_ARRIBA) y si no, el de un ascendido de esa liga.
export function priorRecienLlegado(codigo, teamId, deArriba) {
  if (deArriba.has(teamId)) return [ATAQUE_DESCENDIDO, DEFENSA_DESCENDIDO];
  return [ATAQUE_RECIEN_LLEGADO, DEFENSA_RECIEN_LLEGADO[codigo] ?? 1.0];
}

// Ataque, defensa y partidos de un equipo; uno sin partidos todavía (un
// ascendido o un descendido antes de debutar) parte de la fuerza de un recién
// llegado, elevada al exponente de su liga, como las demás.
export function fuerzaEquipo(fuerzas, teamId) {
  const e = fuerzas.equipos[String(teamId)];
  if (e) return { ataque: e[0], defensa: e[1], partidos: e[2] };
  if (!fuerzas.con_previa) return { ataque: 1.0, defensa: 1.0, partidos: 0 };
  const [a, d] = priorRecienLlegado(fuerzas.codigo ?? null, teamId, new Set(fuerzas.de_arriba || []));
  const b = fuerzas.exponente ?? 1.0;
  return { ataque: expExacto(b * logExacto(a)), defensa: expExacto(b * logExacto(d)), partidos: 0 };
}

// Los equipos de una lista de partidos compactos, en orden de aparición.
export function equiposDePartidos(partidos) {
  const vistos = new Set();
  for (const p of partidos) { vistos.add(p[1]); vistos.add(p[2]); }
  return [...vistos];
}

// ------------------------------------------
// Goles esperados
// ------------------------------------------
// Media de la liga x ataque propio x defensa del rival.
export function calcularXgPartido(local, visita, promedioLiga) {
  const xgLocal = promedioLiga.avg_local * local.ataque * visita.defensa;
  const xgVisita = promedioLiga.avg_visita * visita.ataque * local.defensa;
  return [redondear(xgLocal, 2), redondear(xgVisita, 2)];
}

// Corrección de Dixon-Coles (RHO_EMPATES) de un marcador: solo 0-0, 1-0, 0-1 y 1-1.
function tau(gl, gv, la, lv) {
  if (gl === 0 && gv === 0) return 1 - la * lv * RHO_EMPATES;
  if (gl === 0 && gv === 1) return 1 + la * RHO_EMPATES;
  if (gl === 1 && gv === 0) return 1 + lv * RHO_EMPATES;
  if (gl === 1 && gv === 1) return 1 - RHO_EMPATES;
  return 1.0;
}

// ------------------------------------------
// 1X2 y doble oportunidad
// ------------------------------------------
export function calcularPoisson(gla, gvi, limite = LIMITE_GOLES) {
  const reutilizar = limite === LIMITE_GOLES;
  const pl = reutilizar ? pmfs(gla, limite, PL) : pmfs(gla, limite);
  const pv = reutilizar ? pmfs(gvi, limite, PV) : pmfs(gvi, limite);
  let local = 0, empate = 0, visita = 0;
  for (let gl = 0; gl <= limite; gl++) {
    const pGl = pl[gl];
    for (let gv = 0; gv <= limite; gv++) {
      let prob = pGl * pv[gv];
      if (gl <= 1 && gv <= 1) prob = prob * tau(gl, gv, gla, gvi);
      if (gl > gv) local += prob;
      else if (gl === gv) empate += prob;
      else visita += prob;
    }
  }
  // la rejilla es finita: se normaliza para que 1 + X + 2 sume exactamente 100
  const total = local + empate + visita;
  local /= total; empate /= total; visita /= total;
  return {
    prob_local: redondear(local * 100, 2),
    prob_empate: redondear(empate * 100, 2),
    prob_visita: redondear(visita * 100, 2),
    prob_1x: redondear((local + empate) * 100, 2),
    prob_x2: redondear((empate + visita) * 100, 2),
    prob_12: redondear((local + visita) * 100, 2),
  };
}

// ------------------------------------------
// Mercados de goles
// ------------------------------------------

// Más/menos, ambos marcan, porterías a cero, por cuánto gana y marcadores, todos
// de una misma rejilla de marcadores con el total de goles esperados acercado a
// la media de la liga, el reparto entre los dos equipos del 1X2 y la misma
// corrección de los marcadores bajos.
// Las probabilidades de 0, 1, 2... goles de un equipo con el 0 un MENOS_CEROS más bajo;
// lo que pierde va a los demás, en proporción (_menos_ceros de app.py). Cambia p.
function menosCeros(p) {
  const p0 = p[0];
  if (p0 >= 1) return p;
  p[0] = p0 * (1 - MENOS_CEROS);
  for (let k = 1; k < p.length; k++) p[k] = p[k] * (1 - p[0]) / (1 - p0);
  return p;
}

export function mercadosDeGoles(xgLocal, xgVisita, promedioLiga, limite = LIMITE_GOLES) {
  const totalLiga = promedioLiga.avg_local + promedioLiga.avg_visita;
  const totalXg = xgLocal + xgVisita;
  const escala = totalXg > 0 ? (totalLiga + ENCOGER_TOTAL * (totalXg - totalLiga)) / totalXg : 1.0;
  const gla = xgLocal * escala;
  const gvi = xgVisita * escala;

  const n = limite + 1;
  const reutilizar = limite === LIMITE_GOLES;   // la rejilla de siempre: sin reservar memoria
  const pl = menosCeros(reutilizar ? pmfs(gla, limite, PL) : pmfs(gla, limite));
  const pv = menosCeros(reutilizar ? pmfs(gvi, limite, PV) : pmfs(gvi, limite));
  const rejilla = reutilizar ? REJILLA : new Float64Array(n * n);
  let suma = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let v = pl[i] * pv[j];
      if (i <= 1 && j <= 1) v = v * tau(i, j, gla, gvi);
      rejilla[i * n + j] = v;
      suma += v;
    }
  }
  for (let k = 0; k < rejilla.length; k++) rejilla[k] /= suma;

  let mas15 = 0, mas25 = 0, mas35 = 0, ambos = 0, ceroLocal = 0, ceroVisita = 0;
  let gana2Local = 0, gana2Visita = 0, ganaCeroLocal = 0, ganaCeroVisita = 0;
  const reparto = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      const v = rejilla[k];
      const total = i + j;
      reparto[total < 5 ? total : 5] += v;
      if (total > 1.5) mas15 += v;
      if (total > 2.5) mas25 += v;
      if (total > 3.5) mas35 += v;
      if (i >= 1 && j >= 1) ambos += v;
      if (j === 0) ceroLocal += v;    // portería a cero del local: el visitante no marca
      if (i === 0) ceroVisita += v;
      if (i - j >= 2) gana2Local += v;
      if (j - i >= 2) gana2Visita += v;
      if (i >= 1 && j === 0) ganaCeroLocal += v;
      if (j >= 1 && i === 0) ganaCeroVisita += v;
    }
  }
  // los tres marcadores más probables, sin ordenar la rejilla entera. Con los goles
  // esperados en una proporción exacta (1.0 y 2.0, 0.5 y 2.0...) hay marcadores con
  // la misma probabilidad, que aquí y en app.py salen con una diferencia en el último
  // bit: por debajo de EMPATE (relativo) cuentan como empate, y en un empate va
  // primero el que deja al visitante con menos goles (el 1-0 antes que el 0-1)
  const EMPATE = 1 + 1e-9;
  let a = -1, b = -1, c = -1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = i * n + j;
      const v = rejilla[k];
      if (a < 0 || v > rejilla[a] * EMPATE) { c = b; b = a; a = k; }
      else if (b < 0 || v > rejilla[b] * EMPATE) { c = b; b = k; }
      else if (c < 0 || v > rejilla[c] * EMPATE) { c = k; }
    }
  }

  return {
    goles_total: redondear(gla + gvi, 2),
    prob_mas_15: pc(mas15),
    prob_mas_25: pc(mas25),
    prob_mas_35: pc(mas35),
    prob_ambos: pc(ambos),
    prob_cero_local: pc(ceroLocal),
    prob_cero_visita: pc(ceroVisita),
    prob_gana2_local: pc(gana2Local),
    prob_gana2_visita: pc(gana2Visita),
    prob_gana_cero_local: pc(ganaCeroLocal),
    prob_gana_cero_visita: pc(ganaCeroVisita),
    goles_reparto: reparto.map(pc),
    marcadores: [a, b, c].map((k) => [Math.floor(k / n), k % n, pc(rejilla[k])]),
  };
}

// ------------------------------------------
// Champions
// ------------------------------------------
// Ataque y defensa de un equipo en su liga nacional (fuerzaEquipo), atenuados:
// la parte de fuerzas_champions de app.py que no pide nada.
export function fuerzasDesdeLiga(f) {
  const b = EXPONENTE_FUERZA_CHAMPIONS;
  return { ataque: f.ataque ** b, defensa: f.defensa ** b, muestra: f.partidos };
}

// Historial en la Champions (historial_champions en app.py): lo que un equipo
// marcó y encajó en sus partidos de Champions de esta temporada y la anterior,
// y lo que se esperaba de él: la media de la Champions de esa temporada por la
// escala, por su nivel de liga y entre el del rival (al revés para lo encajado).
// entradas: [la de esta temporada, la de la anterior], con avg_local, avg_visita
// e historial; factorDe(rival): el nivel de la liga del rival.
export function sumarHistorial(entradas, teamId, factor, factorDe) {
  let gf = 0, gc = 0, esperadoF = 0, esperadoC = 0, n = 0;
  for (const entrada of entradas) {
    if (!entrada) continue;
    const muL = entrada.avg_local, muV = entrada.avg_visita;
    for (const [rival, enCasa, aFavor, enContra] of (entrada.historial || {})[String(teamId)] || []) {
      const fRival = factorDe(rival);
      if (enCasa) {
        esperadoF += muL * ESCALA_CHAMPIONS[0] * factor / fRival;
        esperadoC += muV * ESCALA_CHAMPIONS[1] * fRival / factor;
      } else {
        esperadoF += muV * ESCALA_CHAMPIONS[1] * factor / fRival;
        esperadoC += muL * ESCALA_CHAMPIONS[0] * fRival / factor;
      }
      gf += aFavor;
      gc += enContra;
      n += 1;
    }
  }
  return { partidos: n, gf, gc, esperado_f: esperadoF, esperado_c: esperadoC };
}

// [ataque, defensa] que aporta el historial: goles frente a lo esperado,
// encogidos hacia 1 con k goles de pseudo-cuenta. Sin partidos, [1, 1].
export function multiplicadoresHistorial(h, k = K_HISTORIAL_CHAMPIONS) {
  return [(h.gf + k) / (h.esperado_f + k), (h.gc + k) / (h.esperado_c + k)];
}

// Goles esperados de un partido de Champions: ataque de uno por defensa del
// otro por la media de la Champions, el nivel de cada liga y el historial.
export function calcularXgChampions(local, visita, promedioCl) {
  const xgLocal = promedioCl.avg_local * ESCALA_CHAMPIONS[0]
    * local.ataque * visita.defensa * local.factor / visita.factor
    * local.ataque_cl * visita.defensa_cl;
  const xgVisita = promedioCl.avg_visita * ESCALA_CHAMPIONS[1]
    * visita.ataque * local.defensa * visita.factor / local.factor
    * visita.ataque_cl * local.defensa_cl;
  return [redondear(xgLocal, 2), redondear(xgVisita, 2)];
}
