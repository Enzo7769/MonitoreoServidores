# Monitor de APIs

Revisa cada 15 minutos las APIs de todos los servidores, guarda cada revisión en
MongoDB y muestra los resultados en dos páginas:

- `/resumen` — **Resumen**: reporte tipo Newman con servidores operativos, con problemas y caídos.
- `/` — **Estado en vivo**: cada servidor con sus APIs (contraídos llenan la pantalla; clic para abrir).
- `/dashboard` — **Dashboard**: disponibilidad, tiempos de respuesta, mapa de fallas,
  incidentes y descarga del resumen diario en CSV.
- `/servidores` — **Servidores**: agregar un servidor escribiendo solo su dominio (Directo,
  Con gateway :3022 o Con proxy :3023), re-detectar sus APIs o eliminarlo (pide confirmación).

Las páginas solo visualizan. El monitoreo lo hace el proceso `monitor.js`, que sigue
funcionando aunque nadie tenga la página abierta.

## Dónde queda cada cosa

| Qué | Dónde |
|---|---|
| Revisiones (historial) | MongoDB, base `monitorAPIs`, colección `revisiones` (se borran solas después de `retencionDias`) |
| Resumen diario CSV | `reportes/resumen-AAAA-MM-DD.csv` (se genera solo después de medianoche) y descarga desde el dashboard |
| Cambios de estado | `logs/eventos.log` |
| Revisiones que no se pudieron guardar (Mongo caído) | `logs/pendientes.jsonl` — se suben solas cuando Mongo vuelve |

## Instalación en test.dts.lat (con MobaXterm)

1. Copia la carpeta `MonitorAPIs` al servidor (panel SFTP de MobaXterm), por ejemplo a
   `/opt/MonitorAPIs`. No hace falta copiar `node_modules`.
2. Por SSH:
   ```bash
   cd /opt/MonitorAPIs
   node -v              # necesita Node 18 o superior
   npm install --omit=dev
   pm2 start ecosystem.config.js
   pm2 save             # para que vuelva a arrancar si se reinicia el servidor
   pm2 logs monitor-apis --lines 20
   ```
   En `ecosystem.config.js` el monitor usa `mongodb://localhost:27017` (mismo servidor).
3. Para servir el panel por HTTPS, en `servidores.json` pon `"ssl.activo": true` y copia
   el certificado y la clave privada a las rutas de `ssl`
   (`certs/certificado.pem` y `certs/clave.key`, o las rutas absolutas que pongas ahí).
   El certificado tiene que corresponder a `test.dts.lat`. Con `"activo": false` el panel queda en HTTP.
4. Entra a `https://test.dts.lat:8090` (o `http://` si el SSL está apagado) — o, si el puerto no está abierto en el firewall,
   por un túnel SSH de MobaXterm (Tunneling → puerto local 8090 → `localhost:8090` del servidor)
   y abre `https://localhost:8090` en tu PC.

**Corre una sola instancia.** Si el monitor también está abierto en tu PC (`iniciar-monitor.bat`),
ciérralo: si no, cada revisión se guarda dos veces.

### Comandos útiles
```bash
pm2 status
pm2 restart monitor-apis     # después de cambiar código o catalogo.js
pm2 logs monitor-apis
node descubrir.js            # volver a detectar las APIs de cada servidor
```
Los cambios en `servidores.json` y `credenciales.json` se toman en la siguiente revisión, sin reiniciar.
El puerto (`puertoDashboard`) y el SSL se leen solo al arrancar: después de cambiarlos, `pm2 restart monitor-apis`.
**En test.dts.lat los puertos los fija `ecosystem.config.js`** (`PUERTO_DASHBOARD=3030`, `PUERTO_RUM=3031`), que manda
sobre `servidores.json`. Después de cambiar ese archivo hay que recargarlo: `pm2 restart ecosystem.config.js --update-env`
(un `pm2 restart monitor-apis` solo NO toma variables nuevas).

## Configuración (`servidores.json`)

