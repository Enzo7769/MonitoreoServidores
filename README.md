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

## Configuración (`servidores.json`)

| Campo | Para qué |
|---|---|
| `intervaloSegundos` | Cada cuánto revisa (900 = 15 min) |
| `timeoutMs` / `lentoMs` | Espera máxima por API / sobre cuánto se marca "lenta" |
| `puertoDashboard` | Puerto web del monitor (8090) |
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
