/* login.js - вход: проверка пустых полей, сообщение об ошибке на странице. */

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("login-form");
  if (!form) return;

  const notice = document.getElementById("notice");
  const submit = document.getElementById("submit");

  /* Кнопка «показать/скрыть пароль». */
  form.querySelectorAll("[data-reveal]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = form.querySelector(`[name="${button.dataset.reveal}"]`);
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      button.textContent = isHidden ? "скрыть" : "показать";
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideNotice(notice);
    clearErrors(form);

    const login = form.querySelector("[name=login]").value.trim();
    const password = form.querySelector("[name=password]").value;

    // Пустые поля не уходят на сервер
    let hasError = false;
    if (!login) {
      setFieldError(fieldOf(form, "login"), "Введите логин");
      hasError = true;
    }
    if (!password) {
      setFieldError(fieldOf(form, "password"), "Введите пароль");
      hasError = true;
    }
    if (hasError) {
      showNotice(notice, "Заполните оба поля.");
      return;
    }

    submit.disabled = true;
    submit.textContent = "Проверяем…";

    try {
      await api("POST", "/api/login", { login, password });
      showNotice(notice, "Вход выполнен, открываем кабинет…", "ok");
      setTimeout(() => { window.location.href = "/cabinet"; }, 500);
    } catch (error) {
      // Понятный текст на странице: неверная пара или другая ошибка
      showNotice(notice, error.message);
      if (error.status === 401) {
        setFieldError(fieldOf(form, "password"), "Логин или пароль не подходят");
      }
      submit.disabled = false;
      submit.textContent = "Войти";
    }
  });
});
