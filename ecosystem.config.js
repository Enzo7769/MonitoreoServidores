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
      },
    },
  ],
};
