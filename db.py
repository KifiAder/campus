"""
db.py работа с базой данных MySQL и хешированием паролей.
Всё общение с БД собрано здесь, чтобы app.py занимался только HTTP.
"""

import hashlib
import hmac
import os
import secrets

import mysql.connector
from mysql.connector import errorcode

# Параметры соединения берутся из переменных окружения,
# чтобы проект запускался на любой машине без правки кода.

DB_CONFIG = {
    "host": os.environ.get("DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("DB_PORT", 3306)),
    "user": os.environ.get("DB_USER", "root"),
    "password": os.environ.get("DB_PASSWORD", ""),
    "database": os.environ.get("DB_NAME", "campus"),
    "charset": "utf8mb4",
    "use_pure": True,  # чистый Python-драйвер, C-расширение не нужно
}

# Хеширование пароля: PBKDF2-SHA256, соль у каждого пароля своя.
# Формат хранения: pbkdf2_sha256$<итерации>$<соль>$<hex-хеш>

PBKDF2_ITERATIONS = 200_000


def hash_password(password: str) -> str:
    """Превращает пароль в строку для хранения в users.password"""
    salt = secrets.token_hex(8)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS
    )
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Проверяет пароль против сохранённого хеша (сравнение без утечек по времени)"""
    try:
        algo, iterations, salt, expected = stored.split("$", 3)
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False

    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations)
    )
    return hmac.compare_digest(digest.hex(), expected)


def ensure_schema():
    """Создаёт БД и таблицы, если их ещё нет (вызывается при старте сервера)

    Нужно, чтобы проект запускался одной командой даже без ручного импорта
    schema.sql - но schema.sql всё равно остаётся основным способом
    """
    config = {k: v for k, v in DB_CONFIG.items() if k != "database"}
    conn = mysql.connector.connect(**config)
    try:
        cursor = conn.cursor()
        with open(os.path.join(os.path.dirname(__file__), "schema.sql"), encoding="utf-8") as f:
            script = f.read()
        # Разбиваем по точке с запятой - в schema.sql нет процедур и строк с ';'
        for statement in script.split(";"):
            cleaned = "\n".join(
                line for line in statement.splitlines() if not line.strip().startswith("--")
            ).strip()
            if cleaned:
                cursor.execute(cleaned)
        conn.commit()
        cursor.close()
    finally:
        conn.close()


def get_connection():
    """Новое соединение с MySQL. Вызывающий код должен закрыть его сам"""
    return mysql.connector.connect(**DB_CONFIG)


def query(sql: str, params: tuple = (), fetch: str | None = "all"):
    """Универсальный запрос: SELECT / INSERT / UPDATE в одну функцию

    fetch='all' - список словарей, fetch='one' - словарь или None,
    fetch=None  - вернуть lastrowid для INSERT/UPDATE/DELETE
    """
    conn = get_connection()
    try:
        cursor = conn.cursor(dictionary=True)
        cursor.execute(sql, params)
        if fetch == "all":
            result = cursor.fetchall()
        elif fetch == "one":
            result = cursor.fetchone()
        else:
            conn.commit()
            result = cursor.lastrowid
        cursor.close()
        return result
    finally:
        conn.close()

# Пользователи

def create_user(login: str, password: str, name: str, email: str):
    """Регистрирует студента. Возвращает id или None, если логин/email заняты"""
    try:
        return query(
            "INSERT INTO users (login, password, name, email) VALUES (%s, %s, %s, %s)",
            (login, hash_password(password), name, email),
            fetch=None,
        )
    except mysql.connector.Error as err:
        if err.errno == errorcode.ER_DUP_ENTRY:
            return None
        raise


def find_user_by_login(login: str):
    """Ищет пользователя по логину (для входа)"""
    return query("SELECT * FROM users WHERE login = %s", (login,), fetch="one")


def find_user_by_id(user_id: int):
    """Данные пользователя для кабинета и шапки"""
    return query(
        "SELECT id, login, name, email, role, created_at FROM users WHERE id = %s",
        (user_id,),
        fetch="one",
    )


# Проекты
PROJECT_SELECT = """
    SELECT p.id, p.title, p.short_desc, p.body, p.tags, p.status, p.created_at,
           p.owner_id, u.name AS owner_name, u.login AS owner_login,
           (SELECT COUNT(*) FROM applications a WHERE a.project_id = p.id) AS applications_count
    FROM projects p
    JOIN users u ON u.id = p.owner_id
