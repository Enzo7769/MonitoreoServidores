// Monitor de APIs por servidor.
// Revisa cada cierto intervalo los puertos de servidores.json, guarda cada revisión
// en MongoDB y sirve un dashboard (el HTML solo visualiza; el monitoreo corre aquí).
//
// Uso: node monitor.js   ->  http://localhost:8090   (en producción: pm2, ver README.md)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { puertos: catalogo, serviciosGateway } = require('./catalogo');
const { pedirAuto, probarSocketIO, RUTA_SOCKETIO, leerJson, esperar, enParalelo } = require('./sondas');
const analitica = require('./analitica');
const almacen = require('./almacen');
const descubrimiento = require('./descubrimiento');
const diagnostico = require('./diagnostico');
const demo = require('./demo');
const certificados = require('./certificados');
const { calcularDeriva } = require('./deriva');
const Incidentes = require('./incidentes');

const RUTA_CREDENCIALES = path.join(__dirname, 'credenciales.json');
const RUTA_EVENTOS = path.join(__dirname, 'logs', 'eventos.log');
const RUTA_REPORTES = path.join(__dirname, 'reportes');
const HISTORIAL_MAX = 30;

let config = leerConfig();
let credenciales = leerCredenciales();
const estado = new Map(); // clave -> resultado + historial
const protoCache = new Map(); // "host:puerto" -> 'https' | 'http'
const tokens = new Map(); // host -> { token } | { error }
const logins = new Map(); // host -> Promise en curso (evita logins duplicados en paralelo)
const certs = new Map(); // host -> resumen de certificados SSL (ver certificados.js)
const incidentes = new Incidentes(almacen);
let ultimaRevision = null;
let proximaRevision = null;
let revisando = false;

// Valores por defecto de la fase 1 (se pueden cambiar en servidores.json).
const opcion = (clave, porDefecto) => config[clave] ?? porDefecto;
const ESPERAS_CONFIRMACION = () => opcion('confirmacionEsperasMs', [3000, 8000]);
const INTERVALO_FALLA_MS = () => opcion('intervaloFallaSegundos', 60) * 1000;
const SSL_AVISO_DIAS = () => opcion('sslAvisoDias', 30);
const SSL_CADA_MS = () => opcion('sslRevisarHoras', 6) * 3600e3;

const enMantencion = (srv) => !!srv.mantencion && srv.mantencion.hasta > Date.now();

function leerConfig() {
  return descubrimiento.leerConfig();
}

// credenciales.json (opcional): { "default": { "idEjecutivo": "...", "password": "..." }, "cormupa": {...} }
function leerCredenciales() {
  try { return JSON.parse(fs.readFileSync(RUTA_CREDENCIALES, 'utf8')); } catch { return {}; }
}

function definicionPuerto(srv, puerto) {
  if (srv.gateway?.puerto === puerto) {
    const nombre = descubrimiento.tipoDe(srv) === 'proxy' ? 'Proxy (APIGatewayFila)' : 'APIGatewayFila';
    return { nombre, health: ['/health', '/ping'] };
  }
  return catalogo[puerto] || { nombre: `Puerto ${puerto}` };
}

// nivel: 'ok' (verde) | 'aviso' (amarillo) | 'error' (rojo) | 'sinacceso' (gris)
async function revisarApi(srv, puerto) {
  const def = definicionPuerto(srv, puerto);
  const clave = `${srv.host}:${puerto}`;
  const { timeoutMs, lentoMs } = config;

  const ctx = { nombre: def.nombre, host: srv.host, puerto, ws: def.tipo === 'ws', timeoutMs, lentoMs };

  if (def.tipo === 'ws') {
    // Socket.IO: no basta con que el puerto esté abierto, tiene que entregar una sesión.
    ctx.ruta = RUTA_SOCKETIO;
    let r;
    try {
      r = await probarSocketIO(protoCache.get(clave), srv.host, puerto, timeoutMs);
    } catch (e) {
      return conError('error', diagnostico.deRed(e, ctx));
    }
    protoCache.set(clave, r.proto);
    const base = { ms: r.ms, codigo: r.codigo, ruta: RUTA_SOCKETIO, cuerpo: r.cuerpo.slice(0, 300) };
    if (!r.sesion) return conError('aviso', diagnostico.noSocketIO(r.codigo, r.cuerpo, ctx), base);
    if (r.ms > lentoMs) return conError('aviso', diagnostico.lenta(r.ms, ctx), base);
    return { ...base, nivel: 'ok', detalle: 'Socket.IO acepta sesiones' };
  }

  let ultimo = null;
  for (const ruta of def.health || ['/api/health', '/health']) {
    ctx.ruta = ruta;
    let r;
    try {
      r = await pedirAuto(protoCache.get(clave), srv.host, puerto, ruta, timeoutMs);
    } catch (e) {
      return conError('error', diagnostico.deRed(e, ctx));
    }
    protoCache.set(clave, r.proto);
    const base = { ms: r.ms, codigo: r.codigo, ruta, cuerpo: r.cuerpo.slice(0, 300) };

    if (r.codigo >= 200 && r.codigo < 300) {
      if (r.ms > lentoMs) return conError('aviso', diagnostico.lenta(r.ms, ctx), base);
      return { ...base, nivel: 'ok', detalle: 'Health OK' };
    }
    if (r.codigo === 401 || r.codigo === 403) {
      return { ...base, nivel: 'ok', detalle: `Responde (health pide token · HTTP ${r.codigo})` };
    }
    if (r.codigo === 429) {
      return conError('aviso', diagnostico.limitada(r.codigo, r.cuerpo, ctx), base);
    }
    if (r.codigo >= 500 && r.codigo !== 501) {
      // Un health que devuelve 5xx suele significar Mongo u otra dependencia caída.
      return conError('error', diagnostico.deHttp(r.codigo, r.cuerpo, ctx), base);
    }
    ultimo = base; // 404, 501 (no implementado), 400, 405, 3xx…: probar la siguiente ruta
  }
  // El proceso contesta HTTP pero no tiene ruta de health: está vivo.
  if (ultimo.ms > lentoMs) return conError('aviso', diagnostico.lenta(ultimo.ms, ctx), { ...ultimo, sinHealth: true });
  return { ...ultimo, nivel: 'ok', sinHealth: true, detalle: `Viva (sin /health · HTTP ${ultimo.codigo})` };
}

