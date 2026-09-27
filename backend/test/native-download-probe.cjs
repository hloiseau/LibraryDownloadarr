const fs = require('node:fs');
const Module = require('node:module');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const repo = process.cwd();
const html = `<!doctype html><button id="save">Save file</button><script>
navigator.serviceWorker.register('/service-worker.js');
document.querySelector('#save').onclick = async () => {
 const headers = { Authorization: 'Bearer session-alice', 'Content-Type': 'application/json' };
 const job = await (await fetch('/api/downloads', { method:'POST', headers,
 body: JSON.stringify({ratingKey:'1',partKey:'/library/parts/1/file.mkv',quality:'720p-2'}) })).json();
 const {ticket} = await (await fetch('/api/downloads/'+job.id+'/ticket', { method:'POST', headers })).json();
 const form = document.createElement('form'); form.method='POST'; form.action='/api/downloads/'+job.id+'/file';
 const input=document.createElement('input'); input.type='hidden'; input.name='ticket'; input.value=ticket;
 form.appendChild(input); document.body.appendChild(form); form.submit(); form.remove();
};</script>`;
globalThis.__downloadSmokeHtml = html;
const filename = `${repo}/backend/test/downloads.test.js`;
const fixtureModule = new Module(filename);
fixtureModule.filename = filename;
fixtureModule.paths = Module._nodeModulePaths(`${repo}/backend/test`);
fixtureModule._compile(fs.readFileSync(filename, 'utf8').replace("const { test } = require('node:test');", 'const test = () => {};').replace('const server = http.createServer(app);', `
  app.get(['/','/index.html'], (_req,res)=>res.type('html').send(globalThis.__downloadSmokeHtml));
  app.get('/service-worker.js', (_req,res)=>res.type('application/javascript').send(globalThis.__downloadSmokeWorker));
  const server = http.createServer(app);`) + '\nmodule.exports = { fixture, application };', filename);
const { fixture, application } = fixtureModule.exports;
const cleanup = [];
const t = { after: fn => cleanup.push(fn) };
(async () => {
 let browser;
 try {
  const f = await fixture(t, { status: 'available', streamMedia: async (_req, res) => {
    const block = Buffer.alloc(128 * 1024, 0x5a);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': block.length*32 });
    try {
      for(let i=0;i<32;i++) {
        if (!res.write(block)) await once(res, 'drain');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      res.end();
    } catch {}
  } });
  const app = await application(t, f);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless:true, args:['--no-sandbox'] });
  const oldWorker=fs.readFileSync(`${repo}/frontend/public/service-worker.js`,'utf8');
  for(const variant of ['current-worker','network-bypass']) {
   globalThis.__downloadSmokeWorker = variant === 'current-worker' ? oldWorker : oldWorker.replaceAll('event.respondWith(fetch(event.request));','// Native network bypass.');
   const context = await browser.newContext({acceptDownloads:true});
   const page = await context.newPage();
   await page.goto(app.url);
   await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
   const cdp = await context.newCDPSession(page);
   await cdp.send('Network.enable');
   cdp.on('Network.loadingFailed',e=>console.log(JSON.stringify({variant,networkFailure:e.errorText,type:e.type})));
   const begin=Date.now();
   const waiting = page.waitForEvent('download',{timeout:15000});
   await page.click('#save');
   const download=await waiting;
   const failure=await download.failure();
   const path=failure?null:await download.path();
   console.log(JSON.stringify({variant,serviceWorkerControlled:await page.evaluate(()=>!!navigator.serviceWorker.controller),failure,bytes:path?fs.statSync(path).size:null,elapsedMs:Date.now()-begin}));
   if(variant === 'network-bypass' && (failure || fs.statSync(path).size !== 4194304)) throw new Error('Native bypass download failed');
   await context.close();
  }
 } catch(error) {console.error(error);process.exitCode=1;}
 finally {await browser?.close();for(const fn of cleanup.reverse())await fn();}
})();
