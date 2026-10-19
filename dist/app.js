(() => {
  'use strict';

  const STORAGE_KEY = 'lunch-together-demo-v2';
  const MINIMUM = 10;
  const PRICE = 1100;
  const MEALS = [
    { id: 'chicken', name: 'Курица с рисом', description: 'Курица, рассыпчатый рис, яйцо и свежий огурец', tag: 'Выбор команды', image: 'chicken.jpg', details: 'Комплекс · 420 г' },
    { id: 'cutlets', name: 'Котлета с пюре', description: 'Куриная котлета, картофельное пюре и грибной соус', tag: 'Как дома', image: 'cutlets.jpg', details: 'Комплекс · 450 г' },
    { id: 'veggie', name: 'Овощной боул', description: 'Капуста, морковь, зелёный горошек и сладкий перец', tag: 'Без мяса', image: 'veggie.jpg', details: 'Комплекс · 380 г' },
  ];
  const PEOPLE = [
    ['Алия С.', 'Дизайн', 'chicken'], ['Марат К.', 'Разработка', 'cutlets'],
    ['Дана А.', 'Маркетинг', 'veggie'], ['Руслан Т.', 'Разработка', 'chicken'],
    ['Камила Н.', 'Продажи', 'chicken'], ['Тимур Б.', 'Продукт', 'cutlets'],
    ['Аружан М.', 'Финансы', 'veggie'], ['Ерлан Д.', 'Операции', 'cutlets'],
    ['Сауле Р.', 'Дизайн', 'chicken'], ['Данияр Ж.', 'Разработка', 'cutlets'],
    ['Асем О.', 'Маркетинг', 'veggie'], ['Нурлан Е.', 'Продажи', 'chicken'],
  ];
  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const toastElement = document.getElementById('toast');
  if (!app || !modalRoot) return;
  let modalKind = null;
  let previousFocus = null;
  let toastTimer;
  let storageUnavailable = false;
  let editing = false;
  let state;

  const money = (value) => `${new Intl.NumberFormat('ru-RU').format(value)} ₸`;
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const countItems = (items) => MEALS.reduce((total, meal) => total + (Number(items?.[meal.id]) || 0), 0);
  const personTotal = (person) => countItems(person.items) * PRICE;
  const mine = () => state.participants.find((person) => person.id === state.userId) || null;
  const requestsCount = () => state.participants.length;
  const allPortions = () => state.participants.reduce((total, person) => total + countItems(person.items), 0);
  const paidPeople = () => state.participants.filter((person) => person.payment === 'paid');
  const paidPortions = () => paidPeople().reduce((total, person) => total + countItems(person.items), 0);
  const paymentOpen = () => requestsCount() >= MINIMUM;
  const canAccept = () => paymentOpen() && paidPortions() >= MINIMUM && !state.accepted;
  const itemsLabel = (items) => MEALS.filter((meal) => items[meal.id] > 0).map((meal) => `${meal.name} × ${items[meal.id]}`).join(', ');
  const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('');
  const currentScreen = () => ['menu', 'order', 'supplier'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'menu';
  state = readState();

  function icon(name) {
    const paths = {
      arrow: '<path d="M4 10h12M11 5l5 5-5 5"/>',
      check: '<path d="m4 10 4 4 8-8"/>',
      clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
      people: '<path d="M2 17v-2a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v2M14 3a3 3 0 0 1 0 6M15 11a4 4 0 0 1 3 4v2"/><circle cx="7.5" cy="5.5" r="3.5"/>',
      location: '<path d="M16 8c0 4-6 9-6 9S4 12 4 8a6 6 0 0 1 12 0Z"/><circle cx="10" cy="8" r="2"/>',
      copy: '<rect x="6" y="6" width="11" height="11" rx="2"/><path d="M13 6V3H3v10h3"/>',
      close: '<path d="m5 5 10 10M15 5 5 15"/>',
      wallet: '<path d="M16 7V4H4a2 2 0 0 0 0 4h13v8H4a2 2 0 0 1-2-2V6"/><path d="M17 10h-5v3h5"/>',
      plus: '<path d="M10 4v12M4 10h12"/>',
      leaf: '<path d="M16 3C6 2 2 7 5 13s12 4 11-10Z"/><path d="M4 17 12 8"/>',
    };
    return `<svg class="inline-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.check}</svg>`;
  }

  function makeDemoPerson(index, payment = 'unpaid') {
    const [name, department, meal] = PEOPLE[index % PEOPLE.length];
    return { id: `demo-${index}`, name, department, items: { [meal]: 1 }, payment, isDemo: true };
  }

  function initialState() {
    return { version: 2, participants: Array.from({ length: 8 }, (_, index) => makeDemoPerson(index)), userId: null, draft: { chicken: 1, cutlets: 0, veggie: 0 }, accepted: false, scenario: 'collecting' };
  }

  function cleanItems(items) {
    return Object.fromEntries(MEALS.map((meal) => [meal.id, Math.max(0, Math.min(9, Math.floor(Number(items?.[meal.id]) || 0)))]));
  }

  function readState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || saved.version !== 2 || !Array.isArray(saved.participants)) return initialState();
      const participants = saved.participants.slice(0, 100).filter((person) => person && typeof person.id === 'string' && typeof person.name === 'string').map((person) => ({
        id: person.id.slice(0, 80), name: person.name.slice(0, 60), department: String(person.department || '').slice(0, 60),
        items: cleanItems(person.items), payment: ['unpaid', 'pending', 'paid'].includes(person.payment) ? person.payment : 'unpaid', isDemo: Boolean(person.isDemo),
      })).filter((person) => countItems(person.items) > 0);
      if (!participants.length) return initialState();
      return { version: 2, participants, userId: typeof saved.userId === 'string' ? saved.userId : null, draft: cleanItems(saved.draft), accepted: Boolean(saved.accepted) && participants.filter((person) => person.payment === 'paid').reduce((total, person) => total + countItems(person.items), 0) >= MINIMUM, scenario: ['collecting', 'payment', 'ready'].includes(saved.scenario) ? saved.scenario : 'collecting' };
    } catch (_) {
      return initialState();
    }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (_) { storageUnavailable = true; }
  }

  function toast(message) {
    if (!toastElement) return;
    clearTimeout(toastTimer);
    toastElement.textContent = message;
    toastElement.classList.add('visible', 'show');
    toastTimer = setTimeout(() => {
      toastElement.classList.remove('visible', 'show');
      toastElement.textContent = '';
    }, 3800);
  }

  function navigate(screen) {
    closeModal();
    if (currentScreen() === screen && location.hash === `#${screen}`) render();
    else location.hash = screen;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function progressMarkup() {
    const count = paymentOpen() ? paidPortions() : requestsCount();
    const ready = paidPortions() >= MINIMUM;
    const label = state.accepted ? 'Заказ принят в приготовление' : paymentOpen() ? 'Собираем подтверждённые оплаты' : 'Собираем участников';
    const description = state.accepted ? `${paidPortions()} оплаченных порций отправятся в офис` : paymentOpen() ? `Готовим после подтверждения оплаты ${MINIMUM} порций` : `Для открытия оплаты нужно ${MINIMUM} участников`;
    return `<div class="section-heading"><h2>${label}</h2><span class="badge ${state.accepted || ready ? 'green' : 'orange'}">${Math.min(count, MINIMUM)} / ${MINIMUM}</span></div>
      <div class="progress-track" role="progressbar" aria-label="${paymentOpen() ? 'Подтверждённые оплаченные порции' : 'Участники заказа'}" aria-valuemin="0" aria-valuemax="${MINIMUM}" aria-valuenow="${Math.min(count, MINIMUM)}"><div class="progress-fill" style="width:${Math.min(100, count / MINIMUM * 100)}%"></div></div>
      <div class="progress-dots" aria-hidden="true">${Array.from({ length: MINIMUM }, (_, index) => `<span class="${index < count ? 'filled' : ''}">${index < count ? '✓' : ''}</span>`).join('')}</div>
      <p class="text-muted small">${description}</p>`;
  }

  function statusBadge(person) {
    if (state.accepted) return `<span class="status-pill ${person.payment === 'paid' ? 'paid' : 'pending'}">${person.payment === 'paid' ? 'В приготовлении' : 'Не включён'}</span>`;
    if (person.payment === 'paid') return '<span class="status-pill paid">Оплата подтверждена</span>';
    if (person.payment === 'pending') return '<span class="status-pill pending">На проверке</span>';
    return '<span class="status-pill pending">Не оплачено</span>';
  }

  function deliveryMarkup() {
    return `<div class="info-row"><span>${icon('clock')} Заявки до 10:30 · оплата до 11:00</span><span>${icon('location')} Команда · 3 этаж · 12:30–13:00</span></div>`;
  }

  function renderMenu() {
    const own = mine();
    const locked = state.accepted || (own && !editing);
    const quantity = countItems(state.draft);
    const progressCount = requestsCount();
    return `<div class="page-heading"><p class="eyebrow">ВТОРНИК, 20 ОКТЯБРЯ</p><h1>Что на обед?</h1><p>Вкуснее, когда вместе. Выберите обед для себя — соберём доставку с коллегами.</p></div>
      <section class="hero-card"><div class="hero-copy"><span class="badge light">${state.accepted ? 'Доставка подтверждена' : paymentOpen() ? 'Уже можно оплачивать' : 'Один офис — один заказ'}</span><h2>${state.accepted ? 'Обед уже в планах' : 'Собираемся на обед'}</h2><p>${state.accepted ? 'Поставщик принял оплаченные порции. Скоро встретимся за обедом.' : `Нужно ${MINIMUM} участников, чтобы открыть оплату. Сейчас с нами ${progressCount}.`}</p><div class="hero-amount">${progressCount}<span> / ${MINIMUM} участников</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, progressCount * 10)}%"></div></div></div><div class="hero-art" aria-hidden="true"><img src="assets/chicken.jpg" alt=""></div></section>
      ${deliveryMarkup()}
      ${state.accepted ? '<div class="alert success">Заказ принят. Новые заявки и изменения закрыты.</div>' : ''}
      ${own && !editing ? `<div class="alert success">${icon('check')} Вы уже в списке! Ваш выбор: ${escape(itemsLabel(own.items))}.</div>` : ''}
      <div class="section-heading"><h2>Меню на завтра</h2><span>3 комплекса · по ${money(PRICE)}</span></div>
      <div class="menu-grid">${MEALS.map((meal) => {
        const selected = own && !editing ? (own.items[meal.id] || 0) : (state.draft[meal.id] || 0);
        return `<article class="meal-card ${selected > 0 ? 'selected' : ''}"><img class="meal-image" src="assets/${meal.image}" alt="${escape(meal.name)}" loading="${meal.id === 'chicken' ? 'eager' : 'lazy'}"><div class="meal-body"><span class="meal-tag">${meal.id === 'veggie' ? icon('leaf') : ''}${meal.tag}</span><h3>${meal.name}</h3><p class="text-muted">${meal.description}</p><span class="small text-muted">${meal.details}</span><div class="meal-footer"><span class="meal-price">${money(PRICE)}</span><div class="quantity-control" aria-label="Количество: ${meal.name}"><button type="button" data-action="quantity" data-meal="${meal.id}" data-delta="-1" aria-label="Убрать: ${meal.name}" ${locked || selected <= 0 ? 'disabled' : ''}>−</button><span aria-live="polite">${selected}</span><button type="button" data-action="quantity" data-meal="${meal.id}" data-delta="1" aria-label="Добавить: ${meal.name}" ${locked || selected >= 9 ? 'disabled' : ''}>+</button></div></div></div></article>`;
      }).join('')}</div>
      <div class="notice">${icon('people')} Каждый выбирает свой обед. Курьер привозит общий заказ прямо в офис.</div>
      <div class="sticky-action"><div class="action-summary"><strong>${own && !editing ? 'Вы в заказе' : `${quantity} ${portionWord(quantity)}`}</strong><span>${money((own && !editing ? countItems(own.items) : quantity) * PRICE)}</span></div><button type="button" class="button primary" data-action="${own && !editing || state.accepted ? 'go-order' : editing ? 'save-edit' : 'join'}" ${!own && !state.accepted && quantity === 0 ? 'disabled' : ''}>${state.accepted || own && !editing ? 'Мой заказ' : editing ? 'Сохранить выбор' : 'Присоединиться'} ${icon('arrow')}</button></div>`;
  }

  function portionWord(quantity) {
    const value = quantity % 100;
    if (value >= 11 && value <= 14) return 'порций';
    if (quantity % 10 === 1) return 'порция';
    if (quantity % 10 >= 2 && quantity % 10 <= 4) return 'порции';
    return 'порций';
  }

  function renderOrder() {
    const own = mine();
    let ownContent;
    if (!own) {
      ownContent = `<section class="card empty-state"><div class="success-mark">${icon('people')}</div><h2>Ваш обед ещё не выбран</h2><p class="text-muted">Загляните в меню и добавьте свой комплекс к общему заказу.</p><button class="button primary" type="button" data-action="go-menu">Выбрать обед ${icon('arrow')}</button></section>`;
    } else {
      const excluded = state.accepted && own.payment !== 'paid';
      ownContent = `<section class="card"><div class="section-heading"><h2>Мой обед</h2>${statusBadge(own)}</div><p class="small text-muted">${escape(own.name)} · ${escape(own.department || 'Команда офиса')}</p><div class="stack">${MEALS.filter((meal) => own.items[meal.id] > 0).map((meal) => `<div class="order-row"><img src="assets/${meal.image}" alt="" width="64" height="64"><div class="order-meta"><strong>${meal.name}</strong><span class="text-muted small">${own.items[meal.id]} × ${money(PRICE)}</span></div><strong>${money(own.items[meal.id] * PRICE)}</strong></div>`).join('')}</div><div class="divider"></div><div class="total-row"><span>Итого за мой заказ</span><strong>${money(personTotal(own))}</strong></div>${excluded ? '<div class="alert warning">Ваша заявка не вошла в доставку: к моменту принятия заказа оплата не была подтверждена.</div>' : ''}${!state.accepted && own.payment === 'unpaid' ? '<button class="button ghost" type="button" data-action="edit-order">Изменить выбор</button>' : ''}</section>
      <section class="card payment-card"><div class="section-heading"><h2>${state.accepted && own.payment === 'paid' ? 'Всё готово к доставке' : own.payment === 'paid' ? 'Оплата подтверждена' : own.payment === 'pending' ? 'Перевод на проверке' : 'Оплата поставщику'}</h2>${icon('wallet')}</div>${paymentDescription(own)}${!state.accepted && own.payment === 'unpaid' ? `<button class="button primary full" type="button" data-action="pay" ${!paymentOpen() ? 'disabled' : ''}>Демо-оплата · ${money(personTotal(own))}</button>` : ''}${own.payment === 'pending' && !state.accepted ? '<button class="button secondary full" type="button" data-action="go-supplier">Показать подтверждение поставщику</button>' : ''}<p class="small text-muted">Демо: деньги не списываются, настоящих переводов нет.</p></section>`;
    }
    return `<div class="page-heading"><p class="eyebrow">НАШ ОБЩИЙ ОБЕД</p><h1>Мой заказ</h1><p>${state.accepted ? 'Поставщик принял заказ. Ждём доставку в офис.' : 'Ваш выбор и общий прогресс — всё в одном месте.'}</p></div>
      <section class="card">${progressMarkup()}<div class="divider"></div><div class="detail-row"><span class="text-muted">Участников</span><strong>${requestsCount()}</strong></div><div class="detail-row"><span class="text-muted">Оплаченных порций</span><strong>${paidPortions()} из ${MINIMUM}</strong></div><div class="detail-row"><span class="text-muted">Доставка в офис</span><strong>12:30–13:00</strong></div></section>
      ${ownContent}
      ${!state.accepted ? `<section class="card"><div class="section-heading"><h2>С коллегами быстрее</h2>${icon('people')}</div><p class="text-muted">${paymentOpen() ? 'Группа собрана. Теперь участникам нужно оплатить, а поставщику — подтвердить поступления.' : `Ещё ${Math.max(0, MINIMUM - requestsCount())} ${requestsCount() === 9 ? 'участник' : 'участника'} — и откроется оплата.`}</p><button type="button" class="button secondary full" data-action="invite">${icon('copy')} Пригласить коллегу</button>${!paymentOpen() ? '<button type="button" class="button ghost full" data-action="add-person">Демо: добавить участника</button>' : ''}</section>` : ''}
      <section class="card"><h2>Как всё устроено</h2><div class="step-list"><div class="step-row"><span class="step-number">1</span><div><strong>Собираем 10 участников</strong><p class="small text-muted">До этого записываемся без оплаты.</p></div></div><div class="step-row"><span class="step-number">2</span><div><strong>Оплачиваем и проверяем</strong><p class="small text-muted">После набора группы открывается демо-оплата. Поступление подтверждает поставщик.</p></div></div><div class="step-row"><span class="step-number">3</span><div><strong>Поставщик принимает заказ</strong><p class="small text-muted">Минимум 10 оплаченных порций. В доставку входят только подтверждённые позиции.</p></div></div></div></section>
      <div class="notice">Условия пилота: сбор 10 заявок ещё не гарантирует 10 оплат. Если оплаченных порций меньше 10, заказ не принимается. В реальном пилоте до запуска нужно согласовать возврат предоплаты при недоборе.</div>`;
  }

  function paymentDescription(own) {
    if (state.accepted) return `<p class="text-muted">${own.payment === 'paid' ? 'Ваш обед включён в общий заказ. Встречаемся у точки доставки.' : 'Сбор и проверка оплат закрыты. Эта заявка не включена в принятый заказ.'}</p>`;
    if (own.payment === 'paid') return '<div class="alert success">Поставщик подтвердил демо-поступление. Ваши порции учитываются в минимуме для приготовления.</div>';
    if (own.payment === 'pending') return '<p class="text-muted">Вы смоделировали перевод. Пока поставщик не подтвердит поступление, эти порции не учитываются как оплаченные.</p>';
    if (!paymentOpen()) return '<p class="text-muted">Откроется, когда соберутся 10 участников. Сейчас можно пригласить коллег и выбрать обед.</p>';
    return '<p class="text-muted">Группа собрана. Можно показать демо-предоплату. Само нажатие не подтверждает оплату — её проверяет поставщик.</p>';
  }

  function renderSupplier() {
    const paid = paidPortions();
    const requested = allPortions();
    return `<div class="page-heading"><p class="eyebrow">КАБИНЕТ ПОСТАВЩИКА · КУХНЯ АЗАТА</p><h1>Один офис. Один заказ.</h1><p>Понятный список блюд, участники и подтверждение оплат.</p></div>
      <div class="demo-controls"><span class="small text-muted">Демо-сценарий</span><div class="tabs" role="group" aria-label="Демонстрационные сценарии"><button class="${state.scenario === 'collecting' ? 'active' : ''}" type="button" data-action="scenario" data-scenario="collecting" aria-pressed="${state.scenario === 'collecting'}">Набор</button><button class="${state.scenario === 'payment' ? 'active' : ''}" type="button" data-action="scenario" data-scenario="payment" aria-pressed="${state.scenario === 'payment'}">Оплата</button><button class="${state.scenario === 'ready' ? 'active' : ''}" type="button" data-action="scenario" data-scenario="ready" aria-pressed="${state.scenario === 'ready'}">Собран</button></div></div>
      <div class="stat-grid"><div class="stat-card"><span class="text-muted small">Участников</span><strong>${requestsCount()}</strong></div><div class="stat-card"><span class="text-muted small">Оплачено порций</span><strong>${paid}<span class="small text-muted"> / 10</span></strong></div><div class="stat-card"><span class="text-muted small">Подтверждено</span><strong>${money(paid * PRICE)}</strong></div></div>
      <section class="card">${progressMarkup()}${state.accepted ? '<div class="alert success">Заказ принят. Состав зафиксирован; приготовьте только оплаченные позиции из сводки.</div>' : `<div class="alert ${canAccept() ? 'success' : 'warning'}">${canAccept() ? 'Минимум собран. Можно принять оплаченные порции в приготовление.' : !paymentOpen() ? 'Сначала нужно собрать 10 участников. Оплата пока закрыта.' : `Для принятия заказа не хватает ${Math.max(0, MINIMUM - paid)} оплаченных порций.`}</div>`}</section>
      <section class="card"><div class="section-heading"><h2>${state.accepted ? 'К приготовлению' : 'Сводка по блюдам'}</h2><span class="small text-muted">${state.accepted ? paid : requested} ${portionWord(state.accepted ? paid : requested)}</span></div><div class="table-wrap"><table><thead><tr><th scope="col">Комплекс</th><th scope="col">Заявки</th><th scope="col">Оплачено</th></tr></thead><tbody>${MEALS.map((meal) => {
        const count = state.participants.reduce((sum, person) => sum + (person.items[meal.id] || 0), 0);
        const confirmed = paidPeople().reduce((sum, person) => sum + (person.items[meal.id] || 0), 0);
        return `<tr><td>${meal.name}</td><td>${count}</td><td><strong>${confirmed}</strong></td></tr>`;
      }).join('')}</tbody><tfoot><tr><th scope="row">Всего</th><td>${requested}</td><td><strong>${paid}</strong></td></tr></tfoot></table></div><button type="button" class="button secondary full" data-action="copy-summary">${icon('copy')} Скопировать сводку</button><p class="small text-muted">Только копирование текста. Ничего не отправляется автоматически.</p></section>
      <section class="card"><div class="section-heading"><h2>Участники</h2><span class="badge green">${paidPeople().length} оплат подтверждено</span></div><div class="participant-list">${state.participants.map((person) => `<div class="list-row"><span class="avatar ${person.id === state.userId ? 'own' : ''}">${escape(initials(person.name))}</span><div class="participant-meta"><strong>${escape(person.name)}${person.id === state.userId ? ' <span class="small text-muted">(вы)</span>' : ''}</strong><span class="small text-muted">${escape(person.department)} · ${escape(itemsLabel(person.items))}</span>${statusBadge(person)}</div><div class="payment-meta"><strong>${money(personTotal(person))}</strong>${!state.accepted && person.payment === 'pending' ? `<button class="button secondary small" type="button" data-action="confirm-payment" data-person="${escape(person.id)}">Подтвердить</button>` : !state.accepted && person.isDemo && person.payment === 'unpaid' && paymentOpen() ? `<button class="button ghost small" type="button" data-action="demo-transfer" data-person="${escape(person.id)}">Демо-перевод</button>` : ''}</div></div>`).join('')}</div>${!state.accepted ? '<button class="button ghost full" type="button" data-action="add-person">Демо: добавить участника</button>' : ''}</section>
      <div class="notice">${icon('wallet')} «На проверке» не считается оплатой. Подтвердите поступление отдельно. В этом прототипе все оплаты демонстрационные.</div>
      <div class="supplier-actions"><button class="button primary full" type="button" data-action="accept" ${!canAccept() ? 'disabled' : ''}>${state.accepted ? `${icon('check')} Заказ принят` : 'Принять заказ в приготовление'}</button><p class="small text-muted">${state.accepted ? 'Состав доставки зафиксирован.' : 'После принятия состав заказа и статусы оплат будут зафиксированы.'}</p><button type="button" class="button ghost" data-action="reset">Сбросить демо</button></div>`;
  }

  function render() {
    const screen = currentScreen();
    app.innerHTML = screen === 'supplier' ? renderSupplier() : screen === 'order' ? renderOrder() : renderMenu();
    app.dataset.screen = screen;
    document.querySelectorAll('.nav-button[data-screen]').forEach((button) => {
      const active = button.dataset.screen === screen;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.title = `${screen === 'supplier' ? 'Поставщик' : screen === 'order' ? 'Мой заказ' : 'Меню'} — Обед вместе`;
    if (storageUnavailable && !app.querySelector('[data-storage-notice]')) app.insertAdjacentHTML('beforeend', '<p class="notice" data-storage-notice>Браузер не разрешил сохранить демо. В текущей вкладке всё работает; после обновления изменения могут исчезнуть.</p>');
  }

  function openModal(kind) {
    previousFocus = document.activeElement;
    modalKind = kind;
    let content = '';
    if (kind === 'join') {
      content = `<form id="join-form"><div class="modal-header"><div><p class="eyebrow">ПРИСОЕДИНИТЬСЯ К ОБЕДУ</p><h2 id="modal-title">Как вас записать?</h2></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div><p class="text-muted">${escape(itemsLabel(state.draft))} · ${money(countItems(state.draft) * PRICE)}</p><div class="field"><label for="participant-name">Ваше имя</label><input id="participant-name" name="name" type="text" autocomplete="name" placeholder="Например, Алексей" maxlength="60" required></div><div class="field"><label for="participant-department">Команда или отдел <span class="text-muted">(необязательно)</span></label><input id="participant-department" name="department" type="text" placeholder="Например, Продукт" maxlength="60"></div><div class="notice">Сейчас только записываемся. Оплата откроется после набора 10 участников.</div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">Я с вами ${icon('check')}</button></div></form>`;
    } else if (kind === 'payment') {
      const own = mine();
      if (!own || !paymentOpen() || state.accepted) return;
      content = `<div class="modal-header"><div><p class="eyebrow">ДЕМО-ПРЕДОПЛАТА</p><h2 id="modal-title">Проверим сценарий оплаты</h2></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div><div class="alert warning"><strong>Демо: деньги не списываются</strong></div><p class="text-muted">Настоящих реквизитов здесь нет. Кнопка ниже только изменит статус вашей заявки на «На проверке».</p><div class="card"><div class="detail-row"><span>Ваш заказ</span><strong>${money(personTotal(own))}</strong></div><p class="small text-muted">${escape(itemsLabel(own.items))}</p></div><p class="small text-muted">Поступление отдельно подтверждает поставщик. Если после сбора группы оплат окажется меньше минимума, заказ не принимается. Условия возврата в реальном пилоте согласуются заранее.</p><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Назад</button><button type="button" class="button primary" data-action="simulate-payment">Смоделировать перевод</button></div>`;
    } else if (kind === 'accept') {
      if (!canAccept()) return;
      const excluded = state.participants.filter((person) => person.payment !== 'paid').length;
      content = `<div class="modal-header"><div><p class="eyebrow">ПОДТВЕРЖДЕНИЕ ПОСТАВЩИКА</p><h2 id="modal-title">Принять в приготовление?</h2></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div><p class="text-muted">В доставку войдут ${paidPortions()} оплаченных порций на ${money(paidPortions() * PRICE)}.</p>${excluded ? `<div class="alert warning">Заявки без подтверждённой оплаты (${excluded}) не войдут в доставку.</div>` : ''}<p class="small text-muted">После принятия состав заказа нельзя будет изменить. Для нового прогона можно сбросить демо.</p><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Проверить список</button><button type="button" class="button primary" data-action="confirm-accept">Принять заказ</button></div>`;
    } else if (kind === 'reset') {
      content = `<div class="modal-header"><h2 id="modal-title">Начать демо заново?</h2><button class="icon-button" type="button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div><p class="text-muted">Снова будет 8 участников и 0 оплат. Ваш выбор и демо-статусы удалятся только из этого браузера.</p><div class="modal-actions"><button class="button secondary" type="button" data-action="close-modal">Оставить</button><button class="button danger" type="button" data-action="confirm-reset">Сбросить демо</button></div>`;
    }
    modalRoot.innerHTML = `<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">${content}</section></div>`;
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => (modalRoot.querySelector('input') || modalRoot.querySelector('button') || modalRoot.querySelector('.modal')).focus());
  }

  function closeModal() {
    modalKind = null;
    modalRoot.innerHTML = '';
    document.body.classList.remove('modal-open');
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    previousFocus = null;
  }

  function applyScenario(scenario) {
    const own = mine();
    const preserved = own ? { ...own, items: { ...own.items } } : null;
    state.accepted = false;
    state.scenario = scenario;
    editing = false;
    if (scenario === 'collecting') {
      state.participants = Array.from({ length: 8 }, (_, index) => makeDemoPerson(index));
      if (preserved) { preserved.payment = 'unpaid'; state.participants.push(preserved); }
    } else if (scenario === 'payment') {
      state.participants = Array.from({ length: preserved ? 9 : 10 }, (_, index) => makeDemoPerson(index, index === 0 ? 'pending' : 'unpaid'));
      if (preserved) { preserved.payment = 'unpaid'; state.participants.push(preserved); }
    } else {
      state.participants = Array.from({ length: 10 }, (_, index) => makeDemoPerson(index, 'paid'));
      if (preserved) state.participants.push(preserved);
    }
    save(); render();
    toast(scenario === 'ready' ? 'Минимум собран на демо-участниках. Ваша оплата не менялась.' : 'Демо-сценарий изменён. Выбор блюд сохранён; статусы оплат сброшены.');
  }

  function addPerson() {
    if (state.accepted) return;
    const used = new Set(state.participants.map((person) => person.id));
    let index = 0;
    while (used.has(`demo-${index}`)) index += 1;
    if (index >= 30) { toast('Для демонстрации уже достаточно участников.'); return; }
    state.participants.push(makeDemoPerson(index));
    state.scenario = paymentOpen() ? 'payment' : 'collecting';
    save(); render();
    toast(paymentOpen() ? 'Участник добавлен. Группа собрана, демо-оплата открыта.' : 'Демо-участник добавлен.');
  }

  function summaryText() {
    const lines = ['ОБЕД ВМЕСТЕ · ДЕМО', '20 октября · Команда, 3 этаж · доставка 12:30–13:00', 'Кухня Азата · демонстрационное название', `Статус: ${state.accepted ? 'принят в приготовление' : 'ещё не принят'}`, `Участников: ${requestsCount()}. Оплачено порций: ${paidPortions()}/${MINIMUM}.`, '', 'К приготовлению после принятия — только оплаченные порции:'];
    MEALS.forEach((meal) => {
      const amount = paidPeople().reduce((sum, person) => sum + (person.items[meal.id] || 0), 0);
      lines.push(`${meal.name}: ${amount} × ${money(PRICE)}`);
    });
    lines.push(`Итого оплачено: ${money(paidPortions() * PRICE)}`, '', 'Подтверждённые участники:');
    paidPeople().forEach((person) => lines.push(`${person.name} (${person.department || 'офис'}): ${itemsLabel(person.items)} — ${money(personTotal(person))}`));
    const others = state.participants.filter((person) => person.payment !== 'paid');
    if (others.length) {
      lines.push('', 'Не включены в приготовление — оплата не подтверждена:');
      others.forEach((person) => lines.push(`${person.name}: ${itemsLabel(person.items)} — ${person.payment === 'pending' ? 'на проверке' : 'не оплачено'}`));
    }
    lines.push('', 'Все платежи в этом прототипе демонстрационные.');
    return lines.join('\n');
  }

  async function copyText(text, successMessage) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toast(successMessage);
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_) { /* Readable fallback below. */ }
      area.remove();
      if (copied) toast(successMessage);
      else {
        previousFocus = document.activeElement;
        modalKind = 'copy';
        modalRoot.innerHTML = `<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">Скопируйте текст</h2><button class="icon-button" type="button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div><p class="text-muted">Браузер ограничил копирование. Выделите текст и скопируйте вручную.</p><div class="field"><textarea id="copy-fallback" rows="10" readonly>${escape(text)}</textarea></div><button type="button" class="button primary full" data-action="close-modal">Готово</button></section></div>`;
        document.body.classList.add('modal-open');
        const fallback = document.getElementById('copy-fallback');
        fallback.focus(); fallback.select();
      }
    }
  }

  document.addEventListener('click', (event) => {
    const navButton = event.target.closest('[data-screen].nav-button');
    if (navButton) { event.preventDefault(); editing = false; navigate(navButton.dataset.screen); return; }
    if (event.target.matches('[data-backdrop]')) { closeModal(); return; }
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'go-menu') { navigate('menu'); return; }
    if (action === 'go-order') { editing = false; navigate('order'); return; }
    if (action === 'go-supplier') { navigate('supplier'); return; }
    if (action === 'invite') { copyText(`${location.href.split('#')[0]}#menu`, 'Ссылка скопирована. Отправьте её коллеге.'); return; }
    if (action === 'copy-summary') { copyText(summaryText(), 'Сводка скопирована. Ничего не отправлено.'); return; }
    if (action === 'reset') { openModal('reset'); return; }
    if (action === 'confirm-reset') { state = initialState(); editing = false; save(); closeModal(); render(); toast('Демо сброшено: 8 участников, 0 оплат.'); return; }
    if (action === 'scenario') { applyScenario(button.dataset.scenario); return; }
    if (state.accepted) { toast('Заказ уже принят. Изменения закрыты.'); return; }
    if (action === 'quantity') {
      if (mine() && !editing) return;
      const id = button.dataset.meal;
      if (!MEALS.some((meal) => meal.id === id)) return;
      state.draft[id] = Math.min(9, Math.max(0, (state.draft[id] || 0) + Number(button.dataset.delta)));
      save(); render();
      const replacement = app.querySelector(`[data-action="quantity"][data-meal="${id}"][data-delta="${button.dataset.delta}"]`);
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
      return;
    }
    if (action === 'join') { if (!mine() && countItems(state.draft)) openModal('join'); return; }
    if (action === 'edit-order') {
      const own = mine();
      if (!own || own.payment !== 'unpaid') return;
      state.draft = { ...own.items }; editing = true; navigate('menu'); return;
    }
    if (action === 'save-edit') {
      const own = mine();
      if (!own || own.payment !== 'unpaid' || !countItems(state.draft)) { toast('Выберите хотя бы один комплекс.'); return; }
      own.items = { ...state.draft }; editing = false; save(); navigate('order'); toast('Выбор обновлён.'); return;
    }
    if (action === 'add-person') { addPerson(); return; }
    if (action === 'pay') { if (paymentOpen() && mine()?.payment === 'unpaid') openModal('payment'); return; }
    if (action === 'simulate-payment') {
      const own = mine();
      if (!own || own.payment !== 'unpaid' || !paymentOpen()) return;
      own.payment = 'pending'; save(); closeModal(); render(); toast('Демо-перевод на проверке у поставщика.'); return;
    }
    if (action === 'demo-transfer') {
      const person = state.participants.find((person) => person.id === button.dataset.person);
      if (!person || !person.isDemo || person.payment !== 'unpaid' || !paymentOpen()) return;
      person.payment = 'pending'; save(); render(); toast('Демо-перевод поступил на проверку.'); return;
    }
    if (action === 'confirm-payment') {
      const person = state.participants.find((person) => person.id === button.dataset.person);
      if (!person || person.payment !== 'pending' || !paymentOpen()) return;
      person.payment = 'paid'; save(); render(); toast(`Демо-оплата подтверждена: ${person.name}.`); return;
    }
    if (action === 'accept') { if (canAccept()) openModal('accept'); return; }
    if (action === 'confirm-accept') {
      if (!canAccept()) return;
      state.accepted = true; editing = false; save(); closeModal(); render(); toast('Заказ принят. Оплаченные порции переданы в приготовление.');
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id !== 'join-form') return;
    event.preventDefault();
    if (state.accepted || mine() || !countItems(state.draft)) return;
    const form = event.target;
    const nameInput = form.elements.namedItem('name');
    const name = nameInput.value.trim();
    if (!name) { nameInput.setCustomValidity('Введите имя, чтобы коллеги узнали вас.'); nameInput.reportValidity(); return; }
    nameInput.setCustomValidity('');
    const person = { id: `user-${Date.now()}`, name: name.slice(0, 60), department: form.elements.namedItem('department').value.trim().slice(0, 60) || 'Команда офиса', items: { ...state.draft }, payment: 'unpaid', isDemo: false };
    state.participants.push(person); state.userId = person.id;
    save(); closeModal(); navigate('order'); toast('Вы в списке! Ваш обед добавлен к общему заказу.');
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'participant-name') event.target.setCustomValidity('');
  });

  document.addEventListener('keydown', (event) => {
    if (!modalKind) return;
    if (event.key === 'Escape') { closeModal(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...modalRoot.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea, [tabindex="0"]')];
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  window.addEventListener('hashchange', () => { closeModal(); if (currentScreen() !== 'menu') editing = false; render(); });
  render();
})();
