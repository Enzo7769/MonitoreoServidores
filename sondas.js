// Funciones de bajo nivel para probar un puerto: TCP y HTTP(S).
const http = require('http');
const https = require('https');
const net = require('net');

function probarTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const fin = (ok, codigo) => {
      sock.destroy();
      resolve({ ok, codigo, ms: Date.now() - t0 });
    };
    sock.setTimeout(timeoutMs, () => fin(false, 'ETIMEDOUT')); // siempre en la fase de conexión
    sock.once('connect', () => fin(true));
    sock.once('error', (e) => fin(false, e.code || e.message));
  });
}

function pedir(proto, host, port, ruta, timeoutMs, { metodo = 'GET', cuerpo, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const mod = proto === 'https' ? https : http;
    const t0 = Date.now();
    const cabeceras = { 'User-Agent': 'MonitorAPIs/1.0', ...headers };
    if (cuerpo) {
      cabeceras['Content-Type'] = 'application/json';
      cabeceras['Content-Length'] = Buffer.byteLength(cuerpo);
    }
    const req = mod.request(
      { host, port, path: ruta, method: metodo, rejectUnauthorized: false, headers: cabeceras },
      (res) => {
        let texto = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (texto.length < 4000) texto += c; });
        res.on('end', () => {
          clearTimeout(limite);
          resolve({ codigo: res.statusCode, cuerpo: texto, headers: res.headers, ms: Date.now() - t0 });
        });
      }
    );
    // Para el diagnóstico: distinguir "no conectó" (firewall/apagado) de "conectó y no respondió" (API colgada).
    let conectado = false;
    req.on('socket', (s) => {
      if (!s.connecting) conectado = true;
      else s.once('connect', () => { conectado = true; });
    });
    const limite = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), {
      code: 'ETIMEDOUT', fase: conectado ? 'respuesta' : 'conexion',
    })), timeoutMs);
    req.on('error', (e) => { clearTimeout(limite); reject(e); });
    req.end(cuerpo);
  });
}

// Errores que indican "hablaste HTTPS a un servidor HTTP" (o al revés).
const ERRORES_TLS = new Set(['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'ECONNRESET']);

// Prueba primero el protocolo preferido y, si falla por TLS, el otro.
async function pedirAuto(protoPreferido, host, port, ruta, timeoutMs, opciones) {
  const orden = protoPreferido === 'http' ? ['http', 'https'] : ['https', 'http'];
  try {
    return { proto: orden[0], ...(await pedir(orden[0], host, port, ruta, timeoutMs, opciones)) };
  } catch (e) {
    if (!ERRORES_TLS.has(e.code) && !/ssl|tls/i.test(e.message)) throw e;
    return { proto: orden[1], ...(await pedir(orden[1], host, port, ruta, timeoutMs, opciones)) };
  }
}

function leerJson(texto) {
  try { return JSON.parse(texto); } catch { return null; }
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Los WebSockets de DTS son Socket.IO: el saludo real es una petición "polling" de Engine.IO,
// que debe responder 200 con una sesión: 0{"sid":"...", ...}  (EIO=3 antepone el largo: "96:0{...").
const RUTA_SOCKETIO = '/socket.io/?EIO=4&transport=polling';
const esSesionSocketIO = (codigo, cuerpo) => codigo === 200 && /^(\d+:)?0\{.*"sid"/s.test(cuerpo || '');

async function probarSocketIO(protoPreferido, host, port, timeoutMs) {
  let r = await pedirAuto(protoPreferido, host, port, RUTA_SOCKETIO, timeoutMs);
  // Servidores con python-socketio antiguo solo hablan Engine.IO 3.
  if (r.codigo === 400 && /unsupported|version/i.test(r.cuerpo)) {
    r = await pedirAuto(r.proto, host, port, RUTA_SOCKETIO.replace('EIO=4', 'EIO=3'), timeoutMs);
  }
  return { ...r, sesion: esSesionSocketIO(r.codigo, r.cuerpo) };
}

async function enParalelo(tareas, limite) {
  let i = 0;
  const trabajador = async () => {
    while (i < tareas.length) await tareas[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(limite, tareas.length) }, trabajador));
}

module.exports = { probarTcp, pedirAuto, probarSocketIO, RUTA_SOCKETIO, leerJson, esperar, enParalelo };
