import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { readPhoto, cropPhoto } from './photo-processing.mjs';
import { PhotoCropper } from './PhotoCropper';

export function PhotoPicker({ value, onChange, onBusyChange, disabled }) {
  const gallery = useRef(null);
  const camera = useRef(null);
  const pending = useRef(false);
  const uploading = useRef(false);
  const [source, setSource] = useState(null);
  const [preview, setPreview] = useState('');
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function choose(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || pending.current) return;
    pending.current = true; onBusyChange(true); setError(''); setPhase('Открываем фото…');
    try { setSource(await readPhoto(file)); setPhase(''); }
    catch (err) { setError(err.message); setPhase(''); pending.current = false; onBusyChange(false); }
  }
  function cancel() {
    if (uploading.current) return;
    setSource(null); setError(''); setPhase(''); pending.current = false; onBusyChange(false);
  }
  async function confirm(area, rotation) {
    if (!source || !area || uploading.current) return;
    uploading.current = true; setError(''); setPhase('Подготавливаем кадр…');
    try {
      const blob = await cropPhoto(source, area, rotation);
      setPreview(URL.createObjectURL(blob)); setPhase('Загружаем фото…');
      const body = new FormData(); body.append('photo', blob, 'dish.jpg');
      const result = await api('/supplier/photos', { method: 'POST', body });
      onChange(result.image); setSource(null); pending.current = false; onBusyChange(false);
    } catch (err) { setError(err.message); }
    finally { uploading.current = false; setPreview(''); setPhase(''); }
  }
  const ownPhoto = value.startsWith('/media/');
  return <div className="photo-picker"><label className="photo-title">Фото блюда</label><div className="photo-preview"><img src={preview || value} alt="Превью фото блюда"/>{phase && <span role="status">{phase}</span>}{!phase && !ownPhoto && <span>Фото-пример</span>}</div>
    <input ref={gallery} type="file" accept="image/*" hidden aria-label="Выбрать файл из галереи" onChange={choose}/><input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="Снять фото камерой" onChange={choose}/>
    <div className="photo-buttons"><button className="button secondary" type="button" disabled={disabled || pending.current} onClick={() => gallery.current.click()}>Выбрать фото</button><button className="button secondary" type="button" disabled={disabled || pending.current} onClick={() => camera.current.click()}>Сфотографировать</button></div>
    {error && !source && <p role="alert" className="photo-error">{error}</p>}<p className="small text-muted">Выберите фото или сделайте снимок, затем настройте кадр. Загрузка начнётся после подтверждения обрезки. Сохраните блюдо, чтобы применить фото.</p>
    {ownPhoto && <button className="button ghost" type="button" disabled={disabled || pending.current} onClick={() => { setError(''); onChange('/assets/chicken.jpg'); }}>Вернуть фото-пример</button>}
    {!ownPhoto && <div className="field"><label htmlFor="dish-image">Или выберите фото-пример</label><select id="dish-image" value={value} disabled={disabled || pending.current} onChange={event => onChange(event.target.value)}><option value="/assets/chicken.jpg">Курица с рисом</option><option value="/assets/cutlets.jpg">Котлета с пюре</option><option value="/assets/veggie.jpg">Овощной боул</option></select></div>}
    {source && <PhotoCropper source={source} onCancel={cancel} onConfirm={confirm} phase={phase} error={error}/>}
  </div>;
}
