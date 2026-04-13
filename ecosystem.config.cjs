module.exports = {
  apps: [
    {
      name: 'payments-miniapp',
      script: 'node_modules/.bin/next',
      args: 'start -p 3001',
      cwd: '/root/payments-miniapp',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
