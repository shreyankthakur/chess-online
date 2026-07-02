import asyncio
import json

import chess
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.db import transaction

from .models import Room

# In-memory registry of pending "abandon after grace period" timers, keyed by
# room code. This is fine for a single ASGI worker process (e.g. `runserver`,
# a single Daphne/uvicorn instance). If you scale to multiple worker
# processes, replace this with a periodic Celery/Channels task that checks
# `Room.updated_at` + connected flags in the database instead — an in-memory
# dict on one process can't see disconnects handled by another.
_abandon_timers = {}

RECONNECT_GRACE_SECONDS = 90


class GameConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.code = self.scope["url_route"]["kwargs"]["code"].upper()
        self.token = self._get_token_from_query()
        self.group_name = f"room_{self.code}"

        room = await self._get_room()
        if room is None:
            await self.close(code=4404)  # room not found
            return

        color = room.color_for_token(self.token)
        if color is None:
            await self.close(code=4401)  # bad/missing token
            return

        self.color = color
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        room = await self._mark_connected(self.code, self.color, True)
        self._cancel_abandon_timer(self.code)

        await self.send(text_data=json.dumps({"type": "state", **room.as_state_dict()}))
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "broadcast.presence",
                "color": self.color,
                "connected": True,
                "guestJoined": room.guest_joined,
            },
        )

    async def disconnect(self, close_code):
        if not hasattr(self, "code"):
            return
        room = await self._mark_connected(self.code, self.color, False)
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "broadcast.presence", "color": self.color, "connected": False},
        )
        await self.channel_layer.group_discard(self.group_name, self.channel_name)
        if room and room.status != Room.STATUS_FINISHED:
            self._schedule_abandon_timer(self.code)

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except ValueError:
            return
        action = data.get("action")

        if action == "move":
            await self._handle_move(data)
        elif action == "resign":
            await self._handle_resign()
        elif action == "chat":
            text = str(data.get("text", ""))[:280].strip()
            if text:
                await self.channel_layer.group_send(
                    self.group_name,
                    {"type": "broadcast.chat", "color": self.color, "text": text},
                )
        elif action == "rematch_offer":
            await self.channel_layer.group_send(
                self.group_name, {"type": "broadcast.rematch", "color": self.color}
            )

    # -- action handlers ------------------------------------------------

    async def _handle_move(self, data):
        uci = data.get("uci", "")
        result = await self._apply_move(self.code, self.color, uci)
        if "error" in result:
            await self.send(text_data=json.dumps({"type": "error", "message": result["error"]}))
            return
        await self.channel_layer.group_send(
            self.group_name, {"type": "broadcast.move", **result}
        )
        if result.get("status") == Room.STATUS_FINISHED:
            self._cancel_abandon_timer(self.code)

    async def _handle_resign(self):
        result = await self._apply_resign(self.code, self.color)
        if result:
            await self.channel_layer.group_send(
                self.group_name, {"type": "broadcast.game_over", **result}
            )
            self._cancel_abandon_timer(self.code)

    # -- group event handlers (fan out to this socket) -------------------

    async def broadcast_move(self, event):
        payload = {k: v for k, v in event.items() if k != "type"}
        payload["type"] = "move"
        await self.send(text_data=json.dumps(payload))

    async def broadcast_presence(self, event):
        payload = {
            "type": "presence", "color": event["color"], "connected": event["connected"],
        }
        if "guestJoined" in event:
            payload["guestJoined"] = event["guestJoined"]
        await self.send(text_data=json.dumps(payload))

    async def broadcast_chat(self, event):
        await self.send(text_data=json.dumps({"type": "chat", "color": event["color"], "text": event["text"]}))

    async def broadcast_rematch(self, event):
        await self.send(text_data=json.dumps({"type": "rematch_offer", "color": event["color"]}))

    async def broadcast_game_over(self, event):
        payload = {k: v for k, v in event.items() if k != "type"}
        payload["type"] = "game_over"
        await self.send(text_data=json.dumps(payload))

    # -- abandonment grace period -----------------------------------------

    def _schedule_abandon_timer(self, code):
        self._cancel_abandon_timer(code)
        _abandon_timers[code] = asyncio.ensure_future(self._abandon_after_grace(code))

    def _cancel_abandon_timer(self, code):
        task = _abandon_timers.pop(code, None)
        if task and not task.done():
            task.cancel()

    async def _abandon_after_grace(self, code):
        try:
            await asyncio.sleep(RECONNECT_GRACE_SECONDS)
        except asyncio.CancelledError:
            return
        result = await self._apply_abandon(code)
        if result:
            await self.channel_layer.group_send(
                f"room_{code}", {"type": "broadcast.game_over", **result}
            )

    # -- DB access (sync ORM wrapped for async consumer) ------------------

    @database_sync_to_async
    def _get_room(self):
        try:
            return Room.objects.get(code=self.code)
        except Room.DoesNotExist:
            return None

    @database_sync_to_async
    def _mark_connected(self, code, color, connected):
        try:
            room = Room.objects.get(code=code)
        except Room.DoesNotExist:
            return None
        if color == room.host_color:
            room.host_connected = connected
        else:
            room.guest_connected = connected
        room.save(update_fields=["host_connected", "guest_connected", "updated_at"])
        return room

    @database_sync_to_async
    def _apply_move(self, code, color, uci):
        with transaction.atomic():
            try:
                room = Room.objects.select_for_update().get(code=code)
            except Room.DoesNotExist:
                return {"error": "Room no longer exists."}

            if room.status == Room.STATUS_FINISHED:
                return {"error": "The game is already over."}

            board = room.board
            turn_color = "w" if board.turn == chess.WHITE else "b"
            if color != turn_color:
                return {"error": "It's not your turn."}

            try:
                move = chess.Move.from_uci(uci)
            except ValueError:
                return {"error": "Malformed move."}

            if move not in board.legal_moves:
                return {"error": "Illegal move."}

            san = board.san(move)
            board.push(move)
            room.fen = board.fen()
            room.move_history_san = [*room.move_history_san, san]
            room.mark_game_over_from_board(board)
            room.save(update_fields=[
                "fen", "move_history_san", "status", "winner", "result_reason", "updated_at",
            ])

            return {
                "uci": uci,
                "san": san,
                "fen": room.fen,
                "turn": "w" if board.turn == chess.WHITE else "b",
                "inCheck": board.is_check(),
                "status": room.status,
                "winner": room.winner,
                "resultReason": room.result_reason,
            }

    @database_sync_to_async
    def _apply_resign(self, code, color):
        with transaction.atomic():
            try:
                room = Room.objects.select_for_update().get(code=code)
            except Room.DoesNotExist:
                return None
            if room.status == Room.STATUS_FINISHED:
                return None
            room.status = Room.STATUS_FINISHED
            room.winner = "b" if color == "w" else "w"
            room.result_reason = "resignation"
            room.save(update_fields=["status", "winner", "result_reason", "updated_at"])
            return {"status": room.status, "winner": room.winner, "resultReason": room.result_reason}

    @database_sync_to_async
    def _apply_abandon(self, code):
        with transaction.atomic():
            try:
                room = Room.objects.select_for_update().get(code=code)
            except Room.DoesNotExist:
                return None
            if room.status == Room.STATUS_FINISHED:
                return None
            # Only forfeit if the disconnected side is still disconnected.
            if room.host_connected and room.guest_connected:
                return None
            room.status = Room.STATUS_FINISHED
            if not room.host_connected and room.guest_connected:
                room.winner = "b" if room.host_color == "w" else "w"
            elif not room.guest_connected and room.host_connected:
                room.winner = room.host_color
            else:
                room.winner = None
            room.result_reason = "abandoned"
            room.save(update_fields=["status", "winner", "result_reason", "updated_at"])
            return {"status": room.status, "winner": room.winner, "resultReason": room.result_reason}

    # -- misc ---------------------------------------------------------------

    def _get_token_from_query(self):
        qs = self.scope.get("query_string", b"").decode()
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        return params.get("token", "")