// Resultado con diagnóstico: "detalle" es el título corto; "error" trae causa y sugerencia.
function conError(nivel, error, extra = {}) {
  return { ...extra, nivel, detalle: error.titulo, error };
}

// ---- Revisión a través de APIGatewayFila -------------------------------------

function credencialesDe(srv) {
  return credenciales[srv.nombre] || credenciales[srv.host] || credenciales.default || null;
}

async function obtenerToken(srv, forzar) {
  if (!forzar && tokens.has(srv.host)) return tokens.get(srv.host);
  if (logins.has(srv.host)) return logins.get(srv.host);

  const cred = credencialesDe(srv);
  if (!cred) return { error: null };

  const promesa = (async () => {
    let resultado;
    try {
      const r = await pedirAuto(protoCache.get(`${srv.host}:${srv.gateway.puerto}`), srv.host, srv.gateway.puerto,
        '/login/login', config.timeoutMs, { metodo: 'POST', cuerpo: JSON.stringify(cred) });
      const json = leerJson(r.cuerpo);
      // Según la versión, el token viene en el cuerpo o en la cookie "token".
      const token = json?.token || tokenDeCookie(r.headers['set-cookie']);
      resultado = token ? { token } : { error: json?.message || `login respondió ${r.codigo} sin token` };
    } catch (e) {
      resultado = { error: `login falló: ${e.code || e.message}` };
    }
    tokens.set(srv.host, resultado);
    logins.delete(srv.host);
    return resultado;
  })();
  logins.set(srv.host, promesa);
  return promesa;
}

function tokenDeCookie(setCookie = []) {
  const valores = setCookie
    .map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('token='))
    .map((c) => decodeURIComponent(c.slice('token='.length)))
    .filter(Boolean);
  return valores[valores.length - 1] || null;
}

async function revisarServicioGateway(srv, servicio) {
  const { puerto } = srv.gateway;
  const clave = `${srv.host}:${puerto}`;
  const ruta = `/${servicio}/health`;
  const { timeoutMs, lentoMs } = config;

  const consultar = async (token) => {
    const headers = token ? { Authorization: `Bearer ${token}`, Cookie: `token=${token}` } : {};
    const r = await pedirAuto(protoCache.get(clave), srv.host, puerto, ruta, timeoutMs, { headers });
    protoCache.set(clave, r.proto);
    return r;
  };

  const nombreApi = serviciosGateway[servicio] || servicio;
  const puertoInterno = Object.entries(catalogo).find(([, d]) => d.nombre === nombreApi)?.[0];
  const ctx = { nombre: nombreApi, host: srv.host, viaGateway: true, servicio, puertoGateway: puerto, puertoInterno, timeoutMs, lentoMs };

  let r;
  let sesion = tokens.get(srv.host);
  try {
    r = await consultar(sesion?.token);
    // El gateway pide JWT: hacer login (o renovar el token vencido) y reintentar una vez.
    if (r.codigo === 401 && /JWT|token/i.test(r.cuerpo) && credencialesDe(srv)) {
      sesion = await obtenerToken(srv, true);
      if (sesion.token) r = await consultar(sesion.token);
    }
  } catch (e) {
    // No respondió el gateway mismo: el diagnóstico apunta a él, no a la API de atrás.
    const nombreGw = descubrimiento.tipoDe(srv) === 'proxy' ? 'el proxy (APIGatewayFila)' : 'APIGatewayFila';
    return conError('error', diagnostico.deRed(e, { ...ctx, nombre: nombreGw, viaGateway: false, puerto, ruta }));
  }

  const base = { ms: r.ms, codigo: r.codigo, ruta: `${ruta} (gateway :${puerto})`, cuerpo: r.cuerpo.slice(0, 300) };
  const json = leerJson(r.cuerpo);

  if (r.codigo >= 200 && r.codigo < 300) {
    if (r.ms > lentoMs) return conError('aviso', diagnostico.lenta(r.ms, ctx), base);
    return { ...base, nivel: 'ok', detalle: 'Health OK' };
  }
  if (r.codigo === 401 && json?.mensajeError) {
    // Rechazo del propio gateway: no llegamos a la API.
    if (!credencialesDe(srv)) return { ...base, nivel: 'sinacceso', detalle: 'Requiere JWT (configura credenciales.json)' };
    return conError('aviso', diagnostico.loginFallido(sesion?.error || json.mensajeError, ctx), base);
  }
  if (r.codigo === 404 && json?.serviciosDisponibles) {
    return conError('aviso', diagnostico.servicioRetirado(ctx), base);
  }
  if (r.codigo === 429) {
    // El rate limit puede ser del gateway (globalLimiter) o de la API.
    return conError('aviso', diagnostico.limitada(r.codigo, r.cuerpo, ctx), base);
  }
  if (r.codigo >= 500 && r.codigo !== 501) {
    // 502/503 del gateway = la API de atrás no responde (o circuit breaker abierto).
    return conError('error', diagnostico.deHttp(r.codigo, r.cuerpo, ctx), base);
  }
  // 401/403/404/501… de la API real: el proceso está vivo.
  if (r.codigo === 404 || r.codigo === 501) return { ...base, nivel: 'ok', sinHealth: true, detalle: `Viva (sin /health · HTTP ${r.codigo})` };
  return { ...base, nivel: 'ok', detalle: `Responde (HTTP ${r.codigo})` };
}

