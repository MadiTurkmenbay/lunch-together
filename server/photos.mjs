import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import sharp from 'sharp';
import { rateLimit } from 'express-rate-limit';

sharp.concurrency(1);
export const photoPath = /^\/media\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.webp$/;
export async function ensurePhotoOwned(db,supplierId,image,fail) {
  const match = photoPath.exec(image);
  if (match && !(await db.query('SELECT 1 FROM dish_photos WHERE id=$1 AND supplier_id=$2',[match[1],supplierId])).rowCount) {
    fail(400,'Загрузите своё фото блюда.','PHOTO_UNAVAILABLE');
  }
}

export function registerPhotos(app,{ pool,supplier,fail,storage,logger }) {
  const uploadLimit = rateLimit({ windowMs: 15*60*1000,limit: 30,keyGenerator: req => req.supplier.id,standardHeaders: 'draft-8',legacyHeaders: false,message: { error: 'За 15 минут можно загрузить 30 фото. Попробуйте позже.',code: 'PHOTO_RATE_LIMIT' } });
  const upload = multer({ storage: multer.memoryStorage(),limits: { fileSize: 10*1024*1024,files: 1,fields: 0,parts: 1 } }).single('photo');
  const receive = (req,res,next) => upload(req,res,error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Фото слишком большое. Максимум 10 МБ.',code: 'PHOTO_TOO_LARGE' });
    res.status(400).json({ error: 'Выберите одно фото.',code: 'INVALID_PHOTO_UPLOAD' });
  });
  let processing = false;
  const admit = (req,res,next) => {
    if (processing) fail(429,'Другое фото ещё загружается. Повторите через несколько секунд.','PHOTO_BUSY');
    processing = true;
    let released = false;
    const release = () => { if (!released) { released = true; processing = false; } };
    req.releasePhotoPermit = release;
    const releaseBeforeWork = () => { if (!req.photoWorkStarted) release(); };
    res.once('finish',releaseBeforeWork); res.once('close',releaseBeforeWork); next();
  };
  // Authenticate before parsing a potentially large multipart body.
  app.post('/api/supplier/photos',supplier,uploadLimit,(_req,_res,next) => { if (!storage) fail(503,'Загрузка фото пока не настроена.','STORAGE_UNAVAILABLE'); next(); },admit,receive,async (req,res) => {
    req.photoWorkStarted = true;
    try {
      if (!req.file?.buffer?.length) fail(400,'Выберите фото блюда.','PHOTO_REQUIRED');
      let normalized;
      try {
        const image = sharp(req.file.buffer,{ limitInputPixels: 40_000_000,animated: false,failOn: 'warning' });
        const metadata = await image.metadata();
        if (!['jpeg','png','webp','heif'].includes(metadata.format) || (metadata.pages || 1) > 1) fail(400,'Поддерживаются обычные фото JPG, PNG и WebP.','INVALID_PHOTO');
        normalized = await image.rotate().resize({ width: 1600,height: 1600,fit: 'inside',withoutEnlargement: true }).webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
      } catch (error) {
        if (error.status) throw error;
        fail(400,'Не удалось прочитать фото. Попробуйте выбрать JPG, PNG или WebP.','INVALID_PHOTO');
      }
      const id = randomUUID(); const key = `dishes/${id}.webp`;
      try { await storage.put(key,normalized.data); }
      catch { fail(503,'Не удалось сохранить фото. Попробуйте ещё раз.','STORAGE_UNAVAILABLE'); }
      try {
        await pool.query('INSERT INTO dish_photos(id,supplier_id,object_key,byte_size,width,height) VALUES($1,$2,$3,$4,$5,$6)',[id,req.supplier.id,key,normalized.data.length,normalized.info.width,normalized.info.height]);
      } catch (error) { await storage.remove(key).catch(() => logger.error('Photo cleanup failed')); throw error; }
      res.status(201).json({ image: `/media/${id}.webp`,width: normalized.info.width,height: normalized.info.height });
    } finally { req.releasePhotoPermit(); }
  });
  app.get('/media/:file',async (req,res) => {
    const match = photoPath.exec(`/media/${req.params.file}`);
    if (!match) fail(404,'Фото не найдено.','NOT_FOUND');
    const photo = (await pool.query('SELECT object_key,byte_size FROM dish_photos WHERE id=$1',[match[1]])).rows[0];
    if (!photo) fail(404,'Фото не найдено.','NOT_FOUND');
    if (!storage) fail(503,'Фото временно недоступно.','STORAGE_UNAVAILABLE');
    let stream;
    try { stream = await storage.get(photo.object_key); }
    catch (error) {
      if (['NoSuchKey','NotFound'].includes(error.name || error.code)) fail(404,'Фото не найдено.','NOT_FOUND');
      fail(503,'Фото временно недоступно.','STORAGE_UNAVAILABLE');
    }
    res.set({ 'Content-Type': 'image/webp','Content-Length': String(photo.byte_size),'Cache-Control': 'public, max-age=31536000, immutable' });
    try { await pipeline(stream,res); } catch { stream.destroy(); }
  });
}
