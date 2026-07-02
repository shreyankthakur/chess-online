from django.urls import path

from . import views

urlpatterns = [
    path("rooms/create/", views.create_room, name="create_room"),
    path("rooms/join/", views.join_room, name="join_room"),
    path("rooms/quick-match/", views.quick_match, name="quick_match"),
    path("rooms/open/", views.open_rooms, name="open_rooms"),
    path("rooms/<str:code>/", views.room_status, name="room_status"),
]
