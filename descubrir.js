// Escanea los puertos del catálogo en cada servidor y guarda en servidores.json
// cuáles están abiertos. Esos pasan a ser los "esperados": si después se cierran,
// el monitor los marca como caídos.
//
// También detecta el APIGatewayFila (o el proxy) y qué servicios publica; esos
// servicios se revisan a través de él.
//
// Uso:
//   node descubrir.js                 -> todos los servidores
//   node descubrir.js torax fresia    -> solo esos (por nombre o host)
//
// También se puede hacer desde la pestaña "Servidores" del monitor.

const { enParalelo } = require('./sondas');
const { TIPOS, leerConfig, guardarConfig, tipoDe, descubrirServidor } = require('./descubrimiento');

async function main() {
  const config = leerConfig();
  const filtro = process.argv.slice(2);
  const objetivo = config.servidores.filter(
    (s) => filtro.length === 0 || filtro.includes(s.nombre) || filtro.includes(s.host)
  );

  await enParalelo(
    objetivo.map((srv) => async () => {
      let r;
      try {
        r = await descubrirServidor(srv.host, { puertoGateway: TIPOS[tipoDe(srv)].puertoGateway });
      } catch (e) {
        console.log(`✗ ${srv.nombre.padEnd(14)} ${e.code === 'ENOTFOUND' ? 'no resuelve DNS' : e.message} (${srv.host}) — se deja como estaba`);
        return;
      }
      srv.puertos = r.puertos;
      if (r.gateway) srv.gateway = r.gateway;
      else delete srv.gateway;

      const marca = r.puertos.length ? '✓' : '✗';
      console.log(`${marca} ${srv.nombre.padEnd(14)} ${r.puertos.length} puertos: ${r.puertos.join(', ') || '(ninguno accesible)'}`);
      if (r.gateway) console.log(`  ${''.padEnd(14)} gateway en :${r.gateway.puerto} con ${r.gateway.servicios.length} servicios`);
    }),
    4
  );

  guardarConfig(config);
  console.log('\nGuardado en servidores.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
