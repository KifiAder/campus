/* board.js - список проектов с фильтром по статусу и поиском. */

document.addEventListener("DOMContentLoaded", () => {
  const grid = document.getElementById("projects");
  const notice = document.getElementById("notice");
  const searchInput = document.getElementById("search");
  const chips = document.querySelectorAll("#status-chips .chip");

  let currentStatus = "";
  let searchTimer = null;

  /* Запрашивает проекты у сервера и перерисовывает сетку. */
  async function load() {
    hideNotice(notice);

    const params = new URLSearchParams();
    if (currentStatus) params.set("status", currentStatus);
    if (searchInput.value.trim()) params.set("q", searchInput.value.trim());

    try {
      const projects = await api("GET", "/api/projects?" + params.toString());

      if (projects.length === 0) {
        grid.innerHTML = `<div class="empty">
          Ничего не найдено. Попробуйте другой запрос или статус.
        </div>`;
        return;
      }
      grid.innerHTML = projects.map(projectCard).join("");
    } catch (error) {
      grid.innerHTML = "";
      showNotice(notice, "Не удалось загрузить список: " + error.message);
    }
  }

  /* Переключение вкладок-статусов. */
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      currentStatus = chip.dataset.status;
      load();
    });
  });

  /* Поиск с задержкой, чтобы не дёргать сервер на каждую букву. */
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });

  load();
});