| Campo | Para qué |
|---|---|
| `intervaloSegundos` | Cada cuánto revisa (900 = 15 min) |
| `timeoutMs` / `lentoMs` | Espera máxima por API / sobre cuánto se marca "lenta" |
| `puertoDashboard` | Puerto web del monitor (8090 en un PC local; en test.dts.lat lo fija `PUERTO_DASHBOARD` = 3030) |
| `ssl.activo` | `true` sirve el panel por HTTPS; `false` lo deja en HTTP. El certificado y la clave solo se leen si está en `true`. |
| `ssl.certificado` / `ssl.clave` | Rutas del certificado y de la clave privada. Relativas a la carpeta del proyecto, o absolutas. `ssl.ca` (cadena) y `ssl.frase` (si la clave está cifrada) son opcionales. |
| `retencionDias` | Días que se guardan las revisiones en MongoDB |
| `zonaHoraria` | Zona para cortar los días del resumen diario |
| `mongoUri` / `mongoDb` | Conexión a MongoDB (la variable `MONGO_URI` tiene prioridad) |
| `confirmacionEsperasMs` | Reintentos antes de dar una API por caída (por defecto `[3000, 8000]`: a los 3 s y a los 8 s) |
| `intervaloFallaSegundos` | Mientras haya caídas, cada cuánto se revisan solo esas (por defecto 60) |
| `sslAvisoDias` / `sslRevisarHoras` | Avisar si un certificado vence en menos de N días (30) / cada cuánto revisarlos (6 h) |
| `demo` | Muestra el servidor simulado "Demo" (no se guarda en MongoDB) |
| `mongo` (en cada servidor) | Ping directo a MongoDB de ese servidor. Solo corre si `"activo": true`. Por defecto apagado (sin el campo, o `"activo": false`). Puerto 27017 si no se indica otro. Se enciende o apaga en la pestaña Servidores. |
| `slo` | Objetivos de disponibilidad mensual. Ej.: `{ "objetivo": 99.5, "porServicio": { "APITicket": 99.9 }, "porServidor": { "torax": 99.9 } }`. Prioridad: por servicio > por servidor > `objetivo` (99,5 si no se indica). |

| `rum` | Pantallas (visores, UAC, tótems) que reportan desde el navegador. Ver la sección "Pantallas". |

## Pantallas (pestaña "Pantallas")

Cada front carga `rum.js` desde el monitor y reporta desde el navegador: tiempos de carga, errores de JavaScript
(también los que la página captura y escribe con `console.error`), estado de cada WebSocket (envuelve `io()` de
socket.io), llamadas a APIs por endpoint (envuelve `fetch` y `XMLHttpRequest`, o sea también jQuery), memoria y bloqueos.
De las llamadas no se envía el cuerpo ni los parámetros: solo método, URL sin query (ids y RUT → `:id`) y si salió bien. Un latido cada 60 s. Detecta lo que el
monitor no ve desde el servidor: la red de una sucursal, un navegador colgado o un visor que perdió su WebSocket.

**En el front** (`index.html`), justo después del `<script>` de socket.io:
```html
<script src="https://test.dts.lat:3031/rum.js" data-tipo="visor" data-claves="idVisor,idSector,ipEquipo"></script>
```
`data-claves` son claves de `localStorage` que identifican al equipo (nunca datos de pacientes). El nombre
("Visor Centro Lebu") se le pone después en la pestaña Pantallas.

Sin `defer`: así `rum.js` alcanza a ver también los errores que ocurren mientras carga la página.

**Puerto público:** `rum.puerto` (8091 en local; **3031 en test.dts.lat**, vía `PUERTO_RUM`) expone **solo** `/rum.js` y
`/api/beacon`; el panel (8090 en local, 3030 en test) no queda expuesto por ese puerto.
Es el único puerto que hay que abrir en el firewall para las sucursales. Usa el mismo SSL del panel: si los fronts
están en `https://`, el monitor tiene que tener `ssl.activo: true` o el navegador bloquea el reporte.

| `rum.*` | Por defecto | Qué hace |
|---|---|---|
| `puerto` | — | Puerto público solo para pantallas. Sin él, se reporta al puerto del panel. |
| `sinLatidoMin` | 3 | Minutos sin reportes para abrir incidente "Pantalla sin reportar" |
| `socketMin` | 2 | Minutos con un WebSocket desconectado para abrir incidente |
| `erroresUmbral` | 20 | Errores de JavaScript (incluye `console.error`) en 15 min para avisar |
| `audioMin` | 15 | Audio: si la voz o el sonido fallaron en estos minutos y **no volvieron a sonar** → error ("Voz no suena…", "Sonido no suena…"); si fallaron pero después sonaron, o falla un video → aviso. Motivos: sonido automático bloqueado, archivo que no carga, voz que no avisa que terminó (cuelgue), sin parlantes, sin voz para el idioma. En el detalle se ven la voz usada y las voces instaladas en el equipo. |
| `llamadasMin` / `fallosUmbral` | 5 / 3 | Llamadas a APIs: si un endpoint falla `fallosUmbral` veces en `llamadasMin` min y **ninguna** sale bien → error ("No logra llamar a…"); si algunas sí salen bien → aviso. Falla = sin respuesta (CORS, red, certificado) o HTTP 5xx; un 401/404 es respuesta de la API y no cuenta. |
| `horario` | siempre | `{ "dias": [1,2,3,4,5,6], "desde": "07:00", "hasta": "21:00" }` (0 = domingo). Fuera de horario, una pantalla apagada no es incidente. |
| `olvidarDias` | 7 | Pantallas sin reportes por más días se borran solas |
| `token` | — | Si se define, el front debe mandarlo en `data-token` (filtra basura, no es secreto) |
| `detrasDeProxy` | false | `true` si el puerto público está detrás de nginx: toma la IP de `X-Forwarded-For` |

