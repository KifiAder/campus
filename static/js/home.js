/* home.js - подгружает три последних проекта на главную. */
document.addEventListener("DOMContentLoaded", async () => {
  const grid = document.getElementById("home-projects");
  if (!grid) return;

  try {
    const projects = await api("GET", "/api/projects?status=open");

    if (projects.length === 0) {
      grid.innerHTML = `<div class="empty">
        Пока нет проектов с открытым набором. <a href="/register">Станьте первым →</a>
      </div>`;
      return;
    }

    grid.innerHTML = projects.slice(0, 3).map(projectCard).join("");
  } catch (e) {
    grid.innerHTML = `<div class="empty">Не удалось загрузить проекты: ${esc(e.message)}</div>`;
  }
});
