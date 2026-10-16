"""
Comprueba que el modelo del Worker de Cloudflare (worker/) da los mismos
números que el de app.py y validacion.py, que es el que miden backtest.py,
afinar.py y compañía. Si tocas el modelo en un lado y no en el otro, esto falla.

Compara:
  - las constantes (FACTOR_LIGA, ENCOGER_GOLES, K_LIGA...) una a una;
  - goles esperados, 1X2, doble oportunidad y mercados de goles en miles de
    partidos al azar, más los casos límite;
  - la Champions: fuerzas_champions y calcular_xg_champions;
  - la validación entera (validar_liga) sobre temporadas sintéticas.

Los porcentajes pueden diferir en 0.01 en algún caso suelto: scipy y JS calculan
la Poisson con una diferencia en la última cifra binaria, y si el valor cae
justo en el borde de un redondeo, cada uno redondea hacia un lado. Más que eso,
o en más de uno de cada mil valores, es un error.

Hace falta Node (npm install no es necesario: el modelo no usa dependencias).

Uso:
    python test_paridad.py
"""
import json
import math
import os
import random
import subprocess
import sys

# app.py exige estas variables al importarse; aquí no se pide nada a la API.
os.environ.setdefault("FOOTBALL_DATA_TOKEN", "sin_uso_en_este_script")
os.environ.setdefault("UPDATE_SECRET", "test_paridad_dummy_secret")

import app          # noqa: E402
import validacion   # noqa: E402

AQUI = os.path.dirname(os.path.abspath(__file__))
N_PARTIDOS = 4000
N_CHAMPIONS = 1500

NODE = r"""
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const base = process.argv[1] + "/worker/";
const m = await import(pathToFileURL(base + "modelo.js"));
const c = await import(pathToFileURL(base + "config.js"));
const v = await import(pathToFileURL(base + "validacion.js"));
const casos = JSON.parse(readFileSync(0, "utf8"));
const aj = c.ajustes({});
const out = {
  constantes: {
    LIGAS: c.LIGAS, TORNEOS: c.TORNEOS, FACTOR_LIGA: c.FACTOR_LIGA, FACTOR_OTRA_LIGA: c.FACTOR_OTRA_LIGA,
    EXPONENTE_FUERZA_CHAMPIONS: c.EXPONENTE_FUERZA_CHAMPIONS, ESCALA_CHAMPIONS: c.ESCALA_CHAMPIONS,
    K_HISTORIAL_CHAMPIONS: c.K_HISTORIAL_CHAMPIONS,
    DIAS_VALIDEZ_LIGA_EQUIPO: c.DIAS_VALIDEZ_LIGA_EQUIPO, DIAS_VALIDEZ_LIGA: c.DIAS_VALIDEZ_LIGA,
    HORAS_VALIDEZ_PREDICCION: c.HORAS_VALIDEZ_PREDICCION, VENTANA_DIAS: c.VENTANA_DIAS,
    MAX_PARTIDOS_EQUIPO: c.MAX_PARTIDOS_EQUIPO, PSEUDO_PARTIDOS: c.PSEUDO_PARTIDOS, K_LIGA: c.K_LIGA,
    PRIOR_AVG_LOCAL: c.PRIOR_AVG_LOCAL, PRIOR_AVG_VISITA: c.PRIOR_AVG_VISITA,
    DIAS_VALIDEZ_PRIOR: c.DIAS_VALIDEZ_PRIOR, LIMITE_GOLES: c.LIMITE_GOLES, ENCOGER_GOLES: c.ENCOGER_GOLES,
    LIGAS_ANO_NATURAL: [...c.LIGAS_ANO_NATURAL].sort(), DIAS_SEMANA: c.DIAS_SEMANA,
    MAX_INTENTOS_VALIDACION: c.MAX_INTENTOS_VALIDACION,
    DIAS_VALIDEZ_EQUIPO: aj.diasValidezEquipo, MAX_DIAS_BUSQUEDA: aj.maxDiasBusqueda,
    HORAS_VALIDEZ_FIXTURES: aj.horasValidezFixtures, MIN_MINUTOS_ACTUALIZACION: aj.minMinutosActualizacion,
    TZ: aj.tz,
  },
  partidos: casos.partidos.map(({ sl, sv, prom }) => {
    const [xl, xv] = m.calcularXgPartido(sl, sv, prom);
    return { xg: [xl, xv], ...m.calcularPoisson(xl, xv), ...m.mercadosDeGoles(xl, xv, prom) };
  }),
  sueltos: casos.sueltos.map(({ gl, gv, prom }) => ({ ...m.calcularPoisson(gl, gv), ...m.mercadosDeGoles(gl, gv, prom) })),
  champions: casos.champions.map(({ local, visita, cl, previa, rivales }) => {
    // lo mismo que fuerzasChampions en actualizacion.js, con las ligas ya resueltas
    const factorDe = (rival) => c.FACTOR_LIGA[rivales[rival]] ?? c.FACTOR_OTRA_LIGA;
    const f = (x, enCasa) => {
      const factor = c.FACTOR_LIGA[x.liga] ?? c.FACTOR_OTRA_LIGA;
      const entradas = [{ ...cl, historial: { [x.id]: x.hist_actual } },
        previa && { ...previa, historial: { [x.id]: x.hist_previa } }];
      const h = m.sumarHistorial(entradas, x.id, factor, factorDe);
      const [ataqueCl, defensaCl] = m.multiplicadoresHistorial(h);
      const historial = { partidos_cl: h.partidos, ataque_cl: ataqueCl, defensa_cl: defensaCl };
      return x.liga === null
        ? { liga: null, nombre_liga: null, factor: c.FACTOR_OTRA_LIGA, ataque: 1.0, defensa: 1.0, muestra: 0, ...historial }
        : { liga: x.liga, nombre_liga: Object.keys(c.LIGAS).find((k) => c.LIGAS[k] === x.liga),
            factor, ...m.fuerzasDesdeLiga(x.stats, x.prom, enCasa), ...historial };
    };
    const fl = f(local, true), fv = f(visita, false);
    return { local: fl, visita: fv, xg: m.calcularXgChampions(fl, fv, cl) };
  }),
  validacion: casos.validacion.map(({ codigo, nombre, season, previa, ultima }) =>
    v.validarLiga(codigo, nombre, season, previa, ultima)),
  redondeo: casos.redondeo.map(([x, n]) => m.redondear(x, n)),
};
process.stdout.write(JSON.stringify(out));
"""