Cómo decide: **cerrar la página** no es incidente (queda "Cerrada"). **Sin reportes** por más de `sinLatidoMin`
→ incidente; si caen **todas las pantallas de una misma red** → un solo incidente "Sucursal sin conexión"; si caen
casi todas a la vez (≥ 80 %) → "No llegan reportes" (problema del monitor o de su puerto). **WebSocket
desconectado**: si el monitor también lo ve caído en el servidor, no se duplica (ya hay incidente del servidor); si
el servidor responde, es la red de la sucursal; si pasa en 3 o más sucursales → firewall/proxy/certificado de ese puerto.
MongoDB guarda el último estado (`pantallas`) y los eventos 30 días (`pantallas_eventos`).

## SLO y presupuesto de error (pestaña "SLO / SLA")

- **Objetivo (SLO):** disponibilidad que debe tener cada API en el **mes calendario** (zona `zonaHoraria`).
- **Presupuesto de error:** la caída que permite el objetivo. 99,5 % en 30 días = 3 h 36 min; 99,9 % = 43 min.
  Cada revisión con falla gasta el tiempo que duró (hasta la siguiente revisión).
- **Burn rate:** velocidad de gasto. 1× = se agota justo a fin de mes. Alertas (generan incidentes "SLO"):
  - **Consumo muy rápido:** ≥ 14,4× en la última hora y la API sigue fallando.
  - **Consumo rápido:** ≥ 6× en las últimas 6 h.
  - **No alcanza el mes:** ≥ 1× en los últimos 3 días y la proyección supera el 100 %.
  - **Incumplido:** presupuesto del mes agotado.
- **No descuentan presupuesto:** mantenciones, servicios "sin acceso" y las revisiones en que fallaron a la vez
  la mayoría de los servidores (≥ 60 %, al menos 3) y ≥ 20 % de todas las APIs: eso es casi seguro un corte de red
  del propio monitor, no de las APIs.
- **Informe SLA:** botón "Descargar informe SLA (CSV)" o `/api/slo.csv?mes=AAAA-MM`.
- Con el SLO mensual, MongoDB guarda al menos **35 días** de revisiones (aunque `retencionDias` sea menor).

## Cómo decide (fase 1)

- **Confirmación:** una API solo se da por caída si falla también en los reintentos; si se recupera, queda como "falla momentánea".
- **Seguimiento:** con alguna caída, se revisa solo eso cada minuto hasta que vuelva. La colección `revisiones` sigue cada 15 min (para no distorsionar la disponibilidad); la hora exacta queda en `incidentes`.
- **Incidentes agrupados** (colección `incidentes`): un servidor sin respuesta, MongoDB caído en varias APIs o el gateway caído cuentan como **un** incidente.
- **Socket.IO:** los WebSockets se validan pidiendo una sesión real (`/socket.io/?EIO=4&transport=polling`), no solo con el puerto abierto.
- **SSL:** se revisa el certificado de cada puerto; avisa si vence pronto, está vencido o no corresponde al dominio.
- **Diferencias entre servidores:** si casi todos tienen una API y uno no, se avisa (y se puede vigilar desde la pestaña Servidores).
- **Mantención:** desde la pestaña Servidores; mientras dura, las fallas no generan incidentes ni cuentan en la disponibilidad.

## Credenciales (`credenciales.json`, ver `credenciales.ejemplo.json`)

- `default`: usuario con el que el monitor entra al gateway (servidores con APIs solo vía gateway).
- `dashboard`: si se define, las páginas piden usuario y clave. **Recomendado en el servidor.**
