// Monitoreo desde los navegadores (RUM): visores, UAC y tótems reportan al monitor.
//
// Cada front carga public/rum.js, que manda a POST /api/beacon:
//   'hola'   al cargar la página (tiempos de carga)
//   'latido' cada 60 s (estado de cada WebSocket, memoria, bloqueos)
//   'socket' cuando un WebSocket se conecta o se corta
//   'error'  errores de JavaScript y console.error (agrupados en el navegador)
//   'llamada' cuando una llamada a una API falla (a lo más 1 cada 10 s por endpoint)
//   'audio'  cuando falla la voz, un sonido o un video (a lo más 1 cada 10 s por tipo)
//   'adios'  al cerrar la página
// Todos los mensajes traen el estado de los WebSockets y las llamadas a APIs desde el envío anterior.
//
// Este módulo guarda el último estado de cada pantalla (en memoria y en MongoDB,
// colección "pantallas"), los eventos (colección "pantallas_eventos", con TTL) y
// arma los grupos de falla que monitor.js entrega a incidentes.js.

const LIMITE_CUERPO = 8 * 1024;
const MAX_PANTALLAS = 2000;
const MAX_EVENTOS = 40;
const MAX_ERRORES = 30;
const INACTIVA_MS = 12 * 3600e3; // sin reportes por más de 12 h: ya no se vigila
const CUPO_IP_MINUTO = 600; // mensajes por minuto desde una misma IP (una sucursal entera sale por la misma)
const CUPO_PANTALLA_MINUTO = 30;
const TIPOS_MENSAJE = new Set(['hola', 'latido', 'socket', 'error', 'llamada', 'audio', 'adios']);
const TIPOS_AUDIO = { voz: 'Voz', sonido: 'Sonido', video: 'Video' };
const MAX_LLAMADAS = 40; // endpoints distintos que se recuerdan por pantalla
const ID_VALIDO = /^[a-z0-9-]{8,64}$/i;
const CLAVE_VALIDA = /^[\w.-]{1,40}$/;

const POR_DEFECTO = {
  sinLatidoMin: 3, // sin latidos por más de N min: la pantalla se cayó, se colgó o perdió la red
  socketMin: 2, // WebSocket desconectado por más de N min
  erroresUmbral: 20, // errores de JavaScript en 15 min para avisar
  llamadasMin: 5, // ventana para juzgar las llamadas a APIs
  fallosUmbral: 3, // fallos de un mismo endpoint en esa ventana: error si ninguna salió bien, aviso si algunas sí
  audioMin: 15, // si la voz o el sonido fallaron en estos minutos y no volvieron a sonar: error
  horario: null, // { "dias": [1,2,3,4,5,6], "desde": "07:00", "hasta": "21:00" } (0 = domingo). null = siempre
  olvidarDias: 7, // pantallas sin reportes por más de N días se borran solas
  retencionEventosDias: 30,
  token: null, // si se define, rum.js debe mandarlo (data-token)
};

const texto = (v, max = 200) =>
  (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const entero = (v, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function horaLocal(ts, zona) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zona, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ts).map((x) => [x.type, x.value]));
  return { dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutos: Number(p.hour) * 60 + Number(p.minute) };
}

const aMinutos = (hhmm, porDefecto) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : porDefecto;
};

function enHorario(ts, horario, zona) {
  if (!horario) return true;
  const { dia, minutos } = horaLocal(ts, zona);
  const dias = Array.isArray(horario.dias) ? horario.dias : [1, 2, 3, 4, 5, 6];
  return dias.includes(dia) && minutos >= aMinutos(horario.desde, 0) && minutos < aMinutos(horario.hasta, 1440);
}

