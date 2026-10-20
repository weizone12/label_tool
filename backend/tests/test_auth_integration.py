import importlib
import io
import json
import os
import tempfile
import unittest
import urllib.error
from unittest.mock import patch


class FakeAuthResponse:
    def __init__(self, user=None):
        self.payload = json.dumps({"user": user or {
            "id": "00000000-0000-0000-0000-000000000001",
            "username": "tester", "display_name": "Tester", "email": None,
            "status": "active", "must_change_password": False, "is_admin": False,
        }}).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.payload


class AuthIntegrationTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["LABEL_TOOL_DATA_DIR"] = self.temp_dir.name
        import app as app_module
        self.app_module = importlib.reload(app_module)
        self.client = self.app_module.app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_annotation_api_requires_authentication(self):
        body = io.BytesIO(json.dumps({"error": "需要登入"}).encode())
        denied = urllib.error.HTTPError("auth", 401, "Unauthorized", {}, body)
        with patch("auth_integration.urllib.request.urlopen", side_effect=denied):
            response = self.client.get("/api/projects")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "需要登入")

    def test_read_and_write_requests_are_verified(self):
        captured = []

        def verify(request, timeout):
            captured.append((request.method, dict(request.header_items()), timeout))
            return FakeAuthResponse({
                "id": "00000000-0000-0000-0000-000000000001", "username": "admin",
                "display_name": "Admin", "email": None, "status": "active",
                "must_change_password": False, "is_admin": True,
            })

        with patch("auth_integration.urllib.request.urlopen", side_effect=verify):
            response = self.client.get("/api/projects", headers={"Cookie": "session=opaque"})
            self.assertEqual(response.status_code, 200)
            response = self.client.post("/api/projects", json={
                "name": "secured", "primaryMode": "rectangle", "labels": [],
            }, headers={"Cookie": "session=opaque", "X-CSRF-Token": "csrf-value"})
            self.assertEqual(response.status_code, 201)

        self.assertEqual(captured[0][0], "GET")
        self.assertEqual(captured[1][0], "POST")
        self.assertEqual(captured[1][1]["X-csrf-token"], "csrf-value")

    def test_user_only_sees_and_annotates_assigned_projects(self):
        from project_access import connection

        admin = {"id": "admin-id", "username": "admin", "is_admin": True,
                 "status": "active", "must_change_password": False}
        user = {"id": "user-id", "username": "worker", "is_admin": False,
                "status": "active", "must_change_password": False}
        active_user = admin

        def verify(_request, timeout=None):
            return FakeAuthResponse(active_user)

        with patch("auth_integration.urllib.request.urlopen", side_effect=verify):
            first = self.client.post("/api/projects", json={
                "name": "assigned", "primaryMode": "rectangle", "labels": [],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()
            second = self.client.post("/api/projects", json={
                "name": "hidden", "primaryMode": "rectangle", "labels": [],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()
            response = self.client.put(f"/api/projects/{first['id']}/assignments", json={"user_ids": [user["id"]]}, headers={"X-CSRF-Token": "csrf"})
            self.assertEqual(response.status_code, 200)
            admin_projects = self.client.get("/api/projects").get_json()
            assigned_project = next(project for project in admin_projects if project["id"] == first["id"])
            hidden_project = next(project for project in admin_projects if project["id"] == second["id"])
            self.assertEqual(assigned_project["assignedUserIds"], [user["id"]])
            self.assertEqual(hidden_project["assignedUserIds"], [])

            active_user = user
            projects = self.client.get("/api/projects").get_json()
            self.assertEqual([project["id"] for project in projects], [first["id"]])
            self.assertNotIn("assignedUserIds", projects[0])
            forbidden_create = self.client.post("/api/projects", json={"name": "nope"}, headers={"X-CSRF-Token": "csrf"})
            self.assertEqual(forbidden_create.status_code, 403)
            forbidden_settings = self.client.put(f"/api/projects/{first['id']}", json={"name": "changed"}, headers={"X-CSRF-Token": "csrf"})
            self.assertEqual(forbidden_settings.status_code, 403)
            hidden = self.client.get(f"/api/projects/{second['id']}")
            self.assertEqual(hidden.status_code, 403)

        with connection() as db:
            count = db.execute("SELECT COUNT(*) FROM project_assignments").fetchone()[0]
        self.assertEqual(count, 1)

    def test_admin_can_replace_assignments_for_multiple_projects(self):
        from project_access import connection

        admin = {"id": "admin-id", "username": "admin", "is_admin": True,
                 "status": "active", "must_change_password": False}
        user = {"id": "user-id", "username": "worker", "is_admin": False,
                "status": "active", "must_change_password": False}
        active_user = admin

        def verify(_request, timeout=None):
            return FakeAuthResponse(active_user)

        with patch("auth_integration.urllib.request.urlopen", side_effect=verify):
            first = self.client.post("/api/projects", json={
                "name": "first", "group": "日期 / 批次", "primaryMode": "rectangle", "labels": [],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()
            second = self.client.post("/api/projects", json={
                "name": "second", "group": "日期 / 批次", "primaryMode": "rectangle", "labels": [],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()
            outside = self.client.post("/api/projects", json={
                "name": "outside", "group": "其他", "primaryMode": "rectangle", "labels": [],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()

            response = self.client.put("/api/projects/assignments/bulk", json={
                "project_ids": [first["id"], second["id"], first["id"]],
                "user_ids": [user["id"], user["id"]],
            }, headers={"X-CSRF-Token": "csrf"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), {
                "project_ids": [first["id"], second["id"]],
                "user_ids": [user["id"]],
            })

            listed = {project["id"]: project for project in self.client.get("/api/projects").get_json()}
            self.assertEqual(listed[first["id"]]["assignedUserIds"], [user["id"]])
            self.assertEqual(listed[second["id"]]["assignedUserIds"], [user["id"]])
            self.assertEqual(listed[outside["id"]]["assignedUserIds"], [])

            active_user = user
            forbidden = self.client.put("/api/projects/assignments/bulk", json={
                "project_ids": [first["id"]], "user_ids": [],
            }, headers={"X-CSRF-Token": "csrf"})
            self.assertEqual(forbidden.status_code, 403)

        with connection() as db:
            assignments = db.execute(
                "SELECT project_id, user_id FROM project_assignments ORDER BY project_id"
            ).fetchall()
        self.assertEqual(
            [(row["project_id"], row["user_id"]) for row in assignments],
            sorted([(first["id"], user["id"]), (second["id"], user["id"])]),
        )

    def test_only_admin_can_replace_reid_source_state(self):
        admin = {"id": "admin-id", "username": "admin", "is_admin": True,
                 "status": "active", "must_change_password": False}
        user = {"id": "user-id", "username": "worker", "is_admin": False,
                "status": "active", "must_change_password": False}
        active_user = admin

        def verify(_request, timeout=None):
            return FakeAuthResponse(active_user)

        with patch("auth_integration.urllib.request.urlopen", side_effect=verify):
            project = self.client.post("/api/projects", json={
                "name": "reid sources", "projectType": "editing", "primaryMode": "reid", "labels": [],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()
            self.client.put(f"/api/projects/{project['id']}/assignments", json={"user_ids": [user["id"]]}, headers={"X-CSRF-Token": "csrf"})
            video = self.client.post(
                f"/api/projects/{project['id']}/images",
                data={"files": (io.BytesIO(b"video"), "clip.mp4")}, content_type="multipart/form-data",
                headers={"X-CSRF-Token": "csrf"},
            ).get_json()[0]
            admin_state = {
                "reid_edit_only": True, "bbox_source_name": "bbox.jsonl",
                "mmsi_source_name": "mmsi.jsonl", "mmsi_records": [{"mmsi": "123", "x": 4, "y": 5}],
            }
            self.client.put(
                f"/api/projects/{project['id']}/images/{video['id']}/annotation",
                json={"annotations": [], "editor_state": admin_state}, headers={"X-CSRF-Token": "csrf"},
            )

            active_user = user
            response = self.client.put(
                f"/api/projects/{project['id']}/images/{video['id']}/annotation",
                json={"annotations": [], "editor_state": {"mmsi_source_name": "replaced.jsonl"}},
                headers={"X-CSRF-Token": "csrf"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["editor_state"], admin_state)

    def test_assigned_user_can_batch_update_reid_gid(self):
        admin = {"id": "admin-id", "username": "admin", "is_admin": True,
                 "status": "active", "must_change_password": False}
        user = {"id": "user-id", "username": "worker", "is_admin": False,
                "status": "active", "must_change_password": False}
        unassigned_user = {"id": "other-user-id", "username": "other", "is_admin": False,
                           "status": "active", "must_change_password": False}
        active_user = admin

        def verify(_request, timeout=None):
            return FakeAuthResponse(active_user)

        with patch("auth_integration.urllib.request.urlopen", side_effect=verify):
            project = self.client.post("/api/projects", json={
                "name": "reid batch", "primaryMode": "reid", "labels": [{
                    "id": "ship", "name": "Ship", "color": "#00ff00",
                    "attributes": [{"id": "mmsi-attribute", "name": "MMSI", "type": "text"}],
                }],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()
            self.client.put(
                f"/api/projects/{project['id']}/assignments",
                json={"user_ids": [user["id"]]}, headers={"X-CSRF-Token": "csrf"},
            )
            image = self.client.post(
                f"/api/projects/{project['id']}/images",
                data={"files": (io.BytesIO(b"not-an-image"), "photo.jpg")},
                content_type="multipart/form-data", headers={"X-CSRF-Token": "csrf"},
            ).get_json()[0]
            self.client.put(
                f"/api/projects/{project['id']}/images/{image['id']}/annotation",
                json={"annotations": [{
                    "id": "bbox-1", "mode": "reid", "label_id": "ship",
                    "geometry": {"x": 1, "y": 2, "width": 20, "height": 10},
                    "attributes": {"mmsi-attribute": "old"},
                    "identity_id": "gid-1", "track_id": 1,
                }]}, headers={"X-CSRF-Token": "csrf"},
            )

            active_user = user
            response = self.client.put(
                f"/api/projects/{project['id']}/reid/gid",
                json={"gid": "gid-1", "label_id": "ship", "mmsi": "416035000"},
                headers={"X-CSRF-Token": "csrf"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), {
                "matched_annotations": 1, "updated_annotations": 1, "updated_images": 1,
            })
            annotation = self.client.get(
                f"/api/projects/{project['id']}/images/{image['id']}/annotation"
            ).get_json()["annotations"][0]
            self.assertEqual(annotation["attributes"], {"mmsi-attribute": "416035000"})

            camera_response = self.client.put(
                f"/api/projects/{project['id']}/reid/camera-id",
                json={"image_ids": [image["id"]], "camera_id": "cam-1"},
                headers={"X-CSRF-Token": "csrf"},
            )
            self.assertEqual(camera_response.status_code, 200)
            self.assertEqual(camera_response.get_json()["updated_annotations"], 1)
            annotation = self.client.get(
                f"/api/projects/{project['id']}/images/{image['id']}/annotation"
            ).get_json()["annotations"][0]
            self.assertEqual(annotation["camera_id"], "cam-1")

            active_user = unassigned_user
            denied = self.client.put(
                f"/api/projects/{project['id']}/reid/gid",
                json={"gid": "gid-1", "label_id": "ship", "mmsi": "123"},
                headers={"X-CSRF-Token": "csrf"},
            )
            self.assertEqual(denied.status_code, 403)
            denied = self.client.put(
                f"/api/projects/{project['id']}/reid/camera-id",
                json={"image_ids": [image["id"]], "camera_id": "cam-2"},
                headers={"X-CSRF-Token": "csrf"},
            )
            self.assertEqual(denied.status_code, 403)

    def test_assigned_user_can_update_project_completion(self):
        admin = {"id": "admin-id", "username": "admin", "is_admin": True,
                 "status": "active", "must_change_password": False}
        user = {"id": "user-id", "username": "worker", "is_admin": False,
                "status": "active", "must_change_password": False}
        active_user = admin

        def verify(_request, timeout=None):
            return FakeAuthResponse(active_user)

        with patch("auth_integration.urllib.request.urlopen", side_effect=verify):
            project = self.client.post("/api/projects", json={
                "name": "completion batch", "primaryMode": "rectangle", "labels": [],
            }, headers={"X-CSRF-Token": "csrf"}).get_json()
            self.client.put(
                f"/api/projects/{project['id']}/assignments",
                json={"user_ids": [user["id"]]}, headers={"X-CSRF-Token": "csrf"},
            )
            self.client.post(
                f"/api/projects/{project['id']}/images",
                data={"files": (io.BytesIO(b"not-an-image"), "photo.jpg")},
                content_type="multipart/form-data", headers={"X-CSRF-Token": "csrf"},
            )

            active_user = user
            response = self.client.put(
                f"/api/projects/{project['id']}/completion",
                json={"completed": True}, headers={"X-CSRF-Token": "csrf"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), {"completed": True, "updated": 1, "total": 1})
            self.assertTrue(self.client.get(f"/api/projects/{project['id']}/images").get_json()[0]["completed"])


if __name__ == "__main__":
    unittest.main()
