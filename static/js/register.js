/* register.js - клиентская проверка формы регистрации и отправка в /api/register. */

// Те же правила, что и на сервере (app.py) - чтобы совпадало поведение
const LOGIN_RE = /^[a-zA-Z0-9_.]{3,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Zа-яА-Я]{2,}$/;
const PASSWORD_MIN = 6;

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("register-form");
  if (!form) return;

  const notice = document.getElementById("notice");
  const submit = document.getElementById("submit");
  const passwordInput = form.querySelector("[name=password]");
  const passwordHint = fieldOf(form, "password").querySelector(".field__hint");

  /* Проверяет одно поле и возвращает текст ошибки (или ""). */
  function validate(name) {
    const value = form.querySelector(`[name="${name}"]`).value.trim();
    switch (name) {
      case "login":
        if (!value) return "Введите логин";
        return LOGIN_RE.test(value) ? "" : "3–20 символов: латиница, цифры, _ и .";
      case "name":
        if (!value) return "Введите имя";
        return value.length >= 2 ? "" : "Имя — минимум 2 символа";
      case "email":
        if (!value) return "Введите e-mail";
        return EMAIL_RE.test(value) ? "" : "Похоже, в e-mail опечатка";
      case "password":
        if (!value) return "Введите пароль";
        return value.length >= PASSWORD_MIN ? "" : `Пароль — минимум ${PASSWORD_MIN} символов`;
      case "confirm": {
        const password = passwordInput.value;
        if (!value) return "Повторите пароль";
        return value === password ? "" : "Пароли не совпадают";
      }
      default:
        return "";
    }
  }

  /* Показать/убрать ошибку у поля. */
  function applyError(name) {
    const message = validate(name);
    setFieldError(fieldOf(form, name), message);
    return message;
  }

  // Проверка по ходу ввода - только после первого «touch» поля
  form.querySelectorAll("input").forEach((input) => {
    input.addEventListener("blur", () => {
      input.dataset.touched = "1";
      applyError(input.name);
    });
    input.addEventListener("input", () => {
      if (input.dataset.touched) applyError(input.name);
      if (input.name === "password") updateCounter();
      if (input.name === "confirm" && form.querySelector("[name=confirm]").dataset.touched) {
        applyError("confirm");
      }
    });
  });

  /* Счётчик символов пароля: «5 / 6», зелёным цветом после нормы. */
  function updateCounter() {
    const length = passwordInput.value.length;
    passwordHint.textContent = `${length} / ${PASSWORD_MIN}`;
    passwordHint.classList.toggle("is-error", length > 0 && length < PASSWORD_MIN);
  }

  // Кнопка «показать/скрыть пароль»
  form.querySelectorAll("[data-reveal]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = form.querySelector(`[name="${button.dataset.reveal}"]`);
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      button.textContent = isHidden ? "скрыть" : "показать";
    });
  });

  /* Отправка: сначала все проверки, потом запрос к серверу. */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideNotice(notice);

    // Пустые и неверные поля не уходят на сервер
    const names = ["login", "name", "email", "password", "confirm"];
    const invalid = names.filter((name) => {
      form.querySelector(`[name="${name}"]`).dataset.touched = "1";
      return applyError(name) !== "";
    });

    if (invalid.length > 0) {
      showNotice(notice, "Исправьте отмеченные поля — отправка отменена.");
      fieldOf(form, invalid[0]).querySelector("input").focus();
      return;
    }

    const payload = Object.fromEntries(new FormData(form).entries());

    submit.disabled = true;           // защита от двойного клика
    submit.textContent = "Создаём…";

    try {
      const result = await api("POST", "/api/register", payload);
      showNotice(notice, `${result.message}. Открываем кабинет…`, "ok");
      setTimeout(() => { window.location.href = "/cabinet"; }, 700);
    } catch (error) {
      showNotice(notice, error.message);
      // Если заняты логин или e-mail - подсветим оба поля
      if (error.status === 409) {
        setFieldError(fieldOf(form, "login"), "Возможно, логин или e-mail уже заняты");
      }
      submit.disabled = false;
      submit.textContent = "Создать аккаунт";
    }
  });
});
