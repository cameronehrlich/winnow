module.exports = {
  apps: [
    {
      name: 'winnow-watch',
      script: 'src/cli.js',
      args: 'watch --interval 10',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--experimental-vm-modules',
      env: {
        NODE_ENV: 'production',
      },
      // Restart policy
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      // Logging
      error_file: 'logs/winnow-error.log',
      out_file: 'logs/winnow-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Don't watch for file changes (we manage restarts ourselves)
      watch: false,
    },
  ],
};