// -----------------------------------------------------------------------------

function registrarEvento(texto) {
  const linea = `${new Date().toISOString()}  ${texto}\n`;
  process.stdout.write(linea);
  fs.mkdirSync(path.dirname(RUTA_EVENTOS), { recursive: true });
  fs.appendFileSync(RUTA_EVENTOS, linea);
}

function guardarResultado(clave, etiqueta, r, srv) {
  const previo = estado.get(clave);
  const historial = [...(previo?.historial || []), r.nivel].slice(-HISTORIAL_MAX);
  const cambio = !previo || previo.nivel !== r.nivel;
  const nota = srv && enMantencion(srv) ? ' [en mantención]' : '';
  if (previo && cambio && etiqueta) {
    const porQue = r.error ? `${r.error.titulo} — ${r.error.causa} [${r.error.tecnico}]` : r.detalle;
    registrarEvento(`${etiqueta}  ${previo.nivel} -> ${r.nivel}  (${porQue})${nota}`);
  }
  if (r.fallaMomentanea && etiqueta) registrarEvento(`${etiqueta}  falla momentánea (${r.fallaMomentanea}), se recuperó al reintentar${nota}`);
  const ultimoOk = r.nivel === 'ok' ? Date.now() : previo?.ultimoOk ?? null;
  estado.set(clave, { ...r, historial, ultimoOk, desde: cambio ? Date.now() : previo.desde, revisado: Date.now() });
}

// Servidores a vigilar: los de servidores.json más el de demostración si está activo.
function servidoresActivos() {
  return config.demo ? [...config.servidores, demo.SERVIDOR] : config.servidores;
}

// Cada API de un servidor como "ítem": su clave en el estado y cómo revisarla.
function itemsDe(srv) {
  if (srv.demo) {
    return [
      ...srv.puertos.map((puerto) => ({ id: String(puerto), clave: `${srv.host}:${puerto}`, revisar: async () => demo.resultadoPuerto(puerto) })),
      ...srv.gateway.servicios.map((servicio) => ({ id: `gw:${servicio}`, clave: `${srv.host}:gw:${servicio}`, revisar: async () => demo.resultadoServicio(servicio) })),
    ];
  }
  return [
    ...srv.puertos.map((puerto) => ({
      id: String(puerto), clave: `${srv.host}:${puerto}`,
      etiqueta: `[${srv.nombre}] ${definicionPuerto(srv, puerto).nombre}:${puerto}`,
      revisar: () => revisarApi(srv, puerto),
    })),
    ...(srv.gateway?.servicios || []).map((servicio) => ({
      id: `gw:${servicio}`, clave: `${srv.host}:gw:${servicio}`,
      etiqueta: `[${srv.nombre}] gateway/${servicio}`,
      revisar: () => revisarServicioGateway(srv, servicio),
    })),
  ];
}

// Confirmar antes de alarmar: si falla, se reintenta (por defecto a los 3 s y a los 8 s).
// Solo es caída si falla todas las veces; si se recupera, queda como "falla momentánea".
async function conConfirmacion(revisar) {
  const primera = await revisar();
  if (primera.nivel !== 'error') return primera;
  let ultima = primera;
  for (const espera of ESPERAS_CONFIRMACION()) {
    await esperar(espera);
    ultima = await revisar();
    if (ultima.nivel !== 'error') return { ...ultima, fallaMomentanea: primera.error?.titulo || primera.detalle };
  }
  return { ...ultima, intentos: ESPERAS_CONFIRMACION().length + 1 };
}

// Nivel que se guarda en MongoDB: durante una mantención no cuenta para la disponibilidad.
const codigoHistorial = (srv, r) => (enMantencion(srv) && r.nivel !== 'ok' ? 'm' : analitica.CODIGO[r.nivel]);

// Una tarea por API. filtro: para revisar solo algunas (el seguimiento de las caídas).
function tareasDe(srv, anotar = () => {}, { confirmar = true, filtro = () => true } = {}) {
  return itemsDe(srv).filter(filtro).map((item) => async () => {
    const r = confirmar && !srv.demo ? await conConfirmacion(item.revisar) : await item.revisar();
    guardarResultado(item.clave, item.etiqueta, r, srv);
    if (!srv.demo) anotar(srv, item.id, r); // el servidor de demostración nunca llega a MongoDB
  });
}

// Revisa un solo servidor (recién agregado o re-detectado) para que se vea de inmediato.
// No se guarda en MongoDB: el historial sigue el ritmo normal de cada 15 minutos.
async function revisarServidor(srv) {
  await enParalelo(tareasDe(srv), 30);
  await evaluarIncidentes();
}

// Si ya hay una revisión en curso, se espera esa en vez de lanzar otra.
let cicloEnCurso = null;
function revisarTodo() {
  if (!cicloEnCurso) cicloEnCurso = ejecutarRevision().finally(() => { cicloEnCurso = null; });
  return cicloEnCurso;
}

