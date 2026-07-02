from django.contrib import admin

from .models import Room


@admin.register(Room)
class RoomAdmin(admin.ModelAdmin):
    list_display = ("code", "status", "host_color", "guest_joined", "host_connected", "guest_connected", "winner", "updated_at")
    list_filter = ("status", "looking_for_match")
    search_fields = ("code",)
    readonly_fields = ("host_token", "guest_token", "created_at", "updated_at")
