# pronosticos-bot — contexto de proyecto

Resume el estado, las decisiones ya tomadas y por qué, para no repetir
investigación ya hecha. Claude Code lee este archivo automáticamente al abrir el
proyecto.

## Qué es

App Flask en Render que predice resultados de fútbol (1/X/2 y doble oportunidad)
con un modelo Poisson de fuerzas ataque/defensa.

- Repo: `pronosticos-bot`
- Carpeta local: `C:\Users\Alvaro\Desktop\webapp`
- URL producción: https://pronosticos-bot.onrender.com
- Ficheros clave: `app.py`, `templates/index.html`, `validacion.py`, `backtest.py`,
  `afinar.py`, `diagnostico.py`

## Stack

- Python 3.12.7 en Render (el default de Render es 3.14 y rompe scipy — fijar
  versión explícitamente, `runtime.txt`). En local: 3.14.
- Flask + gunicorn (`gunicorn app:app`), scipy para el modelo Poisson.
- Datos: football-data.org, plan free (10 peticiones/minuto, sin acceso a
  temporadas 2021/2022 — devuelven HTTP 403).
- Ligas activas: PD, PL, FL1, BL1. Champions deliberadamente fuera (razón
  abajo). SA y DED entrarían en el plan free si se quisiera sumar.

## Arquitectura

**Actualización reanudable por presupuesto.** Cada pasada gasta como mucho
`PRESUPUESTO_REQUESTS` (40). Al agotarse, el estado queda en `parcial` y la
siguiente pasada continúa por los partidos más cercanos. Las predicciones se
conservan 24h. `MIN_MINUTOS_ACTUALIZACION` no aplica cuando el estado es
`parcial`: continuar no es rehacer trabajo.

**Planificador interno** (sustituyó a cron-job.org). Hilos que arrancan al
importar el módulo:

- keep-alive cada 9 min: pide `/salud` a sí mismo vía `RENDER_EXTERNAL_URL`.
  Render free duerme el servicio tras 15 min sin peticiones entrantes, y un hilo
  de fondo no cuenta como tráfico.
- actualizador cada 5 min: decide si toca actualizar y ejecuta. También lanza la
  validación la primera vez, pero solo cuando el calendario ya está `listo`:
  llenar la web es más urgente que medir el modelo y las dos cosas compiten por
  las mismas 10 peticiones/minuto.

En local viene desactivado por defecto (solo se activa si detecta
`RENDER_EXTERNAL_URL`), para que `backtest.py`/`afinar.py` puedan importar
`app.py` sin gastar cuota de la API.

**Coste:** el plan free da ~750h de instancia/mes por workspace (el mes tiene
~730h). Con el keep-alive el servicio va 24/7 y las consume casi todas. Cabe si
`pronosticos-bot` es el único servicio del workspace — un segundo servicio free
suspendería a ambos.

**La interfaz no usa Jinja2.** `templates/index.html` no tiene ni una etiqueta
`{{ }}`: es un shell estático con el CSS y el JS en línea que se pinta entero en
el cliente sondeando `/api/estado` (cada 4s mientras hay cálculo en curso, cada
30s el resto del tiempo). No hay `static/`, ni build, ni dependencias de JS; de
fuera solo llegan la fuente Archivo (Google Fonts, con fallback del sistema) y
los escudos (URLs de football-data.org). Al tocar la web se trabaja sobre las
funciones `pintar*` y `html*` del `<script>`, no sobre bucles de plantilla. Cada
zona guarda una "huella" de lo último que pintó y solo toca el DOM si cambió
(`pintarBloques` lo hace bloque a bloque en la lista central): sin eso la tabla
parpadearía y perdería el scroll en cada sondeo. Los nombres de equipo vienen de
football-data.org, así que todo lo que entra pasa por `esc()`.

**Interfaz: una terminal a pantalla completa.** El objetivo es llenar la
pantalla en vez de dejar márgenes vacíos:

- Escritorio (≥1180px): tres columnas de alto fijo. Izquierda: Competiciones
  (con la media de goles que usa el modelo en cada liga), Calendario y "Cómo
  leer la tabla". Centro: tira de fechas + tabla. Derecha: Mapa de la ventana
  (una casilla por partido con la sigla del favorito y su %), Confianza del
  favorito (histograma) y Fiabilidad medida (`/api/validacion`). Arriba,
  buscador (`/` lo enfoca, Esc lo limpia) y cinta de próximos partidos; abajo,
  barra de estado. Entre 880 y 1179px los dos laterales se apilan en una sola
  columna. En móvil, una columna con pestañas fijas abajo: Partidos / Panorama /
  Ligas y fechas.