async function ejecutarRevision() {
  revisando = true;
  try {
    config = leerConfig(); // así los cambios a servidores.json se toman sin reiniciar
    const credNuevas = leerCredenciales();
    if (JSON.stringify(credNuevas) !== JSON.stringify(credenciales)) tokens.clear();
    credenciales = credNuevas;

    const registro = {}; // para el historial del dashboard
    // [nivel, ms] o, si hubo falla, [nivel, ms, "tipo de error"] para los incidentes del dashboard.
    const anotar = (srv, id, r) => {
      const codigo = codigoHistorial(srv, r);
      registro[`${srv.nombre}|${id}`] = r.error ? [codigo, r.ms ?? null, r.error.titulo] : [codigo, r.ms ?? null];
    };
    await enParalelo(servidoresActivos().flatMap((srv) => tareasDe(srv, anotar)), 60);
    ultimaRevision = Date.now();
    await almacen.guardarCiclo(ultimaRevision, registro);
    cacheCiclos.clear();
    await evaluarIncidentes();
  } catch (e) {
    console.error('Error en revisión:', e);
  } finally {
    revisando = false;
  }
}

// ---- Seguimiento rápido: mientras algo esté caído, se revisa solo eso cada 1 minuto ----
// Así se sabe con precisión cuándo volvió. No se guarda en "revisiones" (que sigue cada
// 15 min para no distorsionar la disponibilidad); la hora exacta queda en el incidente.

const seguimiento = { activo: false, proxima: null, timer: null, ultima: null };

const enFalla = (srv) => (item) => estado.get(item.clave)?.nivel === 'error';
const hayFallasReales = () => config.servidores.some((srv) => !enMantencion(srv) && itemsDe(srv).some(enFalla(srv)));

function programarSeguimiento() {
  clearTimeout(seguimiento.timer);
  if (!hayFallasReales()) {
    Object.assign(seguimiento, { activo: false, proxima: null });
    return;
  }
  seguimiento.activo = true;
  seguimiento.proxima = Date.now() + INTERVALO_FALLA_MS();
  seguimiento.timer = setTimeout(revisionRapida, INTERVALO_FALLA_MS());
}

async function revisionRapida() {
  // Si la revisión completa está por empezar o en curso, ella se encarga.
  if (cicloEnCurso || (proximaRevision && proximaRevision - Date.now() < 20000)) return programarSeguimiento();
  try {
    const tareas = config.servidores.flatMap((srv) => tareasDe(srv, undefined, { confirmar: false, filtro: enFalla(srv) }));
    await enParalelo(tareas, 30);
    seguimiento.ultima = Date.now();
    await evaluarIncidentes();
  } catch (e) {
    console.error('Error en el seguimiento rápido:', e);
  }
  programarSeguimiento();
}

// ---- Incidentes agrupados por causa raíz -------------------------------------

const ERRORES_DE_RED = new Set(['PUERTO_CERRADO', 'TIMEOUT_CONEXION', 'TIMEOUT_RESPUESTA', 'CONEXION_CORTADA', 'DNS', 'INALCANZABLE', 'SSL']);
const nombreItem = (a) => `${a.nombre}${a.servicio ? ' /' + a.servicio : ' :' + a.puerto}`;

// Convierte el estado actual en grupos de falla: un servidor caído entero, MongoDB caído
// (varias APIs con error de base de datos), el gateway caído, o cada API por separado.
function agruparFallas() {
  const grupos = new Map();
  for (const s of construirEstado({ conIncidentes: false }).servidores) {
    if (s.mantencion) continue;
    const srvCfg = servidoresActivos().find((x) => x.nombre === s.nombre);
    const persistir = !s.demo;
    const vigiladas = s.apis.filter((a) => a.nivel !== 'sinacceso' && a.nivel !== 'pendiente');
    let fallas = vigiladas.filter((a) => a.nivel === 'error');
    const agregar = (clave, g) => grupos.set(`${s.nombre}|${clave}`, { servidor: s.nombre, persistir, ...g });

    const sslInc = certificados.incidenteSsl(s.nombre, s.host, s.ssl);
    if (sslInc) agregar('ssl', { alcance: 'ssl', ...sslInc });
    if (!fallas.length) continue;

    // "Servidor sin respuesta" solo si fallan todas y ninguna alcanzó a responder HTTP
    // (si alguna devolvió un 500, el servidor está arriba: son fallas de cada API).
    if (vigiladas.length >= 2 && fallas.length === vigiladas.length && fallas.every((a) => ERRORES_DE_RED.has(a.error?.tipo))) {
      const tipos = new Set(fallas.map((a) => a.error?.tipo));
      const comun = tipos.size === 1 ? fallas[0].error : null;
      agregar('servidor', {
        alcance: 'servidor', nivel: 'error', titulo: 'Servidor sin respuesta', tipo: comun?.titulo || 'Todas las APIs fallan',
        causa: comun ? `Las ${fallas.length} APIs de ${s.host} fallan con el mismo error. ${comun.causa}` : `Las ${fallas.length} APIs de ${s.host} fallan a la vez: el servidor está apagado, sin red o con un problema general.`,
        sugerencia: comun?.sugerencia || `Entra a ${s.host} y revisa que esté encendido, con red y con espacio en disco.`,
        apis: fallas.map(nombreItem),
      });
      continue;
    }

    const mongo = fallas.filter((a) => a.error?.tipo === 'MONGO');
    if (mongo.length >= 2) {
      agregar('mongo', {
        alcance: 'mongo', nivel: 'error', titulo: `MongoDB no disponible (${mongo.length} APIs)`, tipo: 'Base de datos no disponible',
        causa: `${mongo.length} APIs de ${s.host} no pueden conectarse a MongoDB al mismo tiempo: el problema es la base de datos, no cada API.`,
        sugerencia: mongo[0].error.sugerencia, apis: mongo.map(nombreItem),
      });
      fallas = fallas.filter((a) => !mongo.includes(a));
    }

    const puertoGw = srvCfg?.gateway?.puerto;
    // El propio puerto del gateway y los servicios que pasan por él (todos tienen puerto = puertoGw).
    const gwCaido = fallas.filter((a) => a.puerto === puertoGw && ERRORES_DE_RED.has(a.error?.tipo));
    if (puertoGw && gwCaido.length >= 2) {
      agregar('gateway', {
        alcance: 'gateway', nivel: 'error', titulo: `Gateway sin respuesta (${gwCaido.length} APIs)`, tipo: gwCaido[0].error.titulo,
        causa: `El gateway de ${s.host} (:${puertoGw}) no responde, así que ninguna API que depende de él es alcanzable. ${gwCaido[0].error.causa}`,
        sugerencia: gwCaido[0].error.sugerencia, apis: gwCaido.map(nombreItem),
      });
      fallas = fallas.filter((a) => !gwCaido.includes(a));
    }

    for (const a of fallas) {
      agregar(a.id, {
        alcance: 'api', nivel: 'error', titulo: nombreItem(a), tipo: a.error?.titulo || a.detalle,
        causa: a.error?.causa || a.detalle, sugerencia: a.error?.sugerencia || '', apis: [nombreItem(a)],
      });
    }
  }
  return grupos;
}