def _stats(rnd):
    n_l, n_v = rnd.randint(0, 20), rnd.randint(0, 20)
    return {"gf_local": rnd.randint(0, 3 * n_l), "gc_local": rnd.randint(0, 2 * n_l), "n_local": n_l,
            "gf_visita": rnd.randint(0, 2 * n_v), "gc_visita": rnd.randint(0, 3 * n_v), "n_visita": n_v}


def _prom(rnd):
    return {"avg_local": rnd.uniform(1.0, 2.0), "avg_visita": rnd.uniform(0.8, 1.6)}


def _temporada(rnd, equipos, fuerza, n_jornadas):
    """Liga sintética a doble vuelta, con goles según la fuerza de cada uno."""
    out, dia = [], 0
    for j in range(n_jornadas):
        orden = list(equipos)
        rnd.shuffle(orden)
        for k in range(0, len(orden) - 1, 2):
            l, v = orden[k], orden[k + 1]
            def goles(mu):
                # Poisson por inversión, para no depender de numpy aquí
                x, p, s, u = 0, math.exp(-mu), math.exp(-mu), rnd.random()
                while u > s and x < 12:
                    x += 1; p *= mu / x; s += p
                return x
            out.append({"fecha": f"2024-{1 + (dia // 28) % 12:02d}-{1 + dia % 28:02d}T{12 + k % 8:02d}:00:00Z",
                        "local": l, "visita": v,
                        "gl": goles(1.45 * fuerza[l] / fuerza[v]), "gv": goles(1.1 * fuerza[v] / fuerza[l])})
        dia += 1
    out.sort(key=lambda m: m["fecha"])
    return out