const reloj = (ts, zona) => new Date(ts).toLocaleTimeString('es-CL', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const NOMBRE_TIPO = { visor: 'Visor', uac: 'UAC', totem: 'Tótem', front: 'Pantalla' };
const nombreTipo = (tipo) => NOMBRE_TIPO[tipo] || cap(tipo || 'pantalla');

// Qué revisar según por qué falló el audio.
function sugerenciaAudio(a) {
  const e = a.error || '';
  if (/bloqueó el sonido|no permite hablar/.test(e)) {
    return 'El navegador no deja sonar sin que alguien toque la pantalla: abre el visor con el acceso directo de kiosco (Chrome con --autoplay-policy=no-user-gesture-required) o haz un clic en la pantalla.';
  }
  if (/no avisó que terminó|por internet/.test(e) || / \[por internet\]/.test(a.voz || '')) {
    return 'La voz usada funciona por internet y puede colgarse: instala en el equipo la voz Microsoft Sabina (Español México) y recarga el visor.';
  }
  if (/archivo|red al bajar|no empezó/.test(e)) {
    return `Revisa que ${a.src || 'el archivo de audio'} responda desde la sucursal (servidor web y red). Si el visor quedó pegado en un número, recárgalo (F5).`;
  }
  if (/parlantes|salida de audio/.test(e)) return 'Revisa los parlantes del equipo y que Windows tenga una salida de audio activa.';
  if (/no hay voz|no está disponible|sintetizador/.test(e)) return 'Instala en el equipo la voz Microsoft Sabina (Español México) y recarga el visor.';
  return 'Abre la consola del navegador (F12) en esa pantalla para ver el detalle y recarga el visor.';
}

function destinoSocket(url) {
  try {
    const u = new URL(url);
    const seguro = u.protocol === 'https:' || u.protocol === 'wss:';
    return { host: u.hostname.toLowerCase(), puerto: Number(u.port) || (seguro ? 443 : 80) };
  } catch {
    return null;
  }
}

class Pantallas {
  // opciones(): config "rum" de servidores.json + zona y demo.
  // ubicarSocket(host, puerto) -> { servidor, nombre, nivel } | null  (estado del WebSocket visto desde el monitor)
  // ubicarHost(host) -> nombre del servidor | null
  constructor({ almacen, opciones, ubicarSocket, ubicarHost }) {
    this.almacen = almacen;
    this.opcionesBase = opciones;
    this.ubicarSocket = ubicarSocket;
    this.ubicarHost = ubicarHost;
    this.mapa = new Map(); // id -> pantalla
    this.sucias = new Set(); // ids con cambios sin guardar en MongoDB
    this.eventosPendientes = [];
    this.cupos = new Map(); // ip|id -> { minuto, n }
    this.arranque = Date.now();
  }

  opciones() {
    const base = this.opcionesBase();
    return { ...POR_DEFECTO, ...(base.rum || {}), zona: base.zona, demo: base.demo };
  }

  async cargar() {
    for (const p of await this.almacen.leerPantallas().catch(() => [])) {
      if (!this.mapa.has(p.id)) this.mapa.set(p.id, p);
    }
  }

  // ---- Recepción -------------------------------------------------------------

  cupoAgotado(clave, limite, ahora) {
    const minuto = Math.floor(ahora / 60e3);
    const c = this.cupos.get(clave);
    if (!c || c.minuto !== minuto) {
      this.cupos.set(clave, { minuto, n: 1 });
      return false;
    }
    c.n += 1;
    return c.n > limite;
  }

  // Devuelve el código HTTP de la respuesta (204 si se aceptó).
  recibir(cuerpo, { ip, ahora = Date.now() }) {
    if (!cuerpo || cuerpo.length > LIMITE_CUERPO) return 413;
    if (this.cupoAgotado(`ip:${ip}`, CUPO_IP_MINUTO, ahora)) return 429;
    let m;
    try { m = JSON.parse(cuerpo); } catch { return 400; }
    if (!m || typeof m !== 'object' || !TIPOS_MENSAJE.has(m.k) || !ID_VALIDO.test(String(m.id || ''))) return 400;
    const op = this.opciones();
    if (op.token && m.token !== op.token) return 403;
    if (this.cupoAgotado(`id:${m.id}`, CUPO_PANTALLA_MINUTO, ahora)) return 429;

    let p = this.mapa.get(m.id);
    if (!p) {
      if (this.mapa.size >= MAX_PANTALLAS) return 507;
      p = { id: m.id, primeraVez: ahora, alias: '', eventos: [], errores: [], ocurrencias: [], sockets: [], llamadas: [], componentes: [] };
      this.mapa.set(m.id, p);
      this.anotar(p, ahora, 'nueva', 'Primera vez que reporta');
    }

    p.tipo = texto(m.tipo, 20).toLowerCase() || 'front';
    p.nombre = texto(m.nombre, 80);
    p.ids = this.leerIds(m.ids);
    p.pagina = texto(m.pagina, 200);
    p.ip = texto(ip, 60);
    p.ua = texto(m.ua, 160) || p.ua || '';
    p.ultimoLatido = ahora;
    if (m.k !== 'adios') p.cerrado = null;
    if (Array.isArray(m.s)) p.sockets = this.leerSockets(m.s, p.sockets, ahora);
    if (Array.isArray(m.ll)) this.registrarLlamadas(p, m.ll, ahora);
    if (Array.isArray(m.au)) this.registrarAudio(p, m.au, ahora);
    if (Array.isArray(m.co)) {
      const antes = new Map((p.componentes || []).map((c) => [c.nombre, c.ok]));
      p.componentes = this.leerComponentes(m.co, ahora);
      for (const c of p.componentes) {
        if (antes.has(c.nombre) && antes.get(c.nombre) !== c.ok) {
          this.anotar(p, ahora, c.ok ? 'socket-ok' : 'socket-caido', `${c.nombre} ${c.ok ? 'responde de nuevo' : `no responde${c.error ? ` (${c.error})` : ''}`}`);
        }
      }
    }
    if (Array.isArray(m.vs) && m.vs.length) p.voces = m.vs.slice(0, 20).map((v) => texto(v, 100)).filter(Boolean);
    if (m.mem != null) p.memoriaMB = entero(m.mem, 1e6);
    if (m.lag != null) p.bloqueoMaxMs = entero(m.lag, 3600e3);
    if (m.abierta != null) p.abiertaDesde = ahora - (entero(m.abierta, 365 * 86400e3) || 0);
    p.servidor = this.servidorDe(p);

    if (m.k === 'hola') {
      p.carga = { totalMs: entero(m.carga?.total, 600e3), ttfbMs: entero(m.carga?.ttfb, 600e3), domMs: entero(m.carga?.dom, 600e3) };
      p.cargas = (p.cargas || 0) + 1;
      this.anotar(p, ahora, 'carga', p.tipo === 'totem' ? 'Agente o aplicación iniciada' : `Página cargada${p.carga.totalMs != null ? ` en ${p.carga.totalMs.toLocaleString('es-CL')} ms` : ''}`);
    } else if (m.k === 'socket') {
      const s = p.sockets.find((x) => x.url === texto(m.cambio?.u, 200));
      if (s) this.anotar(p, ahora, s.ok ? 'socket-ok' : 'socket-caido', s.ok ? `${s.nombre} conectado` : `${s.nombre} desconectado${s.error ? ` (${s.error})` : ''}`);
    } else if (m.k === 'error') {
      this.registrarError(p, m.e || {}, ahora);
    } else if (m.k === 'adios') {
      p.cerrado = ahora;
      this.anotar(p, ahora, 'cierre', 'Página cerrada');
    }

    this.sucias.add(p.id);
    return 204;
  }

  leerIds(ids) {
    const r = {};
    if (!ids || typeof ids !== 'object') return r;
    for (const [k, v] of Object.entries(ids).slice(0, 8)) {
      if (CLAVE_VALIDA.test(k) && texto(v, 80)) r[k] = texto(v, 80);
    }
    return r;
  }

  leerSockets(lista, previos, ahora) {
    return lista.slice(0, 10).map((s) => {
      const url = texto(s?.u, 200);
      const destino = destinoSocket(url);
      const ubicado = destino && this.ubicarSocket(destino.host, destino.puerto);
      const previo = previos.find((x) => x.url === url);
      return {
        url,
        host: destino?.host || '',
        puerto: destino?.puerto || null,
        nombre: ubicado?.nombre || (destino ? `${destino.host}:${destino.puerto}` : url),
        ok: s?.ok === true,
        desde: ahora - (entero(s?.h, 365 * 86400e3) ?? 0),
        caidas: entero(s?.c, 1e6) ?? previo?.caidas ?? 0,
        error: texto(s?.e, 200),
      };
    });
  }

  // ll: [{ m, u, ok, f, e }] = llamadas de cada endpoint desde el envío anterior.
  registrarLlamadas(p, ll, ahora) {
    p.llamadas = p.llamadas || [];
    for (const x of ll.slice(0, 15)) {
      const url = texto(x?.u, 200);
      const ok = entero(x?.ok, 1e5) || 0;
      const f = entero(x?.f, 1e5) || 0;
      if (!url || (!ok && !f)) continue;
      const metodo = texto(x?.m, 10).toUpperCase() || 'GET';
      const clave = `${metodo} ${url}`;
      let l = p.llamadas.find((y) => y.clave === clave);
      if (!l) {
        const destino = destinoSocket(url);
        const ubicado = destino && this.ubicarSocket(destino.host, destino.puerto);
        let ruta = url;
        try { ruta = new URL(url).pathname; } catch {}
        l = {
          clave, metodo, url, ruta, host: destino?.host || '', puerto: destino?.puerto || null,
          nombre: ubicado?.nombre || (destino ? `${destino.host}:${destino.puerto}` : url), historial: [],
        };
        p.llamadas.push(l);
      }
      l.historial = [...l.historial.filter(([t]) => ahora - t < 3600e3), [ahora, ok, f]];
      if (ok) l.ultimoOk = ahora;
      if (f) {
        const nuevo = !l.ultimoFallo || ahora - l.ultimoFallo > 10 * 60e3;
        l.ultimoFallo = ahora;
        l.error = texto(x?.e, 120) || 'sin respuesta';
        if (nuevo) this.anotar(p, ahora, 'llamada-falla', `${metodo} ${l.nombre} ${l.ruta}: ${l.error}`);
      }
    }
    p.llamadas = p.llamadas.sort((a, b) => Math.max(b.ultimoOk || 0, b.ultimoFallo || 0) - Math.max(a.ultimoOk || 0, a.ultimoFallo || 0)).slice(0, MAX_LLAMADAS);
  }

  // au: [{ t: 'voz'|'sonido'|'video', ok, f, e, src, voz }] = desde el envío anterior.
  registrarAudio(p, au, ahora) {
    p.audio = p.audio || [];
    for (const x of au.slice(0, 5)) {
      const tipo = TIPOS_AUDIO[x?.t] ? x.t : null;
      const ok = entero(x?.ok, 1e4) || 0;
      const f = entero(x?.f, 1e4) || 0;
      if (!tipo || (!ok && !f)) continue;
      let a = p.audio.find((y) => y.tipo === tipo);
      if (!a) { a = { tipo, historial: [] }; p.audio.push(a); }
      a.historial = [...a.historial.filter(([t]) => ahora - t < 3600e3), [ahora, ok, f]];
      if (texto(x?.src, 200)) a.src = texto(x.src, 200);
      if (texto(x?.voz, 100)) a.voz = texto(x.voz, 100);
      if (ok) a.ultimoOk = ahora;
      if (f) {
        const error = texto(x?.e, 120) || 'no se pudo reproducir';
        if (!a.ultimoFallo || a.error !== error || ahora - a.ultimoFallo > 10 * 60e3) {
          this.anotar(p, ahora, 'audio-falla', `${TIPOS_AUDIO[tipo]}: ${error}`);
        }
        a.ultimoFallo = ahora;
        a.error = error;
      }
    }
  }

  llamadasEn(l, ms, ahora) {
    return (l.historial || []).filter(([t]) => ahora - t < ms).reduce((s, [, ok, f]) => ({ ok: s.ok + ok, f: s.f + f }), { ok: 0, f: 0 });
  }

  // e: { m, src, l, n, nv?, h? }. nv = nivel que le puso la propia app ('error' | 'warning'; los
  // agentes que leen el log de una app lo mandan). h = hace cuántos ms ocurrió (al releer un log).
  registrarError(p, e, ahora) {
    const msg = texto(e.m, 300) || 'Error sin mensaje';
    const src = texto(e.src, 200);
    const linea = entero(e.l, 1e7);
    const n = Math.max(1, entero(e.n, 1e4) || 1);
    const nivel = e.nv === 'error' || e.nv === 'warning' ? e.nv : null;
    const t = ahora - Math.min(entero(e.h, 3600e3) || 0, 3600e3);
    const clave = `${msg}|${src}|${linea}`;
    let err = p.errores.find((x) => x.clave === clave);
    if (!err) {
      err = { clave, msg, src, linea, nivel, n: 0, primera: t, historial: [] };
      p.errores.push(err);
      this.anotar(p, t, 'error', msg);
    }
    err.n += n;
    err.ultima = Math.max(err.ultima || 0, t);
    err.historial = [...(err.historial || []).filter(([x]) => ahora - x < 3600e3), [t, n]];
    p.errores = p.errores.sort((a, b) => b.ultima - a.ultima).slice(0, MAX_ERRORES);
    p.ocurrencias = [...(p.ocurrencias || []).filter(([x]) => ahora - x < 3600e3), [t, n]];
  }

  // co: [{ n, ok, h, e }] = partes de un equipo que no son WebSockets (la app, el servicio de impresora…).
  leerComponentes(lista, ahora) {
    return lista.slice(0, 10).map((c) => ({
      nombre: texto(c?.n, 80) || 'Componente',
      ok: c?.ok === true,
      desde: ahora - (entero(c?.h, 365 * 86400e3) ?? 0),
      error: texto(c?.e, 200),
    }));
  }

  anotar(p, t, tipo, detalle) {
    p.eventos = [...(p.eventos || []), { t, tipo, detalle }].slice(-MAX_EVENTOS);
    if (this.eventosPendientes.length < 5000) {
      this.eventosPendientes.push({ t, pantalla: p.id, servidor: p.servidor || null, tipo, detalle });
    }
  }

  servidorDe(p) {
    for (const s of [...(p.sockets || []), ...(p.llamadas || [])]) {
      const srv = s.host && this.ubicarHost(s.host);
      if (srv) return srv;
    }
    const pagina = destinoSocket(p.pagina);
    return (pagina && this.ubicarHost(pagina.host)) || null;
  }

  // ---- Estado ------------------------------------------------------------------

  nombreDe(p) {
    if (p.alias) return p.alias;
    if (p.nombre) return p.nombre;
    const ids = Object.entries(p.ids || {}).filter(([k]) => !/^ip/i.test(k));
    return `${nombreTipo(p.tipo)} ${ids.length ? ids.map(([, v]) => v).join(' · ') : p.id.slice(0, 6)}`;
  }

  erroresEn(p, ms, ahora) {
    return (p.ocurrencias || []).filter(([t]) => ahora - t < ms).reduce((s, [, n]) => s + n, 0);
  }

  // Estado de una pantalla y, si corresponde, el problema que genera incidente.
  evaluar(p, ahora, op) {
    const zona = op.zona;
    if (p.cerrado && p.cerrado >= p.ultimoLatido) return { nivel: 'cerrada', detalle: `Cerrada a las ${reloj(p.cerrado, zona)}` };
    const sinReportes = ahora - p.ultimoLatido;
    if (sinReportes > INACTIVA_MS) return { nivel: 'inactiva', detalle: 'Sin reportes hace más de 12 h' };
    // Recién arrancado el monitor, las pantallas aún no alcanzan a mandar su latido.
    const enGracia = !p.demo && ahora - this.arranque < (op.sinLatidoMin + 1) * 60e3;
    if (sinReportes > op.sinLatidoMin * 60e3 && !enGracia) {
      if (!enHorario(ahora, op.horario, zona)) return { nivel: 'inactiva', detalle: `Sin reportes desde las ${reloj(p.ultimoLatido, zona)} (fuera de horario)` };
      return {
        nivel: 'error', problema: 'latido', detalle: `Sin reportes desde las ${reloj(p.ultimoLatido, zona)}`,
        causa: `La pantalla dejó de reportar a las ${reloj(p.ultimoLatido, zona)} sin cerrar la página: el equipo se apagó, el navegador se colgó o la sucursal perdió internet.`,
        sugerencia: 'Revisa que el equipo esté encendido y con red; si lo está, recarga la página del navegador.',
      };
    }

    // Componentes del equipo (la app de un tótem, su servicio de impresora…) que no responden.
    const compCaidos = (p.componentes || []).filter((c) => !c.ok && ahora - c.desde > op.socketMin * 60e3);
    if (compCaidos.length) {
      const c = compCaidos[0];
      return {
        nivel: 'error', problema: 'componente', componentes: compCaidos,
        detalle: `${c.nombre} no responde desde las ${reloj(c.desde, zona)}`,
        causa: `En el equipo, ${compCaidos.map((x) => `${x.nombre}${x.error ? ` (${x.error})` : ''}`).join(', ')} no responde desde las ${reloj(c.desde, zona)}. El equipo sigue encendido y reportando, pero esa parte no funciona.`,
        sugerencia: /impres/i.test(c.nombre)
          ? 'Revisa en el equipo que el servicio de impresión esté corriendo y que la impresora esté encendida y con papel.'
          : 'Revisa en el equipo que la aplicación esté abierta; si se cerró, ábrela de nuevo.',
      };
    }

    // Un mismo WebSocket puede estar abierto dos veces (p. ej. números y citas): manda el peor.
    const porDestino = new Map();
    for (const s of p.sockets || []) {
      const clave = s.host ? `${s.host}:${s.puerto}` : s.url;
      const previo = porDestino.get(clave);
      if (!previo || (previo.ok && !s.ok) || (!previo.ok && !s.ok && s.desde < previo.desde)) porDestino.set(clave, s);
    }
    const caidos = [...porDestino.values()].filter((s) => !s.ok);
    const largos = caidos.filter((s) => ahora - s.desde > op.socketMin * 60e3);
    if (largos.length) {
      const s = largos[0];
      const enServidor = s.host ? this.ubicarSocket(s.host, s.puerto) : null;
      const nombres = largos.map((x) => x.nombre).join(', ');
      if (enServidor?.nivel === 'error') {
        return { nivel: 'error', porServidor: true, detalle: `${nombres}: caído en el servidor ${enServidor.servidor}` };
      }
      return {
        nivel: 'error', problema: 'socket', destinos: largos, detalle: `Sin conexión con ${nombres} desde las ${reloj(s.desde, zona)}`,
        causa: `La pantalla sigue abierta y reportando, pero no logra conectarse a ${nombres} desde las ${reloj(s.desde, zona)}${s.error ? ` (${s.error})` : ''}. ${enServidor ? 'Desde el monitor ese WebSocket responde bien, así que el problema está entre la sucursal y el servidor (red, proxy o firewall) o en el navegador.' : ''}`.trim(),
        sugerencia: 'Recarga la página del visor. Si no se conecta, revisa la red de la sucursal y que el navegador llegue al puerto del WebSocket.',
      };
    }

    // Audio: la voz o el sonido fallaron y no han vuelto a sonar → el visor llama sin que nadie escuche.
    const ventanaAudio = op.audioMin * 60e3;
    const audios = p.audio || [];
    const mudos = audios.filter((a) => a.tipo !== 'video' && a.ultimoFallo && ahora - a.ultimoFallo < ventanaAudio && !(a.ultimoOk > a.ultimoFallo));
    if (mudos.length) {
      const a = mudos[0];
      const que = a.tipo === 'voz' ? 'el anuncio por voz' : 'el sonido de llamado';
      return {
        nivel: 'error', problema: 'audio', audio: a,
        detalle: `${TIPOS_AUDIO[a.tipo]} no suena: ${a.error}`,
        causa: `Desde las ${reloj(a.ultimoFallo, zona)} ${que} falla (${a.error}) y no ha vuelto a sonar: los pacientes ven el número pero no lo escuchan.`
          + (a.tipo === 'voz' && a.voz ? ` Voz usada: ${a.voz}.` : '')
          + (a.tipo === 'sonido' && a.src ? ` Archivo en ${a.src}.` : '')
          + (mudos.length > 1 ? ` También falla: ${mudos.slice(1).map((x) => TIPOS_AUDIO[x.tipo].toLowerCase()).join(', ')}.` : ''),
        sugerencia: sugerenciaAudio(a),
      };
    }

    // Llamadas a APIs: un endpoint que falla una y otra vez sin ninguna llamada buena deja a la pantalla sin funcionar.
    const ventana = op.llamadasMin * 60e3;
    const malas = (p.llamadas || [])
      .map((l) => ({ l, ...this.llamadasEn(l, ventana, ahora) }))
      .filter((x) => x.f >= op.fallosUmbral);
    const muertas = malas.filter((x) => x.ok === 0);
    if (muertas.length) {
      const { l, f } = muertas[0];
      const enServidor = l.host ? this.ubicarSocket(l.host, l.puerto) : null;
      const destino = `${l.nombre} ${l.ruta}`;
      if (enServidor?.nivel === 'error') {
        return { nivel: 'error', porServidor: true, detalle: `${destino}: caída en el servidor ${enServidor.servidor}` };
      }
      const sinRespuesta = /^sin respuesta|^sin red/.test(l.error || '');
      return {
        nivel: 'error', problema: 'api', destinos: muertas.map((x) => x.l),
        detalle: `No logra llamar a ${destino} (${l.error})`,
        causa: `En los últimos ${op.llamadasMin} min, ${f} llamadas a ${l.metodo} ${l.url} fallaron y ninguna salió bien (${l.error}).`
          + (sinRespuesta ? ' El navegador no recibió respuesta: suele ser CORS (la API no acepta llamadas desde la dirección de esta página), un certificado SSL inválido o la red de la sucursal.' : '')
          + (enServidor?.nivel === 'ok' ? ' Desde el monitor esa API responde, así que no está caída.' : '')
          + (muertas.length > 1 ? ` También fallan: ${muertas.slice(1).map((x) => `${x.l.nombre} ${x.l.ruta}`).join(', ')}.` : ''),
        sugerencia: sinRespuesta
          ? `Abre la consola del navegador (F12) en esa pantalla: si dice "blocked by CORS policy", agrega el origen de la página (${destinoSocket(p.pagina) ? new URL(p.pagina).origin : 'la URL del front'}) a los permitidos de la API.`
          : 'Revisa el log de esa API en el servidor: está respondiendo con error.',
      };
    }

    // Un error que la propia app marca como ERROR y se repite (lo informa un agente que lee su log):
    // la app está fallando en algo concreto una y otra vez.
    const repetidos = (p.errores || [])
      .filter((e) => e.nivel === 'error')
      .map((e) => ({ e, n: (e.historial || []).filter(([t]) => ahora - t < ventana).reduce((s, [, k]) => s + k, 0) }))
      .filter((x) => x.n >= op.fallosUmbral)
      .sort((a, b) => b.n - a.n);
    if (repetidos.length) {
      const { e, n } = repetidos[0];
      return {
        nivel: 'error', problema: 'error-app', errorApp: e,
        detalle: `Error repetido (${n} en ${op.llamadasMin} min): ${e.msg.split(':')[0]}`,
        causa: `La aplicación registró ${n} veces en los últimos ${op.llamadasMin} min el error "${e.msg}" (último a las ${reloj(e.ultima, zona)}).`
          + (repetidos.length > 1 ? ` También se repiten: ${repetidos.slice(1, 4).map((x) => `"${x.e.msg.split(':')[0]}" (${x.n})`).join(', ')}.` : ''),
        sugerencia: /timeout|sin respuesta|conexi/i.test(e.msg)
          ? 'La aplicación no recibe respuesta a tiempo: revisa la red del equipo y que la API que usa esa función responda desde la sucursal.'
          : 'Revisa el log de la aplicación en el equipo para ver el detalle completo (stack trace).',
      };
    }

    const errores15 = this.erroresEn(p, 15 * 60e3, ahora);
    // Audio que falló pero después volvió a sonar, o un video que no se reproduce.
    const intermitentes = audios.filter((a) => a.ultimoFallo && ahora - a.ultimoFallo < ventanaAudio);
    if (intermitentes.length) {
      const a = intermitentes[0];
      const { ok, f } = this.llamadasEn(a, ventanaAudio, ahora);
      return {
        nivel: 'aviso', problema: 'audio-parcial', audio: a,
        detalle: a.tipo === 'video' ? `Video no se reproduce: ${a.error}` : `${TIPOS_AUDIO[a.tipo]}: ${f} de ${ok + f} fallaron (${a.error})`,
        causa: a.tipo === 'video'
          ? `El video no se pudo reproducir (${a.error})${a.src ? ` desde ${a.src}` : ''}.`
          : `En los últimos ${op.audioMin} min ${TIPOS_AUDIO[a.tipo].toLowerCase()} falló ${f} de ${ok + f} veces (${a.error}), aunque después volvió a sonar.`,
        sugerencia: sugerenciaAudio(a),
      };
    }
    if (malas.length) {
      const { l, ok, f } = malas[0];
      return {
        nivel: 'aviso', problema: 'api-parcial', detalle: `${l.nombre} ${l.ruta}: ${f} de ${ok + f} llamadas fallan`,
        causa: `En los últimos ${op.llamadasMin} min fallaron ${f} de ${ok + f} llamadas a ${l.metodo} ${l.url} (${l.error}).`,
        sugerencia: 'La API responde a veces: revisa su log y la red de la sucursal.',
      };
    }
    if (errores15 >= op.erroresUmbral) {
      // Un agente que lee el log de una app (tótem) manda el nivel: no son errores de JavaScript.
      const deApp = (p.errores || []).some((e) => e.nivel);
      const queErrores = deApp ? 'errores de la aplicación' : 'errores de JavaScript';
      return {
        nivel: 'aviso', problema: 'errores', deApp, detalle: `${errores15} ${queErrores} en 15 min`,
        causa: `${deApp ? 'La aplicación registró' : 'La página tuvo'} ${errores15} ${queErrores} en los últimos 15 minutos. El más reciente: "${p.errores[0]?.msg || '—'}".`,
        sugerencia: deApp
          ? 'Abre el detalle para ver los errores agrupados. Si se repite el mismo error, el equipo no está pudiendo atender esa función.'
          : 'Abre el detalle de la pantalla para ver los errores agrupados; suele ser un cambio reciente del front o un dato inesperado de una API.',
      };
    }
    if (caidos.length) return { nivel: 'aviso', detalle: `Reconectando ${caidos.map((x) => x.nombre).join(', ')}…` };
    return { nivel: 'ok', detalle: 'Conectada' };
  }

  todas(ahora) {
    const op = this.opciones();
    const reales = [...this.mapa.values()];
    return { op, lista: op.demo ? [...reales, ...demoPantallas(ahora)] : reales };
  }

  // Para la pestaña "Pantallas".
  lista(ahora = Date.now()) {
    const { op, lista } = this.todas(ahora);
    return lista.map((p) => {
      const est = this.evaluar(p, ahora, op);
      return {
        id: p.id, nombre: this.nombreDe(p), alias: p.alias || '', nombreReportado: p.nombre || '', tipo: p.tipo, nombreTipo: nombreTipo(p.tipo), ids: p.ids || {},
        servidor: p.servidor || null, demo: !!p.demo, pagina: p.pagina, ip: p.ip, ua: p.ua,
        primeraVez: p.primeraVez, ultimoLatido: p.ultimoLatido, abiertaDesde: p.abiertaDesde || null, cargas: p.cargas || 0,
        carga: p.carga || null, memoriaMB: p.memoriaMB ?? null, bloqueoMaxMs: p.bloqueoMaxMs ?? null,
        sockets: p.sockets || [],
        componentes: p.componentes || [],
        llamadas: (p.llamadas || []).map((l) => {
          const v5 = this.llamadasEn(l, op.llamadasMin * 60e3, ahora);
          const v60 = this.llamadasEn(l, 3600e3, ahora);
          return {
            metodo: l.metodo, url: l.url, ruta: l.ruta, nombre: l.nombre, error: l.error || '', ultimoOk: l.ultimoOk || null, ultimoFallo: l.ultimoFallo || null,
            ok5: v5.ok, fallos5: v5.f, ok60: v60.ok, fallos60: v60.f,
          };
        }).filter((l) => l.ok60 + l.fallos60 > 0),
        audio: (p.audio || []).map((a) => {
          const v = this.llamadasEn(a, op.audioMin * 60e3, ahora);
          const v60 = this.llamadasEn(a, 3600e3, ahora);
          return {
            tipo: a.tipo, nombreTipo: TIPOS_AUDIO[a.tipo], ok: v.ok, fallos: v.f, ok60: v60.ok, fallos60: v60.f,
            error: a.error || '', ultimoOk: a.ultimoOk || null, ultimoFallo: a.ultimoFallo || null, src: a.src || '', voz: a.voz || '',
          };
        }),
        voces: p.voces || [],
        errores15: this.erroresEn(p, 15 * 60e3, ahora), errores60: this.erroresEn(p, 3600e3, ahora),
        errores: (p.errores || []).map(({ clave, historial, ...e }) => e), eventos: [...(p.eventos || [])].reverse(),
        nivel: est.nivel, detalle: est.detalle, porServidor: !!est.porServidor,
      };
    });
  }

  // Grupos de falla para incidentes.js (clave -> grupo).
  grupos(ahora = Date.now()) {
    const { op, lista } = this.todas(ahora);
    const grupos = new Map();
    const evaluadas = lista.map((p) => ({ p, est: this.evaluar(p, ahora, op) }));
    const vivas = evaluadas.filter(({ est }) => !['cerrada', 'inactiva'].includes(est.nivel));
    const servidorDe = (p) => p.servidor || 'pantallas';
    const agregar = (clave, servidor, demo, g) => grupos.set(`${servidor}|${clave}`, { servidor, persistir: !demo, ...g });

    // Si casi ninguna pantalla reporta a la vez, lo más probable es que no lleguen al monitor.
    const reales = vivas.filter(({ p }) => !p.demo);
    const sinLatido = reales.filter(({ est }) => est.problema === 'latido');
    if (reales.length >= 4 && sinLatido.length / reales.length >= 0.8) {
      agregar('pantallas:todas', 'pantallas', false, {
        alcance: 'red', nivel: 'error', titulo: `No llegan reportes de ${sinLatido.length} pantallas`, tipo: 'Pantallas sin reportar',
        causa: `${sinLatido.length} de ${reales.length} pantallas dejaron de reportar al mismo tiempo, en distintas sucursales. Lo más probable es que el problema sea del monitor o de su puerto público, no de las pantallas.`,
        sugerencia: 'Revisa que el puerto público del monitor (rum.puerto) esté abierto y que el monitor tenga red.',
        apis: sinLatido.map(({ p }) => this.nombreDe(p)),
      });
    }
    const globalSinLatido = grupos.size > 0;

    // Sin latido: si se cayeron todas las pantallas de una misma red, es la red de la sucursal.
    const porRed = new Map();
    for (const e of vivas) {
      const red = `${e.p.demo ? 'demo:' : ''}${e.p.ip || '?'}`;
      if (!porRed.has(red)) porRed.set(red, []);
      porRed.get(red).push(e);
    }
    for (const [red, miembros] of porRed) {
      const caidas = miembros.filter(({ p, est }) => est.problema === 'latido' && !(globalSinLatido && !p.demo));
      if (!caidas.length) continue;
      const demo = caidas[0].p.demo;
      if (caidas.length >= 2 && caidas.length === miembros.length) {
        const ip = red.replace(/^demo:/, '');
        agregar(`red:${ip}`, servidorDe(caidas[0].p), demo, {
          alcance: 'red', nivel: 'error', titulo: `Sucursal sin conexión: ${caidas.length} pantallas (red ${ip})`, tipo: 'Pantallas sin reportar',
          causa: `Las ${caidas.length} pantallas que reportan desde la red ${ip} dejaron de hacerlo. Cuando caen todas las de un mismo lugar, el problema suele ser el internet de la sucursal, no cada equipo.`,
          sugerencia: 'Verifica la conexión a internet de la sucursal (router, proveedor).',
          apis: caidas.map(({ p }) => this.nombreDe(p)),
        });
        continue;
      }
      for (const { p, est } of caidas) {
        agregar(`pantalla:${p.id}:latido`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'error', titulo: this.nombreDe(p), tipo: 'Pantalla sin reportar', causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
    }

    // Un WebSocket o una API inalcanzable desde varias sucursales, aunque el servidor responda:
    // firewall, proxy, certificado o CORS de ese puerto (no es cada pantalla).
    const porDestino = new Map();
    for (const e of vivas.filter(({ est }) => est.problema === 'socket' || est.problema === 'api')) {
      for (const s of e.est.destinos) {
        const clave = `${e.est.problema}:${e.p.demo ? 'demo:' : ''}${s.host}:${s.puerto}${e.est.problema === 'api' ? s.ruta : ''}`;
        if (!porDestino.has(clave)) porDestino.set(clave, { s, problema: e.est.problema, miembros: [] });
        porDestino.get(clave).miembros.push(e);
      }
    }
    const agrupadas = new Set();
    for (const [clave, { s, problema, miembros }] of porDestino) {
      const redes = new Set(miembros.map(({ p }) => p.ip));
      if (redes.size < 3) continue;
      const demo = miembros[0].p.demo;
      const ws = problema === 'socket';
      const destino = ws ? s.nombre : `${s.nombre} ${s.ruta}`;
      agregar(clave, servidorDe(miembros[0].p), demo, {
        alcance: 'red', nivel: 'error',
        titulo: ws ? `${miembros.length} pantallas sin conexión con ${destino}` : `${miembros.length} pantallas no logran llamar a ${destino}`,
        tipo: ws ? 'WebSocket inalcanzable desde las sucursales' : 'API inalcanzable desde las sucursales',
        causa: `Pantallas de ${redes.size} sucursales distintas no logran ${ws ? 'conectarse a' : 'llamar a'} ${destino}${ws ? '' : ` (${s.error})`}. Cuando pasa en varias sucursales a la vez, suele ser el firewall, el certificado SSL${ws ? ' o un proxy' : ', CORS'} de ese puerto, no cada pantalla.`,
        sugerencia: `Prueba abrir ${s.url} desde un navegador de una sucursal y revisa el firewall y el certificado del puerto ${s.puerto}.`,
        apis: miembros.map(({ p }) => this.nombreDe(p)),
      });
      miembros.forEach(({ p }) => agrupadas.add(`${problema}:${p.id}`));
    }
    // El mismo audio fallando igual en 3 o más sucursales: el archivo o el servidor, no cada visor.
    const porAudio = new Map();
    for (const e of vivas.filter(({ est }) => est.problema === 'audio')) {
      const clave = `audio:${e.p.demo ? 'demo:' : ''}${e.est.audio.tipo}:${e.est.audio.src}:${e.est.audio.error}`;
      if (!porAudio.has(clave)) porAudio.set(clave, []);
      porAudio.get(clave).push(e);
    }
    for (const [clave, miembros] of porAudio) {
      const redes = new Set(miembros.map(({ p }) => p.ip));
      if (redes.size < 3) continue;
      const a = miembros[0].est.audio;
      agregar(clave, servidorDe(miembros[0].p), miembros[0].p.demo, {
        alcance: 'red', nivel: 'error', titulo: `${miembros.length} visores sin ${a.tipo === 'voz' ? 'voz' : 'sonido'} (${a.error})`, tipo: 'Audio que falla en varias sucursales',
        causa: `Visores de ${redes.size} sucursales distintas no logran reproducir ${a.tipo === 'voz' ? 'la voz' : `el audio${a.src ? ` de ${a.src}` : ''}`} por el mismo motivo: ${a.error}. Cuando pasa en varias sucursales a la vez, el problema suele estar en el servidor o en el archivo, no en cada equipo.`,
        sugerencia: sugerenciaAudio(a),
        apis: miembros.map(({ p }) => this.nombreDe(p)),
      });
      miembros.forEach(({ p }) => agrupadas.add(`audio:${p.id}`));
    }

    for (const { p, est } of vivas) {
      if (est.problema === 'componente') {
        agregar(`pantalla:${p.id}:componente`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'error', titulo: this.nombreDe(p), tipo: `${est.componentes.map((c) => c.nombre).join(', ')} no responde`,
          causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
      if (est.problema === 'error-app') {
        agregar(`pantalla:${p.id}:error-app`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'error', titulo: this.nombreDe(p), tipo: `Error repetido: ${est.errorApp.msg.split(':')[0]}`,
          causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
      if (est.problema === 'audio' && !agrupadas.has(`audio:${p.id}`)) {
        agregar(`pantalla:${p.id}:audio`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'error', titulo: this.nombreDe(p), tipo: est.detalle, causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
      if (est.problema === 'audio-parcial') {
        agregar(`pantalla:${p.id}:audio-parcial`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'aviso', titulo: this.nombreDe(p), tipo: est.audio.tipo === 'video' ? 'Video que no se reproduce' : 'Audio con fallas',
          causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
      if (est.problema === 'socket' && !agrupadas.has(`socket:${p.id}`)) {
        agregar(`pantalla:${p.id}:socket`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'error', titulo: this.nombreDe(p), tipo: `Sin conexión con ${est.destinos.map((s) => s.nombre).join(', ')}`,
          causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
      if (est.problema === 'api' && !agrupadas.has(`api:${p.id}`)) {
        agregar(`pantalla:${p.id}:api`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'error', titulo: this.nombreDe(p), tipo: `No logra llamar a ${est.destinos[0].nombre} ${est.destinos[0].ruta}`,
          causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
      if (est.problema === 'api-parcial') {
        agregar(`pantalla:${p.id}:api-parcial`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'aviso', titulo: this.nombreDe(p), tipo: 'Llamadas a APIs con fallas', causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
      if (est.problema === 'errores') {
        agregar(`pantalla:${p.id}:errores`, servidorDe(p), p.demo, {
          alcance: 'pantalla', nivel: 'aviso', titulo: this.nombreDe(p), tipo: est.deApp ? 'Errores de la aplicación' : 'Errores de JavaScript', causa: est.causa, sugerencia: est.sugerencia, apis: [this.nombreDe(p)],
        });
      }
    }
    return grupos;
  }

  // ---- Administración y guardado ---------------------------------------------

  renombrar(id, alias) {
    const p = this.mapa.get(id);
    if (!p) return false;
    p.alias = texto(alias, 80);
    this.sucias.add(id);
    return true;
  }

  async olvidar(id) {
    if (!this.mapa.delete(id)) return false;
    this.sucias.delete(id);
    await this.almacen.borrarPantallas([id]).catch(() => {});
    return true;
  }

  // Cada 30 s: guarda en MongoDB lo que cambió y borra las pantallas abandonadas.
  async guardar(ahora = Date.now()) {
    const op = this.opciones();
    const viejas = [...this.mapa.values()].filter((p) => ahora - p.ultimoLatido > op.olvidarDias * 86400e3).map((p) => p.id);
    viejas.forEach((id) => { this.mapa.delete(id); this.sucias.delete(id); });
    for (const [clave, c] of this.cupos) if (c.minuto < Math.floor(ahora / 60e3)) this.cupos.delete(clave);
    if (!this.almacen.conectado()) return;
    if (viejas.length) await this.almacen.borrarPantallas(viejas).catch(() => {});
    const docs = [...this.sucias].map((id) => this.mapa.get(id)).filter(Boolean);
    const eventos = this.eventosPendientes;
    this.sucias.clear();
    this.eventosPendientes = [];
    try {
      await this.almacen.guardarPantallas(docs, eventos, op.retencionEventosDias);
    } catch (e) {
      docs.forEach((p) => this.sucias.add(p.id));
      this.eventosPendientes = [...eventos, ...this.eventosPendientes].slice(-5000);
      throw e;
    }
  }
}

// ---- Pantallas de demostración (servidor "demo"; no se guardan) ---------------

function demoPantallas(ahora) {
  const min = 60e3;
  const ws = (puerto, nombre, ok, haceMs, extra = {}) => ({
    url: `https://demo.dts.lat:${puerto}`, host: 'demo.dts.lat', puerto, nombre, ok, desde: ahora - haceMs, caidas: ok ? 0 : 1, error: ok ? '' : 'websocket error', ...extra,
  });
  const base = (id, tipo, ids, ip, extra) => ({
    id: `demo-${id}`, demo: true, tipo, ids, ip, servidor: 'demo', alias: '', nombre: '', pagina: `https://demo.dts.lat/${tipo}/`,
    ua: 'Chrome 131 (demo)', primeraVez: ahora - 9 * 86400e3, ultimoLatido: ahora - 20e3, abiertaDesde: ahora - 5 * 3600e3, cargas: 3,
    carga: { totalMs: 1800, ttfbMs: 120, domMs: 900 }, memoriaMB: 140, bloqueoMaxMs: 40, errores: [], ocurrencias: [], cerrado: null,
    eventos: [{ t: ahora - 5 * 3600e3, tipo: 'carga', detalle: 'Página cargada en 1.800 ms' }], ...extra,
  });
  return [
    base('visor-centro', 'visor', { idVisor: '12', idSector: '3' }, '200.1.1.10', {
      alias: 'Visor sala de espera',
      voces: ['Microsoft Sabina - Spanish (Mexico) (es-MX)', 'Microsoft Helena - Spanish (Spain) (es-ES)'],
      audio: [
        { tipo: 'sonido', historial: [[ahora - 4 * min, 6, 0]], ultimoOk: ahora - 4 * min, src: 'https://demo.dts.lat/audios/' },
        { tipo: 'voz', historial: [[ahora - 4 * min, 6, 0]], ultimoOk: ahora - 4 * min, voz: 'Microsoft Sabina - Spanish (Mexico)' },
      ],
      sockets: [ws(3029, 'wssAlimentaBarra :3029', true, 5 * 3600e3), ws(3002, 'WSNumeroAtencion :3002', true, 5 * 3600e3), ws(3085, 'WebSocketVideo :3085', true, 5 * 3600e3)],
    }),
    base('visor-box', 'visor', { idVisor: '14', idSector: '5' }, '200.1.1.10', {
      sockets: [ws(3029, 'wssAlimentaBarra :3029', true, 5 * 3600e3), ws(3002, 'WSNumeroAtencion :3002', false, 7 * min), ws(3085, 'WebSocketVideo :3085', true, 5 * 3600e3)],
      eventos: [{ t: ahora - 7 * min, tipo: 'socket-caido', detalle: 'WSNumeroAtencion :3002 desconectado (transport close)' }],
    }),
    base('uac-modulo4', 'uac', { idEjecutivo: '88', modulo: '4' }, '200.1.1.10', {
      sockets: [ws(3027, 'WSEncolador :3027', true, 2 * 3600e3), ws(3002, 'WSNumeroAtencion :3002', true, 2 * 3600e3)],
      memoriaMB: 410, bloqueoMaxMs: 2600,
      errores: [{ msg: "TypeError: Cannot read properties of undefined (reading 'nombreTramite')", src: 'https://demo.dts.lat/uac/js/index.js', linea: 512, n: 37, primera: ahora - 40 * min, ultima: ahora - min }],
      ocurrencias: [[ahora - 10 * min, 15], [ahora - 4 * min, 12], [ahora - min, 10]],
    }),
    base('totem-1', 'totem', { idTotem: '2' }, '200.7.7.20', { ultimoLatido: ahora - 11 * min, sockets: [ws(3027, 'WSEncolador :3027', true, 3 * 3600e3)] }),
    base('visor-lebu', 'visor', { idVisor: '30', idSector: '1' }, '190.5.5.5', { ultimoLatido: ahora - 6 * min, sockets: [ws(3002, 'WSNumeroAtencion :3002', true, 3600e3)] }),
    base('visor-lebu-2', 'visor', { idVisor: '31', idSector: '2' }, '190.5.5.5', { ultimoLatido: ahora - 6 * min, sockets: [ws(3002, 'WSNumeroAtencion :3002', true, 3600e3)] }),
    base('visor-mudo', 'visor', { idVisor: '22', idSector: '4' }, '200.3.3.3', {
      alias: 'Visor box dental',
      sockets: [ws(3029, 'wssAlimentaBarra :3029', true, 2 * 3600e3), ws(3085, 'WebSocketVideo :3085', true, 2 * 3600e3)],
      voces: ['Microsoft Helena - Spanish (Spain) (es-ES)', 'Google español (es-ES) [por internet]'],
      audio: [{ tipo: 'sonido', historial: [[ahora - 9 * min, 0, 1]], ultimoFallo: ahora - 9 * min, error: 'el navegador bloqueó el sonido automático', src: 'https://demo.dts.lat/audios/' }],
      eventos: [{ t: ahora - 9 * min, tipo: 'audio-falla', detalle: 'Sonido: el navegador bloqueó el sonido automático' }],
    }),
    base('visor-cerrado', 'visor', { idVisor: '40', idSector: '1' }, '200.9.9.9', { ultimoLatido: ahora - 90 * min, cerrado: ahora - 90 * min, sockets: [] }),
  ];
}

module.exports = { Pantallas, enHorario, POR_DEFECTO };
