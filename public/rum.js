/*
 * Monitor de APIs: reporte desde el navegador (visores, UAC, tótems).
 *
 * Uso (después del <script> de socket.io):
 *   <script src="https://test.dts.lat:8091/rum.js" data-tipo="visor" data-claves="idVisor,idSector,ipEquipo"></script>
 *
 *   data-tipo    visor | uac | totem | ... (cómo se agrupa en el panel)
 *   data-claves  claves de localStorage que identifican al equipo (se envían tal cual: no pongas datos de pacientes)
 *   data-nombre  nombre fijo opcional (si no, se le pone uno en la pestaña "Pantallas" del monitor)
 *   data-token   solo si el monitor tiene "rum.token"
 *   data-latido  segundos entre latidos (60 por defecto)
 *
 * Mide: tiempos de carga, errores de JavaScript (y console.error), estado de cada WebSocket
 * (envolviendo io()), llamadas a APIs (fetch y XMLHttpRequest: cuántas salen bien y cuántas
 * fallan, por endpoint), audio (voz del sistema y <audio>/<video>: si sonó, si falló y por qué,
 * qué voz se usó y cuáles tiene el equipo), memoria y bloqueos del navegador. No envía el
 * contenido de la página, ni cuerpos de llamadas ni parámetros de URL (ids y RUT → :id), ni el
 * texto que se dice por voz, ni nombres de archivos de audio (solo su carpeta).
 */