def _casos(rnd):
    partidos = [{"sl": _stats(rnd), "sv": _stats(rnd), "prom": _prom(rnd)} for _ in range(N_PARTIDOS)]
    sueltos = [{"gl": round(rnd.uniform(0.05, 4.5), 2), "gv": round(rnd.uniform(0.05, 4.0), 2), "prom": _prom(rnd)}
               for _ in range(500)]
    # límites: equipos que no marcan nada, goleadas, los mismos goles a los dos lados
    sueltos += [{"gl": 0.0, "gv": 0.0, "prom": {"avg_local": 1.5, "avg_visita": 1.2}},
                {"gl": 0.0, "gv": 2.3, "prom": {"avg_local": 1.5, "avg_visita": 1.2}},
                {"gl": 6.8, "gv": 0.01, "prom": {"avg_local": 1.6, "avg_visita": 1.1}},
                {"gl": 1.3, "gv": 1.3, "prom": {"avg_local": 1.3, "avg_visita": 1.3}}]
    ligas = list(app.FACTOR_LIGA) + ["ELC", "BSA", None]
    champions = []
    for k in range(N_CHAMPIONS):
        # rivales de su historial en la Champions, cada uno de una liga
        rivales = {str(10 ** 6 + 40 * k + j): rnd.choice(ligas) for j in range(rnd.choice((1, 8, 30)))}
        def hist():
            return [[int(rnd.choice(list(rivales))), rnd.choice((0, 1)), rnd.randint(0, 5), rnd.randint(0, 4)]
                    for _ in range(rnd.choice((0, 0, 1, 4, 8, 12)))]
        lado = lambda tid: {"id": tid, "liga": rnd.choice(ligas), "stats": _stats(rnd), "prom": _prom(rnd),
                            "hist_actual": hist(), "hist_previa": hist()}
        champions.append({"local": lado(2 * k), "visita": lado(2 * k + 1), "cl": _prom(rnd),
                          "previa": _prom(rnd) if rnd.random() < 0.8 else None, "rivales": rivales})

    validaciones = []
    for i, (n_equipos, jornadas_previa, jornadas_ultima) in enumerate(((20, 38, 38), (18, 34, 34), (20, 8, 38), (20, 38, 6))):
        equipos = list(range(100 * i, 100 * i + n_equipos))
        fuerza = {e: rnd.uniform(0.6, 1.6) for e in equipos}
        validaciones.append({"codigo": f"T{i}", "nombre": f"Prueba {i}", "season": 2024,
                             "previa": _temporada(rnd, equipos, fuerza, jornadas_previa),
                             "ultima": _temporada(rnd, equipos, fuerza, jornadas_ultima)})
    # redondeo: empates exactos (0.125, 2.675...), negativos y valores corrientes
    redondeo = [[x, n] for x in (0.125, 0.375, 2.675, 1.005, 12.345, 45.675, -0.125, 0.5, 1.5, 2.5)
                for n in (0, 1, 2)] + [[rnd.uniform(0, 100), rnd.choice((1, 2, 3, 4))] for _ in range(3000)]
    return {"partidos": partidos, "sueltos": sueltos, "champions": champions, "validacion": validaciones,
            "redondeo": redondeo}