"""


def list_projects(status: str = "", search: str = "", owner_id: int | None = None):
    """Список проектов с необязательными фильтрами: статус, поиск, автор."""
    sql = PROJECT_SELECT + " WHERE 1 = 1"
    params: list = []

    if status in ("open", "in_work", "closed"):
        sql += " AND p.status = %s"
        params.append(status)
    if search:
        sql += " AND (p.title LIKE %s OR p.short_desc LIKE %s OR p.tags LIKE %s)"
        like = f"%{search}%"
        params.extend([like, like, like])
    if owner_id is not None:
        sql += " AND p.owner_id = %s"
        params.append(owner_id)

    sql += " ORDER BY p.created_at DESC, p.id DESC"
    return query(sql, tuple(params))


def get_project(project_id: int):
    """Один проект по id (карточка проекта и её страница)."""
    return query(PROJECT_SELECT + " WHERE p.id = %s", (project_id,), fetch="one")


def create_project(owner_id: int, title: str, short_desc: str, body: str, tags: str):
    """Публикует проект на бирже."""
    return query(
        "INSERT INTO projects (owner_id, title, short_desc, body, tags) "
        "VALUES (%s, %s, %s, %s, %s)",
        (owner_id, title, short_desc, body, tags),
        fetch=None,
    )


def update_project_status(project_id: int, new_status: str):
    """Меняет статус проекта и пишет запись в журнал status_log."""
    project = query("SELECT status FROM projects WHERE id = %s", (project_id,), fetch="one")
    if not project or project["status"] == new_status:
        return False

    query("UPDATE projects SET status = %s WHERE id = %s", (new_status, project_id), fetch=None)
    query(
        "INSERT INTO status_log (project_id, old_status, new_status) VALUES (%s, %s, %s)",
        (project_id, project["status"], new_status),
        fetch=None,
    )
    return True


def status_history(project_id: int):
    """История смены статусов проекта, новые сверху."""
    return query(
        "SELECT old_status, new_status, changed_at FROM status_log "
        "WHERE project_id = %s ORDER BY changed_at DESC, id DESC",
        (project_id,),
    )

# Отклики на проекты

def add_application(project_id: int, user_id: int, message: str):
    """Отклик на проект. False — если пользователь уже откликался."""
    try:
        query(
            "INSERT INTO applications (project_id, user_id, message) VALUES (%s, %s, %s)",
            (project_id, user_id, message),
            fetch=None,
        )
        return True
    except mysql.connector.Error as err:
        if err.errno == errorcode.ER_DUP_ENTRY:
            return False
        raise


def list_applications_for_owner(owner_id: int):
    """Все отклики на проекты конкретного автора (для его кабинета)."""
    return query(
        """SELECT a.id, a.message, a.created_at,
                  p.id AS project_id, p.title AS project_title,
                  u.name AS user_name, u.login AS user_login
           FROM applications a
           JOIN projects p ON p.id = a.project_id
           JOIN users u ON u.id = a.user_id
           WHERE p.owner_id = %s
           ORDER BY a.created_at DESC""",
        (owner_id,),
    )


def has_applied(project_id: int, user_id: int) -> bool:
    """Откликался ли пользователь на этот проект."""
    row = query(
        "SELECT 1 AS ok FROM applications WHERE project_id = %s AND user_id = %s",
        (project_id, user_id),
        fetch="one",
    )
    return row is not None


def list_my_sent_applications(user_id: int):
    """Отклики, которые пользователь сам оставил на чужих проектах."""
    return query(
        """SELECT a.id, a.message, a.created_at,
                  p.id AS project_id, p.title AS project_title, p.status AS project_status,
                  u.name AS owner_name
           FROM applications a
           JOIN projects p ON p.id = a.project_id
           JOIN users u ON u.id = p.owner_id
           WHERE a.user_id = %s
           ORDER BY a.created_at DESC""",
        (user_id,),
    )

# Сводка для кабинета

def user_summary(user_id: int, is_curator: bool = False) -> dict:
    """Три счётчика: проектов, откликов, проектов в статусе «ищу команду».

    Для куратора считаются значения по всей бирже.
    """
    if is_curator:
        projects = query("SELECT COUNT(*) AS c FROM projects", fetch="one")
        apps = query("SELECT COUNT(*) AS c FROM applications", fetch="one")
        open_count = query(
            "SELECT COUNT(*) AS c FROM projects WHERE status = 'open'", fetch="one"
        )
    else:
        projects = query(
            "SELECT COUNT(*) AS c FROM projects WHERE owner_id = %s", (user_id,), fetch="one"
        )
        apps = query(
            "SELECT COUNT(*) AS c FROM applications a JOIN projects p ON p.id = a.project_id "
            "WHERE p.owner_id = %s",
            (user_id,),
            fetch="one",
        )
        open_count = query(
            "SELECT COUNT(*) AS c FROM projects WHERE owner_id = %s AND status = 'open'",
            (user_id,),
            fetch="one",
        )
    return {
        "projects": projects["c"] if projects else 0,
        "applications": apps["c"] if apps else 0,
        "open": open_count["c"] if open_count else 0,
    }

