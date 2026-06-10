import puppeteer from 'puppeteer';
import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const root = '/home/user/DeadZone';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/preview.html';
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': mime[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(8906, r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
for (const m of ['zombie_necromorph', 'zombie_walk_a', 'zombie_walk_b']) {
  for (const [tag, a] of [['front', 0.3], ['back34', 2.6]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 720 });
    await page.goto(`http://localhost:8906/preview.html?m=${m}&a=${a}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__done === true', { timeout: 60000 });
    if (tag === 'front') {
      const info = await page.evaluate(() => window.__info || window.__err);
      console.log(m, JSON.stringify(info));
    }
    await page.screenshot({ path: `/tmp/prev_${m}_${tag}.png` });
    await page.close();
  }
}
await browser.close(); server.close();