def _python(casos):
    partidos = []
    for c in casos["partidos"]:
        xl, xv = app.calcular_xg_partido(c["sl"], c["sv"], c["prom"])
        partidos.append({"xg": [xl, xv], **app.calcular_poisson(xl, xv), **app.mercados_de_goles(xl, xv, c["prom"])})
    sueltos = [{**app.calcular_poisson(c["gl"], c["gv"]), **app.mercados_de_goles(c["gl"], c["gv"], c["prom"])}
               for c in casos["sueltos"]]

    champions = []
    hoy = app.ahora().isoformat()
    for k, c in enumerate(casos["champions"]):
        # fuerzas_champions de verdad, con la caché ya llena: no pide nada a la API
        # y su historial en la Champions, con la liga de cada rival ya en la caché
        def fuerzas(x, en_casa):
            tid = x["id"]
            cache = {"liga_equipo": {str(tid): {"liga": x["liga"], "actualizado": hoy}},
                     "equipos": {}, "ligas": {}, "priors": {}, "fixtures": {}}
            for rival, liga in c["rivales"].items():
                cache["liga_equipo"][rival] = {"liga": liga, "actualizado": hoy}
            if x["liga"]:
                cache["equipos"][f"{tid}:{x['liga']}"] = dict(x["stats"], actualizado=hoy)
                cache["ligas"][x["liga"]] = dict(x["prom"], actualizado=hoy)
            cache["ligas"]["CL"] = dict(c["cl"], historial={str(tid): x["hist_actual"]}, actualizado=hoy)
            if c["previa"]:
                cache["priors"]["CL"] = dict(c["previa"], historial={str(tid): x["hist_previa"]}, actualizado=hoy)
            return app.fuerzas_champions(tid, en_casa, cache)
        fl = fuerzas(c["local"], True)
        fv = fuerzas(c["visita"], False)
        champions.append({"local": fl, "visita": fv, "xg": list(app.calcular_xg_champions(fl, fv, c["cl"]))})

    vals = []
    original = validacion._cargar_temporada
    try:
        for c in casos["validacion"]:
            temporadas = {c["season"] - 1: c["previa"], c["season"]: c["ultima"]}
            validacion._cargar_temporada = lambda codigo, season: temporadas[season]
            vals.append(validacion.validar_liga(c["codigo"], c["nombre"], c["season"]))
    finally:
        validacion._cargar_temporada = original

    constantes = {k: getattr(app, k) for k in (
        "LIGAS", "TORNEOS", "FACTOR_LIGA", "FACTOR_OTRA_LIGA", "EXPONENTE_FUERZA_CHAMPIONS", "K_HISTORIAL_CHAMPIONS",
        "DIAS_VALIDEZ_LIGA_EQUIPO", "DIAS_VALIDEZ_LIGA", "HORAS_VALIDEZ_PREDICCION", "VENTANA_DIAS",
        "MAX_PARTIDOS_EQUIPO", "PSEUDO_PARTIDOS", "K_LIGA", "PRIOR_AVG_LOCAL", "PRIOR_AVG_VISITA",
        "DIAS_VALIDEZ_PRIOR", "LIMITE_GOLES", "ENCOGER_GOLES", "DIAS_SEMANA", "DIAS_VALIDEZ_EQUIPO",
        "MAX_DIAS_BUSQUEDA", "HORAS_VALIDEZ_FIXTURES")}
    constantes.update({
        "ESCALA_CHAMPIONS": list(app.ESCALA_CHAMPIONS),
        "LIGAS_ANO_NATURAL": sorted(app.LIGAS_ANO_NATURAL),
        "MAX_INTENTOS_VALIDACION": app.MAX_INTENTOS_VALIDACION,
        "MIN_MINUTOS_ACTUALIZACION": app.MIN_INTERVALO_ACTUALIZACION.total_seconds() / 60,
        "TZ": app._TZ_NOMBRE,
    })
    redondeo = [round(x, n) for x, n in casos["redondeo"]]
    return {"constantes": constantes, "partidos": partidos, "sueltos": sueltos, "champions": champions,
            "validacion": vals, "redondeo": redondeo}


class Comparador:
    def __init__(self):
        self.valores = 0
        self.distintos = []      # (ruta, python, js)

    def comparar(self, a, b, ruta=""):
        if isinstance(a, dict) and isinstance(b, dict):
            for k in sorted(set(a) | set(b)):
                if k not in a or k not in b:
                    self.distintos.append((f"{ruta}.{k}", a.get(k, "<falta>"), b.get(k, "<falta>")))
                elif k == "marcadores":
                    self.comparar_marcadores(a[k], b[k], f"{ruta}.{k}")
                else:
                    self.comparar(a[k], b[k], f"{ruta}.{k}")
        elif isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
            if len(a) != len(b):
                self.distintos.append((ruta + "[len]", len(a), len(b)))
            for i, (x, y) in enumerate(zip(a, b)):
                self.comparar(x, y, f"{ruta}[{i}]")
        else:
            self.valores += 1
            numeros = (isinstance(a, (int, float)) and not isinstance(a, bool)
                       and isinstance(b, (int, float)) and not isinstance(b, bool))
            if not numeros:
                if a != b:
                    self.distintos.append((ruta, a, b))
            elif float(a) != float(b) and not self._intermedio(ruta, a, b):
                self.distintos.append((ruta, a, b))

    @staticmethod
    def _intermedio(ruta, a, b):
        """Ataque y defensa de la Champions no se publican: son la raíz de un
        cociente, y pow() de glibc y Math.pow de V8 pueden diferir en la última
        cifra binaria. Lo que se publica son los goles esperados, redondeados."""
        return ruta.endswith((".ataque", ".defensa")) and abs(a - b) <= 1e-12 * max(abs(a), abs(b), 1)

    def comparar_marcadores(self, a, b, ruta):
        """Dos marcadores con la misma probabilidad pueden salir en otro orden
        (numpy no desempata siempre igual). Solo pasa en casos degenerados, con
        probabilidad 0: ahí qué marcador sale es indiferente."""
        if len(a) != len(b):
            self.distintos.append((ruta + "[len]", len(a), len(b)))
            return
        for i, (x, y) in enumerate(zip(a, b)):
            if x[2] == 0 and y[2] == 0:
                self.valores += 3
                continue
            self.comparar(x, y, f"{ruta}[{i}]")


