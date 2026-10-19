import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Cropper from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import './photo-cropper.css';

export function PhotoCropper({ source, onCancel, onConfirm, phase, error }) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [format, setFormat] = useState('menu');
  const [area, setArea] = useState(null);
  const panel = useRef(null);
  const cancel = useRef(onCancel);
  const working = useRef(false);
  cancel.current = onCancel;
  working.current = !!phase;
  const originalAspect = rotation % 180 === 0 ? source.width / source.height : source.height / source.width;
  const aspect = format === 'square' ? 1 : format === 'original' ? originalAspect : 4 / 3;
  const onAreaChange = useCallback((_percent, pixels) => setArea(pixels), []);

  useEffect(() => {
    const previous = document.activeElement;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const background = [...document.body.children].filter(element => !element.contains(panel.current));
    const inert = background.map(element => [element, element.inert]);
    background.forEach(element => { element.inert = true; });
    panel.current.querySelector('button')?.focus();
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (!working.current) cancel.current(); }
      if (event.key !== 'Tab') return;
      const elements = [...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(element => !element.closest('[inert]'));
      const first = elements[0]; const last = elements.at(-1);
      if (!first) { event.preventDefault(); panel.current.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = scroll;
      inert.forEach(([element, value]) => { element.inert = value; });
      requestAnimationFrame(() => previous?.focus());
    };
  }, []);

  function reset(nextFormat = format, nextRotation = rotation) {
    setArea(null); setCrop({ x: 0, y: 0 }); setZoom(1);
    setFormat(nextFormat); setRotation(nextRotation);
  }

  return createPortal(<div className="crop-backdrop"><section ref={panel} className="crop-panel" role="dialog" aria-modal="true" aria-labelledby="crop-title" aria-describedby="crop-help" aria-busy={!!phase} tabIndex={-1}>
    <header className="crop-header"><div><span>ФОТО БЛЮДА</span><h2 id="crop-title">Кадрирование фото</h2></div><button type="button" className="crop-close" aria-label="Отменить кадрирование" onClick={onCancel} disabled={!!phase}>×</button></header>
    <p id="crop-help" className="crop-help">Двигайте фото пальцем. Меняйте масштаб двумя пальцами или ползунком.</p>
    <div className={`crop-stage ${phase ? 'crop-working' : ''}`} inert={!!phase}><Cropper image={source.url} crop={crop} zoom={zoom} rotation={rotation} aspect={aspect} minZoom={1} maxZoom={3} onCropChange={setCrop} onZoomChange={setZoom} onCropAreaChange={onAreaChange} disableAutomaticStylesInjection showGrid keyboardStep={10} cropperProps={{ tabIndex: 0, 'aria-label': 'Переместить фото в рамке', 'aria-describedby': 'crop-help' }} mediaProps={{ alt: 'Фото для кадрирования' }}/></div>
    <div className="crop-controls"><div className="crop-formats" role="group" aria-label="Формат кадра">{[['menu', '4:3'], ['square', 'Квадрат'], ['original', 'Исходный']].map(([value, label]) => <button type="button" key={value} aria-pressed={format === value} disabled={!!phase} onClick={() => reset(value)}>{label}</button>)}</div>
      <div className="crop-zoom-label"><label htmlFor="crop-zoom">Масштаб</label><output htmlFor="crop-zoom">{Math.round(zoom * 100)}%</output></div><input id="crop-zoom" type="range" min={1} max={3} step={.01} value={zoom} disabled={!!phase} onChange={event => setZoom(Number(event.target.value))}/>
      <div className="crop-tools"><button type="button" disabled={!!phase} onClick={() => reset(format, (rotation + 90) % 360)}>↻ Повернуть</button><button type="button" disabled={!!phase} onClick={() => reset(format, 0)}>Сбросить</button></div>
      {error && <p className="crop-error" role="alert">{error}</p>}{phase && <p className="crop-progress" role="status">{phase}</p>}
    </div>
    <footer className="crop-footer"><button type="button" className="button secondary" onClick={onCancel} disabled={!!phase}>Отмена</button><button type="button" className="button primary" onClick={() => onConfirm(area, rotation)} disabled={!!phase || !area}>{phase ? 'Подождите…' : 'Обрезать и загрузить'}</button></footer>
  </section></div>, document.body);
}