async function evaluarIncidentes() {
  try {
    await incidentes.evaluar(agruparFallas());
  } catch (e) {
    console.error('Error evaluando incidentes:', e);
  }
}

incidentes.on('abierto', (i) => registrarEvento(`[${i.servidor}] INCIDENTE abierto: ${i.titulo} — ${i.tipo}`));
incidentes.on('resuelto', (i) => registrarEvento(`[${i.servidor}] INCIDENTE resuelto: ${i.titulo} (duró ${Math.round((i.fin - i.inicio) / 60000)} min)`));

// ---- Certificados SSL (cada 6 h por servidor) --------------------------------

async function revisarCertificados() {
  const pendientes = config.servidores.filter((srv) => Date.now() - (certs.get(srv.host)?.revisado || 0) > SSL_CADA_MS());
  await enParalelo(pendientes.map((srv) => async () => {
    const puertos = [...new Set([...srv.puertos, ...(srv.gateway ? [srv.gateway.puerto] : [])])];
    certs.set(srv.host, await certificados.revisarServidor(srv.host, puertos, { timeoutMs: config.timeoutMs, avisoDias: SSL_AVISO_DIAS() }));
  }), 4);
  if (pendientes.length) await evaluarIncidentes();
}

const PENDIENTE = { nivel: 'pendiente', detalle: 'Esperando primera revisión', historial: [] };

// Solo se comparan APIs conocidas (catálogo); rutas internas del gateway como /status no cuentan.
function derivaActual() {
  const reales = config.servidores.map((s) => ({
    ...s,
    tipo: descubrimiento.tipoDe(s),
    puertos: s.puertos.filter((p) => catalogo[p]),
    gateway: s.gateway && { ...s.gateway, servicios: s.gateway.servicios.filter((sv) => serviciosGateway[sv]) },
  }));
  return calcularDeriva(reales, (p) => catalogo[p].nombre, (sv) => serviciosGateway[sv]);
}

function construirEstado({ conIncidentes = true } = {}) {
  const deriva = derivaActual();
  return {
    actualizado: ultimaRevision,
    proximaRevision,
    revisando,
    seguimiento: { activo: seguimiento.activo, proxima: seguimiento.proxima, ultima: seguimiento.ultima, cadaSegundos: INTERVALO_FALLA_MS() / 1000 },
    mongo: almacen.conectado(),
    intervaloSegundos: config.intervaloSegundos,
    ...(conIncidentes ? { incidentes: incidentes.lista() } : {}),
    servidores: servidoresActivos().map((srv) => ({
      nombre: srv.nombre,
      host: srv.host,
      tipo: descubrimiento.tipoDe(srv),
      demo: !!srv.demo,
      mantencion: enMantencion(srv) ? srv.mantencion : null,
      ssl: srv.demo ? demo.certificado() : certs.get(srv.host) || null,
      deriva: deriva.get(srv.nombre) || null,
      apis: [
        ...srv.puertos.map((puerto) => {
          const def = definicionPuerto(srv, puerto);
          return {
            id: `${puerto}`,
            puerto,
            nombre: def.nombre,
            tipo: def.tipo || 'api',
            ...(estado.get(`${srv.host}:${puerto}`) || PENDIENTE),
          };
        }),
        ...(srv.gateway?.servicios || []).map((servicio) => ({
          id: `gw:${servicio}`,
          puerto: srv.gateway.puerto,
          servicio,
          nombre: serviciosGateway[servicio] || servicio,
          tipo: 'gateway',
          ...(estado.get(`${srv.host}:gw:${servicio}`) || PENDIENTE),
        })),
      ],
    })),
  };
}

function nombreApi(nombreServidor, id) {
  if (id.startsWith('gw:')) {
    const servicio = id.slice(3);
    return `${serviciosGateway[servicio] || servicio} /${servicio}`;
  }
  const srv = config.servidores.find((s) => s.nombre === nombreServidor) || {};
  return `${definicionPuerto(srv, Number(id)).nombre} :${id}`;
}

// Estado actual (no histórico) para los indicadores "ahora" del dashboard.
function resumenActual(filtroServidor) {
  const servidores = construirEstado({ conIncidentes: false }).servidores.filter((s) => !filtroServidor || s.nombre === filtroServidor);
  let apis = 0, caidas = 0, conProblemas = 0;
  for (const s of servidores) {
    if (s.mantencion) continue; // en mantención: sus fallas son esperables
    const vigiladas = s.apis.filter((a) => a.nivel !== 'sinacceso' && a.nivel !== 'pendiente');
    apis += vigiladas.length;
    caidas += vigiladas.filter((a) => a.nivel === 'error').length;
    if (vigiladas.some((a) => a.nivel === 'error' || a.nivel === 'aviso')) conProblemas++;
  }
  return { servidores: servidores.length, apis, caidas, conProblemas };
}

