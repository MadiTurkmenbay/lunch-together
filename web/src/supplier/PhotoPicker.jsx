import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';

async function preparePhoto(file) {
  if (file.size > 25*1024*1024) throw new Error('Выберите фото размером до 25 МБ.');
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error('Выберите изображение из галереи.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch { throw new Error('Телефон не смог открыть это фото. Попробуйте JPG, PNG или WebP.'); }
    if (!image.naturalWidth || image.naturalWidth*image.naturalHeight > 40_000_000) throw new Error('Слишком большое разрешение. Выберите фото до 40 мегапикселей.');
    const scale = Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1,Math.round(image.naturalWidth*scale)); canvas.height = Math.max(1,Math.round(image.naturalHeight*scale));
    const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(image,0,0,canvas.width,canvas.height);
    let blob;
    for (const quality of [.88,.76,.64,.52]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',quality));
      if (blob && blob.size <= 900*1024) break;
    }
    if (blob?.size > 900*1024) throw new Error('Не получилось сжать фото. Попробуйте снимок меньшего разрешения.');
    if (!blob) throw new Error('Не получилось подготовить фото. Попробуйте другое.');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

export function PhotoPicker({ value,onChange,onBusyChange,disabled }) {
  const gallery = useRef(null); const camera = useRef(null); const pending = useRef(false);
  const [preview,setPreview] = useState(''); const [phase,setPhase] = useState(''); const [error,setError] = useState('');
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); },[preview]);
  async function choose(event) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file || pending.current) return;
    pending.current = true; onBusyChange(true); setError(''); setPhase('Сжимаем фото…');
    try {
      const blob = await preparePhoto(file); setPreview(URL.createObjectURL(blob)); setPhase('Загружаем фото…');
      const body = new FormData(); body.append('photo',blob,'dish.jpg');
      const result = await api('/supplier/photos',{ method: 'POST',body });
      onChange(result.image); setPreview('');
    } catch (err) { setPreview(''); setError(err.message); }
    finally { pending.current = false; setPhase(''); onBusyChange(false); }
  }
  const ownPhoto = value.startsWith('/media/');
  return <div className="photo-picker"><label className="photo-title">Фото блюда</label><div className="photo-preview"><img src={preview || value} alt="Превью фото блюда"/>{phase && <span role="status">{phase}</span>}{!phase && !ownPhoto && <span>Фото-пример</span>}</div><input ref={gallery} type="file" accept="image/*" hidden aria-label="Выбрать файл из галереи" onChange={choose}/><input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="Снять фото камерой" onChange={choose}/><div className="photo-buttons"><button className="button secondary" type="button" disabled={disabled || !!phase} onClick={() => gallery.current.click()}>Выбрать фото</button><button className="button secondary" type="button" disabled={disabled || !!phase} onClick={() => camera.current.click()}>Сфотографировать</button></div>{error && <p role="alert" className="photo-error">{error}</p>}<p className="small text-muted">Из галереи или с камеры. Фото сжимается, геометки удаляются. Сохраните блюдо, чтобы применить фото.</p>{ownPhoto && <button className="button ghost" type="button" disabled={disabled || !!phase} onClick={() => { setError(''); onChange('/assets/chicken.jpg'); }}>Вернуть фото-пример</button>}{!ownPhoto && <div className="field"><label htmlFor="dish-image">Или выберите фото-пример</label><select id="dish-image" value={value} disabled={disabled || !!phase} onChange={e => onChange(e.target.value)}><option value="/assets/chicken.jpg">Курица с рисом</option><option value="/assets/cutlets.jpg">Котлета с пюре</option><option value="/assets/veggie.jpg">Овощной боул</option></select></div>}</div>;
}
