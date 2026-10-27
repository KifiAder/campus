/* app.js - общий код для всех страниц:
   запросы к API, шапка пользователя, тёмная тема, утилиты.*/

/* Короткая обёртка над fetch: JSON туда-обратно и понятные ошибки. */
async function api(method, url, body) {
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  };
  if (body !== undefined) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    // Сервер ответил не-JSON (например, упал) - сообщаем об этом ниже
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || "Сервер ответил ошибкой " + response.status);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

/* Экранирование текста перед вставкой в innerHTML. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/* Дата ISO -> «12 окт 2026, 14:05». */
function formatDate(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString("ru-RU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/* Человеческие подписи статусов. */
const STATUS_LABELS = {
  open: "Ищу команду",
  in_work: "В работе",
  closed: "Архив",
};

function statusBadge(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="status status--${esc(status)}">${esc(label)}</span>`;
}

/* Показать/скрыть блок сообщения (#notice на странице). */
function showNotice(element, text, type = "error") {
  if (!element) return;
  element.textContent = text;
  element.className = `notice notice--${type} is-visible`;
}

function hideNotice(element) {
  if (!element) return;
  element.className = "notice";
  element.textContent = "";
}

/* Вывести ошибку под конкретным полем. */
function setFieldError(fieldWrap, message) {
  if (!fieldWrap) return;
  const hint = fieldWrap.querySelector(".field__hint");
  fieldWrap.classList.toggle("has-error", Boolean(message));
  if (hint) {
    hint.textContent = message || hint.dataset.default || "";
    hint.classList.toggle("is-error", Boolean(message));
  }
}

/* Очистить все ошибки формы перед новой проверкой. */
function clearErrors(form) {
  form.querySelectorAll(".field.has-error").forEach((field) => setFieldError(field, ""));
}

/* Найти обёртку .field по name поля ввода. */
function fieldOf(form, name) {
  return form.querySelector(`[name="${name}"]`)?.closest(".field");
}

/* --- Тёмная тема: запоминается в localStorage --- */
function initTheme() {
  const saved = localStorage.getItem("theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = saved || preferred;

  const toggle = document.querySelector("[data-theme-toggle]");
  if (!toggle) return;

  const paint = () => {
    const isDark = document.documentElement.dataset.theme === "dark";
    toggle.textContent = isDark ? "☀" : "☾";
    toggle.setAttribute("aria-label", isDark ? "Включить светлую тему" : "Включить тёмную тему");
  };
  paint();

  toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    paint();
  });
}

/* Шапка: аватар и имя, если пользователь вошёл; иначе кнопки входа. */
async function initHeader() {
  const slot = document.querySelector("[data-header-user]");
  if (!slot) return null;

  let state;
  try {
    state = await api("GET", "/api/me");
  } catch (e) {
    state = { user: null };
  }
  const user = state.user;

  if (!user) {
    slot.innerHTML = `
      <a class="btn btn--sm btn--ghost" href="/login">Войти</a>
      <a class="btn btn--sm btn--primary" href="/register">Регистрация</a>`;
    return null;
  }

  slot.innerHTML = `
    <a class="header-user" href="/cabinet" title="${esc(user.name)}">
      <span class="avatar avatar--sm">${esc(user.initials)}</span>
      <span>${esc(user.name.split(" ")[0])}</span>
    </a>
    <button class="btn btn--sm btn--ghost" type="button" data-logout>Выйти</button>`;

  slot.querySelector("[data-logout]").addEventListener("click", doLogout);

  // Пункт «Куратор» добавляем только на страницы, где его ещё нет в разметке
  const nav = document.querySelector("[data-nav]");
  if (nav && user.role === "curator" && !nav.querySelector('a[href="/admin"]')) {
    nav.insertAdjacentHTML("beforeend", `<a href="/admin">Куратор</a>`);
  }

  return user;
}

/* Выход: гасим сессию и возвращаем на главную. */
async function doLogout() {
  try {
    await api("POST", "/api/logout");
  } catch (e) {
    /* даже если сервер ответил ошибкой - всё равно уводим на главную */
  }
  window.location.href = "/";
}

/* Проверка авторизации для закрытых страниц. */
async function requireUser() {
  const state = await api("GET", "/api/me");
  if (!state.user) {
    window.location.href = "/login";
    return null;
  }
  return state;
}

/* Карточка проекта для сетки на главной и в кабинете. */
function projectCard(project, index = 0) {
  const tags = project.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  return `
    <a class="project-card is-shown" href="/project?id=${project.id}"
       style="animation-delay:${Math.min(index * 40, 240)}ms">
      <div class="project-card__main">
        <div class="project-card__top">
          <span class="mono muted">#${String(project.id).padStart(3, "0")}</span>
          ${statusBadge(project.status)}
        </div>
        <h3 class="project-card__title">${esc(project.title)}</h3>
        <p class="project-card__desc">${esc(project.short_desc)}</p>
        <div class="project-card__tags">${tags}</div>
      </div>
      <div class="project-card__foot">
        <div class="project-card__author">
          <span class="avatar avatar--sm">${esc(project.owner_initials)}</span>
          <span>${esc(project.owner_name)}</span>
        </div>
        <span>${project.applications_count} откл.</span>
      </div>
    </a>`;
}

/* Запуск общих частей при загрузке страницы. */
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initHeader();
  // Год в подвале
  document.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = new Date().getFullYear();
  });
});