function enviarJson(res, datos) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(datos));
}

// ---- Lecturas desde MongoDB (con caché hasta la siguiente revisión) ----------

const cacheCiclos = new Map(); // horas -> Promise<ciclos>
function ciclosDe(horas) {
  if (!cacheCiclos.has(horas)) {
    const promesa = almacen.leerCiclos(Date.now() - horas * 3600e3);
    promesa.catch(() => cacheCiclos.delete(horas));
    cacheCiclos.set(horas, promesa);
  }
  return cacheCiclos.get(horas);
}

const zona = () => config.zonaHoraria || 'America/Santiago';

// Ciclos de un día local: se pide un margen de ±1 día y se filtra por fecha local.
async function resumenDe(fecha) {
  const base = Date.parse(`${fecha}T00:00:00Z`);
  const ciclos = await almacen.leerCiclos(base - 86400e3, base + 2 * 86400e3);
  return analitica.resumenDiario(ciclos, fecha, zona(), config.intervaloSegundos, nombreApi);
}

// Guarda en reportes/ el CSV de ayer si todavía no existe (corre después de cada revisión).
async function generarReporteDeAyer() {
  const ayer = analitica.fechaLocal(Date.now() - 86400e3, zona());
  const ruta = path.join(RUTA_REPORTES, `resumen-${ayer}.csv`);
  if (fs.existsSync(ruta) || !almacen.conectado()) return;
  const filas = await resumenDe(ayer);
  if (!filas.length) return;
  fs.mkdirSync(RUTA_REPORTES, { recursive: true });
  fs.writeFileSync(ruta, analitica.aCsv(filas));
  console.log(`Resumen diario guardado: ${ruta}`);
}

// ---- Pestaña "Servidores": agregar, re-detectar y eliminar ------------------

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let texto = '';
    req.on('data', (c) => { texto += c; if (texto.length > 10000) req.destroy(); });
    req.on('end', () => resolve(leerJson(texto) || {}));
    req.on('error', reject);
  });
}

function responder(res, codigo, datos) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(datos));
}

function resumenServidor(srv) {
  const s = construirEstado({ conIncidentes: false }).servidores.find((x) => x.nombre === srv.nombre);
  const vigiladas = (s?.apis || []).filter((a) => a.nivel !== 'sinacceso' && a.nivel !== 'pendiente');
  return {
    nombre: srv.nombre,
    host: srv.host,
    tipo: descubrimiento.tipoDe(srv),
    puertoGateway: srv.gateway?.puerto ?? null,
    demo: !!srv.demo,
    mantencion: s?.mantencion || null,
    ssl: s?.ssl || null,
    deriva: s?.deriva || null,
    directas: srv.puertos.length,
    viaGateway: srv.gateway?.servicios.length ?? 0,
    ok: vigiladas.filter((a) => a.nivel === 'ok').length,
    caidas: vigiladas.filter((a) => a.nivel === 'error').length,
    avisos: vigiladas.filter((a) => a.nivel === 'aviso').length,
    total: vigiladas.length,
  };
}

// Detecta y guarda; devuelve un aviso si el tipo elegido no calza con lo encontrado.
async function detectarYAplicar(srv) {
  const { puertoGateway } = descubrimiento.TIPOS[descubrimiento.tipoDe(srv)];
  const r = await descubrimiento.descubrirServidor(srv.host, { puertoGateway });
  srv.puertos = r.puertos;
  if (r.gateway) srv.gateway = r.gateway;
  else delete srv.gateway;

  if (!r.puertos.length) return 'No respondió ningún puerto: revisa el firewall o que el servidor esté encendido.';
  if (puertoGateway && !r.gateway) {
    return r.puertos.includes(puertoGateway)
      ? `El puerto ${puertoGateway} responde, pero no parece un gateway: solo se vigilan las APIs directas.`
      : `El puerto ${puertoGateway} no responde: solo se vigilan las APIs directas.`;
  }
  return null;
}

