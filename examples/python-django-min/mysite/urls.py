from django.http import HttpResponse, JsonResponse
from django.urls import path

urlpatterns = [
    path("", lambda r: HttpResponse("Hello from Django on LevantDeploy")),
    path("health", lambda r: JsonResponse({"ok": True})),
]
