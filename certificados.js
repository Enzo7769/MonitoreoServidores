// Revisión de certificados SSL: fecha de vencimiento y validez para el dominio.
// Cada API tiene su propia carpeta cert/, así que se revisa cada puerto por separado:
// basta con que una API tenga un certificado viejo para que esa API deje de funcionar.

const tls = require('tls');
const net = require('net');

// Lee el certificado que presenta host:puerto. Si el puerto no habla TLS, devuelve { sinTls: true }.
function leerCertificado(host, puerto, timeoutMs = 5000) {
  return new Promise((resolve) => {
    // SNI solo admite nombres de dominio, no IPs.
    const s = tls.connect({ host, port: puerto, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: false });
    const fin = (r) => { clearTimeout(limite); s.destroy(); resolve(r); };
    const limite = setTimeout(() => fin({ error: 'ETIMEDOUT' }), timeoutMs);
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      if (!c || !c.valid_to) return fin({ error: 'SIN_CERTIFICADO' });
      fin({
        venceEl: Date.parse(c.valid_to),
        emisor: c.issuer?.O || c.issuer?.CN || '',
        sujeto: c.subject?.CN || '',
        huella: c.fingerprint256,
        valido: s.authorized,
        errorValidez: s.authorized ? null : String(s.authorizationError || ''),
      });
    });
    s.once('error', (e) => fin(/wrong version|EPROTO|packet length/i.test(e.message + e.code) ? { sinTls: true } : { error: e.code || e.message }));
  });
}

const PROBLEMAS_VALIDEZ = {
  CERT_HAS_EXPIRED: 'el certificado está vencido',
  ERR_TLS_CERT_ALTNAME_INVALID: 'el certificado no corresponde a este dominio',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'es un certificado autofirmado',
  SELF_SIGNED_CERT_IN_CHAIN: 'la cadena tiene un certificado autofirmado',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'falta el certificado intermedio (cadena incompleta)',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'falta el certificado intermedio (cadena incompleta)',
};
const textoValidez = (codigo) => PROBLEMAS_VALIDEZ[codigo] || codigo;

// Revisa todos los puertos TLS de un servidor y resume: el que vence primero y los inválidos.
async function revisarServidor(host, puertos, { timeoutMs, avisoDias }) {
  const ahora = Date.now();
  const lecturas = [];
  for (const puerto of puertos) {
    const r = await leerCertificado(host, puerto, timeoutMs);
    if (r.sinTls || r.error) continue;
    lecturas.push({ puerto, ...r, dias: Math.floor((r.venceEl - ahora) / 86400e3) });
  }
  if (!lecturas.length) return { revisado: ahora, puertos: [] };

  const masProximo = lecturas.reduce((a, b) => (b.venceEl < a.venceEl ? b : a));
  const invalidos = lecturas.filter((l) => !l.valido && l.errorValidez !== 'CERT_HAS_EXPIRED');
  const vencidos = lecturas.filter((l) => l.dias < 0);
  const porVencer = lecturas.filter((l) => l.dias >= 0 && l.dias <= avisoDias);

  let nivel = 'ok';
  if (vencidos.length) nivel = 'error';
  else if (porVencer.length || invalidos.length) nivel = 'aviso';

  return {
    revisado: ahora,
    nivel,
    venceEl: masProximo.venceEl,
    dias: masProximo.dias,
    emisor: masProximo.emisor,
    puertos: lecturas.map(({ puerto, venceEl, dias, valido, errorValidez, emisor }) => ({ puerto, venceEl, dias, valido, problema: errorValidez ? textoValidez(errorValidez) : null, emisor })),
    vencidos: vencidos.map((l) => l.puerto),
    porVencer: porVencer.map((l) => l.puerto),
    invalidos: invalidos.map((l) => ({ puerto: l.puerto, problema: textoValidez(l.errorValidez) })),
    distintos: new Set(lecturas.map((l) => l.huella)).size,
  };
}

// Incidente (o null) a partir del resumen de certificados de un servidor.
function incidenteSsl(srvNombre, host, c) {
  if (!c || c.nivel === 'ok' || !c.nivel) return null;
  const lista = (ps) => ps.map((p) => `:${p}`).join(', ');
  if (c.vencidos.length) {
    return { nivel: 'error', titulo: 'Certificado SSL vencido', tipo: 'SSL vencido',
      causa: `El certificado de ${host} está vencido en ${lista(c.vencidos)}: los navegadores y los fronts rechazan la conexión.`,
      sugerencia: 'Renueva el certificado (carpeta cert/ de cada API) y reinicia las APIs afectadas.', apis: c.vencidos.map((p) => `:${p}`) };
  }
  if (c.porVencer.length) {
    return { nivel: 'aviso', titulo: `Certificado SSL vence en ${c.dias} ${c.dias === 1 ? 'día' : 'días'}`, tipo: 'SSL por vencer',
      causa: `El certificado de ${host} vence el ${new Date(c.venceEl).toLocaleDateString('es-CL')} (${lista(c.porVencer)}). Al vencer, esas APIs dejan de responder por HTTPS.`,
      sugerencia: 'Renueva el certificado antes de esa fecha y cópialo a la carpeta cert/ de cada API.', apis: c.porVencer.map((p) => `:${p}`) };
  }
  return { nivel: 'aviso', titulo: 'Certificado SSL con problemas', tipo: 'SSL inválido',
    causa: `En ${host}: ${c.invalidos.map((i) => `:${i.puerto} ${i.problema}`).join('; ')}.`,
    sugerencia: 'Revisa que cada API use el certificado del dominio con su cadena completa.', apis: c.invalidos.map((i) => `:${i.puerto}`) };
}

module.exports = { leerCertificado, revisarServidor, incidenteSsl };
