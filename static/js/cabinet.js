/* cabinet.js - личный кабинет: создание проекта, свои проекты,
   входящие заявки и мои отклики. */

document.addEventListener("DOMContentLoaded", async () => {
  const notice = document.getElementById("notice");
  const form = document.getElementById("project-form");

  /* 1. Проверяем вход: без сессии сервер уже перекинул бы на /login,
        но заодно получаем счётчики и имя. */
  let state;
  try {
    state = await requireUser();
    if (!state) return;
  } catch (error) {
    showNotice(notice, error.message);
    return;
  }

  const user = state.user;
  document.getElementById("cabinet-title").textContent = `Кабинет · ${user.name.split(" ")[0]}`;
  document.getElementById("cabinet-subtitle").textContent = user.role === "curator"
    ? "Режим куратора: видны все проекты биржи и заявки."
    : "Управляйте своими проектами и заявками.";
  paintStats(state.summary);

  /* 2. Вкладки кабинета. */
  const chips = document.querySelectorAll("#tabs .chip");

  /* Активирует вкладку по имени: подсветка + показ панели + подгрузка данных. */
  function activateTab(tab) {
    chips.forEach((c) => c.classList.toggle("is-active", c.dataset.tab === tab));
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
    if (tab === "mine") loadMine();
    if (tab === "inbox") loadInbox();
    if (tab === "sent") loadSent();
  }

  chips.forEach((chip) => {
    chip.addEventListener("click", () => activateTab(chip.dataset.tab));
  });

  paintStats(state.summary);

  /* Счётчики в карточках статистики. */
  function paintStats(summary) {
    document.getElementById("stat-projects").textContent = summary.projects;
    document.getElementById("stat-open").textContent = summary.open;
    document.getElementById("stat-apps").textContent = summary.applications;
  }

  /* Перезагрузить счётчики после изменений. */
  async function refreshStats() {
    try {
      const fresh = await api("GET", "/api/me");
      if (fresh.summary) paintStats(fresh.summary);
    } catch (e) { /* молча: счётчики не критичны */ }
  }

  /* 3. Форма нового проекта: валидация + отправка. */
  const fields = {
    title: { min: 6, max: 120, message: "Заголовок — от 6 символов" },
    short_desc: { min: 10, max: 180, message: "Короткое описание — от 10 символов" },
    body: { min: 30, max: 3000, message: "Подробное описание — от 30 символов" },
    tags: { min: 0, max: 190, message: "" },
  };

  // Счётчики «0 / 120» под полями
  Object.keys(fields).forEach((name) => {
    const input = form.querySelector(`[name="${name}"]`);
    const hint = fieldOf(form, name).querySelector(".field__hint");
    input.addEventListener("input", () => {
      hint.textContent = `${input.value.length} / ${fields[name].max}`;
      hint.classList.remove("is-error");
      fieldOf(form, name).classList.remove("has-error");
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideNotice(notice);
    clearErrors(form);

    // Проверка каждого поля - пустое или слишком короткое не уходит на сервер
    const invalid = Object.entries(fields).filter(([name, rule]) => {
      const value = form.querySelector(`[name="${name}"]`).value.trim();
      const ok = value.length >= rule.min && value.length <= rule.max;
      if (!ok) setFieldError(fieldOf(form, name), rule.message);
      return !ok;
    });

    if (invalid.length > 0) {
      showNotice(notice, "Заполните поля, отмеченные красным — проект не отправлен.");
      form.querySelector(`[name="${invalid[0][0]}"]`).focus();
      return;
    }

    const payload = Object.fromEntries(new FormData(form).entries());
    const submit = document.getElementById("project-submit");
    submit.disabled = true;
    submit.textContent = "Публикуем…";

    try {
      const result = await api("POST", "/api/projects", payload);
      showNotice(notice, `${result.message}. Он уже виден на бирже.`, "ok");
      form.reset();
      Object.keys(fields).forEach((name) => {
        const hint = fieldOf(form, name).querySelector(".field__hint");
        hint.textContent = `0 / ${fields[name].max}`;
      });
      refreshStats();
      // Показываем результат: сразу переходим на «Мои проекты»
      setTimeout(() => activateTab("mine"), 600);
    } catch (error) {
      showNotice(notice, error.message);
      if (error.status === 401) setTimeout(() => { location.href = "/login"; }, 800);
    } finally {
      submit.disabled = false;
      submit.textContent = "Опубликовать";
    }
  });

  /* 4. Вкладка «Мои проекты» с поиском. */
  const mineGrid = document.getElementById("mine-grid");
  const mineSearch = document.getElementById("mine-search");
  let mineTimer = null;

  async function loadMine() {
    const query = new URLSearchParams({ mine: "1" });
    const text = mineSearch.value.trim();
    if (text) query.set("q", text);

    mineGrid.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
    try {
      const projects = await api("GET", "/api/projects?" + query.toString());
      mineGrid.innerHTML = projects.length
        ? projects.map(projectCard).join("")
        : `<div class="empty">У вас пока нет проектов. Создайте первый на вкладке «Новый проект».</div>`;
    } catch (error) {
      mineGrid.innerHTML = `<div class="empty">Не удалось загрузить: ${esc(error.message)}</div>`;
    }
  }

  mineSearch.addEventListener("input", () => {
    clearTimeout(mineTimer);
    mineTimer = setTimeout(loadMine, 300);
  });

  /* 5. Вкладка «Входящие заявки» - отклики на мои проекты. */
  async function loadInbox() {
    const tbody = document.querySelector("#inbox-table tbody");
    tbody.innerHTML = `<tr><td class="muted small">Загрузка…</td></tr>`;
    try {
      const rows = await api("GET", "/api/applications");
      tbody.innerHTML = rows.length
        ? rows.map((row) => `
            <tr>
              <td><strong>${esc(row.user_name)}</strong><br><span class="mono muted">@${esc(row.user_login)}</span></td>
              <td><a href="/project?id=${row.project_id}">${esc(row.project_title)}</a></td>
              <td>${esc(row.message)}</td>
              <td class="table__muted">${esc(formatDate(row.created_at))}</td>
            </tr>`).join("")
        : `<tr><td class="muted small">Пока никто не откликнулся. Опубликуйте проект — заявки появятся здесь.</td></tr>`;
    } catch (error) {
      tbody.innerHTML = `<tr><td class="muted small">Ошибка: ${esc(error.message)}</td></tr>`;
    }
  }

  /* 6. Вкладка «Мои отклики» - что я отправил другим авторам. */
  async function loadSent() {
    const tbody = document.querySelector("#sent-table tbody");
    tbody.innerHTML = `<tr><td class="muted small">Загрузка…</td></tr>`;
    try {
      const rows = await api("GET", "/api/applications/sent");
      tbody.innerHTML = rows.length
        ? rows.map((row) => `
            <tr>
              <td><a href="/project?id=${row.project_id}">${esc(row.project_title)}</a></td>
              <td>${esc(row.owner_name)}</td>
              <td>${statusBadge(row.project_status)}</td>
              <td>${esc(row.message)}</td>
            </tr>`).join("")
        : `<tr><td class="muted small">Вы ещё не откликались на проекты. Посмотрите <a href="/board">биржа</a>.</td></tr>`;
    } catch (error) {
      tbody.innerHTML = `<tr><td class="muted small">Ошибка: ${esc(error.message)}</td></tr>`;
    }
  }
});
