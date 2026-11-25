import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright-core';

const origin = process.env.WENOTE_TEST_ORIGIN;
const credentials = {email: `${randomUUID()}@test.invalid`, password: randomUUID()};
let token = '';
async function json(path, body, method = 'POST') {
  const r = await fetch(origin + path, {method, headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
  assert.ok(r.ok, `${path} ${r.status} ${await r.clone().text()}`);
  return r.json();
}
await json('/api/v1/auth/register', credentials);
({access_token: token} = await json('/api/v1/auth/login', credentials));
const vault = (await json('/api/v1/vaults', {name: '图像检查'})).id;
const base = `/api/v1/vaults/${vault}`;
const note = await json(base+'/files', {path: '原图.md', content: ''});
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOmSuJkAAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(bytes).digest('hex');
const asset = await json(base+'/assets/uploads', {file_id:note.file_id, name:'点.png', media_type:'image/png', content_size:bytes.length, content_hash:'sha256:'+hash});
const url = asset.canonical_url;
assert.equal(new URL(url).origin, origin);
const owner = (await json('/api/v1/me', undefined, 'GET')).id;
assert.match(owner, /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/u);
assert.match(vault, /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/u);
assert.deepEqual(new URL(url).pathname.split('/').slice(1, 4), ['assets', owner, vault]);
assert.equal(new URL(url).pathname.split('/').at(-1), hash.slice(0,16));
assert.equal(asset.content_hash, 'sha256:'+hash);
const complete = await fetch(origin+base+`/assets/${asset.asset_id}/complete`, {method:'POST', headers:{Authorization:`Bearer ${token}`}, body:bytes});
assert.equal(complete.status, 200);
await json(base+'/files/'+note.file_id+'/content', {base_version_id:note.version_id, content:Buffer.from(`![点](${url})`).toString('base64')}, 'PUT');
const target = (await json('/api/v1/vaults', {name:'粘贴副本'})).id;
const copy = await json(`/api/v1/vaults/${target}/files`, {path:'副本.md', content:Buffer.from(`![点](${url})`).toString('base64')});
const text = await (await fetch(`${origin}/api/v1/vaults/${target}/files/${copy.file_id}/content`, {headers:{Authorization:`Bearer ${token}`}})).text();
assert.ok(text.includes(`/${target}/`));
assert.ok(!text.includes(`/${vault}/`));
const secret=randomUUID();
const link=await json('/api/v1/share-links',{token_hash:createHash('sha256').update(secret).digest('hex'),vault_id:vault,paths:['原图.md'],expires:Math.floor(Date.now()/1000)+600});
const sessionPath=`/s/${link.id}/session`, shareImage=`${origin}/s/${link.id}/assets/${asset.asset_id}`;
const browser = await chromium.launch({channel:process.env.CHROME_PATH ? undefined : 'chrome', executablePath:process.env.CHROME_PATH});
const other = createServer((_, res) => res.end('<html><body></body></html>')).listen(0,'127.0.0.1');
try {
  await once(other,'listening');
  const page = await browser.newPage();
  await page.goto(origin);
  const observed = await page.evaluate(async ({url,token}) => {
    const r = await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    const src = URL.createObjectURL(await r.blob());
    try { const im = new Image(); im.src=src; await im.decode(); return [r.status,im.naturalWidth,r.headers.get('Cross-Origin-Resource-Policy'),r.headers.get('Cache-Control')]; }
    finally { URL.revokeObjectURL(src); }
  },{url,token});
  assert.deepEqual(observed,[200,1,'same-origin','private, no-store']);
  assert.equal((await fetch(url)).status,401);
  const session=await page.request.post(origin+sessionPath,{data:{token:secret}});
  assert.equal(session.status(),204);
  assert.equal(await page.evaluate(async u=>{const im=new Image(); im.src=u;await im.decode();return im.naturalWidth;},shareImage),1);
  for (const host of ['127.0.0.1','localhost']) {
    await page.goto(`http://${host}:${other.address().port}`);
    for(const embedded of [url,`${origin}/assets/${asset.asset_id}`,shareImage]) {
      const sent = page.waitForRequest(r=>r.url()===embedded);
      const visible = await page.evaluate(async u=>{const im=new Image();im.src=u;try{await im.decode();return true;}catch{return false;}},embedded);
      assert.equal(visible,false);await sent;
    }
  }
  const revoked=await fetch(origin+'/api/v1/share-links/'+link.id,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});
  assert.equal(revoked.status,204);
  assert.ok(!(await page.request.get(shareImage)).ok());
  console.log('Verified authenticated browser image, anonymous denial and cross-origin embedding on two origins');
} finally { other.close(); await browser.close(); }
