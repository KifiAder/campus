--  КурсПроект - биржа студенческих проектов
--  Схема базы данных MySQL / MariaDB
--  Запуск:  mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS campus
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE campus;

-- Пользователи портала.
-- password хранит НЕ пароль, а строку вида
--   pbkdf2_sha256$200000$<соль>$<хеш>
-- role: 'student' - автор проектов, 'curator' - видит всё и меняет статусы

CREATE TABLE IF NOT EXISTS users (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  login      VARCHAR(32)  NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  name       VARCHAR(64)  NOT NULL,
  email      VARCHAR(128) NOT NULL UNIQUE,
  role       ENUM('student', 'curator') NOT NULL DEFAULT 'student',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB;

-- Проекты на бирже. owner_id - автор (users.id).
-- Статус: open - ищу команду, in_work - уже в работе,
--         closed - архив (набор закрыт)

CREATE TABLE IF NOT EXISTS projects (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  owner_id   INT UNSIGNED NOT NULL,
  title      VARCHAR(120) NOT NULL,
  short_desc VARCHAR(180) NOT NULL,
  body       TEXT         NOT NULL,
  tags       VARCHAR(190) NOT NULL DEFAULT '',
  status     ENUM('open', 'in_work', 'closed') NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_projects_owner
    FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  INDEX idx_projects_owner (owner_id),
  INDEX idx_projects_status (status)
) ENGINE = InnoDB;

-- Заявки «хочу в проект» от других студентов.
-- Пара (project_id, user_id) уникальна - нельзя откликнуться дважды.

CREATE TABLE IF NOT EXISTS applications (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  message    VARCHAR(500) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_app_project
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_app_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE KEY uq_app_project_user (project_id, user_id)
) ENGINE = InnoDB;


-- Журнал смены статусов проекта - чтобы автор видел историю,
-- а не только текущее значение.

CREATE TABLE IF NOT EXISTS status_log (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  old_status ENUM('open', 'in_work', 'closed') NOT NULL,
  new_status ENUM('open', 'in_work', 'closed') NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_log_project
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE = InnoDB;

--  Тестовые пользователи
--  Пароли захэшированы pbkdf2_sha256, соль "campus2026":
--    студент  timosh / student123
--    куратор  curator / admin123

INSERT IGNORE INTO users (login, password, name, email, role) VALUES
  ('timosh', 'pbkdf2_sha256$200000$campus2026$0157eaea485ea9547da8d8b473aadbb7c6971b8e6d98f2c967ba1495861b39d7',
   'Тимофей Ковалёв', 'timosh@campus.code', 'student'),
  ('curator', 'pbkdf2_sha256$200000$campus2026$e14dc1e417617d36385ea4ea1a8ab7e6917281af9f11ced6deae4d5f7e53a1d6',
   'Ирина Сергеевна', 'curator@campus.code', 'curator');

-- Один пример проекта от тестового студента (не создаётся повторно)
INSERT INTO projects (owner_id, title, short_desc, body, tags, status)
SELECT u.id,
       'Расписание кабинетов в телеграм-боте',
       'Парсим расписание колледжа и присылаем напоминание за 15 минут до пары.',
       'Нужно выгружать расписание с сайта колледжа, класть в базу и отправлять уведомления подписчикам. Есть готовый бот на aiogram, нужен человек на парсер и оформление меню.',
       'python, телеграм, парсинг',
       'open'
FROM users u
WHERE u.login = 'timosh'
  AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.title = 'Расписание кабинетов в телеграм-боте');