- La tabla responde al ancho del panel central (container query `centro`), no
  al de la ventana: <640px compacta (equipos apilados + 1 X 2), ≥640px tabla,
  ≥800px añade 1X/X2/12, goles esperados y muestra, ≥1150px la barra de reparto.
  La columna Liga solo aparece en las vistas que mezclan ligas.
- Los % de 1/X/2 se redondean por resto mayor para que sumen 100, y la doble
  oportunidad se suma de esos mismos enteros: lo que se lee, cuadra.
- Rutas por hash: `#/`, `#/semana`, `#/dia/2026-10-10`, `#/liga/PD`,
  `#/liga/PD/2026-10-10`. `#/` es toda la ventana en escritorio y el primer día
  en móvil.
- Color: la rampa arena es secuencial y está reservada a la probabilidad
  (celdas 1/X/2, mapa, cinta); el calendario cuenta partidos con una rampa neutra
  aparte. Los tonos de liga están validados por pares vecinos en el orden fijo
  PD, PL, FL1, BL1 (`ORDEN_LIGAS`): cada vecino se separa al menos ΔE 15 en
  visión normal. LaLiga (rojo) y Bundesliga (naranja) se parecen mucho (ΔE ≈ 7)
  y solo funcionan porque nunca salen juntas: si cambia el orden o se añade una
  liga, hay que revisar la paleta. Aun así la liga la identifica la sigla
  ESP/ENG/FRA/ALE y no el color solo, y ningún texto va en color de liga.
- Escudos y nombres cortos: `_ficha_base` añade `local_corto`, `local_sigla` y
  `local_escudo` (y los de visita) sacados de la misma respuesta del calendario:
  cero peticiones extra. `_escudo` solo deja pasar URLs https; si una imagen no
  carga, la web pinta un monograma, y sin esos campos abrevia el nombre largo.
- Logo "Casilla": tres casillas 1 X 2 con el favorito encendido. El mismo SVG va
  en la cabecera y como favicon (data URI del `<link rel="icon">`).

**Endpoints:** `/` (web), `/api/estado`, `/api/ligas` (qué ancla y qué media usa
cada liga), `/salud`, `/actualizar?token=...&forzar=1`,
`/validar?token=...[&temporada=N]` (lanza el backtest) y `/api/validacion` (su
resultado).

**Efecto secundario de cada deploy:** el disco de Render free es efímero, cada
deploy borra `cache.json` y `data.json`. La web dice "Todavía no hay datos"
hasta la primera actualización, que el planificador lanza sola unos 20 s
después de arrancar y que paga el coste completo de API (~2 peticiones/equipo)
porque la caché está vacía; las pasadas siguientes continúan cada 5 min
mientras queden partidos pendientes. `/actualizar?token=...&forzar=1` no acelera
esto: sirve para rehacer una pasada antes de `MIN_MINUTOS_ACTUALIZACION`
(25 min) y para volver a bajar el calendario ignorando la caché.

## Bugs ya encontrados y corregidos (no reabrir sin motivo nuevo)

1. **Normalizador equivocado en `calcular_xg_partido`** (crítico). La defensa del
   visitante se dividía entre `avg_visita`, pero los goles que encaja fuera son
   goles de local. Dos equipos medios daban xG 2.00-0.93 en vez de 1.55-1.20 —
   sesgo sistemático a favor del local en todos los partidos.
2. **`/v4/matches` global no sirve en plan free:** devuelve HTTP 200 con lista
   vacía en vez de 403. Se usa `/v4/competitions/{cod}/matches` con
   `dateFrom`/`dateTo`, inyectando a mano el bloque `competition`.
3. **Fallback todo-o-nada** (`n_local == 0 or n_visita == 0` → 1.3 fijo) producía
   predicciones idénticas a inicio de temporada. Sustituido por encogimiento
   bayesiano hacia la media de liga.
4. **Datos contaminados:** `/teams/{id}/matches` sin `competitions` mezclaba Copa
   del Rey, Champions y amistosos; `limit=20` sin orden no garantizaba los 20
   últimos.
