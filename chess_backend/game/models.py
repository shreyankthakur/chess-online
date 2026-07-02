import random
import uuid

import chess

from django.db import models


ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # avoid 0/O/1/I ambiguity


def generate_room_code():
    for _ in range(20):
        code = "".join(random.choice(ROOM_CODE_CHARS) for _ in range(5))
        if not Room.objects.filter(code=code).exists():
            return code
    return uuid.uuid4().hex[:8].upper()  # extremely unlikely fallback


class Room(models.Model):
    """
    A single chess game between two players. `fen` is the single source of
    truth for board state; python-chess (server-side) is authoritative for
    legality, check/checkmate/stalemate and draw detection.
    """

    STATUS_WAITING = "waiting"     # host created the room, no guest yet
    STATUS_ACTIVE = "active"       # both players connected, game in progress
    STATUS_FINISHED = "finished"   # game over (checkmate / resignation / draw / abandoned)
    STATUS_CHOICES = [
        (STATUS_WAITING, "Waiting for opponent"),
        (STATUS_ACTIVE, "Active"),
        (STATUS_FINISHED, "Finished"),
    ]

    RESULT_CHOICES = [
        ("checkmate", "Checkmate"),
        ("resignation", "Resignation"),
        ("stalemate", "Stalemate"),
        ("draw", "Draw"),
        ("abandoned", "Abandoned"),
    ]

    code = models.CharField(max_length=8, unique=True, default=generate_room_code, editable=False)

    fen = models.CharField(max_length=100, default=chess.STARTING_FEN)
    move_history_san = models.JSONField(default=list, blank=True)  # ["e4", "e5", "Nf3", ...]

    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_WAITING)
    looking_for_match = models.BooleanField(default=False)  # discoverable via quick-match

    # Reconnect tokens: whoever holds the token can reclaim their seat after a
    # dropped connection. Issued once, never shown to the other player.
    host_token = models.UUIDField(default=uuid.uuid4, editable=False)
    guest_token = models.UUIDField(null=True, blank=True, editable=False)

    host_color = models.CharField(max_length=1, choices=[("w", "White"), ("b", "Black")], default="w")
    guest_joined = models.BooleanField(default=False)

    host_connected = models.BooleanField(default=False)
    guest_connected = models.BooleanField(default=False)

    winner = models.CharField(max_length=1, choices=[("w", "White"), ("b", "Black")], null=True, blank=True)
    result_reason = models.CharField(max_length=20, choices=RESULT_CHOICES, null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["code"])]

    def __str__(self):
        return f"Room {self.code} ({self.status})"

    # -- convenience helpers -------------------------------------------------

    @property
    def board(self) -> chess.Board:
        return chess.Board(self.fen)

    def color_for_token(self, token):
        if str(self.host_token) == str(token):
            return self.host_color
        if self.guest_token and str(self.guest_token) == str(token):
            return "b" if self.host_color == "w" else "w"
        return None

    def mark_game_over_from_board(self, board: chess.Board):
        """Sets status/winner/result_reason if the given board is terminal."""
        if board.is_checkmate():
            self.status = self.STATUS_FINISHED
            self.winner = "b" if board.turn == chess.WHITE else "w"  # side NOT to move just delivered mate
            self.result_reason = "checkmate"
        elif board.is_stalemate():
            self.status = self.STATUS_FINISHED
            self.winner = None
            self.result_reason = "stalemate"
        elif board.is_insufficient_material() or board.can_claim_fifty_moves() or board.is_repetition(3):
            self.status = self.STATUS_FINISHED
            self.winner = None
            self.result_reason = "draw"

    def as_state_dict(self):
        return {
            "code": self.code,
            "fen": self.fen,
            "turn": "w" if chess.Board(self.fen).turn == chess.WHITE else "b",
            "moveHistory": self.move_history_san,
            "status": self.status,
            "hostColor": self.host_color,
            "guestJoined": self.guest_joined,
            "hostConnected": self.host_connected,
            "guestConnected": self.guest_connected,
            "winner": self.winner,
            "resultReason": self.result_reason,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }
