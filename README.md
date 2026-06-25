# Mundial 2026: fixtures, directo y cuotas

Backend serverless para cruzar partidos, directo, estadísticas y cuotas del
Mundial 2026. El proveedor principal es la API FIFA World Cup de balldontlie;
si no hay clave o el plan no permite un endpoint, el sistema degrada a
Fixtur.es, ESPN, Wikipedia y The Odds API según el caso.

La pestaña PRO también incluye KPIs deportivos del torneo y está protegida por
una sesión HTTP-only que se destruye al abandonar el apartado.

Los KPIs de equipos y partidos usan balldontlie cuando está configurado. Las
fuentes públicas siguen como respaldo y dejan marcadas como no disponibles las
métricas de jugador que no publiquen.

## Endpoint

`GET /api/unified-matches`

Parámetros opcionales:

- `from`, `to`: filtros por fecha del feed de fixtures.
- `sportKey`: fuerza una clave, pero se valida contra `/v4/sports`.

La respuesta incluye:

- IDs del fixture y del evento de cuotas.
- Features disponibles en el feed de fixtures.
- Cuotas 1X2 por casa.
- Overround por casa, probabilidades implícitas sin margen y mejor precio.
- Método y confianza de la reconciliación.
- Partidos no reconciliados y metadatos de caché/cuota.

Otros endpoints:

- `GET /api/live-matches`: partidos activos, marcador, estadísticas e incidencias.
- `POST /api/analysis-auth`: registra solicitudes o inicia una sesión PRO.
- `DELETE /api/analysis-auth`: cierra y elimina la sesión PRO.
- `GET /api/tournament-stats`: líderes y KPIs del torneo.
- `GET /api/picks`: picks del modelo y analítica de mercado.

## Variables de entorno

Configura en Vercel, nunca en el navegador:

```dotenv
BALLDONTLIE_API_KEY=...
BALLDONTLIE_SEASON=2026
ODDS_API_KEY=...
ODDS_SPORT_TITLE_HINTS=FIFA World Cup,World Cup,soccer_fifa_world_cup
ODDS_REGIONS=eu,uk
ODDS_MARKETS=h2h
ESPN_WORLDCUP_LEAGUE=fifa.world
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_PRO_USERS_COLLECTION=pro_users
ANALYSIS_SESSION_SECRET=...
PRO_ADMIN_PASSWORD=...
```

`BALLDONTLIE_API_KEY` también puede llamarse `BDL_API_KEY`. Para este proyecto
se usan endpoints de balldontlie como `matches`, `odds`, `rosters`,
`match_events` y `team_match_stats`; según su documentación, esos endpoints de
Mundial requieren clave y los de partidos/cuotas/stats están en el tier GOAT.
Si la clave falta o el plan responde 401/429/5xx, el backend intenta los
respaldos sin romper la respuesta pública.

## Acceso PRO con Firebase

1. Crea un proyecto Firebase y una base Cloud Firestore.
2. En `Configuración del proyecto > Cuentas de servicio`, genera una clave.
3. Añade sus valores como variables de entorno en Vercel.
4. Despliega las reglas cerradas con `firebase deploy --only firestore:rules`.
5. El cliente hace el Bizum y crea una solicitud con teléfono y PIN.
6. Abre `/admin.html`, inicia sesión y aprueba o revoca cada solicitud.

La contraseña se valida únicamente en el servidor mediante
`PRO_ADMIN_PASSWORD`. Usa un valor largo, único y distinto del secreto de
sesión.

También puedes activar una cuenta desde terminal:

```bash
npm run pro:activate -- +34611476090
```

Las solicitudes se guardan en `pro_users` con `status: "pending"`. El panel o
el script las cambia a `status: "active"` y `active: true`. Tras la aprobación,
el navegador registrado abre PRO sin volver a pedir teléfono ni PIN. La
sesión corta se elimina al salir de PRO y se recrea solo si el usuario sigue
aprobado. El PIN se deriva con `scrypt` y nunca se almacena en texto claro.
Tras cinco intentos incorrectos, la cuenta queda bloqueada durante quince
minutos.

## Arquitectura

```text
api/unified-matches.js
lib/
  cache.js
  config.js
  orchestrator.js
  merger.js
  reconciler.js
  providers/
    ballDontLieFifaProvider.js
    oddsProvider.js
    fixturesIcsProvider.js
  sources/
    espnLiveMatches.js
    espnScoreboard.js
    wikipediaWorldCup.js
```

Los proveedores/fuentes son los únicos módulos que conocen URLs, autenticación
y forma de respuesta externa. El orquestador prioriza balldontlie para
fixtures/cuotas y, si no está disponible, resuelve el `sport_key` de The Odds
API, descarga fixtures/cuotas de respaldo, reconcilia y fusiona.

## Reconciliación

Un partido se casa por:

1. Pareja local/visitante normalizada.
2. Fecha y hora dentro de una ventana de 90 minutos.
3. Coincidencia exacta, alias o similitud Levenshtein como último recurso.
4. Orientación directa o invertida, porque el Mundial se juega en sede neutral.

Los alias están en `DEFAULT_ALIAS_GROUPS` dentro de
`lib/reconciler.js`. Para añadir uno, incorpora todas sus variantes al mismo
grupo. Los no reconciliados se registran y se devuelven en `unmatched`.
La respuesta indica `orientacion: "same" | "swapped"`. Se puede desactivar el
segundo caso con `MATCH_ALLOW_SWAPPED=false`.

El pipeline Python dispone de la misma estrategia en `ml/reconciler.py`, sin
dependencias externas.

## Caché y límites

- balldontlie FIFA World Cup: requiere `Authorization: <api key>`; los
  endpoints de partidos, cuotas, plantillas y estadísticas usados aquí son de
  tier GOAT según la documentación actual.
- The Odds API Starter: 500 créditos al mes, con reinicio el día 1; queda como
  respaldo de cuotas.
- Fixtur.es/ESPN/Wikipedia: fuentes públicas sin secreto propio; se consultan
  con caché HTTP/serverless y degradación segura si alguna cae.
- balldontlie fixtures/directo/cuotas: 5 minutos.
- Catálogo de The Odds API: 24 horas.
- Cuotas: 1 hora.
- Si una actualización falla o devuelve límite, se usa el último dato stale
  disponible en la misma instancia serverless.

The Odds API no cobra créditos por `/v4/sports`. La consulta configurada con
`regions=eu,uk` y `markets=h2h` cuesta normalmente 2 créditos: una región por
un mercado. Las cabeceras de cuota de ambos proveedores se exponen en
`sources` y se escriben en los logs de Vercel.

La caché en memoria es deliberadamente best-effort en Vercel. Para conservar
stale entre arranques en frío, sustituye `CacheStore` por Vercel KV, Redis o
otro almacén persistente manteniendo su interfaz.

## Desarrollo y pruebas

```bash
node --test test/*.test.js
python3 -m unittest discover -s ml -p 'test_*.py' -v
vercel dev
```

Prueba local:

```bash
curl "http://localhost:3000/api/unified-matches?enrichment=none"
```

Documentación oficial:

- [balldontlie FIFA World Cup API](https://fifa.balldontlie.io/)
- [The Odds API v4](https://the-odds-api.com/liveapi/guides/v4/)