(function () {
  'use strict';
  if (window.__monitorRum) return;
  window.__monitorRum = true;

  var script = document.currentScript;
  if (!script || !script.src) return;
  var d = script.dataset || {};
  var monitor = d.url || script.src.replace(/\/rum\.js(\?.*)?$/, '');
  var destino = monitor + '/api/beacon';
  var fetchOriginal = window.fetch;
  var tipo = d.tipo || 'front';
  var claves = (d.claves || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var LATIDO_MS = Math.max(15, Number(d.latido) || 60) * 1000;
  var inicio = Date.now();
  var sockets = [];
  var bloqueoMax = 0;

  function leer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function nuevoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  var id = leer('monitorRumId');
  if (!id) { id = nuevoId(); guardar('monitorRumId', id); }

  function ids() {
    var r = {};
    for (var i = 0; i < claves.length; i++) {
      var v = leer(claves[i]);
      if (v) r[claves[i]] = String(v).slice(0, 80);
    }
    return r;
  }

  function estadoSockets() {
    var ahora = Date.now();
    return sockets.map(function (s) { return { u: s.u, ok: s.ok, h: ahora - s.desde, c: s.c, e: s.e }; });
  }

  function memoria() {
    var m = window.performance && performance.memory;
    return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
  }

  function enviar(k, extra) {
    var m = {
      v: 1, k: k, id: id, tipo: tipo, nombre: d.nombre || '', ids: ids(), token: d.token || '',
      pagina: location.origin + location.pathname, ua: navigator.userAgent.slice(0, 160),
      s: estadoSockets(), ll: tomarLlamadas(), au: tomarAudio(), mem: memoria(), lag: bloqueoMax, abierta: Date.now() - inicio,
    };
    for (var c in extra) m[c] = extra[c];
    var cuerpo = JSON.stringify(m);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(destino, new Blob([cuerpo], { type: 'text/plain' }))) return;
    } catch (e) {}
    try {
      if (fetchOriginal) fetchOriginal.call(window, destino, { method: 'POST', body: cuerpo, keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } })['catch'](function () {});
    } catch (e) {}
  }

  // RUT y números largos fuera de cualquier texto que se envíe.
  function enmascarar(texto) {
    return String(texto).replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]\b/g, '[rut]').replace(/\b\d{7,}\b/g, '[n]');
  }

  // ---- Llamadas a APIs: se cuentan por endpoint (método + URL sin parámetros) ----
  var llamadas = {};
  function normalizar(url) {
    try {
      var u = new URL(url, location.href);
      var ruta = u.pathname.split('/').map(function (s) {
        return /^\d+$|^[0-9a-f]{12,}$|^[0-9a-f-]{32,36}$|^\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]$/i.test(s) ? ':id' : s;
      }).join('/');
      return u.origin + ruta;
    } catch (e) { return ''; }
  }
  function registrarLlamada(metodo, url, estado, error) {
    var u = normalizar(url);
    if (!u || u.indexOf(monitor) === 0 || u.indexOf('/socket.io/') !== -1) return;
    var clave = String(metodo || 'GET').toUpperCase() + ' ' + u;
    var l = llamadas[clave] || (llamadas[clave] = { m: String(metodo || 'GET').toUpperCase(), u: u, ok: 0, f: 0, e: '', avisado: 0 });
    // Falla = sin respuesta (CORS, red, certificado) o error del servidor (5xx). Un 401/404 es respuesta de la API.
    if (estado && estado < 500) { l.ok++; return; }
    l.f++;
    l.e = estado ? 'HTTP ' + estado : (navigator.onLine === false ? 'sin red' : 'sin respuesta' + (error ? ' (' + enmascarar(error).slice(0, 80) + ')' : ''));
    var ahora = Date.now();
    if (ahora - l.avisado > 10e3) { l.avisado = ahora; enviar('llamada'); }
  }
  // Lo acumulado desde el último envío (primero las que fallan); los contadores vuelven a cero.
  function tomarLlamadas() {
    var lista = [];
    for (var k in llamadas) {
      var l = llamadas[k];
      if (l.ok || l.f) lista.push({ m: l.m, u: l.u, ok: l.ok, f: l.f, e: l.f ? l.e : '' });
      l.ok = 0; l.f = 0;
    }
    lista.sort(function (a, b) { return b.f - a.f; });
    return lista.slice(0, 15);
  }

  if (fetchOriginal) {
    window.fetch = function (recurso, opciones) {
      var url = typeof recurso === 'string' ? recurso : (recurso && recurso.url) || String(recurso);
      var metodo = (opciones && opciones.method) || (recurso && recurso.method) || 'GET';
      var p = fetchOriginal.apply(this, arguments);
      try {
        p.then(function (r) { registrarLlamada(metodo, url, r.type === 'opaque' ? 200 : r.status); },
          function (e) { if (!e || e.name !== 'AbortError') registrarLlamada(metodo, url, 0, e && e.message); });
      } catch (e) {}
      return p;
    };
  }
  if (window.XMLHttpRequest) {
    var xhrAbrir = XMLHttpRequest.prototype.open;
    var xhrMandar = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (metodo, url) {
      this.__rum = { m: metodo, u: url };
      return xhrAbrir.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var x = this;
      if (x.__rum && !x.__rumEscuchando) {
        x.__rumEscuchando = true;
        x.addEventListener('abort', function () { x.__rumAbortado = true; });
        x.addEventListener('loadend', function () { if (!x.__rumAbortado) registrarLlamada(x.__rum.m, x.__rum.u, x.status); });
      }
      return xhrMandar.apply(this, arguments);
    };
  }

  // ---- Audio: voz del sistema (speechSynthesis) y elementos <audio>/<video> ----
  // Por tipo ('voz', 'sonido', 'video') se cuenta cuántos sonaron y cuántos fallaron desde el último envío.
  var audio = {};
  function carpeta(src) {
    try { var u = new URL(src, location.href); return u.origin + u.pathname.replace(/[^/]*$/, ''); } catch (e) { return ''; }
  }
  function registrarAudio(tipo, ok, motivo, extra) {
    var a = audio[tipo] || (audio[tipo] = { ok: 0, f: 0, e: '', src: '', voz: '', avisado: 0 });
    if (extra && extra.src) a.src = extra.src;
    if (extra && extra.voz) a.voz = extra.voz;
    if (ok) { a.ok++; return; }
    a.f++;
    a.e = String(motivo || 'no se pudo reproducir').slice(0, 120);
    var ahora = Date.now();
    if (ahora - a.avisado > 10e3) { a.avisado = ahora; enviar('audio'); }
  }
  function tomarAudio() {
    var lista = [];
    for (var t in audio) {
      var a = audio[t];
      if (a.ok || a.f) lista.push({ t: t, ok: a.ok, f: a.f, e: a.f ? a.e : '', src: a.src, voz: a.voz });
      a.ok = 0; a.f = 0;
    }
    return lista;
  }
  function vocesInstaladas() {
    try {
      return speechSynthesis.getVoices().slice(0, 20).map(function (v) {
        return v.name + ' (' + v.lang + ')' + (v.localService ? '' : ' [por internet]') + (v['default'] ? ' [predeterminada]' : '');
      });
    } catch (e) { return []; }
  }

  var MOTIVO_MEDIA = {
    1: 'reproducción abortada', 2: 'error de red al bajar el archivo',
    3: 'archivo dañado o formato no soportado', 4: 'archivo no disponible o formato no soportado',
  };
  if (window.HTMLMediaElement && HTMLMediaElement.prototype.play) {
    var playOriginal = HTMLMediaElement.prototype.play;
    var escucharMedia = function (el, tipo) {
      el.__rumMedia = true;
      var actual = function () { return el.__rumIntento; };
      el.addEventListener('playing', function () {
        var i = actual();
        if (!i || i.listo) return;
        if (tipo === 'video') return i.cerrar(true); // los videos suelen ir en bucle: basta con que empiece
        clearTimeout(i.t);
        var dura = isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 + 10000 : 60000;
        i.t = setTimeout(function () { i.cerrar(false, 'empezó a sonar y nunca terminó'); }, dura);
      });
      el.addEventListener('ended', function () { var i = actual(); if (i) i.cerrar(true); });
      el.addEventListener('pause', function () { var i = actual(); if (i && !el.ended) i.neutro(); });
      el.addEventListener('error', function () {
        var i = actual();
        if (i) i.cerrar(false, MOTIVO_MEDIA[el.error && el.error.code] || 'no se pudo reproducir');
      });
    };
    HTMLMediaElement.prototype.play = function () {
      var el = this;
      try {
        var tipo = el.tagName === 'VIDEO' ? 'video' : 'sonido';
        if (!el.__rumMedia) escucharMedia(el, tipo);
        var intento = { listo: false, t: null };
        intento.neutro = function () { intento.listo = true; clearTimeout(intento.t); };
        intento.cerrar = function (ok, motivo) {
          if (intento.listo) return;
          intento.neutro();
          registrarAudio(tipo, ok, motivo, { src: carpeta(el.currentSrc || el.src) });
        };
        intento.t = setTimeout(function () { intento.cerrar(false, 'no empezó a sonar en 30 s'); }, 30000);
        if (el.__rumIntento && !el.__rumIntento.listo) el.__rumIntento.neutro();
        el.__rumIntento = intento;
      } catch (e) {}
      var p = playOriginal.apply(this, arguments);
      try {
        if (p && typeof p.then === 'function') {
          p.then(null, function (e) {
            if (!el.__rumIntento) return;
            if (e && e.name === 'AbortError') return el.__rumIntento.neutro();
            el.__rumIntento.cerrar(false, e && e.name === 'NotAllowedError' ? 'el navegador bloqueó el sonido automático' : 'no se pudo cargar el archivo');
          });
        }
      } catch (e) {}
      return p;
    };
  }

  var MOTIVO_VOZ = {
    'not-allowed': 'el navegador no permite hablar sin interacción', 'synthesis-unavailable': 'no hay sintetizador de voz',
    'synthesis-failed': 'falló el sintetizador de voz', 'language-unavailable': 'no hay voz para ese idioma',
    'voice-unavailable': 'la voz elegida no está disponible', 'audio-busy': 'la salida de audio está ocupada',
    'audio-hardware': 'no hay salida de audio (parlantes)', network: 'falló la voz por internet', 'text-too-long': 'texto demasiado largo',
  };
  if (window.speechSynthesis && typeof speechSynthesis.speak === 'function') {
    var hablarOriginal = speechSynthesis.speak;
    var enCurso = []; // referencia a cada locución hasta que termine (si se pierde, el navegador puede no avisar el término)
    speechSynthesis.speak = function (u) {
      try {
        if (u && typeof u.addEventListener === 'function') {
          var voz = u.voice ? u.voice.name + (u.voice.localService ? '' : ' [por internet]') : 'elegida por el navegador (' + (u.lang || 'sin idioma') + ')';
          var listo = false;
          enCurso.push(u);
          var soltar = function () { listo = true; clearTimeout(t); var i = enCurso.indexOf(u); if (i >= 0) enCurso.splice(i, 1); };
          var cerrar = function (ok, motivo) { if (listo) return; soltar(); registrarAudio('voz', ok, motivo, { voz: voz }); };
          var t = setTimeout(function () { cerrar(false, 'la voz no avisó que terminó (posible cuelgue)'); }, Math.max(15000, String(u.text || '').length * 250));
          u.addEventListener('end', function () { cerrar(true); });
          u.addEventListener('error', function (ev) {
            // 'interrupted'/'canceled': la página la cortó a propósito (speechSynthesis.cancel()).
            if (ev && (ev.error === 'interrupted' || ev.error === 'canceled')) return soltar();
            cerrar(false, MOTIVO_VOZ[ev && ev.error] || (ev && ev.error) || 'error de voz');
          });
        }
      } catch (e) {}
      return hablarOriginal.apply(this, arguments);
    };
    try { speechSynthesis.addEventListener('voiceschanged', function () { enviar('latido', { vs: vocesInstaladas() }); }); } catch (e) {}
  }

  // ---- WebSockets: se envuelve io() para escuchar cada socket que cree la página ----
  function seguir(socket, url) {
    if (!socket || typeof socket.on !== 'function') return;
    var s = { u: String(url || location.origin).slice(0, 200), ok: !!socket.connected, desde: Date.now(), c: 0, e: '' };
    sockets.push(s);
    function cambiar(ok, error) {
      if (s.ok === ok) { if (error) s.e = error; return; }
      s.ok = ok;
      s.desde = Date.now();
      if (!ok) s.c++;
      s.e = ok ? '' : (error || '');
      enviar('socket', { cambio: { u: s.u, ok: ok } });
    }
    socket.on('connect', function () { cambiar(true); });
    socket.on('disconnect', function (motivo) { cambiar(false, String(motivo || 'desconectado')); });
    socket.on('connect_error', function (err) {
      var texto = String((err && err.message) || err || 'error de conexión').slice(0, 200);
      if (!s.ok && !s.e) { s.e = texto; enviar('socket', { cambio: { u: s.u, ok: false } }); } else cambiar(false, texto);
    });
  }

  function envolver(io) {
    if (typeof io !== 'function' || io.__rum) return io;
    var envuelto = function (url) {
      var socket = io.apply(this, arguments);
      try { seguir(socket, typeof url === 'string' ? url : null); } catch (e) {}
      return socket;
    };
    for (var k in io) { try { envuelto[k] = io[k]; } catch (e) {} }
    envuelto.connect = envuelto;
    envuelto.__rum = true;
    return envuelto;
  }

  if (window.io) {
    window.io = envolver(window.io);
  } else {
    // socket.io todavía no cargó: se envuelve en cuanto se defina window.io.
    var actual;
    try {
      Object.defineProperty(window, 'io', {
        configurable: true,
        get: function () { return actual; },
        set: function (v) { actual = envolver(v); },
      });
    } catch (e) {}
  }

  // ---- Errores de JavaScript (agrupados: el mismo error se manda a lo más 1 vez por minuto) ----
  var errores = {};
  var enviadosHora = 0;
  setInterval(function () { enviadosHora = 0; }, 3600e3);

  function registrarError(msg, src, linea) {
    msg = enmascarar(msg);
    var clave = msg + '|' + src + '|' + linea;
    var e = errores[clave] || (errores[clave] = { n: 0, ultimo: 0 });
    e.n++;
    var ahora = Date.now();
    if (ahora - e.ultimo < 60e3 || enviadosHora >= 60) return;
    enviadosHora++;
    enviar('error', { e: { m: String(msg).slice(0, 300), src: String(src || '').slice(0, 200), l: linea || null, n: e.n } });
    e.n = 0;
    e.ultimo = ahora;
  }

  window.addEventListener('error', function (ev) {
    if (!ev || !ev.message) return; // errores de carga de imágenes/recursos: no
    registrarError(ev.message, ev.filename, ev.lineno);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    registrarError('Promesa rechazada: ' + ((r && r.message) || String(r)), (r && r.stack && String(r.stack).split('\n')[1]) || '', null);
  });

  // Errores que la página captura y solo escribe en consola (p. ej. un catch con console.error).
  // Solo texto y mensajes de Error: un objeto se envía como [objeto], por si trae datos de pacientes.
  if (window.console && typeof console.error === 'function') {
    var consolaError = console.error;
    console.error = function () {
      try {
        var partes = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          partes.push(a instanceof Error ? (a.name + ': ' + a.message) : (typeof a === 'object' && a !== null) ? '[objeto]' : String(a));
        }
        registrarError('console.error: ' + partes.join(' ').slice(0, 300), '', null);
      } catch (e) {}
      return consolaError.apply(this, arguments);
    };
  }

  // ---- Bloqueos: si el navegador se congela, el intervalo de 1 s llega tarde ----
  var esperado = Date.now() + 1000;
  setInterval(function () {
    var ahora = Date.now();
    var atraso = ahora - esperado;
    // Pestaña en segundo plano: el navegador frena los intervalos a propósito, no es un bloqueo.
    if (document.visibilityState !== 'hidden' && atraso > bloqueoMax) bloqueoMax = atraso;
    esperado = ahora + 1000;
  }, 1000);

  // ---- Carga, latidos y cierre ----
  function alCargar() {
    setTimeout(function () {
      var n = window.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      var carga = n ? { total: Math.round(n.loadEventEnd || n.duration), ttfb: Math.round(n.responseStart), dom: Math.round(n.domContentLoadedEventEnd) } : {};
      enviar('hola', { carga: carga, vs: vocesInstaladas() });
    }, 0);
  }
  if (document.readyState === 'complete') alCargar();
  else window.addEventListener('load', alCargar);

  setInterval(function () { enviar('latido'); bloqueoMax = 0; }, LATIDO_MS);
  window.addEventListener('pagehide', function () { enviar('adios'); });
})();
