import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['extension/src/content.entry.js'], outfile: 'extension/dist/content.js' },
  { ...common, entryPoints: ['extension/src/bridge.js'], outfile: 'extension/dist/bridge.js' },
];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching... (Ctrl+C to stop)');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
