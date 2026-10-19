export async function api(path, { method = 'GET', body } = {}) {
  let response;
  try { response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(result.error || (response.status === 401 ? 'Войдите в кабинет поставщика.' : 'Не получилось выполнить действие. Обновите страницу и попробуйте ещё раз.')); error.status = response.status; throw error; }
  return result;
}