async function administrarServidores(req, res, url) {
  // GET /api/servidores -> lista
  if (req.method === 'GET' && url.pathname === '/api/servidores') {
    return responder(res, 200, { servidores: servidoresActivos().map(resumenServidor), tipos: descubrimiento.TIPOS, demo: !!config.demo });
  }

  // POST /api/servidores/demo { activo } -> mostrar u ocultar el servidor de demostración
  if (req.method === 'POST' && url.pathname === '/api/servidores/demo') {
    const { activo } = await leerCuerpo(req);
    const cfg = leerConfig();
    cfg.demo = !!activo;
    descubrimiento.guardarConfig(cfg);
    config = cfg;
    if (cfg.demo) await revisarServidor(demo.SERVIDOR);
    else for (const clave of [...estado.keys()]) if (clave.startsWith(`${demo.SERVIDOR.host}:`)) estado.delete(clave);
    return responder(res, 200, { demo: cfg.demo });
  }

  // POST /api/servidores { host, tipo } -> agregar
  if (req.method === 'POST' && url.pathname === '/api/servidores') {
    const cuerpo = await leerCuerpo(req);
    const host = descubrimiento.normalizarHost(cuerpo.host);
    const tipo = cuerpo.tipo in descubrimiento.TIPOS ? cuerpo.tipo : 'directo';
    if (!descubrimiento.hostValido(host)) return responder(res, 400, { error: 'Escribe un dominio válido, por ejemplo maipu.dts.lat' });

    const cfg = leerConfig();
    const nombre = descubrimiento.nombreDesdeHost(host);
    if (cfg.servidores.some((s) => s.host === host)) return responder(res, 409, { error: `${host} ya está en la lista.` });
    if (cfg.servidores.some((s) => s.nombre === nombre)) return responder(res, 409, { error: `Ya existe un servidor llamado "${nombre}".` });

    const srv = { nombre, host, tipo, puertos: [] };
    let aviso;
    try {
      aviso = await detectarYAplicar(srv);
    } catch (e) {
      return responder(res, 422, { error: e.code === 'ENOTFOUND' ? `${host} no existe (el DNS no lo encuentra).` : `No se pudo revisar ${host}: ${e.message}` });
    }
    if (!srv.puertos.length) return responder(res, 422, { error: aviso });

    cfg.servidores.push(srv);
    descubrimiento.guardarConfig(cfg);
    config = cfg;
    registrarEvento(`[${nombre}] servidor agregado (${descubrimiento.TIPOS[tipo].nombre}, ${srv.puertos.length} puertos${srv.gateway ? `, ${srv.gateway.servicios.length} servicios vía :${srv.gateway.puerto}` : ''})`);
    await revisarServidor(srv);
    return responder(res, 201, { servidor: resumenServidor(srv), aviso });
  }

  // POST /api/servidores/redetectar { nombre } -> volver a detectar sus APIs
  if (req.method === 'POST' && url.pathname === '/api/servidores/redetectar') {
    const { nombre } = await leerCuerpo(req);
    if (nombre === demo.SERVIDOR.nombre) return responder(res, 400, { error: 'El servidor de demostración es simulado: no tiene APIs que detectar.' });
    const cfg = leerConfig();
    const srv = cfg.servidores.find((s) => s.nombre === nombre);
    if (!srv) return responder(res, 404, { error: 'Servidor no encontrado' });
    let aviso;
    try {
      aviso = await detectarYAplicar(srv);
    } catch (e) {
      return responder(res, 422, { error: e.code === 'ENOTFOUND' ? `${srv.host} no existe (el DNS no lo encuentra).` : e.message });
    }
    descubrimiento.guardarConfig(cfg);
    config = cfg;
    await revisarServidor(srv);
    return responder(res, 200, { servidor: resumenServidor(srv), aviso });
  }

  // POST /api/servidores/mantencion { nombre, minutos, motivo } -> silenciar (minutos 0 = terminar)
  if (req.method === 'POST' && url.pathname === '/api/servidores/mantencion') {
    const { nombre, minutos, motivo } = await leerCuerpo(req);
    const cfg = leerConfig();
    const srv = cfg.servidores.find((s) => s.nombre === nombre);
    if (!srv) return responder(res, 404, { error: 'Servidor no encontrado' });
    const min = Math.min(Math.max(Number(minutos) || 0, 0), 24 * 60);
    if (min > 0) {
      srv.mantencion = { desde: Date.now(), hasta: Date.now() + min * 60000, motivo: String(motivo || '').slice(0, 200) };
      registrarEvento(`[${nombre}] en mantención por ${min} min${srv.mantencion.motivo ? ` (${srv.mantencion.motivo})` : ''}`);
    } else {
      delete srv.mantencion;
      registrarEvento(`[${nombre}] fin de la mantención`);
    }
    descubrimiento.guardarConfig(cfg);
    config = cfg;
    if (min === 0) await revisarServidor(srv); // ver de inmediato cómo quedó
    else await evaluarIncidentes(); // cierra sus incidentes abiertos
    return responder(res, 200, { servidor: resumenServidor(srv) });
  }

  // POST /api/servidores/vigilar { nombre, puertos[], servicios[] } -> sumar APIs que "deberían" estar
  if (req.method === 'POST' && url.pathname === '/api/servidores/vigilar') {
    const { nombre, puertos = [], servicios = [] } = await leerCuerpo(req);
    const cfg = leerConfig();
    const srv = cfg.servidores.find((s) => s.nombre === nombre);
    if (!srv) return responder(res, 404, { error: 'Servidor no encontrado' });
    const nuevosPuertos = puertos.map(Number).filter((p) => catalogo[p] && !srv.puertos.includes(p));
    srv.puertos = [...srv.puertos, ...nuevosPuertos].sort((a, b) => a - b);
    const nuevosServicios = srv.gateway ? servicios.filter((sv) => typeof sv === 'string' && !srv.gateway.servicios.includes(sv)) : [];
    if (nuevosServicios.length) srv.gateway.servicios.push(...nuevosServicios);
    descubrimiento.guardarConfig(cfg);
    config = cfg;
    registrarEvento(`[${nombre}] se vigilan además: ${[...nuevosPuertos.map((p) => `:${p}`), ...nuevosServicios.map((sv) => `/${sv}`)].join(', ')}`);
    await revisarServidor(srv);
    return responder(res, 200, { servidor: resumenServidor(srv) });
  }

  // DELETE /api/servidores?nombre=maipu -> eliminar
  if (req.method === 'DELETE' && url.pathname === '/api/servidores') {
    const nombre = url.searchParams.get('nombre');
    const cfg = leerConfig();
    if (nombre === demo.SERVIDOR.nombre) {
      cfg.demo = false;
      descubrimiento.guardarConfig(cfg);
      config = cfg;
      for (const clave of [...estado.keys()]) if (clave.startsWith(`${demo.SERVIDOR.host}:`)) estado.delete(clave);
      return responder(res, 200, { eliminado: nombre });
    }
    const srv = cfg.servidores.find((s) => s.nombre === nombre);
    if (!srv) return responder(res, 404, { error: 'Servidor no encontrado' });
    cfg.servidores = cfg.servidores.filter((s) => s !== srv);
    descubrimiento.guardarConfig(cfg);
    config = cfg;
    for (const clave of [...estado.keys()]) if (clave.startsWith(`${srv.host}:`)) estado.delete(clave);
    tokens.delete(srv.host);
    registrarEvento(`[${nombre}] servidor eliminado del monitoreo`);
    return responder(res, 200, { eliminado: nombre });
  }

  return responder(res, 405, { error: 'Operación no permitida' });
}

