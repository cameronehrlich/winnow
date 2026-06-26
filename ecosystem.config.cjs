const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function loadEnvFile() {
  try {
    return Object.fromEntries(
      readFileSync(join(__dirname, '.env'), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
        .filter(Boolean)
        .map(([, key, value]) => [key, value.trim().replace(/^(['"])(.*)\1$/, '$2')]),
    );
  } catch {
    return {};
  }
}

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
        ...loadEnvFile(),
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
