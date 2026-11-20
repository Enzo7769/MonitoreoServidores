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

async function enParalelo(tareas, limite) {
  let i = 0;
  const trabajador = async () => {
    while (i < tareas.length) await tareas[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(limite, tareas.length) }, trabajador));
}

module.exports = { probarTcp, pedirAuto, leerJson, enParalelo };