// ---- Acceso al dashboard -----------------------------------------------------

// Si credenciales.json tiene "dashboard": { "usuario": "...", "clave": "..." }, se pide login.
function autorizado(req) {
  const acceso = credenciales.dashboard;
  if (!acceso?.usuario) return true;
  const [tipo, valor] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !valor) return false;
  return Buffer.from(valor, 'base64').toString() === `${acceso.usuario}:${acceso.clave}`;
}

function enviarPagina(res, archivo) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, 'public', archivo)).pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  try {
    if (!autorizado(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Monitor de APIs", charset="UTF-8"' });
      return res.end('Requiere usuario y clave');
    }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/estado') return enviarJson(res, construirEstado());

    if (url.pathname === '/api/revisar' && req.method === 'POST') {
      await revisarTodo();
      programarSeguimiento();
      return enviarJson(res, construirEstado());
    }

    if (url.pathname === '/api/analitica') {
      const horas = Math.min(Math.max(Number(url.searchParams.get('horas')) || 24, 1), 24 * 90);
      const filtro = url.searchParams.get('servidor') || null;
      const datos = analitica.calcular(await ciclosDe(horas), { horas, servidor: filtro }, nombreApi);
      // Incidentes agrupados (colección "incidentes", con hora exacta). Si todavía no hay
      // ninguno guardado, se mantienen los calculados desde las revisiones de cada 15 min.
      const guardados = await almacen.leerIncidentes(Date.now() - horas * 3600e3, { servidor: filtro }).catch(() => null);
      if (guardados && (guardados.length || !datos.incidentes.length)) {
        datos.incidentes = guardados.map((i) => ({
          inicio: i.inicio, fin: i.fin, servidor: i.servidor, api: i.titulo, tipo: i.tipo, alcance: i.alcance,
          apis: i.apis, nivel: i.nivel, activo: i.estado === 'activo', duracionMs: (i.fin ?? Date.now()) - i.inicio,
        }));
        datos.kpis.incidentes = guardados.filter((i) => i.nivel === 'error').length;
      }
      return enviarJson(res, {
        ...datos,
        ahora: resumenActual(filtro),
        servidores: config.servidores.map((s) => s.nombre),
        intervaloSegundos: config.intervaloSegundos,
        proximaRevision,
        mongo: almacen.conectado(),
      });
    }

    if (url.pathname === '/api/resumen.csv') {
      const fecha = url.searchParams.get('fecha') || analitica.fechaLocal(Date.now(), zona());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { res.writeHead(400); return res.end('fecha debe ser YYYY-MM-DD'); }
      const csv = analitica.aCsv(await resumenDe(fecha));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="resumen-${fecha}.csv"`,
      });
      return res.end(csv);
    }

    if (url.pathname.startsWith('/api/servidores')) return await administrarServidores(req, res, url);

    if (url.pathname === '/servidores') return enviarPagina(res, 'servidores.html');
    if (url.pathname === '/dashboard') return enviarPagina(res, 'dashboard.html');
    if (url.pathname === '/resumen') return enviarPagina(res, 'resumen.html');
    if (url.pathname === '/' || url.pathname === '/index.html') return enviarPagina(res, 'index.html');

    res.writeHead(404);
    res.end('No encontrado');
  } catch (e) {
    console.error('Error atendiendo', req.url, e);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Migración única: el historial que la versión anterior guardaba en archivo pasa a la
// cola de pendientes para que almacen.js lo suba a MongoDB.
function migrarHistorialLocal() {
  const viejo = path.join(__dirname, 'logs', 'historial.jsonl');
  if (!fs.existsSync(viejo)) return;
  fs.appendFileSync(path.join(__dirname, 'logs', 'pendientes.jsonl'), fs.readFileSync(viejo));
  fs.renameSync(viejo, path.join(__dirname, 'logs', 'historial.migrado.jsonl'));
}

async function conectarMongo() {
  migrarHistorialLocal();
  const mongoUri = process.env.MONGO_URI || config.mongoUri;
  if (!mongoUri) return console.error('Falta "mongoUri" en servidores.json: el historial no se guardará.');
  try {
    await almacen.conectar({ mongoUri, mongoDb: config.mongoDb, retencionDias: config.retencionDias || 30 });
    await incidentes.cargar();
    console.log(`Historial en MongoDB: ${mongoUri.replace(/\/\/[^@/]*@/, '//***@')} base "${config.mongoDb || 'monitorAPIs'}"`);
  } catch (e) {
    console.error(`No se pudo conectar a MongoDB (${e.message}). Se reintenta en la próxima revisión.`);
  }
}

const puertoDashboard = Number(process.env.PUERTO_DASHBOARD) || config.puertoDashboard;
servidor.listen(puertoDashboard, () => {
  console.log(`Monitor de APIs en http://localhost:${puertoDashboard}`);
  console.log(`Revisando ${config.servidores.length} servidores cada ${config.intervaloSegundos}s. Cambios de estado en logs/eventos.log\n`);
});

(async function ciclo() {
  if (!almacen.conectado()) await conectarMongo();
  await revisarTodo();
  proximaRevision = Date.now() + config.intervaloSegundos * 1000;
  programarSeguimiento();
  revisarCertificados().catch((e) => console.error('Error revisando certificados:', e.message));
  generarReporteDeAyer().catch((e) => console.error('Error generando resumen diario:', e.message));
  setTimeout(ciclo, config.intervaloSegundos * 1000);
})();
