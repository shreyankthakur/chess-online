"""
ASGI config for chess_backend project.

Routes plain HTTP requests (REST API, admin) through Django as usual, and
upgrades WebSocket connections under /ws/ to the Channels consumers defined
in game/routing.py.
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'chess_backend.settings')

# get_asgi_application() must be called before importing anything that
# touches Django models, so it comes first.
django_asgi_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402

import game.routing  # noqa: E402

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": AllowedHostsOriginValidator(
        URLRouter(game.routing.websocket_urlpatterns)
    ),
})