5. **Prior de una liga aplicado a las cuatro** (sept 2026). `PRIOR_AVG_LOCAL` /
   `PRIOR_AVG_VISITA` salían de LaLiga y se usaban en todas. Con `K_LIGA=50`, a
   30 partidos jugados el prior pesa el 62% del valor estimado; Bundesliga (más
   goleadora) salía ~9-12% por debajo. Arreglado: cada liga se ancla en su propia
   temporada anterior (`obtener_prior_liga`), una petición por liga cacheada 30
   días. Las constantes quedan solo como último recurso. Verificado: BL1 pasó de
   -11.8% a +3.2% de sesgo.
6. **Zona horaria en Windows:** `zoneinfo` no encuentra `America/Lima` sin el
   paquete `tzdata` (en Linux viene con el SO). Añadido a `requirements.txt` +
   fallback a UTC-5 fijo (exacto para Perú todo el año).
7. **Poisson truncado en 5 goles** perdía hasta 6.5% de masa → límite subido a 10
   y normalizado. Añadidas dobles oportunidad X2 y 12. `Cache-Control: no-store`
   para que un deploy no deje al navegador con la interfaz vieja.

## Por qué la Champions se queda fuera

El modelo mide la fuerza de un equipo con sus partidos en esa misma competición.
En liga hay ~19 partidos en casa y ~19 fuera; en Champions, 4 y 4. Y la "media de
la liga" en Champions no significa nada: mezcla al Bayern con el campeón de
Kazajistán, así que dividir entre esa media no mide fuerza relativa. Hacerlo bien
exige tomar las stats de cada equipo de su liga doméstica y normalizarlas entre
ligas — proyecto aparte, no trivial.

## Validación

Backtest sobre LaLiga 2023+2024 (720 partidos evaluados):

```
Modelo corregido      Brier 0.6013   LogLoss 1.0072   Acierto 49.0%
Base "equipo medio"   Brier 0.6499   LogLoss 1.0749   Acierto 44.4%
```

Skill score del 7.5% sobre la base. PL, FL1 y BL1 las valida la propia app
(`validacion.py`, abajo) sobre la última temporada terminada, pero sus cifras no
están apuntadas aquí. Para el mismo backtest de dos temporadas que LaLiga:
`LIGA_BACKTEST=PL python backtest.py 2023 2024`, etc.

`validacion.py` corre ese mismo backtest walk-forward **dentro de la app**
(`/validar?token=...`, resultado en `/api/validacion`): importa
`calcular_xg_partido` y `calcular_poisson` de `app` en vez de reimplementarlos,
para no validar una copia desincronizada del modelo desplegado. Cuesta 2
peticiones por liga y solo la primera vez — las temporadas terminadas no cambian,
así que quedan cacheadas en disco.

## Afinado del modelo — dos decisiones cerradas (sept 2026)

Datos disponibles: solo LaLiga 2023+2024 (2021/2022 dan 403 en plan free).

### 1. Hiperparámetros (`PSEUDO_PARTIDOS=6`, `rho=0`): se quedan como están

No porque estén demostrados óptimos, sino porque con 760 partidos no se puede
distinguir ninguna configuración de otra:

- Train 2023 → gana `pseudo=3, rho=-0.2`; validado en 2024, pierde.
- Train 2024 → gana `pseudo=6, rho=0` (la config actual).
- Mínimo global de LogLoss sobre las dos temporadas juntas: `(pseudo=4,
  rho=-0.1)` = 1.0052 vs 1.0073 actual — diferencia 0.0021, y el test pareado da
  `+0.0021 ± 0.0029`: no significativo. Ídem para las otras comparaciones
  probadas.
- Matiz para el futuro: en las 7 configuraciones de la tabla, `rho` entre -0.05 y
  -0.15 sale sistemáticamente algo mejor que `rho=0`, coherente con el sesgo de
  empates de la calibración (25.3% predicho vs 27.6% real). Pero son los mismos
  760 partidos reutilizados 7 veces, no pruebas independientes. Si algún día hay
  más temporadas, esta es la primera hipótesis a reprobar.

### 2. Prior de equipos ascendidos: medido, real, y aun así descartado

Ascendidos a 2024 (Espanyol, Leganés, Valladolid), 57 partidos local + 57
visitante: ataque local 0.688 vs 1.055 del resto, ataque visitante 0.722 vs
1.049, defensa visitante 1.425 vs 0.925 (3 de 4 efectos superan 2 errores
estándar — el fenómeno es real, el modelo no lo captura).

No se implementa. Razones: la magnitud solo se puede medir en 2024, que es
también el único set de validación disponible — ajustar y evaluar sobre los
mismos datos es circular (exactamente lo que el punto 1 mostró que no sirve). Son
3 equipos de una sola temporada; el 0.688 concreto casi seguro no se repite. La
web ya avisa "⚠ Pocos partidos previos" en predicciones con poca muestra, así que
el usuario tiene la señal aunque el número no la tenga.

