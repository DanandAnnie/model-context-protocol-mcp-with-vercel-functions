"""Deployed demo smoke test. Credentials come only from environment variables.

Creates two disposable confirmed test accounts without sending email, verifies
account isolation and Hermes-style API access, and removes its own test data.
Never run against a live-provider deployment.
"""
import base64
import http.cookiejar
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = os.environ["STUDIO_BASE_URL"].rstrip("/")
SHARE = os.environ["STUDIO_SHARE_URL"]
DB = os.environ["SUPABASE_URL"].rstrip("/")
ADMIN = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLIC = os.environ["SUPABASE_PUBLIC_KEY"]
HOST = urllib.parse.urlsplit(BASE).hostname
REF = urllib.parse.urlsplit(DB).hostname.split(".")[0]


def request(client, method, url, body=None, headers=None):
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, data=data, headers=h)
    try:
        response = client.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        value = None
    return response.status, value


def client():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.open(SHARE, timeout=30).read()
    return opener, jar


def session(jar, token):
    encoded = "base64-" + base64.urlsafe_b64encode(json.dumps(token).encode()).decode().rstrip("=")
    chunks = [encoded[i:i + 3180] for i in range(0, len(encoded), 3180)]
    for i, value in enumerate(chunks):
        name = f"sb-{REF}-auth-token" + (f".{i}" if len(chunks) > 1 else "")
        jar.set_cookie(http.cookiejar.Cookie(0, name, value, None, False, HOST, False,
                                             False, "/", True, True, None, True, None, None, {}))


def expect(status, expected, label):
    if status != expected:
        raise RuntimeError(f"{label}: HTTP {status}, expected {expected}")
    print(f"PASS {label}", flush=True)


admin = urllib.request.build_opener()
admin_headers = {"apikey": ADMIN, "Authorization": "Bearer " + ADMIN}
users = []
clients = []
tokens = []
try:
    anonymous, _ = client()
    code, health = request(anonymous, "GET", BASE + "/api/health")
    expect(code, 200, "health")
    assert health["persistence"] == "supabase"
    assert set(health["providers"].values()) == {"mock"}, "Refusing a live-provider deployment"
    expect(request(anonymous, "GET", BASE + "/api/videos")[0], 401, "anonymous API denied")
    expect(request(anonymous, "POST", BASE + "/api/webhooks/heygen", {})[0], 503, "provider callbacks disabled")

    for _ in range(2):
        email = f"avatar-launch-test-{uuid.uuid4().hex}@example.com"
        password = secrets.token_urlsafe(32)
        code, user = request(admin, "POST", DB + "/auth/v1/admin/users",
                             {"email": email, "password": password, "email_confirm": True}, admin_headers)
        expect(code, 200, "disposable account created without email")
        users.append(user["id"])
        code, token = request(admin, "POST", DB + "/auth/v1/token?grant_type=password",
                              {"email": email, "password": password}, {"apikey": PUBLIC})
        expect(code, 200, "real Supabase password sign-in")
        tokens.append(token)
        app, jar = client()
        session(jar, token)
        clients.append(app)
        expect(request(app, "GET", BASE + "/api/avatars")[0], 200, "signed-in session accepted")

    owner, other = clients
    code, status = request(owner, "GET", BASE + "/api/status")
    expect(code, 200, "authenticated provider status")
    assert status["authMode"] == "supabase" and status["mode"] == "demo"
    expect(request(owner, "PUT", BASE + "/api/brand", {"name": "Disposable launch QA", "primaryColor": "#123456"})[0], 200, "brand saved")
    code, brand = request(owner, "GET", BASE + "/api/brand")
    assert brand["brand"]["name"] == "Disposable launch QA"
    _, isolated = request(other, "GET", BASE + "/api/brand")
    assert not isolated.get("brand") or isolated["brand"].get("name") != "Disposable launch QA"
    print("PASS brand persistence and account isolation", flush=True)

    code, key = request(owner, "POST", BASE + "/api/keys", {"name": "Disposable Hermes smoke key"})
    expect(code, 201, "developer key minted by session")
    bearer = {"Authorization": "Bearer " + key["secret"]}
    expect(request(anonymous, "POST", BASE + "/api/keys", {"name": "escalation"}, bearer)[0], 403, "key cannot mint keys")
    code, made = request(anonymous, "POST", BASE + "/api/videos", {
        "title": "Disposable Hermes demo", "script": "This is a simulated launch verification.",
        "avatarId": "stock_2", "voiceId": "stock_voice_2", "aspect": "16:9"}, bearer)
    expect(code, 201, "Hermes-style video creation")
    video_id = made["video"]["id"]
    expect(request(other, "GET", BASE + "/api/videos/" + video_id)[0], 404, "other account cannot read video")
    for _ in range(15):
        code, result = request(anonymous, "GET", BASE + "/api/videos/" + video_id, headers=bearer)
        if code == 200 and result["video"]["status"] == "completed":
            break
        time.sleep(2)
    assert result["video"]["status"] == "completed", "Demo did not complete"
    print("PASS polling across requests retains and completes video", flush=True)
    expect(request(owner, "DELETE", BASE + "/api/keys/" + key["key"]["id"])[0], 204, "developer key revoked")
    expect(request(anonymous, "GET", BASE + "/api/videos", headers=bearer)[0], 401, "revoked key rejected")
    print("PASS all deployed demo smoke checks", flush=True)
finally:
    for app in clients:
        code, _ = request(app, "DELETE", BASE + "/api/account", {"confirm": "DELETE"})
        print(f"Cleanup disposable app data: HTTP {code}", flush=True)
    for token in tokens:
        request(admin, "POST", DB + "/auth/v1/logout?scope=global", headers={"apikey": PUBLIC, "Authorization": "Bearer " + token["access_token"]})
    for user_id in users:
        code, _ = request(admin, "DELETE", DB + "/auth/v1/admin/users/" + user_id, headers=admin_headers)
        print(f"Cleanup disposable account: HTTP {code}", flush=True)