def _sin_indices(ruta):
    """partidos[12].prob_local -> partidos[].prob_local, para agrupar."""
    out, dentro = [], False
    for ch in ruta:
        if ch == "[":
            dentro = True
            out.append("[]")
        elif ch == "]":
            dentro = False
        elif not dentro:
            out.append(ch)
    return "".join(out)


def main():
    rnd = random.Random(20261016)
    casos = _casos(rnd)
    py = json.loads(json.dumps(_python(casos)))   # mismas reglas de JSON que el lado JS
    proc = subprocess.run(["node", "--input-type=module", "-e", NODE, AQUI], input=json.dumps(casos),
                          capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        return 1
    js = json.loads(proc.stdout)

    fallos = 0
    for parte in ("constantes", "partidos", "sueltos", "champions", "validacion", "redondeo"):
        comp = Comparador()
        comp.comparar(py[parte], js[parte], parte)
        tolerables, graves = [], []
        for ruta, a, b in comp.distintos:
            numeros = all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (a, b))
            # un redondeo en el borde: como mucho una unidad de la última cifra que se publica
            if parte not in ("constantes", "redondeo") and numeros and abs(a - b) <= 0.0100000001:
                tolerables.append((ruta, a, b))
            else:
                graves.append((ruta, a, b))
        graves_reales = graves
        proporcion = len(tolerables) / max(comp.valores, 1)
        ok = not graves_reales and proporcion <= 0.001
        fallos += not ok
        print(f"{'OK  ' if ok else 'MAL '} {parte:11} {comp.valores:7} valores, "
              f"{len(comp.distintos)} distintos ({len(tolerables)} en el borde de un redondeo)")
        for ruta, a, b in (graves_reales + tolerables)[:8]:
            print(f"       {ruta}: python={a!r} js={b!r}")
        if graves_reales:
            grupos = {}
            for ruta, _, _ in graves_reales:
                grupos[_sin_indices(ruta)] = grupos.get(_sin_indices(ruta), 0) + 1
            print("       por campo:", dict(sorted(grupos.items(), key=lambda x: -x[1])[:6]))

    # La web lleva las mismas cabeceras en los dos sitios: las de app.py y las de
    # public/_headers (Cloudflare). Una CSP distinta rompería la web solo en uno.
    reglas = {}
    with open(os.path.join(AQUI, "public", "_headers"), encoding="utf-8") as f:
        lineas = f.read().splitlines()
    for linea in lineas:
        if linea.startswith("  ") and ":" in linea:
            nombre, valor = linea.strip().split(":", 1)
            reglas[nombre] = valor.strip()
    ok = (reglas.get("Content-Security-Policy") == app.CSP_WEB
          and reglas.get("Strict-Transport-Security") == "max-age=31536000"
          and reglas.get("Cache-Control") == "no-store, must-revalidate")
    fallos += not ok
    print(f"{'OK  ' if ok else 'MAL '} cabeceras   public/_headers {'=' if ok else '!='} app.py")
    print("\nParidad: " + ("todo igual." if not fallos else f"{fallos} partes con diferencias."))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
