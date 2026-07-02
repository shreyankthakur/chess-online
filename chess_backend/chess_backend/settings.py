"""
Django settings for chess_backend project.

Configured to run out of the box for local development, and to become
production-ready purely through environment variables (no code edits
needed) when deployed. See the project README for a deployment walk-through.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name, default=False):
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


# SECURITY WARNING: keep the secret key used in production secret!
# Set DJANGO_SECRET_KEY in your host's environment variables for real
# deployments. Falls back to a dev-only key so `runserver` works untouched.
SECRET_KEY = os.environ.get(
    "DJANGO_SECRET_KEY",
    "django-insecure-zu1dm(!zn2k3b&^2j4t=wka979zx$cmdc*qf#h1n7(daml33_o",
)

# SECURITY WARNING: don't run with debug turned on in production!
# Defaults to True for local dev; set DJANGO_DEBUG=False in production.
DEBUG = env_bool("DJANGO_DEBUG", default=True)

# Comma-separated list, e.g. "chess-api.example.com,my-app.up.railway.app".
# Defaults to "*" for easy local/dev use; set this explicitly in production.
_allowed_hosts = os.environ.get("DJANGO_ALLOWED_HOSTS", "*")
ALLOWED_HOSTS = [h.strip() for h in _allowed_hosts.split(",") if h.strip()]


# Application definition

INSTALLED_APPS = [
    'daphne',  # must come before django.contrib.staticfiles to enable `runserver` over ASGI
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'corsheaders',
    'channels',
    'game',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',  # serves /static/ (e.g. admin) without a separate web server
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

# Comma-separated list of frontend origins allowed to call this API, e.g.
# "https://my-chess-app.vercel.app,https://my-chess-app.netlify.app".
# If unset, CORS defaults to allow-all so local dev / quick demos work
# out of the box — set CORS_ALLOWED_ORIGINS explicitly before going live.
_cors_origins = os.environ.get("CORS_ALLOWED_ORIGINS", "")
if _cors_origins.strip():
    CORS_ALLOWED_ORIGINS = [o.strip() for o in _cors_origins.split(",") if o.strip()]
else:
    CORS_ALLOW_ALL_ORIGINS = True

# Same idea for Channels' WebSocket origin check (game/asgi.py wraps the
# websocket router in AllowedHostsOriginValidator, which uses ALLOWED_HOSTS).

ROOT_URLCONF = 'chess_backend.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

ASGI_APPLICATION = 'chess_backend.asgi.application'
WSGI_APPLICATION = 'chess_backend.wsgi.application'  # kept for `manage.py` / tooling that expects it

# In-memory channel layer works great for a single process (fine for most
# free-tier deployments running one instance). If you scale to more than one
# worker process, set REDIS_URL (e.g. from a free Upstash/Redis Cloud
# instance) so all workers share game state and matchmaking correctly.
_redis_url = os.environ.get("REDIS_URL", "")
if _redis_url:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [_redis_url]},
        }
    }
else:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels.layers.InMemoryChannelLayer",
        }
    }


# Database
# Defaults to local SQLite (fine for a single instance / small scale, but
# its file is lost on redeploy on most free container hosts since their
# filesystem is ephemeral — active games/rooms reset when the container
# restarts). Set DATABASE_URL to point at a free managed Postgres (e.g.
# Neon, Supabase) for state that survives restarts.
_database_url = os.environ.get("DATABASE_URL", "")
if _database_url:
    import dj_database_url

    DATABASES = {
        "default": dj_database_url.parse(_database_url, conn_max_age=600)
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
        }
    }


# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]


# Internationalization
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True


# Static files (CSS, JavaScript, Images)
STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

# Trust the reverse proxy most PaaS/container hosts sit behind, so Django
# correctly detects HTTPS (needed for secure cookies / CSRF over TLS).
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
