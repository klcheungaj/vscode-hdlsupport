const { defineConfig } = require('vite') as typeof import('vite');

module.exports = defineConfig(({ mode }: { mode: string }): import('vite').UserConfig => {
  const production = mode === 'production';

  return {
    build: {
      emptyOutDir: true,
      lib: {
        entry: 'src/extension.ts',
        fileName: () => 'extension.js',
        formats: ['cjs'],
      },
      license: production ? { fileName: 'extension.js.LICENSE.txt' } : false,
      minify: production ? 'oxc' : false,
      outDir: 'dist',
      copyPublicDir: false,
      reportCompressedSize: false,
      sourcemap: production ? 'hidden' : true,
      ssr: true,
      target: 'node18',
      rolldownOptions: {
        external: ['vscode'],
        output: {
          codeSplitting: false,
        },
        platform: 'node',
      },
    },
    logLevel: production ? 'warn' : 'info',
    ssr: {
      external: ['vscode'],
      noExternal: true,
      target: 'node',
    },
  };
});
