"""
app.py - HTTP-сервер портала «Биржа проектов».
Без фреймворков: только стандартный http.server + mysql-connector.
Сервер раздаёт статические файлы и JSON API, страницы - обычные HTML-файлы,
которые забирают данные через fetch.

Запуск:  python app.py      (по умолчанию http://127.0.0.1:8000)
"""

import json
import mimetypes
import os
import re
import secrets
import threading
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import mysql.connector

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", 8000))
COOKIE_NAME = "session"

# Сессии хранятся в памяти: session_id -> user_id.
# При перезапуске сервера все пользователи разлогинятся - для
# учебного проекта это нормально и даже честно видно на демо.

SESSIONS: dict[str, int] = {}
SESSIONS_LOCK = threading.Lock()

# Правила валидации повторяют клиентские из static/js/*.js,
# но проверяются и здесь: JS можно обойти, сервер - нельзя.

LOGIN_RE = re.compile(r"^[a-zA-Z0-9_.]{3,20}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-zA-Zа-яА-Я]{2,}$")
PASSWORD_MIN = 6
STATUSES = ("open", "in_work", "closed")


class ApiError(Exception):
    """Ошибка API с кодом ответа и текстом для пользователя."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status

# Чтение тела запроса и разбор форм

def read_json(handler) -> dict:
    """Читает JSON-тело запроса. Пустое тело - пустой словарь."""
    length = int(handler.headers.get("Content-Length") or 0)
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError("Некорректный JSON в запросе", 400)
    return data if isinstance(data, dict) else {}


def clean(value, max_len: int) -> str:
    """Приводит значение к строке без пробелов по краям и обрезает длину."""
    return str(value if value is not None else "").strip()[:max_len]


def initials(name: str) -> str:
    """«Тимофей Ковалёв» -> «ТК», для аватара в шапке и на карточке."""
    parts = [p for p in name.split() if p]
    return ("".join(p[0] for p in parts[:2])).upper() or "?"


def public_user(user: dict) -> dict:
    """Убирает хеш пароля перед отправкой клиенту."""
    return {
        "id": user["id"],
        "login": user["login"],
        "name": user["name"],
        "email": user["email"],
        "role": user["role"],
        "initials": initials(user["name"]),
    }


# Обработчики API (каждый возвращает словарь, который уйдёт как JSON)

def api_register(handler, data: dict):
    """Регистрация: проверка полей, запись в users, сразу открываем сессию."""
    login = clean(data.get("login"), 32)
    password = str(data.get("password") or "")
    confirm = str(data.get("confirm") or "")
    name = clean(data.get("name"), 64)
    email = clean(data.get("email"), 128).lower()

    # Собираем ошибки по полям - клиент покажет их под нужными input
    errors = {}
    if not LOGIN_RE.match(login):
        errors["login"] = "3–20 символов: латиница, цифры, _ и ."
    if len(name) < 2:
        errors["name"] = "Имя — минимум 2 символа"
    if not EMAIL_RE.match(email):
        errors["email"] = "Похоже, в e-mail опечатка"
    if len(password) < PASSWORD_MIN:
        errors["password"] = f"Пароль — минимум {PASSWORD_MIN} символов"
    if password != confirm:
        errors["confirm"] = "Пароли не совпадают"
    if errors:
        raise ApiError("Проверьте поля формы", 422)

    user_id = db.create_user(login, password, name, email)
    if user_id is None:
        raise ApiError("Логин или e-mail уже заняты", 409)

    user = db.find_user_by_id(user_id)
    start_session(handler, user)  # после регистрации сразу залогинены
    return {"ok": True, "message": "Аккаунт создан", "user": public_user(user)}


def api_login(handler, data: dict):
    """Вход: ищем логин, сверяем хеш пароля, заводим сессию."""
    login = clean(data.get("login"), 32)
    password = str(data.get("password") or "")

    if not login or not password:
        raise ApiError("Введите логин и пароль", 422)

    user = db.find_user_by_login(login)
    if not user or not db.verify_password(password, user["password"]):
        raise ApiError("Неверный логин или пароль", 401)

    start_session(handler, user)
    return {"ok": True, "message": "Вход выполнен", "user": public_user(user)}


def api_projects_list(handler, query: dict) -> list:
    """Список проектов с фильтром по статусу и поиском по строке."""
    status = (query.get("status") or [""])[0]
    search = clean((query.get("q") or [""])[0], 60)
    owner = (query.get("mine") or [""])[0]

    owner_id = None
    if owner == "1":
        user = get_user_or_error(handler)
        owner_id = user["id"]

    rows = db.list_projects(status=status, search=search, owner_id=owner_id)
    return [serialize_project(row) for row in rows]


def api_project_get(handler, project_id: int) -> dict:
    """Один проект: данные, история статусов и мой отклик, если он есть."""
    project = db.get_project(project_id)
    if not project:
        raise ApiError("Проект не найден", 404)

    project = serialize_project(project)
    project["history"] = [
        {"from": h["old_status"], "to": h["new_status"], "at": iso(h["changed_at"])}
        for h in db.status_history(project_id)
    ]

    user = get_user(handler)
    project["my_application"] = None
    if user:
        project["can_apply"] = project["owner_id"] != user["id"] and project["status"] == "open"
        project["can_edit_status"] = project["owner_id"] == user["id"] or user["role"] == "curator"
    return project


def serialize_project(row: dict) -> dict:
    """Готовит строку из БД к отправке в браузер (даты в ISO, теги массивом)."""
    return {
        "id": row["id"],
        "title": row["title"],
        "short_desc": row["short_desc"],
        "body": row["body"],
        "tags": [t.strip() for t in row["tags"].split(",") if t.strip()],
        "status": row["status"],
        "created_at": iso(row["created_at"]),
        "owner_id": row["owner_id"],
        "owner_name": row["owner_name"],
        "owner_login": row["owner_login"],
        "owner_initials": initials(row["owner_name"]),
        "applications_count": row["applications_count"],
    }


def iso(dt) -> str:
    """datetime -> строка для JS (без возни с часовыми поясами)."""
    return dt.strftime("%Y-%m-%dT%H:%M") if dt else ""


def api_project_create(handler, data: dict):
    """Публикация нового проекта текущим пользователем."""
    user = get_user_or_error(handler)

    title = clean(data.get("title"), 120)
    short_desc = clean(data.get("short_desc"), 180)
    body = clean(data.get("body"), 3000)
    tags = clean(data.get("tags"), 190)

    errors = {}
    if len(title) < 6:
        errors["title"] = "Заголовок — минимум 6 символов"
    if len(short_desc) < 10:
        errors["short_desc"] = "Опишите идею одной фразой (от 10 символов)"
    if len(body) < 30:
        errors["body"] = "Подробное описание — минимум 30 символов"
    if errors:
        raise ApiError("Проверьте поля формы", 422)

    project_id = db.create_project(user["id"], title, short_desc, body, tags)
    return {
        "ok": True,
        "message": "Проект опубликован на бирже",
        "project": serialize_project(db.get_project(project_id)),
    }


def api_project_status(handler, project_id: int, data: dict):
    """Смена статуса: автор проекта или куратор."""
    user = get_user_or_error(handler)
    project = db.get_project(project_id)
    if not project:
        raise ApiError("Проект не найден", 404)
    if user["role"] != "curator" and project["owner_id"] != user["id"]:
        raise ApiError("Менять статус может только автор проекта или куратор", 403)

    new_status = clean(data.get("status"), 20)
    if new_status not in STATUSES:
        raise ApiError("Неизвестный статус", 422)

    changed = db.update_project_status(project_id, new_status)
    return {
        "ok": True,
        "message": "Статус обновлён" if changed else "Статус уже такой",
        "project": serialize_project(db.get_project(project_id)),
    }


def api_apply(handler, project_id: int, data: dict):
    """Отклик на проект: нельзя на свой и нельзя дважды"""
    user = get_user_or_error(handler)
    project = db.get_project(project_id)
    if not project:
        raise ApiError("Проект не найден", 404)
    if project["owner_id"] == user["id"]:
        raise ApiError("Нельзя откликнуться на собственный проект", 403)
    if project["status"] != "open":
        raise ApiError("Проект больше не набирает команду", 409)

    message = clean(data.get("message"), 500)
    if len(message) < 15:
        raise ApiError("Расскажите о себе чуть подробнее (от 15 символов)", 422)

    if not db.add_application(project_id, user["id"], message):
        raise ApiError("Вы уже откликались на этот проект", 409)

    return {"ok": True, "message": "Отклик отправлен автору", "applications_count": project["applications_count"] + 1}


def api_me(handler):
    """Кто вошёл + счётчики для кабинета."""
    user = get_user(handler)
    if not user:
        return {"user": None}
    summary = db.user_summary(user["id"], is_curator=user["role"] == "curator")
    return {"user": public_user(user), "summary": summary}


def api_my_applications(handler):
    """Отклики, пришедшие на проекты текущего пользователя."""
    user = get_user_or_error(handler)
    rows = db.list_applications_for_owner(user["id"])
    return [
        {
            "id": r["id"],
            "project_id": r["project_id"],
            "project_title": r["project_title"],
            "user_name": r["user_name"],
            "user_login": r["user_login"],
            "initials": initials(r["user_name"]),
            "message": r["message"],
            "created_at": iso(r["created_at"]),
        }
        for r in rows
    ]


def api_logout(handler):
    """Выход: сессия удаляется на сервере, cookie - на клиенте"""
    end_session(handler)
    return {"ok": True, "message": "Вы вышли из аккаунта"}


def api_my_sent(handler):
    """Мои отклики на чужие проекты (вкладка «Мои отклики»)"""
    user = get_user_or_error(handler)
    rows = db.list_my_sent_applications(user["id"])
    return [
        {
            "id": r["id"],
            "project_id": r["project_id"],
            "project_title": r["project_title"],
            "project_status": r["project_status"],
            "owner_name": r["owner_name"],
            "message": r["message"],
            "created_at": iso(r["created_at"]),
        }
        for r in rows
    ]



# Работа с сессией из HTTP-запросов

def session_id_of(handler) -> str:
    """Достаёт id сессии из cookie (если он есть)"""
    cookie = SimpleCookie(handler.headers.get("Cookie", ""))
    morsel = cookie.get(COOKIE_NAME)
    return morsel.value if morsel else ""


def get_user(handler):
    """Пользователь по cookie сессии или None. handler нужен для чтения cookie"""
    sid = session_id_of(handler)
    with SESSIONS_LOCK:
        user_id = SESSIONS.get(sid)
    return db.find_user_by_id(user_id) if user_id else None


def get_user_or_error(handler):
    """То же, но для защищённых ручек: нет входа — 401."""
    user = get_user(handler)
    if not user:
        raise ApiError("Сначала войдите в аккаунт", 401)
    return user


def start_session(handler, user: dict):
    """Создаёт сессию и готовит HttpOnly-cookie в ответе"""
    sid = secrets.token_urlsafe(24)
    with SESSIONS_LOCK:
        SESSIONS[sid] = user["id"]
    handler.session_cookie = f"{COOKIE_NAME}={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800"


def end_session(handler):
    """Удаляет сессию на сервере и гасит cookie в браузере."""
    sid = session_id_of(handler)
    with SESSIONS_LOCK:
        SESSIONS.pop(sid, None)
    handler.session_cookie = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


# HTTP-обработчик: статика, страницы и API

class Handler(BaseHTTPRequestHandler):
    server_version = "MarketBoard/1.0"

    # Все маршруты API: (метод, регулярный шаблон, функция)
    ROUTES = [
        ("GET", r"^/api/me$", lambda h, m, q, d: api_me(h)),
        ("POST", r"^/api/register$", lambda h, m, q, d: api_register(h, d)),
        ("POST", r"^/api/login$", lambda h, m, q, d: api_login(h, d)),
        ("POST", r"^/api/logout$", lambda h, m, q, d: api_logout(h)),
        ("GET", r"^/api/projects$", lambda h, m, q, d: api_projects_list(h, q)),
        ("POST", r"^/api/projects$", lambda h, m, q, d: api_project_create(h, d)),
        ("GET", r"^/api/projects/(\d+)$", lambda h, m, q, d: api_project_get(h, int(m[0]))),
        ("PATCH", r"^/api/projects/(\d+)/status$",
         lambda h, m, q, d: api_project_status(h, int(m[0]), d)),
        ("POST", r"^/api/projects/(\d+)/apply$", lambda h, m, q, d: api_apply(h, int(m[0]), d)),
        ("GET", r"^/api/applications$", lambda h, m, q, d: api_my_applications(h)),
        ("GET", r"^/api/applications/sent$", lambda h, m, q, d: api_my_sent(h)),
        ("GET", r"^/api/projects/(\d+)$", lambda h, m, q, d: api_project_get(h, int(m[0]))),
    ]

    # Страницы: URL -> HTML-файл из templates/
    PAGES = {
        "/": "index.html",
        "/register": "register.html",
        "/login": "login.html",
        "/board": "board.html",
        "/cabinet": "cabinet.html",
        "/project": "project.html",
        "/admin": "admin.html",
        "/404": "404.html",
    }

    def log_message(self, fmt, *args):
        """Тише лог: без служебных строк http.server, только запросы"""
        print(f"  {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def do_PATCH(self):
        self.handle_request("PATCH")

    def handle_request(self, method: str):
        """Единая точка входа: решаем, API это или файл"""
        self.session_cookie = None  # cookie для Set-Cookie, если менялась сессия
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        try:
            if path.startswith("/api/"):
                self.handle_api(method, path, query)
            elif method == "GET":
                self.handle_files(path)
            else:
                self.send_json({"error": "Метод не поддерживается"}, 405)
        except ApiError as err:
            self.send_json({"error": err.message}, err.status)
        except mysql.connector.Error as err:
            # Ошибку БД не показываем пользователю целиком, но пишем в консоль
            print(f"  !! Ошибка БД: {err}")
            self.send_json({"error": "База данных недоступна. Проверьте настройки подключения."}, 503)
        except BrokenPipeError:
            pass
        except Exception as err:  # страховка, чтобы сервер не падал на одном запросе
            print(f"  !! Ошибка: {type(err).__name__}: {err}")
            self.send_json({"error": "Внутренняя ошибка сервера"}, 500)

    def handle_api(self, method: str, path: str, query: dict):
        """Ищет подходящий маршрут и вызывает обработчик"""
        matched = [
            (route_method, pattern, func)
            for route_method, pattern, func in self.ROUTES
            if re.match(pattern, path)
        ]
        if not matched:
            raise ApiError("Такого API-метода нет", 404)

        # Путь есть, но метод другой (например, GET вместо POST)
        found = next(((pattern, func) for m, pattern, func in matched if m == method), None)
        if found is None:
            raise ApiError("Метод не поддерживается для этого адреса", 405)

        # Номер проекта из URL, если в шаблоне есть группа (\d+)
        pattern, func = found
        groups = re.match(pattern, path).groups()
        data = read_json(self) if method in ("POST", "PATCH") else {}
        result = func(self, groups, query, data)
        self.send_json(result, 200)

    def handle_files(self, path: str):
        """Отдаёт HTML-страницу, файл из static/ или 404."""
        # Защищённые страницы без входа показывают форму входа
        user_id = SESSIONS.get(session_id_of(self))

        if path in self.PAGES:
            if path in ("/cabinet", "/admin") and not user_id:
                return self.redirect("/login")
            if path == "/admin":
                user = get_user(self)
                if not user or user["role"] != "curator":
                    return self.send_json({"error": "Доступ только для куратора"}, 403)
            return self.send_file(os.path.join(TEMPLATES_DIR, self.PAGES[path]), "text/html")

        if path.startswith("/static/"):
            # os.path.normpath не даёт выйти за пределы static/ через ".."
            safe_path = os.path.normpath(path.lstrip("/"))
            file_path = os.path.join(BASE_DIR, safe_path)
            if file_path.startswith(STATIC_DIR) and os.path.isfile(file_path):
                return self.send_file(file_path, None)
            raise ApiError("Файл не найден", 404)

        if path == "/health":
            return self.send_json({"status": "ok"}, 200)

        self.send_file(os.path.join(TEMPLATES_DIR, "404.html"), "text/html", 404)

    def send_file(self, file_path: str, content_type: str | None, status: int = 200):
        """Читает файл с диска и отправляет его браузеру."""
        if not os.path.isfile(file_path):
            raise ApiError("Файл не найден", 404)

        if content_type is None:
            content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"

        with open(file_path, "rb") as f:
            body = f.read()

        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload, status: int = 200):
        """Отправляет JSON с нужным кодом; добавит Set-Cookie, если менялась сессия."""
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "session_cookie", None):
            self.send_header("Set-Cookie", self.session_cookie)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location: str):
        """302-переадресация (например, с /cabinet на /login)"""
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()


def main():
    """Точка входа: проверяет БД и запускает сервер"""
    print("Биржа проектов — сервер запускается…")

    try:
        db.ensure_schema()
        print("  БД и таблицы готовы")
    except mysql.connector.Error as err:
        print(f"  !! Не удалось подключиться к MySQL: {err}")
        print("     Проверьте переменные DB_HOST, DB_USER, DB_PASSWORD и что MySQL запущен.")
        raise SystemExit(1)

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"  Открыть в браузере: http://{HOST}:{PORT}")
    print("  Остановка: Ctrl+C\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
