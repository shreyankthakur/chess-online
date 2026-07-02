import json
import uuid

import chess

from django.db import transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .models import Room


def _json_body(request):
    if not request.body:
        return {}
    try:
        return json.loads(request.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}


@csrf_exempt
@require_POST
def create_room(request):
    """Create a private room. The caller becomes the host (White by default)."""
    body = _json_body(request)
    host_color = body.get("hostColor", "w")
    if host_color not in ("w", "b"):
        host_color = "w"

    room = Room.objects.create(host_color=host_color)
    return JsonResponse({
        "code": room.code,
        "token": str(room.host_token),
        "color": room.host_color,
        "status": room.status,
    })


@csrf_exempt
@require_POST
def join_room(request):
    """Join an existing private room by its 5-character code."""
    body = _json_body(request)
    code = (body.get("code") or "").strip().upper()
    if not code:
        return JsonResponse({"error": "A room code is required."}, status=400)

    try:
        room = Room.objects.get(code=code)
    except Room.DoesNotExist:
        return JsonResponse({"error": "No room found with that code."}, status=404)

    if room.guest_joined:
        return JsonResponse({"error": "That room already has two players."}, status=409)

    guest_color = "b" if room.host_color == "w" else "w"
    room.guest_token = uuid.uuid4()
    room.guest_joined = True
    room.status = Room.STATUS_ACTIVE
    room.save(update_fields=["guest_token", "guest_joined", "status", "updated_at"])

    return JsonResponse({
        "code": room.code,
        "token": str(room.guest_token),
        "color": guest_color,
        "status": room.status,
    })


@csrf_exempt
@require_POST
def quick_match(request):
    """
    Pair the caller with the oldest open public room, or open a new public
    room to wait in if none are available. Uses select_for_update so two
    concurrent callers can't both claim the same room.
    """
    with transaction.atomic():
        candidate = (
            Room.objects.select_for_update(skip_locked=True)
            .filter(status=Room.STATUS_WAITING, looking_for_match=True, guest_joined=False)
            .order_by("created_at")
            .first()
        )
        if candidate:
            guest_color = "b" if candidate.host_color == "w" else "w"
            candidate.guest_token = uuid.uuid4()
            candidate.guest_joined = True
            candidate.status = Room.STATUS_ACTIVE
            candidate.save(update_fields=["guest_token", "guest_joined", "status", "updated_at"])
            return JsonResponse({
                "code": candidate.code,
                "token": str(candidate.guest_token),
                "color": guest_color,
                "status": candidate.status,
                "matched": True,
            })

        room = Room.objects.create(host_color="w", looking_for_match=True)
        return JsonResponse({
            "code": room.code,
            "token": str(room.host_token),
            "color": room.host_color,
            "status": room.status,
            "matched": False,
        })


@require_GET
def room_status(request, code):
    try:
        room = Room.objects.get(code=code.upper())
    except Room.DoesNotExist:
        return JsonResponse({"error": "Room not found."}, status=404)
    return JsonResponse(room.as_state_dict())


@require_GET
def open_rooms(request):
    """Lists public rooms currently waiting for a second player (a simple lobby browser)."""
    rooms = Room.objects.filter(
        status=Room.STATUS_WAITING, looking_for_match=True, guest_joined=False
    ).order_by("-created_at")[:25]
    return JsonResponse({
        "rooms": [{"code": r.code, "hostColor": r.host_color, "createdAt": r.created_at.isoformat()} for r in rooms]
    })
