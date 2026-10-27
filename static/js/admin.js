/* admin.js - панель куратора: список всех проектов и смена статусов. */

document.addEventListener("DOMContentLoaded", async () => {
  const notice = document.getElementById("notice");
  const tbody = document.querySelector("#admin-table tbody");
  const search = document.getElementById("admin-search");
  const statusFilter = document.getElementById("admin-status");

  let timer = null;

  /* Загружает проекты с учётом поиска и фильтра статуса. */
  async function load() {
    const params = new URLSearchParams();
    if (search.value.trim()) params.set("q", search.value.trim());
    if (statusFilter.value) params.set("status", statusFilter.value);

    tbody.innerHTML = `<tr><td class="muted small">Загрузка…</td></tr>`;
    try {
      const projects = await api("GET", "/api/projects?" + params.toString());

      tbody.innerHTML = projects.length
        ? projects.map((p) => `
          <tr>
            <td>
              <a href="/project?id=${p.id}"><strong>${esc(p.title)}</strong></a><br>
              <span class="small muted">${esc(p.short_desc)}</span>
            </td>
            <td>${esc(p.owner_name)}<br><span class="mono muted">@${esc(p.owner_login)}</span></td>
            <td class="mono">${p.applications_count}</td>
            <td class="table__muted">${esc(formatDate(p.created_at))}</td>
            <td>
              <select class="select" data-status-for="${p.id}" style="width:auto;font-size:13px">
                <option value="open"${p.status === "open" ? " selected" : ""}>Ищу команду</option>
                <option value="in_work"${p.status === "in_work" ? " selected" : ""}>В работе</option>
                <option value="closed"${p.status === "closed" ? " selected" : ""}>Архив</option>
              </select>
            </td>
          </tr>`).join("")
        : `<tr><td class="muted small">Ничего не найдено.</td></tr>`;

      // Счётчики (для куратора /api/me отдаёт цифры по всей бирже)
      const state = await api("GET", "/api/me");
      if (state.summary) {
        document.getElementById("a-projects").textContent = state.summary.projects;
        document.getElementById("a-open").textContent = state.summary.open;
        document.getElementById("a-apps").textContent = state.summary.applications;
      }

      bindStatusSelects();
    } catch (error) {
      tbody.innerHTML = `<tr><td class="muted small">Ошибка: ${esc(error.message)}</td></tr>`;
    }
  }

  /* Смена статуса из выпадающего списка прямо в строке таблицы. */
  function bindStatusSelects() {
    tbody.querySelectorAll("[data-status-for]").forEach((select) => {
      select.addEventListener("change", async () => {
        const projectId = select.dataset.statusFor;
        select.disabled = true;
        try {
          const result = await api("PATCH", `/api/projects/${projectId}/status`, {
            status: select.value,
          });
          showNotice(notice, `#${projectId}: ${result.message}`, "ok");
        } catch (error) {
          showNotice(notice, error.message);
        } finally {
          select.disabled = false;
        }
      });
    });
  }

  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  });
  statusFilter.addEventListener("change", load);

  load();
});
