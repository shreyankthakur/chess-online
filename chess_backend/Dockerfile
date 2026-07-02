FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System deps needed to build psycopg2 (only used if you set DATABASE_URL to Postgres)
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN python manage.py collectstatic --noinput

# Most container hosts inject $PORT; default to 8000 for local `docker run`.
ENV PORT=8000
EXPOSE 8000

# Daphne serves both plain HTTP (REST API/admin) and WebSocket (/ws/game/...)
# from the same ASGI app defined in chess_backend/asgi.py.
CMD python manage.py migrate --noinput && daphne -b 0.0.0.0 -p ${PORT} chess_backend.asgi:application
