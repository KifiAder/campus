/* project.js - страница одного проекта: описание, отклик, смена статуса. */

document.addEventListener("DOMContentLoaded", async () => {
  const projectId = new URLSearchParams(location.search).get("id");
  const notice = document.getElementById("notice");
  const bodyCard = document.getElementById("project-body");
  const applyCard = document.getElementById("apply-card");
  const applyForm = document.getElementById("apply-form");
  const statusForm = document.getElementById("status-form");

  let project = null;
  let me = null;

  if (!projectId || !/^\d+$/.test(projectId)) {
    bodyCard.innerHTML = `<h1>Проект не указан</h1>
      <p class="muted">Откройте проект из списка на бирже.</p>`;
    return;
  }

  try {
    // Пользователь может быть не авторизован - /api/me вернёт user: null
    const state = await api("GET", "/api/me");
    me = state.user;
    project = await api("GET", `/api/projects/${projectId}`);
  } catch (error) {
    bodyCard.innerHTML = `<h1>Проект недоступен</h1>
      <p class="muted">${esc(error.message)}</p>`;
    return;
  }

  document.title = `${project.title} — Биржа проектов`;
  renderProject();
  renderHistory();
  setupApply(notice, applyCard, applyForm, project, me);
  setupStatus(notice, statusForm, project);

  /* Заполняет все блоки страницы данными проекта. */
  function renderProject() {
    const tags = project.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ");
    bodyCard.innerHTML = `
      <div class="card__head">
        <span class="mono muted">Проект #${String(project.id).padStart(3, "0")}</span>
        ${statusBadge(project.status)}
      </div>
      <h1>${esc(project.title)}</h1>
      <p class="muted small">${esc(project.short_desc)}</p>
      <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <div style="white-space:pre-line">${esc(project.body)}</div>
      <div class="project-card__tags" style="margin-top:16px">${tags}</div>
      <p class="small muted" style="margin-top:18px">
        Опубликован ${esc(formatDate(project.created_at))} ·
        откликов: ${project.applications_count}
      </p>`;

    document.getElementById("author-avatar").textContent = project.owner_initials;
    document.getElementById("author-name").innerHTML =
      `${esc(project.owner_name)}<br><span class="mono muted">@${esc(project.owner_login)}</span>`;
    document.getElementById("project-status").innerHTML = statusBadge(project.status);
  }

  /* История изменений статуса из таблицы status_log. */
  function renderHistory() {
    const table = document.getElementById("history-table");
    if (project.history.length === 0) {
      table.innerHTML = `<tbody><tr><td class="muted small">Пока без изменений</td></tr></tbody>`;
      return;
    }
    table.innerHTML = `
      <thead><tr><th>Переход</th><th>Дата</th></tr></thead>
      <tbody>${project.history.map((h) => `
        <tr>
          <td>${esc(STATUS_LABELS[h.from] || h.from)} → ${esc(STATUS_LABELS[h.to] || h.to)}</td>
          <td class="table__muted">${esc(formatDate(h.at))}</td>
        </tr>`).join("")}
      </tbody>`;
  }
});

/* Форма отклика: показываем только тем, кому можно откликаться. */
function setupApply(notice, applyCard, applyForm, project, me) {
  if (!me) {
    // Не вошёл - вместо формы предложение войти
    if (project.status === "open") {
      applyCard.style.display = "block";
      applyCard.innerHTML = `
        <h2>Хочу в проект</h2>
        <p class="small muted">Чтобы откликнуться, нужен аккаунт студента.</p>
        <a class="btn btn--primary" href="/login">Войти и откликнуться</a>`;
    }
    return;
  }

  if (project.owner_id === me.id) {
    // Свой проект - откликаться нельзя
    applyCard.style.display = "block";
    applyCard.innerHTML = `
      <h2>Ваш проект</h2>
      <p class="small muted">Отклики участников смотрите в кабинете.</p>
      <a class="btn" href="/cabinet">Открыть кабинет</a>`;
    return;
  }

  if (project.status !== "open") {
    applyCard.style.display = "block";
    applyCard.innerHTML = `
      <h2>Набор закрыт</h2>
      <p class="small muted">Проект не принимает новые отклики.</p>`;
    return;
  }

  applyCard.style.display = "block";
  const textarea = applyForm.querySelector("[name=message]");
  const hint = fieldOf(applyForm, "message").querySelector(".field__hint");

  // Счётчик символов сообщения
  textarea.addEventListener("input", () => {
    hint.textContent = `${textarea.value.length} / 500`;
    hint.classList.remove("is-error");
  });

  applyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideNotice(notice);
    const message = textarea.value.trim();

    if (message.length < 15) {
      setFieldError(fieldOf(applyForm, "message"), "Нужно минимум 15 символов");
      showNotice(notice, "Дополните сообщение — отклик не отправлен.");
      return;
    }

    const submit = document.getElementById("apply-submit");
    submit.disabled = true;
    submit.textContent = "Отправляем…";

    try {
      const result = await api("POST", `/api/projects/${project.id}/apply`, { message });
      showNotice(notice, result.message, "ok");
      applyCard.innerHTML = `<h2>Отклик отправлен</h2>
        <p class="small muted">Автор увидит ваше сообщение в своём кабинете.</p>`;
    } catch (error) {
      showNotice(notice, error.message);
      submit.disabled = false;
      submit.textContent = "Отправить отклик";
    }
  });
}

/* Смена статуса: доступна автору проекта и куратору. */
function setupStatus(notice, statusForm, project) {
  if (!project.can_edit_status) return;

  const select = document.getElementById("status-select");
  const submit = document.getElementById("status-submit");

  select.value = project.status;
  statusForm.style.display = "block";

  statusForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideNotice(notice);
    submit.disabled = true;

    try {
      const result = await api("PATCH", `/api/projects/${project.id}/status`, {
        status: select.value,
      });
      project.status = result.project.status;

      // Перезагружаем историю с сервера и обновляем страницу
      const fresh = await api("GET", `/api/projects/${project.id}`);
      project.history = fresh.history;
      window.location.reload();
    } catch (error) {
      showNotice(notice, error.message);
      submit.disabled = false;
    }
  });
}