Si se retoma: no hace falta lista de ascendidos. Un equipo con muy pocos partidos
en la ventana de 400 días es un recién llegado — basta con cambiar el objetivo del
encogimiento (`_encoger`) para esos equipos en vez de añadir un campo nuevo. El
efecto se diluye solo conforme acumulan partidos.

## Herramientas de afinado

- `afinar.py` compara configuraciones con un test pareado de LogLoss y su error
  estándar: dice si una diferencia es real, no solo cuál gana.
- `afinar.py` avisa ("AVISO: no se pudo cargar …") si una temporada no carga.
  `backtest.py` solo imprime el error HTTP de esa temporada, y su resumen sigue
  listando todas las temporadas pedidas: si una falla, mira cuántos partidos
  cargó antes de fiarte del resultado.
- `backtest.py` captura `requests.RequestException`: sin conexión, esa temporada
  vuelve vacía en vez de tumbar el script.

## Render: cómo se despliega

Configuración del servicio `pronosticos-bot` (`srv-da749a2d0e5s73d8iuvg`),
consultada en la API de Render (sept 2026):

```
autoDeploy: yes    autoDeployTrigger: commit    branch: main    rootDir: (vacío)
```

**Un push a `main` despliega solo**, normalmente en menos de un minuto.
**Un push a cualquier otra rama no despliega nada**: si el trabajo está en una
rama con su pull request abierta, hay que mergear a `main` primero. La pestaña
Events del panel no sirve para saber si el auto-deploy funciona: ahí los
deploys manuales se leen fácil y los automáticos pasan desapercibidos.

Cómo comprobarlo en 5 segundos: Render → Events, comparar el hash del último
"Deploy live" con `git log --oneline -1 main`. Si no coinciden, mira primero en
qué rama está tu commit.

Después de cada deploy el disco arranca vacío y la web se llena sola en unos
minutos (ver "Efecto secundario de cada deploy"). Para rehacer una pasada a
mano: `/actualizar?token=...&forzar=1` con el valor de `UPDATE_SECRET` (Render →
Environment).

## Pendiente (por orden de lo que más mueve la aguja)

- **Apuntar la validación de PL, FL1 y BL1:** la app ya las mide
  (`/api/validacion`), pero sus cifras no están en este archivo y solo LaLiga
  tiene el backtest de dos temporadas.
- **Persistencia:** el disco de Render free borra `cache.json`/`data.json` en cada
  deploy. Bloquea el registro de predicciones. Variable `DATA_DIR` ya preparada
  para cuando se resuelva (¿disco persistente de pago? ¿DB externa gratuita?).
- **Registro de predicciones en vivo:** nadie mide si los pronósticos publicados
  aciertan. Guardarlos con su resultado real cerraría el círculo y acumularía
  datos propios que el plan free no vende — es lo único que puede sacar el `rho`
  del empate estadístico descrito arriba.
- **`test_migracion.py` está desincronizado:** prueba `app._parsear_standings` y
  `app.USAR_PRIOR_PREVIA`, que no existen en `app.py`. Es de una migración a
  `/standings` que no está en el código actual, así que el archivo revienta con
  `AttributeError` si se corre. O se completa la migración o se borra el test;
  tal como está no prueba nada.
- **Más temporadas de datos:** bloqueado por el plan free de football-data.org. Es
  lo único que convertiría el "empate estadístico" del afinado en una respuesta
  real.
- **xG real** (tier de pago): el techo de un modelo basado solo en goles
  marcados/encajados ronda un skill score del 9-10%; el actual ya está en 7.5%.

## Convenciones para seguir trabajando aquí

- No reabrir el debate de `PSEUDO_PARTIDOS`/`rho` ni el prior de ascendidos sin
  datos nuevos (más temporadas) — ya se demostró que con los datos actuales
  cualquier conclusión es ruido. Ver "Afinado del modelo" arriba.
- Cualquier cambio al modelo debe pasar por `backtest.py` sobre LaLiga 2023+2024
  como mínimo, y usar el test pareado de `afinar.py` para saber si una diferencia
  es real o ruido antes de adoptarla.
- Antes de depurar "la web no se actualiza", mirar Render → Events primero.
- Los hilos de fondo (keep-alive, actualizador) solo se activan si existe
  `RENDER_EXTERNAL_URL` — en local no consumen cuota de API al importar `app.py`.
