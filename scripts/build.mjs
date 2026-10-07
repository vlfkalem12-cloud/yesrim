import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const main = { entryPoints: ['src/code.ts'], bundle: true, outfile: 'dist/code.js', target: 'es2020', format: 'iife' };
const ui = { entryPoints: ['src/ui.ts'], bundle: true, write: false, target: 'es2020', format: 'iife' };
async function writeUI(result) {
  const template = await readFile('src/ui.html', 'utf8');
  await writeFile('dist/ui.html', template.replace('<!-- UI_SCRIPT -->', `<script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`));
}
if (process.argv.includes('--watch')) {
  const uiContext = await context({ ...ui, plugins: [{ name: 'embed-ui', setup(b) { b.onEnd(async result => { if (!result.errors.length) await writeUI(result); }); } }] });
  const mainContext = await context(main);
  await Promise.all([uiContext.watch(), mainContext.watch()]);
  // esbuild watches TS; HTML needs its own watcher.
  const { watch } = await import('node:fs');
  watch('src/ui.html', () => uiContext.rebuild());
  console.log('Watching src/. Reload the development plugin in Figma after changes.');
} else {
  await Promise.all([build(main), build(ui).then(writeUI)]);
  console.log('Built dist/code.js and dist/ui.html');
}
