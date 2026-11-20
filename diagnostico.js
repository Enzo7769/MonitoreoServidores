// Traduce una falla técnica (código de red, HTTP, respuesta del gateway) a:
//   { tipo, titulo, causa, sugerencia, tecnico }
// para mostrar en las páginas qué pasó, por qué suele pasar y qué revisar.
//
// ctx: { nombre, host, puerto, ws, viaGateway, servicio, puertoInterno, ruta, timeoutMs, lentoMs }

const seg = (ms) => `${Math.round(ms / 1000)} s`;

const ERRORES_TLS = /^(CERT_|ERR_TLS|ERR_SSL|EPROTO|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_SSL)/;

function donde(ctx) {
  return ctx.viaGateway
    ? `${ctx.host}:${ctx.puertoGateway}/${ctx.servicio}`
    : `${ctx.host}:${ctx.puerto}`;
}

const revisarProceso = (ctx) =>
  `En ${ctx.host}: revisa ${ctx.nombre} con "pm2 status" y "pm2 logs", o "docker ps -a" y "docker logs"; mira el último error y reiníciala.`;

// Falla de red: no se obtuvo respuesta HTTP.
function deRed(e, ctx) {
  const codigo = e.code || e.codigo || e.message || 'desconocido';
  const tecnico = `${ctx.ws ? 'TCP' : 'GET'} ${donde(ctx)}${ctx.ruta && !ctx.ws ? ctx.ruta : ''} → ${codigo}${e.fase ? ` (${e.fase})` : ''}`;
  const base = { tipo: codigo, tecnico };

  if (codigo === 'ECONNREFUSED') {
    if (ctx.ws) {
      return { ...base, tipo: 'PUERTO_CERRADO', titulo: 'WebSocket detenido',
        causa: `Nada está escuchando en el puerto ${ctx.puerto}: el proceso Python de ${ctx.nombre} no está corriendo (se detuvo o se cayó).`,
        sugerencia: `${revisarProceso(ctx)} Revisa también su archivo *Error.txt o la carpeta logs/.` };
    }
    return { ...base, tipo: 'PUERTO_CERRADO', titulo: 'Puerto cerrado: API detenida',
      causa: `Nada está escuchando en el puerto ${ctx.puerto}: el proceso de ${ctx.nombre} está detenido o se cayó al arrancar (error en el código, en el .env o puerto ocupado).`,
      sugerencia: revisarProceso(ctx) };
  }

  if (codigo === 'ETIMEDOUT' && e.fase === 'respuesta') {
    return { ...base, tipo: 'TIMEOUT_RESPUESTA', titulo: 'API colgada (no responde)',
      causa: `${ctx.nombre} aceptó la conexión pero no respondió en ${seg(ctx.timeoutMs)}: está bloqueada, sobrecargada o esperando una consulta lenta (por ejemplo a MongoDB).`,
      sugerencia: `Revisa CPU y memoria del proceso ("pm2 monit") y sus logs; si sigue igual, reiníciala. Verifica que MongoDB responda.` };
  }
  if (codigo === 'ETIMEDOUT') {
    return { ...base, tipo: 'TIMEOUT_CONEXION', titulo: 'Sin respuesta al conectar',
      causa: `El servidor no aceptó la conexión al puerto ${ctx.viaGateway ? ctx.puertoGateway : ctx.puerto} en ${seg(ctx.timeoutMs)}: un firewall bloquea el puerto, o el servidor está apagado o saturado.`,
      sugerencia: `Verifica que ${ctx.host} esté encendido y que el firewall (GCP / ufw) permita ese puerto.` };
  }
  if (codigo === 'ECONNRESET' || codigo === 'EPIPE' || /socket hang up/i.test(codigo)) {
    return { ...base, tipo: 'CONEXION_CORTADA', titulo: 'Conexión cortada',
      causa: `${ctx.nombre} cerró la conexión sin responder: el proceso se reinició o se cayó durante la petición, o falló la negociación SSL.`,
      sugerencia: `Revisa en "pm2 status" si tiene reinicios (columna ↺) y sus logs a esa hora.` };
  }
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') {
    return { ...base, tipo: 'DNS', titulo: 'El dominio no resuelve (DNS)',
      causa: `${ctx.host} no se encuentra en el DNS: el dominio cambió, expiró o hay un problema temporal de DNS.`,
      sugerencia: `Prueba "nslookup ${ctx.host}" y revisa el registro DNS del dominio.` };
  }
  if (codigo === 'EHOSTUNREACH' || codigo === 'ENETUNREACH') {
    return { ...base, tipo: 'INALCANZABLE', titulo: 'Servidor inalcanzable',
      causa: `No hay ruta de red hasta ${ctx.host}: el servidor está apagado o hay un problema de red.`,
      sugerencia: `Verifica en la consola de GCP que la máquina esté encendida.` };
  }
  if (ERRORES_TLS.test(codigo)) {
    return { ...base, tipo: 'SSL', titulo: 'Error de SSL / certificado',
      causa: `No se pudo establecer HTTPS con ${ctx.nombre}: certificado vencido o inválido, o la API tiene mal configurado SSL (carpeta cert/).`,
      sugerencia: `Revisa los certificados de la API y su fecha de vencimiento.` };
  }
  return { ...base, titulo: `Error de red (${codigo})`,
    causa: `Falla de red no clasificada al conectar con ${ctx.nombre}.`,
    sugerencia: `Revisa los logs de la API y la conectividad con ${ctx.host}.` };
}

// Extrae un mensaje legible de la respuesta (JSON o HTML).
function mensajeDe(cuerpo) {
  if (!cuerpo) return '';
  try {
    const j = JSON.parse(cuerpo);
    const m = j.mensajeError || j.message || j.mensaje || j.error || j.detalle || j.status;
    return typeof m === 'string' ? m : JSON.stringify(m ?? j).slice(0, 160);
  } catch {
    return cuerpo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
}

const pareceMongo = (texto) => /mongo|27017|MongoServerSelectionError|MongoNetworkError|topology|buffering timed out/i.test(texto);

// Respuesta HTTP de error (5xx) de la API o del gateway.
function deHttp(codigo, cuerpo, ctx) {
  const msg = mensajeDe(cuerpo);
  const tecnico = `GET ${donde(ctx)}${ctx.viaGateway ? '/health' : ctx.ruta || ''} → HTTP ${codigo}${msg ? ` · "${msg}"` : ''}`;
  const delGateway = ctx.viaGateway && /mensajeError/.test(cuerpo || '');

  if (pareceMongo(msg)) {
    return { tipo: 'MONGO', tecnico, titulo: 'Base de datos no disponible',
      causa: `${ctx.nombre} respondió ${codigo} porque no puede conectarse a MongoDB${msg ? `: "${msg}"` : '.'}`,
      sugerencia: `Revisa que MongoDB esté arriba ("systemctl status mongod" o su contenedor) y la cadena de conexión del .env de la API.` };
  }

  if (ctx.viaGateway && codigo === 502) {
    return { tipo: 'GW_502', tecnico, titulo: 'El gateway no llega a la API (502)',
      causa: `El gateway responde, pero ${ctx.nombre} detrás de él (localhost:${ctx.puertoInterno ?? '?'}) no contesta: la API está detenida o caída.`,
      sugerencia: revisarProceso(ctx) };
  }
  if (ctx.viaGateway && codigo === 503) {
    return { tipo: 'GW_503', tecnico, titulo: 'Circuito abierto en el gateway (503)',
      causa: `El gateway dejó de enviar peticiones a ${ctx.nombre} después de varias fallas seguidas (circuit breaker). Lo vuelve a intentar solo en ~60 s.`,
      sugerencia: `El problema real está en ${ctx.nombre}: ${revisarProceso(ctx)}` };
  }
  if (codigo === 504) {
    return { tipo: 'HTTP_504', tecnico, titulo: 'La API tardó demasiado (504)',
      causa: `${ctx.viaGateway ? 'El gateway' : 'El proxy'} esperó a ${ctx.nombre} y no respondió a tiempo: está colgada o muy lenta.`,
      sugerencia: `Revisa CPU, memoria y logs de ${ctx.nombre}; verifica que MongoDB responda rápido.` };
  }
  if (delGateway) {
    return { tipo: 'GW_ERROR', tecnico, titulo: `Error del gateway (${codigo})`,
      causa: `El gateway falló al reenviar la petición a ${ctx.nombre}${msg ? `: "${msg}"` : '.'}`,
      sugerencia: `Revisa los logs de APIGatewayFila en ${ctx.host}.` };
  }
  if (codigo === 502) {
    return { tipo: 'HTTP_502', tecnico, titulo: 'Error de pasarela (502)',
      causa: `Un intermediario no obtuvo respuesta válida: un proxy delante de ${ctx.nombre} no llega a ella, o ${ctx.nombre} llama a otro servicio que está caído${msg ? `. Mensaje: "${msg}"` : '.'}`,
      sugerencia: `Revisa si hay un proxy (nginx / Apache) delante de la API y los servicios que ${ctx.nombre} consume; mira sus logs.` };
  }
  if (codigo === 503) {
    return { tipo: 'HTTP_503', tecnico, titulo: 'Servicio no disponible (503)',
      causa: `${ctx.nombre} indica que no está lista: está arrancando, en mantención o una dependencia está caída${msg ? `: "${msg}"` : '.'}`,
      sugerencia: `Revisa los logs de ${ctx.nombre}.` };
  }
  return { tipo: `HTTP_${codigo}`, tecnico, titulo: `Error interno de la API (${codigo})`,
    causa: `${ctx.nombre} respondió ${codigo}: algo falló dentro de la API (excepción no controlada o dependencia caída)${msg ? `. Mensaje: "${msg}"` : '.'}`,
    sugerencia: `Revisa los logs de ${ctx.nombre} (carpeta logs/ o "pm2 logs") a la hora del error.` };
}

function lenta(ms, ctx) {
  return { tipo: 'LENTA', tecnico: `GET ${donde(ctx)}${ctx.viaGateway ? '/health' : ctx.ruta || ''} → ${ms} ms (límite ${ctx.lentoMs} ms)`,
    titulo: `Lenta (${ms.toLocaleString('es-CL')} ms)`,
    causa: `${ctx.nombre} respondió bien pero tardó ${ms.toLocaleString('es-CL')} ms (el límite es ${ctx.lentoMs.toLocaleString('es-CL')} ms): carga alta en el servidor, consultas lentas a MongoDB o red congestionada.`,
    sugerencia: `Si se repite, revisa CPU y memoria del servidor ("pm2 monit") y los tiempos de MongoDB.` };
}

// 429: la API (o el gateway) está limitando peticiones. Responde, así que es aviso, no caída.
function limitada(codigo, cuerpo, ctx) {
  const msg = mensajeDe(cuerpo);
  const quien = ctx.viaGateway && /mensajeError|gateway/i.test(cuerpo || '') ? 'El gateway' : ctx.nombre;
  return { tipo: 'HTTP_429', tecnico: `GET ${donde(ctx)}${ctx.viaGateway ? '/health' : ctx.ruta || ''} → HTTP ${codigo}${msg ? ` · "${msg}"` : ''}`,
    titulo: 'Demasiadas peticiones (429)',
    causa: `${quien} está rechazando peticiones por límite de tasa (rate limit): recibe más tráfico del permitido. La API está viva, pero algunos usuarios pueden estar recibiendo errores.`,
    sugerencia: `Revisa si hay tráfico anormal o si el límite (express-rate-limit / globalLimiter del gateway) es demasiado bajo para la operación normal.` };
}

function loginFallido(error, ctx) {
  return { tipo: 'LOGIN', tecnico: `POST ${ctx.host}:${ctx.puertoGateway}/login/login → ${error}`,
    titulo: 'Login del monitor falló',
    causa: `El gateway pide JWT y el usuario de credenciales.json fue rechazado: ${error}. Sin login no se puede revisar ${ctx.nombre}.`,
    sugerencia: `Revisa idEjecutivo y password en credenciales.json (y que el usuario no tenga cambio de clave pendiente).` };
}

function servicioRetirado(ctx) {
  return { tipo: 'GW_SIN_SERVICIO', tecnico: `GET ${donde(ctx)}/health → 404 Servicio no encontrado`,
    titulo: 'El gateway ya no publica este servicio',
    causa: `El gateway de ${ctx.host} ya no tiene configurado "${ctx.servicio}" (config/apis.js).`,
    sugerencia: `Si fue a propósito, usa "Re-detectar" en la pestaña Servidores para actualizar la lista.` };
}

module.exports = { deRed, deHttp, lenta, limitada, loginFallido, servicioRetirado };
