/**
 * PM2 process config — an alternative to the systemd unit.
 *
 *   npm install -g pm2
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save
 *   pm2 startup        # prints one command to run so PM2 starts on boot
 *
 * PM2 restarts the app if it crashes and keeps logs in ~/.pm2/logs.
 */
module.exports = {
  apps: [
    {
      name: "zone-watch",
      script: "server/index.js",
      cwd: __dirname + "/..",
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        WATCH_INTERVAL_MS: "10000",
      },
      out_file: "~/.pm2/logs/zone-watch-out.log",
      error_file: "~/.pm2/logs/zone-watch-error.log",
      time: true,
    },
  ],
};
