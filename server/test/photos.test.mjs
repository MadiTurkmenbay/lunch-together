import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { S3Client,CreateBucketCommand,DeleteBucketCommand,ListObjectsV2Command,DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../app.mjs';
import { createPhotoStorage } from '../photo-storage.mjs';
import { migrate,seed } from '../db.mjs';
import { hashPassword } from '../security.mjs';

const database = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_S3_ENDPOINT;
test('photos: real MinIO uploads, validation, metadata removal, ownership and menu snapshots',{ skip: (!database || !endpoint) && 'Set TEST_DATABASE_URL and TEST_S3_ENDPOINT to disposable services' },async t => {
  const admin = new pg.Pool({ connectionString: database }); const schema = `lt_photos_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: database,options: `-c search_path=${schema}` });
  const original = { ...process.env }; let server;
  const env = { S3_ENDPOINT: endpoint,S3_BUCKET: `lunch-photos-test-${randomUUID()}`,S3_ACCESS_KEY: 'lunch_test_storage',S3_SECRET_KEY: 'disposable_storage_password' };
  const s3 = new S3Client({ endpoint,region: 'us-east-1',forcePathStyle: true,credentials: { accessKeyId: env.S3_ACCESS_KEY,secretAccessKey: env.S3_SECRET_KEY } });
  const storage = createPhotoStorage(env);
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    const objects = await s3.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET }));
    for (const object of objects.Contents || []) await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET,Key: object.Key }));
    await s3.send(new DeleteBucketCommand({ Bucket: env.S3_BUCKET })); storage.close(); s3.destroy();
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    for (const key of ['SUPPLIER_LOGIN','SUPPLIER_PASSWORD_HASH','APP_ORIGIN']) { if (original[key] === undefined) delete process.env[key]; else process.env[key]=original[key]; }
  });
  await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  process.env.SUPPLIER_LOGIN = 'photographer'; process.env.SUPPLIER_PASSWORD_HASH = await hashPassword('photo-password-123'); delete process.env.APP_ORIGIN;
  await migrate(pool); await seed(pool);
  server = createApp({ pool,storage,logger: { error: (...args) => assert.fail(JSON.stringify(args)) } }).listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function client() {
    const jar = new Map();
    return async (path,{ method='GET',body,originHeader=origin }={}) => {
      const multipart = body instanceof FormData;
      const response = await fetch(origin+path,{ method,headers: { Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '),...(method !== 'GET' ? { Origin: originHeader,...(!multipart ? { 'Content-Type': 'application/json' } : {}) } : {}) },...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) { const pair=cookie.split(';')[0]; const at=pair.indexOf('='); jar.set(pair.slice(0,at),pair.slice(at+1)); }
      const isImage = response.headers.get('content-type')?.startsWith('image/');
      return { status: response.status,headers: response.headers,...(isImage ? { bytes: Buffer.from(await response.arrayBuffer()) } : await response.json()) };
    };
  }
  const supplier = client(); const guest = client(); let uploaded,dishId,planId;
  const post = body => ({ method: 'POST',body });
  const jpeg = await sharp({ create: { width: 2200,height: 1100,channels: 3,background: '#84ad4e' } }).jpeg().withMetadata({ orientation: 6,exif: { IFD0: { Artist: 'Private photographer' } } }).toBuffer();
  const form = (bytes=jpeg,type='image/jpeg') => { const result = new FormData(); result.append('photo',new Blob([bytes],{ type }),'photo.jpg'); return result; };
  const dish = image => ({ name: 'Photo lunch',description: 'Test meal',tag: '',details: '',price: 1150,image });
  await t.test('authentication and origin checks run before accepting a file',async () => {
    assert.equal((await guest('/api/supplier/photos',post(form()))).status,401);
    assert.equal((await supplier('/api/supplier/login',post({ login: 'photographer',password: 'photo-password-123' }))).status,200);
    assert.equal((await supplier('/api/supplier/photos',{ ...post(form()),originHeader: 'https://attacker.example' })).status,403);
    assert.equal((await supplier('/api/supplier/dishes',post(form()))).status,415);
    assert.equal((await supplier('/api/supplier/photos',post({}))).code,'PHOTO_REQUIRED');
  });
  await t.test('malformed images, SVG and excessive size cannot reach object storage',async () => {
    assert.equal((await supplier('/api/supplier/photos',post(form(Buffer.from('not a photo'))))).code,'INVALID_PHOTO');
    assert.equal((await supplier('/api/supplier/photos',post(form(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script></svg>'),'image/png')))).code,'INVALID_PHOTO');
    assert.equal((await supplier('/api/supplier/photos',post(form(Buffer.alloc(10*1024*1024+1))))).status,413);
    assert.equal((await pool.query('SELECT count(*)::int n FROM dish_photos')).rows[0].n,0);
  });
  await t.test('uploaded pixels are rotated, resized and stripped of original metadata',async () => {
    uploaded = await supplier('/api/supplier/photos',post(form())); assert.equal(uploaded.status,201);
    assert.match(uploaded.image,/^\/media\/[a-f0-9-]+\.webp$/); assert.equal(uploaded.width,800); assert.equal(uploaded.height,1600);
    const image = await guest(uploaded.image); assert.equal(image.status,200); assert.match(image.headers.get('cache-control'),/immutable/);
    const metadata = await sharp(image.bytes).metadata(); assert.equal(metadata.format,'webp'); assert.equal(metadata.exif,undefined); assert.equal(metadata.orientation,undefined); assert.equal(metadata.icc,undefined);
    assert.equal((await guest(`/media/${randomUUID()}.webp`)).status,404);
    assert.equal((await guest('/media/not-an-image.svg')).status,404);
  });
  await t.test('suppliers can attach only their own valid photos',async () => {
    assert.equal((await supplier('/api/supplier/dishes',post(dish(`/media/${randomUUID()}.webp`)))).code,'PHOTO_UNAVAILABLE');
    assert.equal((await supplier('/api/supplier/dishes',post(dish('https://example.com/photo.jpg')))).status,400);
    const other = client(); await pool.query('INSERT INTO suppliers(id,login,password_hash) VALUES($1,$2,$3)',[randomUUID(),'other',process.env.SUPPLIER_PASSWORD_HASH]);
    await other('/api/supplier/login',post({ login: 'other',password: 'photo-password-123' }));
    assert.equal((await other('/api/supplier/dishes',post(dish(uploaded.image)))).code,'PHOTO_UNAVAILABLE');
    const created = await supplier('/api/supplier/dishes',post(dish(uploaded.image))); assert.equal(created.status,201); dishId = created.id;
  });
  await t.test('published menus keep the photo snapshot when the catalog is changed',async () => {
    const body = { title: 'Menu with photo',office: 'Office',orderDeadline: new Date(Date.now()+3600000).toISOString(),paymentDeadline: new Date(Date.now()+7200000).toISOString(),deliveryAt: new Date(Date.now()+10800000).toISOString(),minParticipants: 1,minPaidPortions: 1,paymentInstructions: '',meals: [{ dishId,price: 1150 }] };
    planId=(await supplier('/api/supplier/menu-plans',post(body))).id;
    await supplier(`/api/supplier/dishes/${dishId}`,{ method: 'PUT',body: dish('/assets/chicken.jpg') });
    const first=(await guest('/api/state')).batch; await supplier(`/api/supplier/batches/${first.id}/cancel`,post({}));
    assert.equal((await supplier(`/api/supplier/menu-plans/${planId}/publish`,post({}))).status,201);
    assert.equal((await guest('/api/state')).meals[0].image,uploaded.image);
    assert.equal((await guest(uploaded.image)).status,200);
    const objects=await s3.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET })); assert.equal(objects.Contents.length,1);
    assert.equal(objects.Contents[0].Key,`dishes/${uploaded.image.split('/').at(-1)}`);
  });
  await t.test('concurrent photo processing is bounded and a failed upload releases its permit',async () => {
    const originalPut = storage.put;
    storage.put = async () => { throw new Error('private-storage-error'); };
    const failed = await supplier('/api/supplier/photos',post(form()));
    assert.equal(failed.status,503); assert.equal(failed.code,'STORAGE_UNAVAILABLE'); assert.ok(!JSON.stringify(failed).includes('private-storage-error'));
    let release,arrive;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { arrive = resolve; });
    storage.put = async (...args) => { arrive(); await held; return originalPut(...args); };
    const first = supplier('/api/supplier/photos',post(form()));
    try {
      await arrived;
      assert.equal((await supplier('/api/supplier/photos',post(form()))).code,'PHOTO_BUSY');
    } finally { release(); storage.put = originalPut; }
    assert.equal((await first).status,201);
  });

});
