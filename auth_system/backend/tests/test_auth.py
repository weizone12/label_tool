import importlib
import os
import tempfile
import unittest


class AuthTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["AUTH_DATA_DIR"] = self.temp_dir.name
        os.environ["AUTH_SECRET_KEY"] = "test-only-secret"
        os.environ["AUTH_COOKIE_SECURE"] = "0"
        import app as app_module
        self.app_module = importlib.reload(app_module)
        self.app_module.app.config.update(TESTING=True)
        self.client = self.app_module.app.test_client()
        from auth.models import Base, db_session
        from auth.service import create_user
        Base.metadata.drop_all(db_session.bind)
        Base.metadata.create_all(db_session.bind)
        self.admin, _ = create_user(username="admin", password="AdminPassword!123", is_admin=True)
        self.admin.must_change_password = False
        db_session.commit()

    def tearDown(self):
        from auth.models import db_session
        db_session.remove()
        db_session.bind.dispose()
        self.temp_dir.cleanup()

    def csrf(self):
        return self.client.get("/api/auth/csrf").get_json()["csrf_token"]

    def post(self, path, body=None, token=None):
        return self.client.post(path, json=body or {}, headers={"X-CSRF-Token": token or self.csrf()})

    def patch(self, path, body, token):
        return self.client.patch(path, json=body, headers={"X-CSRF-Token": token})

    def login(self, username, password):
        response = self.post("/api/auth/login", {"username": username, "password": password})
        return response, response.get_json().get("csrf_token") if response.is_json else None

    def test_complete_user_lifecycle_and_permissions(self):
        response, admin_csrf = self.login("admin", "AdminPassword!123")
        self.assertEqual(response.status_code, 200)

        response = self.post("/api/admin/users", {"username": "new-user", "display_name": "New User"}, admin_csrf)
        self.assertEqual(response.status_code, 201)
        created = response.get_json()
        user_id = created["user"]["id"]
        temporary_password = created["temporary_password"]
        self.assertTrue(created["user"]["must_change_password"])
        self.assertNotIn("password_hash", response.get_data(as_text=True))
        from auth.models import db_session, User
        stored_user = db_session.get(User, user_id)
        self.assertTrue(stored_user.password_hash.startswith("$argon2id$"))
        self.assertNotIn(temporary_password, stored_user.password_hash)

        renamed = self.patch(f"/api/admin/users/{user_id}", {"username": "renamed-user"}, admin_csrf)
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.get_json()["user"]["username"], "renamed-user")
        duplicate = self.patch(f"/api/admin/users/{user_id}", {"username": "admin"}, admin_csrf)
        self.assertEqual(duplicate.status_code, 400)

        self.post("/api/auth/logout", token=admin_csrf)
        response, user_csrf = self.login("renamed-user", temporary_password)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["user"]["must_change_password"])
        denied = self.client.get("/api/admin/users")
        self.assertEqual(denied.status_code, 403)

        changed = self.post("/api/auth/change-password", {
            "current_password": temporary_password, "new_password": "PermanentPassword!456"
        }, user_csrf)
        self.assertEqual(changed.status_code, 200)
        self.assertFalse(changed.get_json()["user"]["must_change_password"])
        self.post("/api/auth/logout", token=user_csrf)
        self.assertEqual(self.login("renamed-user", "PermanentPassword!456")[0].status_code, 200)

        self.client = self.app_module.app.test_client()
        _, admin_csrf = self.login("admin", "AdminPassword!123")
        disabled = self.patch(f"/api/admin/users/{user_id}", {"status": "disabled"}, admin_csrf)
        self.assertEqual(disabled.status_code, 200)
        self.client = self.app_module.app.test_client()
        failed, _ = self.login("renamed-user", "PermanentPassword!456")
        self.assertEqual(failed.status_code, 401)
        self.assertEqual(failed.get_json()["error"], "帳號或密碼錯誤")

        self.client = self.app_module.app.test_client()
        _, admin_csrf = self.login("admin", "AdminPassword!123")
        self.patch(f"/api/admin/users/{user_id}", {"status": "active"}, admin_csrf)
        reset = self.post(f"/api/admin/users/{user_id}/reset-password", token=admin_csrf)
        self.assertEqual(reset.status_code, 200)
        self.assertTrue(reset.get_json()["user"]["must_change_password"])
        self.assertNotIn("password_hash", reset.get_data(as_text=True))
        reset_password = reset.get_json()["temporary_password"]
        self.client = self.app_module.app.test_client()
        relogin, _ = self.login("renamed-user", reset_password)
        self.assertTrue(relogin.get_json()["user"]["must_change_password"])

    def test_csrf_and_login_rate_limit(self):
        csrf_response = self.client.get("/api/auth/csrf")
        cookie = csrf_response.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.assertNotIn("csrf_token", cookie)
        self.assertEqual(self.client.post("/api/auth/login", json={}).status_code, 403)
        for _ in range(5):
            response, _ = self.login("missing", "wrong")
            self.assertEqual(response.status_code, 401)
        response, _ = self.login("missing", "wrong")
        self.assertEqual(response.status_code, 429)


if __name__ == "__main__":
    unittest.main()
