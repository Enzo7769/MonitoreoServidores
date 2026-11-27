// pm2 start ecosystem.config.js   (en test.dts.lat)
module.exports = {
  apps: [
    {
      name: 'monitor-apis',
      script: 'monitor.js',
      cwd: __dirname,
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        TZ: 'America/Santiago',
        // En el mismo servidor que Mongo conviene ir por localhost (no por internet).
        MONGO_URI: 'mongodb://localhost:27017/?directConnection=true',
        // Puertos en test.dts.lat (mandan sobre servidores.json, que en un PC local usa 8090/8091):
        // 3030 = panel (restringirlo o ponerle usuario y clave), 3031 = público, solo /rum.js y /api/beacon.
        PUERTO_DASHBOARD: '3030',
        PUERTO_RUM: '3031',
      },
    },
  ],
};
