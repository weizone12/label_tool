import io
import os
import tempfile
import unittest
import uuid
from pathlib import Path

from PIL import Image


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["LABEL_TOOL_DATA_DIR"] = self.temp_dir.name
        import importlib
        import app as app_module
        self.app_module = importlib.reload(app_module)
        self.client = self.app_module.app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_project_image_annotation_lifecycle(self):
        response = self.client.post("/api/projects", json={
            "name": "測試專案",
            "primaryMode": "rotated_rectangle",
            "labels": [{"id": "person", "name": "人", "color": "#ff0000", "attributes": []}],
            "classificationMode": "multiple",
        })
        self.assertEqual(response.status_code, 201)
        project_id = response.get_json()["id"]
        self.assertTrue((Path(self.temp_dir.name) / "projects" / "測試專案").exists())

        image_buffer = io.BytesIO()
        Image.new("RGB", (320, 180), "white").save(image_buffer, format="PNG")
        image_buffer.seek(0)
        response = self.client.post(
            f"/api/projects/{project_id}/images",
            data={"files": (image_buffer, "sample.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 201)
        image = response.get_json()[0]
        self.assertEqual((image["width"], image["height"]), (320, 180))
        listed_image = self.client.get(f"/api/projects/{project_id}/images").get_json()[0]
        self.assertEqual(listed_image["originalFilename"], "sample.png")

        annotation = {
            "annotations": [{
                "id": str(uuid.uuid4()), "mode": "rotated_rectangle", "label_id": "person",
                "geometry": {"points": [[10, 10], [80, 20], [75, 60], [5, 50]]},
                "attributes": {}, "metadata": {},
            }],
            "classifications": [{"label_id": "person"}],
            "revision": 0,
        }
        response = self.client.put(f"/api/projects/{project_id}/images/{image['id']}/annotation", json=annotation)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["revision"], 1)

        response = self.client.get(f"/api/projects/{project_id}/images/{image['id']}/annotation")
        self.assertEqual(response.get_json()["annotations"][0]["mode"], "rotated_rectangle")
        self.assertEqual(response.get_json()["classifications"], [])
        project_path = Path(self.temp_dir.name) / "projects" / "測試專案"
        self.assertFalse((project_path / "exports").exists())

        response = self.client.delete(f"/api/projects/{project_id}")
        self.assertEqual(response.status_code, 204)
        self.assertFalse((Path(self.temp_dir.name) / "projects" / "測試專案").exists())

    def test_ocr_project_gets_internal_text_label(self):
        response = self.client.post("/api/projects", json={
            "name": "OCR 專案", "primaryMode": "ocr", "labels": [],
        })
        self.assertEqual(response.status_code, 201)
        project = response.get_json()
        self.assertEqual(project["primaryMode"], "ocr")
        self.assertEqual(project["schema_version"], "1.0")
        self.assertEqual(project["labels"][0]["id"], "ocr-text")
        self.assertEqual(project["labels"][0]["attributes"][0]["id"], "transcription")

        source_dir = Path(self.temp_dir.name) / "source"
        source_dir.mkdir()
        source_image = source_dir / "invoice.png"
        Image.new("RGB", (200, 100), "white").save(source_image)
        project_path = self.app_module.project_dir(project["id"])
        records = self.app_module.register_source_images(project_path, [source_image])
        self.assertEqual(len(records), 1)
        copied_image = project_path / "images" / "invoice.png"
        self.assertEqual(records[0]["sourcePath"], str(copied_image.resolve()))
        self.assertTrue(copied_image.is_file())
        self.assertEqual(records[0]["projectRelativePath"], "images/invoice.png")

        response = self.client.put(f"/api/projects/{project['id']}/images/{records[0]['id']}/annotation", json={
            "annotations": [{
                "id": str(uuid.uuid4()), "mode": "ocr", "label_id": "ocr-text",
                "geometry": {"points": [[1, 2], [10, 2], [10, 8], [1, 8]]},
                "attributes": {"transcription": "測試文字"}, "metadata": {},
            }],
            "classifications": [], "revision": 0,
        })
        self.assertEqual(response.status_code, 200)
        self.assertFalse((project_path / "exports").exists())

    def test_yolo_detection_and_segmentation_exports(self):
        source_image = Path(self.temp_dir.name) / "source.png"
        Image.new("RGB", (100, 200), "white").save(source_image)
        cases = [
            ("rectangle", [{"x": 10, "y": 20}, {"x": 50, "y": 100}], "0 0.300000 0.300000 0.400000 0.400000\n"),
            ("polygon", [{"x": 10, "y": 20}, {"x": 50, "y": 20}, {"x": 30, "y": 100}], "0 0.100000 0.100000 0.500000 0.100000 0.300000 0.500000\n"),
        ]
        for mode, points, expected in cases:
            with self.subTest(mode=mode):
                response = self.client.post("/api/projects", json={
                    "name": f"{mode} project", "primaryMode": mode,
                    "labels": [{"id": "object", "name": "物件", "color": "#ff0000", "attributes": []}],
                })
                project = response.get_json()
                project_path = self.app_module.project_dir(project["id"])
                image = self.app_module.register_source_images(project_path, [source_image])[0]
                response = self.client.put(f"/api/projects/{project['id']}/images/{image['id']}/annotation", json={
                    "annotations": [{"id": str(uuid.uuid4()), "mode": mode, "label_id": "object", "geometry": ({"x": 10, "y": 20, "width": 40, "height": 80} if mode == "rectangle" else {"polygons": [[[point["x"], point["y"]] for point in points]]}), "attributes": {}, "metadata": {}}],
                    "classifications": [], "revision": 0,
                })
                self.assertEqual(response.status_code, 200)
                saved = response.get_json()["annotations"][0]
                self.assertEqual(saved["mode"], mode)
                self.assertFalse((project_path / "exports").exists())

    def test_classification_is_exclusive_and_uses_image_level_labels(self):
        project = self.client.post("/api/projects", json={
            "name": "分類專案", "primaryMode": "classification", "classificationMode": "multiple",
            "labels": [
                {"id": str(uuid.uuid4()), "name": "Rain", "color": "#00aaff"},
                {"id": "night", "name": "Night", "color": "#000033"},
            ],
        }).get_json()
        uuid.UUID(project["id"])
        self.assertEqual(project["primaryMode"], "classification")
        self.assertEqual([label["id"] for label in project["labels"]], ["rain", "night"])

        source = Path(self.temp_dir.name) / "classification.png"
        Image.new("RGB", (90, 60), "white").save(source)
        directory = self.app_module.project_dir(project["id"])
        image = self.app_module.register_source_images(directory, [source])[0]
        uuid.UUID(image["id"])
        response = self.client.put(f"/api/projects/{project['id']}/images/{image['id']}/annotation", json={
            "annotations": [{"id": str(uuid.uuid4()), "type": "rectangle", "points": [{"x": 1, "y": 1}, {"x": 2, "y": 2}]}],
            "classifications": [{"label_id": "rain"}, {"label_id": "night"}],
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["schema_version"], "1.0")
        self.assertEqual(data["annotations"], [])
        self.assertEqual(data["classifications"], [{"label_id": "rain"}, {"label_id": "night"}])
        uuid.UUID(data["media"]["id"])

        single = self.client.put(f"/api/projects/{project['id']}", json={"classificationMode": "single"}).get_json()
        self.assertEqual(single["classificationMode"], "single")
        rejected = self.client.put(f"/api/projects/{project['id']}/images/{image['id']}/annotation", json={
            "classifications": [{"label_id": "rain"}, {"label_id": "night"}],
        })
        self.assertEqual(rejected.status_code, 400)

    def test_all_eight_primary_modes_are_supported(self):
        modes = {"rectangle", "polygon", "ocr", "rotated_rectangle", "semantic_segmentation", "instance_segmentation", "reid", "classification"}
        for mode in modes:
            with self.subTest(mode=mode):
                response = self.client.post("/api/projects", json={"name": mode, "primaryMode": mode, "labels": []})
                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.get_json()["primaryMode"], mode)

    def test_second_stage_segmentation_and_reid_exports(self):
        source_image = Path(self.temp_dir.name) / "second-stage.png"
        Image.new("RGB", (64, 48), "white").save(source_image)
        label = {"id": "person", "name": "人物", "color": "#ff0000", "attributes": []}
        for mode in ("semantic_segmentation", "instance_segmentation", "reid"):
            with self.subTest(mode=mode):
                project = self.client.post("/api/projects", json={"name": mode, "primaryMode": mode, "labels": [label]}).get_json()
                directory = self.app_module.project_dir(project["id"])
                image = self.app_module.register_source_images(directory, [source_image])[0]
                annotation = {
                    "id": str(uuid.uuid4()), "mode": mode, "label_id": "person", "attributes": {},
                    "geometry": {"x": 4, "y": 4, "width": 28, "height": 20} if mode == "reid" else {"polygons": [[[4, 4], [32, 4], [32, 24]]]},
                    "metadata": {"identity_id": "person-1", "track_id": "track-1", "camera_id": "cam-1", "frame_id": 1},
                }
                response = self.client.put(f"/api/projects/{project['id']}/images/{image['id']}/annotation", json={"annotations": [annotation], "completed": True})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.get_json()["completed"])
                saved = response.get_json()["annotations"][0]
                self.assertNotIn("instanceId", saved)
                if mode == "reid":
                    self.assertEqual(saved.get("identity_id"), "person-1")
                    self.assertEqual(saved.get("track_id"), "track-1")
                    self.assertTrue({"identity_id", "track_id", "camera_id", "video_id", "frame_id"}.issubset(saved))
                    self.assertNotIn("identity_id", saved["metadata"])
                    self.assertNotIn("track_id", saved["metadata"])
                self.assertFalse((directory / "exports").exists())


if __name__ == "__main__":
    unittest.main()
