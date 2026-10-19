export async function readPhoto(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Выберите фото размером до 25 МБ.');
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error('Выберите изображение из галереи.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { throw new Error('Телефон не смог открыть это фото. Попробуйте JPG, PNG или WebP.'); }
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || width * height > 40_000_000) throw new Error('Слишком большое разрешение. Выберите фото до 40 мегапикселей.');
    return { url, image, width, height };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

// Cropper coordinates are relative to the rotated image's bounding box.
// Draw directly to the small output canvas, avoiding a full-resolution rotated copy.
export function cropGeometry(width, height, area, rotation = 0) {
  if (![width, height, area?.x, area?.y, area?.width, area?.height, rotation].every(Number.isFinite)
    || width <= 0 || height <= 0 || area.width <= 0 || area.height <= 0 || rotation % 90 !== 0) {
    throw new Error('Не удалось определить границы кадра. Попробуйте ещё раз.');
  }
  const angle = ((rotation % 360) + 360) % 360;
  const rotatedWidth = angle % 180 === 0 ? width : height;
  const rotatedHeight = angle % 180 === 0 ? height : width;
  const x = Math.max(0, Math.min(area.x, rotatedWidth - 1));
  const y = Math.max(0, Math.min(area.y, rotatedHeight - 1));
  const cropWidth = Math.min(area.width, rotatedWidth - x);
  const cropHeight = Math.min(area.height, rotatedHeight - y);
  const scale = Math.min(1, 1600 / Math.max(cropWidth, cropHeight));
  return { x, y, scale, rotatedWidth, rotatedHeight, radians: angle * Math.PI / 180,
    outputWidth: Math.max(1, Math.round(cropWidth * scale)), outputHeight: Math.max(1, Math.round(cropHeight * scale)) };
}

export async function cropPhoto(source, area, rotation) {
  const geometry = cropGeometry(source.width, source.height, area, rotation);
  const canvas = document.createElement('canvas');
  canvas.width = geometry.outputWidth;
  canvas.height = geometry.outputHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Не получилось подготовить фото. Попробуйте другой браузер.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(geometry.scale, geometry.scale);
  context.translate(-geometry.x, -geometry.y);
  context.translate(geometry.rotatedWidth / 2, geometry.rotatedHeight / 2);
  context.rotate(geometry.radians);
  context.drawImage(source.image, -source.width / 2, -source.height / 2);
  let blob;
  for (const quality of [.88, .76, .64, .52]) {
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= 900 * 1024) break;
  }
  if (!blob) throw new Error('Не получилось подготовить фото. Попробуйте другое.');
  if (blob.size > 900 * 1024) throw new Error('Не получилось сжать фото. Попробуйте снимок меньшего разрешения.');
  return blob;
}
