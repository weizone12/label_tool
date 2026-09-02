from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import uuid
import base64
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file
from flask_cors import CORS
from PIL import Image


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("LABEL_TOOL_DATA_DIR", BASE_DIR / "data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
ALLOWED_IMAGES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
ALLOWED_VIDEOS = {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"}
ALLOWED_MEDIA = ALLOWED_IMAGES | ALLOWED_VIDEOS
SUPPORTED_MODES = {"rectangle", "polygon", "ocr", "rotated_rectangle", "semantic_segmentation", "instance_segmentation", "reid", "classification"}

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": ["http://127.0.0.1:5173", "http://localhost:5173"]}})


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    migrate_project_directories()


def safe_project_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return cleaned or "untitled-project"


def available_project_directory(name: str, current: Path | None = None) -> Path:
    base = safe_project_name(name)
    candidate = PROJECTS_DIR / base
    sequence = 2
    while candidate.exists() and candidate != current:
        candidate = PROJECTS_DIR / f"{base} ({sequence})"
        sequence += 1
    return candidate


def migrate_project_directories() -> None:
    for directory in list(PROJECTS_DIR.iterdir()):
        config_path = directory / "project.json"
        if not directory.is_dir() or not config_path.exists():
            continue
        config = read_json(config_path, {})
        desired = available_project_directory(config.get("name", directory.name), current=directory)
        if directory != desired:
            directory.rename(desired)


def project_dir(project_id: str) -> Path:
    try:
        normalized = str(uuid.UUID(project_id))
    except ValueError:
        abort(404, "找不到專案")
    for path in PROJECTS_DIR.iterdir():
        if not path.is_dir():
            continue
        config = read_json(path / "project.json", {})
        if config.get("id") == normalized:
            return path
    abort(404, "找不到專案")


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def normalize_project(config: dict, directory: Path) -> dict:
    changed = False
    if config.get("primaryMode") not in SUPPORTED_MODES:
        config["primaryMode"] = "rectangle"
        changed = True
    if config.get("schema_version") != "1.0":
        config["schema_version"] = "1.0"
        changed = True
    config.setdefault("classificationMode", "multiple")
    if config["primaryMode"] == "reid" and config.get("mediaType") != "both":
        config["mediaType"] = "both"
        changed = True
    if config["primaryMode"] == "ocr" and not any(label.get("id") == "ocr-text" for label in config.get("labels", [])):
        config.setdefault("labels", []).insert(0, {
            "id": "ocr-text", "name": "文字", "color": "#22d3ee", "system": True,
            "attributes": [{"id": "transcription", "name": "辨識文字", "type": "text", "system": True}],
        })
        changed = True
    used_ids = set()
    id_map = {}
    for index, label in enumerate(config.get("labels", []), 1):
        original_id = str(label.get("id", ""))
        candidate = original_id
        try:
            uuid.UUID(candidate)
            candidate = ""
        except ValueError:
            pass
        source = candidate or str(label.get("name", ""))
        base = re.sub(r"[^\w-]+", "-", source.strip().lower(), flags=re.UNICODE).strip("-_") or f"label-{index}"
        label_id = base
        sequence = 2
        while label_id in used_ids:
            label_id = f"{base}-{sequence}"
            sequence += 1
        used_ids.add(label_id)
        id_map[original_id] = label_id
        if original_id != label_id:
            label["id"] = label_id
            changed = True
    for annotation_path in (directory / "annotations").glob("*.json"):
        data = read_json(annotation_path, {})
        if config["primaryMode"] == "classification":
            classifications = normalized_classifications(data.get("classifications", []), used_ids, id_map)
            if config.get("classificationMode") == "single":
                classifications = classifications[:1]
            data["annotations"] = []
            data["classifications"] = classifications
        else:
            data["annotations"] = normalized_annotations(data.get("annotations", []), config["primaryMode"], used_ids, id_map)
            data["classifications"] = []
        write_json_atomic(annotation_path, data)
    if changed:
        write_json_atomic(directory / "project.json", config)
    return config


def load_project(project_id: str):
    directory = project_dir(project_id)
    return normalize_project(read_json(directory / "project.json"), directory)


def project_allows_videos(project: dict) -> bool:
    return project.get("primaryMode") == "reid"


def image_record(path: Path, image_id: str | None = None) -> dict:
    try:
        with Image.open(path) as image:
            width, height = image.size
    except Exception:
        width, height = (1280, 720) if path.suffix.lower() in ALLOWED_VIDEOS else (0, 0)
    return {
        "id": image_id or path.stem,
        "filename": path.name,
        "width": width,
        "height": height,
        "mediaType": "video" if path.suffix.lower() in ALLOWED_VIDEOS else "image",
    }


def image_metadata(directory: Path) -> dict:
    return read_json(directory / "images.json", {}) or {}


def source_image_id(path: Path) -> str:
    normalized = os.path.normcase(str(path.resolve()))
    return str(uuid.uuid5(uuid.NAMESPACE_URL, normalized))


def safe_media_relative_path(value: str | Path) -> Path:
    raw = Path(value)
    parts = []
    for part in raw.parts:
        if part in ("", ".", "..", raw.anchor):
            continue
        cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", part).strip(" .")
        if cleaned:
            parts.append(cleaned)
    return Path(*parts) if parts else Path("unnamed-media")


def available_media_target(images_dir: Path, relative: Path) -> Path:
    candidate = images_dir / relative
    sequence = 2
    while candidate.exists():
        candidate = images_dir / relative.with_name(f"{relative.stem} ({sequence}){relative.suffix}")
        sequence += 1
    return candidate


def project_media_path(item: dict, fallback: str) -> str:
    stored = item.get("storedRelativePath") or item.get("relativePath") or fallback
    return (Path("images") / safe_media_relative_path(stored)).as_posix()


def copy_media_into_project(directory: Path, source: Path, relative: Path, existing: dict | None = None) -> tuple[Path, dict]:
    images_dir = directory / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    existing = existing or {}
    stored = existing.get("storedRelativePath")
    if stored:
        existing_target = (images_dir / safe_media_relative_path(stored)).resolve()
        if existing_target.is_file():
            target = existing_target
        else:
            target = available_media_target(images_dir, safe_media_relative_path(relative))
    else:
        target = available_media_target(images_dir, safe_media_relative_path(relative))
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.resolve() != target.resolve() and not target.exists():
        shutil.copy2(source, target)
    stored_relative = target.resolve().relative_to(images_dir.resolve())
    metadata = {
        "sourcePath": str(target.resolve()),
        "originalFilename": source.name,
        "relativePath": str(relative),
        "storedRelativePath": str(stored_relative),
        "projectRelativePath": (Path("images") / stored_relative).as_posix(),
    }
    return target, metadata


def register_source_images(directory: Path, paths: list[Path], root: Path | None = None) -> list[dict]:
    metadata = image_metadata(directory)
    registered = []
    for source in paths:
        source = source.resolve()
        if not source.is_file() or source.suffix.lower() not in ALLOWED_MEDIA:
            continue
        image_id = source_image_id(source)
        relative_path = source.name
        if root:
            try:
                relative_path = str(source.relative_to(root.resolve()))
            except ValueError:
                pass
        target, stored_metadata = copy_media_into_project(directory, source, Path(relative_path), metadata.get(image_id))
        metadata[image_id] = stored_metadata
        record = image_record(target, image_id)
        record.update(metadata[image_id])
        registered.append(record)
    write_json_atomic(directory / "images.json", metadata)
    project = read_json(directory / "project.json", {})
    project["imageCount"] = len(list_image_records(directory))
    project["updatedAt"] = utc_now()
    write_json_atomic(directory / "project.json", project)
    return registered


def list_image_records(directory: Path) -> list[dict]:
    metadata = image_metadata(directory)
    records = []
    linked_paths = set()
    metadata_changed = False
    images_dir = (directory / "images").resolve()
    for image_id, item in metadata.items():
        source_path = item.get("sourcePath")
        if not source_path:
            continue
        source = Path(source_path)
        if not source.is_file() or source.suffix.lower() not in ALLOWED_MEDIA:
            continue
        try:
            source.resolve().relative_to(images_dir)
            stored_source = source.resolve()
        except ValueError:
            relative = Path(item.get("relativePath") or item.get("originalFilename") or source.name)
            stored_source, stored_metadata = copy_media_into_project(directory, source, relative, item)
            item.clear()
            item.update(stored_metadata)
            metadata_changed = True
        record = image_record(stored_source, image_id)
        record.update(item)
        annotation = read_json(directory / "annotations" / f"{image_id}.json", {})
        record["completed"] = bool(annotation.get("completed", False))
        record["annotationCount"] = len(annotation.get("annotations", []))
        records.append(record)
        linked_paths.add(stored_source.resolve())
    if metadata_changed:
        write_json_atomic(directory / "images.json", metadata)
    images_dir = directory / "images"
    if images_dir.exists():
        for path in images_dir.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in ALLOWED_MEDIA or path.resolve() in linked_paths:
                continue
            record = image_record(path)
            record.update(metadata.get(record["id"], {}))
            annotation = read_json(directory / "annotations" / f"{record['id']}.json", {})
            record["completed"] = bool(annotation.get("completed", False))
            record["annotationCount"] = len(annotation.get("annotations", []))
            records.append(record)
    records.sort(key=lambda item: (item.get("originalFilename") or item["filename"]).lower())
    return records


def run_windows_picker(kind: str, include_videos: bool = False) -> list[Path]:
    if os.name != "nt":
        raise RuntimeError("Windows 原生選擇視窗僅支援 Windows")
    common = """
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0.01
$owner.Location = New-Object System.Drawing.Point([int]($workingArea.Left + ($workingArea.Width / 2)), [int]($workingArea.Top + ($workingArea.Height / 2)))
$owner.Show()
$owner.Activate()
[System.Windows.Forms.Application]::DoEvents()
"""
    if kind == "files":
        media_filter = "Image and video files|*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.tif;*.tiff;*.mp4;*.webm;*.mov;*.m4v;*.avi;*.mkv" if include_videos else "Image files|*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.tif;*.tiff"
        picker = """
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $true
$dialog.Filter = '__MEDIA_FILTER__|All files|*.*'
$dialog.RestoreDirectory = $true
$dialog.Title = 'Select source files'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    @($dialog.FileNames) | ConvertTo-Json -Compress
} else { '[]' }
$owner.Close()
""".replace("__MEDIA_FILTER__", media_filter)
    else:
        picker = """
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select an image folder'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    @($dialog.SelectedPath) | ConvertTo-Json -Compress
} else { '[]' }
$owner.Close()
"""
    encoded = base64.b64encode((common + picker).encode("utf-16le")).decode("ascii")
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-STA", "-EncodedCommand", encoded],
        capture_output=True, timeout=3600, check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(message or "無法開啟 Windows 選擇視窗")
    output = completed.stdout.decode("utf-8-sig", errors="replace").strip()
    if not output:
        return []
    selected = json.loads(output.splitlines()[-1])
    if isinstance(selected, str):
        selected = [selected]
    return [Path(item) for item in selected]


def normalized(value: float, extent: int) -> float:
    if extent <= 0:
        return 0.0
    return max(0.0, min(1.0, float(value) / extent))


def yolo_number(value: float) -> str:
    return f"{value:.6f}"


def export_label_path(exports_dir: Path, record: dict) -> Path:
    relative = Path(record.get("relativePath") or record.get("originalFilename") or record["filename"])
    safe_parts = [part for part in relative.parts if part not in ("", ".", "..", relative.anchor)]
    safe_relative = Path(*safe_parts) if safe_parts else Path(record["id"])
    return (exports_dir / "labels" / safe_relative).with_suffix(".txt")


def export_annotations(directory: Path, project: dict, image_id: str) -> None:
    exports_dir = directory / "exports"
    records = {record["id"]: record for record in list_image_records(directory)}
    if project.get("primaryMode") == "classification":
        return
    if project.get("primaryMode") == "ocr":
        lines = []
        for record in sorted(records.values(), key=lambda item: (item.get("originalFilename") or item["filename"]).lower()):
            annotation_data = read_json(directory / "annotations" / f"{record['id']}.json", {"annotations": []})
            items = []
            for annotation in annotation_data.get("annotations", []):
                if annotation.get("type") != "ocr" or len(annotation.get("points", [])) != 4:
                    continue
                items.append({
                    "transcription": str(annotation.get("attributes", {}).get("transcription", "")),
                    "points": [[point["x"], point["y"]] for point in annotation["points"]],
                })
            serialized = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
            lines.append(f"{project_media_path(record, record['filename'])}\t{serialized}")
        write_text_atomic(exports_dir / "ocr_annotations.txt", "\n".join(lines) + ("\n" if lines else ""))
        return

    labels = [label for label in project.get("labels", []) if not label.get("system")]
    class_ids = {label["id"]: index for index, label in enumerate(labels)}
    write_text_atomic(exports_dir / "classes.txt", "\n".join(label["name"] for label in labels) + ("\n" if labels else ""))
    record = records.get(image_id)
    if not record:
        return
    annotation_data = read_json(directory / "annotations" / f"{image_id}.json", {"annotations": []})
    width, height = int(record.get("width", 0)), int(record.get("height", 0))
    output_lines = []
    coco_items = []
    for annotation in annotation_data.get("annotations", []):
        class_id = class_ids.get(annotation.get("labelId"))
        points = annotation.get("points", [])
        if class_id is None:
            continue
        if annotation.get("type") == "rectangle" and len(points) == 2:
            x1, y1 = points[0]["x"], points[0]["y"]
            x2, y2 = points[1]["x"], points[1]["y"]
            values = [
                normalized((x1 + x2) / 2, width), normalized((y1 + y2) / 2, height),
                normalized(abs(x2 - x1), width), normalized(abs(y2 - y1), height),
            ]
        elif annotation.get("type") in {"polygon", "semantic_segmentation", "instance_segmentation"} and len(points) >= 3:
            values = [coordinate for point in points for coordinate in (normalized(point["x"], width), normalized(point["y"], height))]
            if annotation.get("type") == "instance_segmentation":
                coco_items.append({
                    "id": annotation.get("instanceId") or annotation.get("id"), "image_id": image_id,
                    "category_id": class_id, "segmentation": [[coordinate for point in points for coordinate in (point["x"], point["y"])]] ,
                    "iscrowd": 0,
                })
        elif annotation.get("type") == "rotated_rectangle" and len(points) == 4:
            values = [coordinate for point in points for coordinate in (normalized(point["x"], width), normalized(point["y"], height))]
        else:
            continue
        output_lines.append(" ".join([str(class_id), *(yolo_number(value) for value in values)]))
    write_text_atomic(export_label_path(exports_dir, record), "\n".join(output_lines) + ("\n" if output_lines else ""))
    if project.get("primaryMode") == "semantic_segmentation" and width > 0 and height > 0:
        mask = Image.new("P", (width, height), 0)
        palette = [0, 0, 0]
        for label in labels:
            color = label.get("color", "#000000").lstrip("#")
            try: palette.extend([int(color[i:i + 2], 16) for i in (0, 2, 4)])
            except ValueError: palette.extend([255, 255, 255])
        palette.extend([0] * (768 - len(palette)))
        mask.putpalette(palette[:768])
        from PIL import ImageDraw
        drawer = ImageDraw.Draw(mask)
        for annotation in annotation_data.get("annotations", []):
            class_id = class_ids.get(annotation.get("labelId"))
            if annotation.get("type") == "semantic_segmentation" and class_id is not None and len(annotation.get("points", [])) >= 3:
                drawer.polygon([(point["x"], point["y"]) for point in annotation["points"]], fill=class_id + 1)
        mask_path = (exports_dir / "masks" / Path(record.get("relativePath") or record["filename"])).with_suffix(".png")
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        mask.save(mask_path)
    if project.get("primaryMode") == "instance_segmentation":
        write_json_atomic(exports_dir / "instances" / f"{image_id}.json", {
            "image": {"id": image_id, "file_name": project_media_path(record, record["filename"]), "width": width, "height": height},
            "categories": [{"id": index, "name": label["name"]} for index, label in enumerate(labels)],
            "annotations": coco_items,
        })
    if project.get("primaryMode") == "reid":
        rows = []
        for annotation in annotation_data.get("annotations", []):
            if annotation.get("type") != "reid" or len(annotation.get("points", [])) != 2:
                continue
            a, b = annotation["points"]
            rows.append({"image": project_media_path(record, record["filename"]), "identity": annotation.get("identity", ""), "trackId": annotation.get("trackId", ""), "frame": annotation.get("frame"), "bbox": [min(a["x"], b["x"]), min(a["y"], b["y"]), abs(b["x"] - a["x"]), abs(b["y"] - a["y"])]})
        write_json_atomic(exports_dir / "reid" / f"{image_id}.json", rows)


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/api/projects")
def list_projects():
    ensure_dirs()
    projects = []
    for config_path in PROJECTS_DIR.glob("*/project.json"):
        config = read_json(config_path, {})
        if config:
            projects.append(normalize_project(config, config_path.parent))
    projects.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
    return jsonify(projects)


@app.post("/api/projects")
def create_project():
    ensure_dirs()
    body = request.get_json(force=True)
    name = str(body.get("name", "")).strip()
    primary_mode = body.get("primaryMode")
    if not name:
        return jsonify({"error": "專案名稱不可為空"}), 400
    if primary_mode not in SUPPORTED_MODES:
        return jsonify({"error": "請選擇有效的標註方式"}), 400
    classification_mode = body.get("classificationMode", "multiple")
    if classification_mode not in {"single", "multiple"}:
        return jsonify({"error": "請選擇有效的圖片分類模式"}), 400
    project_id = str(uuid.uuid4())
    directory = available_project_directory(name)
    (directory / "images").mkdir(parents=True)
    (directory / "annotations").mkdir(parents=True)
    now = utc_now()
    labels = body.get("labels", [])
    if primary_mode == "ocr" and not any(label.get("id") == "ocr-text" for label in labels):
        labels = [{
            "id": "ocr-text", "name": "文字", "color": "#22d3ee", "system": True,
            "attributes": [{"id": "transcription", "name": "辨識文字", "type": "text", "system": True}],
        }, *labels]
    if primary_mode == "classification":
        used_ids = set()
        normalized_labels = []
        for index, label in enumerate(labels, 1):
            supplied_id = str(label.get("id", ""))
            try:
                uuid.UUID(supplied_id)
                supplied_id = ""
            except ValueError:
                pass
            base = re.sub(r"[^\w-]+", "-", (supplied_id or str(label.get("name", ""))).strip().lower(), flags=re.UNICODE).strip("-_") or f"label-{index}"
            label_id = base
            sequence = 2
            while label_id in used_ids:
                label_id = f"{base}-{sequence}"
                sequence += 1
            used_ids.add(label_id)
            normalized_labels.append({"id": label_id, "name": str(label.get("name", label_id)).strip(), "color": label.get("color", "#fb7185")})
        labels = normalized_labels
    project = {
        "schema_version": "1.0",
        "id": project_id,
        "name": name,
        "primaryMode": primary_mode,
        "labels": labels,
        "classificationMode": classification_mode,
        "mediaType": "both" if primary_mode == "reid" else "image",
        "createdAt": now,
        "updatedAt": now,
        "imageCount": 0,
    }
    write_json_atomic(directory / "project.json", project)
    return jsonify(normalize_project(project, directory)), 201


@app.get("/api/projects/<project_id>")
def get_project(project_id: str):
    return jsonify(load_project(project_id))


def value_is_used(value) -> bool:
    return value is not None and value != "" and value != [] and value != {}


def validate_label_deletions(directory: Path, old_labels: list[dict], new_labels: list[dict]) -> str | None:
    documents = [read_json(path, {}) for path in (directory / "annotations").glob("*.json")]
    new_by_id = {str(label.get("id")): label for label in new_labels}
    for label in old_labels:
        label_id = str(label.get("id"))
        if label_id not in new_by_id:
            count = sum(
                sum(1 for item in document.get("annotations", []) if item.get("label_id") == label_id)
                + sum(1 for item in document.get("classifications", []) if item.get("label_id") == label_id)
                for document in documents
            )
            if count:
                return f"Label「{label.get('name', label_id)}」仍被 {count} 筆標註使用，無法刪除"
            continue
        new_attribute_ids = {str(attribute.get("id")) for attribute in new_by_id[label_id].get("attributes", [])}
        for attribute in label.get("attributes", []):
            attribute_id = str(attribute.get("id"))
            if attribute_id in new_attribute_ids:
                continue
            count = sum(
                1
                for document in documents
                for item in document.get("annotations", [])
                if item.get("label_id") == label_id and value_is_used(item.get("attributes", {}).get(attribute_id))
            )
            if count:
                return f"屬性「{attribute.get('name', attribute_id)}」仍被 {count} 筆標註使用，無法刪除"
    return None


@app.put("/api/projects/<project_id>")
def update_project(project_id: str):
    directory = project_dir(project_id)
    existing = read_json(directory / "project.json", {})
    body = request.get_json(force=True)
    old_name = existing.get("name")
    if "labels" in body:
        if not isinstance(body["labels"], list):
            return jsonify({"error": "labels 必須是陣列"}), 400
        conflict = validate_label_deletions(directory, existing.get("labels", []), body["labels"])
        if conflict:
            return jsonify({"error": conflict}), 400
    for field in ("name", "primaryMode", "labels", "classificationMode", "mediaType"):
        if field in body:
            existing[field] = body[field]
    if existing.get("primaryMode") not in SUPPORTED_MODES:
        return jsonify({"error": "請選擇有效的標註方式"}), 400
    if existing.get("classificationMode") not in {"single", "multiple"}:
        return jsonify({"error": "請選擇有效的圖片分類模式"}), 400
    existing["updatedAt"] = utc_now()
    write_json_atomic(directory / "project.json", existing)
    existing = normalize_project(existing, directory)
    if existing.get("name") != old_name:
        target = available_project_directory(existing["name"], current=directory)
        if target != directory:
            directory.rename(target)
    return jsonify(existing)


@app.get("/api/projects/<project_id>/images")
def list_images(project_id: str):
    directory = project_dir(project_id)
    return jsonify(list_image_records(directory))


@app.post("/api/projects/<project_id>/images/select-files")
def select_image_files(project_id: str):
    try:
        project = load_project(project_id)
        paths = run_windows_picker("files", project_allows_videos(project))
        return jsonify({"paths": [str(path.resolve()) for path in paths], "root": None})
    except (RuntimeError, json.JSONDecodeError) as error:
        return jsonify({"error": str(error)}), 500


@app.post("/api/projects/<project_id>/images/select-folder")
def select_image_folder(project_id: str):
    try:
        selected = run_windows_picker("folder")
        if not selected:
            return jsonify({"paths": [], "root": None})
        root = selected[0].resolve()
        project = load_project(project_id)
        allowed = ALLOWED_MEDIA if project_allows_videos(project) else ALLOWED_IMAGES
        paths = [path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in allowed]
        return jsonify({"paths": [str(path.resolve()) for path in paths], "root": str(root)})
    except (RuntimeError, json.JSONDecodeError, OSError) as error:
        return jsonify({"error": str(error)}), 500


@app.post("/api/projects/<project_id>/images/register-paths")
def register_image_paths(project_id: str):
    directory = project_dir(project_id)
    body = request.get_json(force=True)
    raw_paths = body.get("paths", [])
    if not isinstance(raw_paths, list):
        return jsonify({"error": "paths 必須是陣列"}), 400
    project = load_project(project_id)
    allowed = ALLOWED_MEDIA if project_allows_videos(project) else ALLOWED_IMAGES
    paths = [Path(value).resolve() for value in raw_paths if isinstance(value, str)]
    paths = [path for path in paths if path.is_file() and path.suffix.lower() in allowed]
    root_value = body.get("root")
    root = Path(root_value).resolve() if isinstance(root_value, str) and root_value else None
    return jsonify(register_source_images(directory, paths, root))


@app.post("/api/projects/<project_id>/images")
def upload_images(project_id: str):
    directory = project_dir(project_id)
    images_dir = directory / "images"
    uploaded = []
    metadata = image_metadata(directory)
    project = load_project(project_id)
    allowed = ALLOWED_MEDIA if project_allows_videos(project) else ALLOWED_IMAGES

    for file in request.files.getlist("files"):
        raw_filename = str(file.filename or "").replace("\\", "/")
        original_filename = Path(raw_filename).name
        relative_path = safe_media_relative_path(raw_filename)
        if relative_path.suffix.lower() not in allowed:
            continue

        image_id = str(uuid.uuid4())
        target = available_media_target(images_dir, relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        file.save(target)

        stored_relative = target.resolve().relative_to(images_dir.resolve())
        metadata[image_id] = {
            "sourcePath": str(target.resolve()),
            "originalFilename": original_filename,
            "relativePath": str(relative_path),
            "storedRelativePath": str(stored_relative),
            "projectRelativePath": (Path("images") / stored_relative).as_posix(),
        }
        record = image_record(target, image_id)
        record.update(metadata[image_id])
        uploaded.append(record)

    write_json_atomic(directory / "images.json", metadata)
    project = read_json(directory / "project.json", {})
    project["imageCount"] = len(list_image_records(directory))
    project["updatedAt"] = utc_now()
    write_json_atomic(directory / "project.json", project)
    
    return jsonify(uploaded), 201


def resolve_image(project_id: str, image_id: str) -> Path:
    directory = project_dir(project_id)
    metadata = image_metadata(directory)
    source_path = metadata.get(image_id, {}).get("sourcePath")
    if source_path:
        source = Path(source_path)
        if source.is_file() and source.suffix.lower() in ALLOWED_MEDIA:
            return source
        abort(404, "來源圖片不存在或已移動")
    images_dir = directory / "images"
    matches = [path for path in images_dir.glob(f"{image_id}.*") if path.suffix.lower() in ALLOWED_MEDIA]
    if not matches:
        abort(404, "找不到圖片")
    return matches[0]


def annotation_media(directory: Path, image_id: str) -> dict:
    record = next((item for item in list_image_records(directory) if item["id"] == image_id), None)
    if not record:
        abort(404, "找不到圖片")
    return {
        "id": image_id,
        "type": record.get("mediaType", "image"),
        "file_name": record.get("originalFilename") or record.get("filename", ""),
        "width": int(record.get("width", 0)),
        "height": int(record.get("height", 0)),
        "source_path": record.get("sourcePath") or str((directory / record.get("projectRelativePath", "")).resolve()),
    }


def normalized_classifications(items, valid_ids: set[str], id_map: dict[str, str] | None = None) -> list[dict]:
    result = []
    seen = set()
    id_map = id_map or {}
    for item in items if isinstance(items, list) else []:
        label_id = str(item.get("label_id", "")) if isinstance(item, dict) else str(item)
        label_id = id_map.get(label_id, label_id)
        if label_id in valid_ids and label_id not in seen:
            result.append({"label_id": label_id})
            seen.add(label_id)
    return result


def normalized_annotations(items, expected_mode: str, valid_ids: set[str] | None = None, id_map: dict[str, str] | None = None) -> list[dict]:
    result = []
    id_map = id_map or {}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        mode = item.get("mode") or item.get("type")
        if mode != expected_mode:
            continue
        label_id = str(item.get("label_id") or item.get("labelId") or "")
        label_id = id_map.get(label_id, label_id)
        if valid_ids is not None and label_id not in valid_ids:
            continue
        geometry = item.get("geometry") if isinstance(item.get("geometry"), dict) else None
        legacy_points = item.get("points", [])
        if geometry is None and mode in {"rectangle", "reid"} and len(legacy_points) == 2:
            a, b = legacy_points
            geometry = {
                "x": min(float(a["x"]), float(b["x"])),
                "y": min(float(a["y"]), float(b["y"])),
                "width": abs(float(b["x"]) - float(a["x"])),
                "height": abs(float(b["y"]) - float(a["y"])),
            }
        elif geometry is None and mode in {"polygon", "semantic_segmentation", "instance_segmentation"}:
            geometry = {"polygons": [[[float(point["x"]), float(point["y"])] for point in legacy_points]]}
        elif geometry is None and mode in {"ocr", "rotated_rectangle"}:
            geometry = {"points": [[float(point["x"]), float(point["y"])] for point in legacy_points]}
        if not isinstance(geometry, dict):
            continue
        metadata = dict(item.get("metadata", {})) if isinstance(item.get("metadata"), dict) else {}
        for old_key, new_key in (("createdAt", "created_at"),):
            if old_key in item and new_key not in metadata:
                metadata[new_key] = item[old_key]
        for key in ("hidden", "locked", "keyframe"):
            if key in item and key not in metadata:
                metadata[key] = item[key]
        annotation = {
            "id": item.get("id"),
            "mode": mode,
            "label_id": label_id,
            "geometry": geometry,
            "attributes": item.get("attributes", {}) if isinstance(item.get("attributes"), dict) else {},
            "metadata": metadata,
        }
        if mode == "reid":
            legacy_names = {
                "identity_id": "identity",
                "track_id": "trackId",
                "camera_id": "cameraId",
                "video_id": "videoId",
                "frame_id": "frame",
            }
            for field, legacy_field in legacy_names.items():
                value = item.get(field, item.get(legacy_field, metadata.pop(field, None)))
                if field != "identity_id" and value == "":
                    value = None
                annotation[field] = value
        try:
            annotation["id"] = str(uuid.UUID(str(annotation.get("id", ""))))
        except ValueError:
            annotation["id"] = str(uuid.uuid4())
        result.append(annotation)
    return result


@app.get("/api/projects/<project_id>/images/<image_id>/content")
def get_image(project_id: str, image_id: str):
    return send_file(resolve_image(project_id, image_id))


@app.get("/api/projects/<project_id>/images/<image_id>/annotation")
def get_annotation(project_id: str, image_id: str):
    resolve_image(project_id, image_id)
    directory = project_dir(project_id)
    project = load_project(project_id)
    path = directory / "annotations" / f"{image_id}.json"
    stored = read_json(path, {})
    is_classification = project["primaryMode"] == "classification"
    valid_ids = {label["id"] for label in project.get("labels", [])}
    payload = {
        "schema_version": "1.0",
        "media": annotation_media(directory, image_id),
        "annotations": [] if is_classification else normalized_annotations(stored.get("annotations", []), project["primaryMode"], valid_ids),
        "classifications": normalized_classifications(stored.get("classifications", []), valid_ids) if is_classification else [],
        "completed": bool(stored.get("completed", False)),
        "revision": int(stored.get("revision", 0)),
    }
    if stored.get("updatedAt"):
        payload["updatedAt"] = stored["updatedAt"]
    return jsonify(payload)


@app.put("/api/projects/<project_id>/images/<image_id>/annotation")
def save_annotation(project_id: str, image_id: str):
    resolve_image(project_id, image_id)
    directory = project_dir(project_id)
    project = load_project(project_id)
    body = request.get_json(force=True)
    is_classification = project["primaryMode"] == "classification"
    valid_ids = {label["id"] for label in project.get("labels", [])}
    classifications = normalized_classifications(body.get("classifications", []), valid_ids) if is_classification else []
    annotations = [] if is_classification else normalized_annotations(body.get("annotations", []), project["primaryMode"], valid_ids)
    if is_classification and project.get("classificationMode") == "single" and len(classifications) > 1:
        return jsonify({"error": "單一分類模式每張圖片最多只能選擇一個 label"}), 400
    payload = {
        "schema_version": "1.0",
        "media": annotation_media(directory, image_id),
        "annotations": annotations,
        "classifications": classifications,
        "completed": bool(body.get("completed", False)),
        "revision": int(body.get("revision", 0)) + 1,
        "updatedAt": utc_now(),
    }
    path = directory / "annotations" / f"{image_id}.json"
    write_json_atomic(path, payload)
    return jsonify(payload)


@app.delete("/api/projects/<project_id>")
def delete_project(project_id: str):
    directory = project_dir(project_id)
    shutil.rmtree(directory)
    return "", 204


if __name__ == "__main__":
    ensure_dirs()
    app.run(
        host="127.0.0.1",
        port=5001,
        debug=os.environ.get("LABEL_TOOL_DEBUG") == "1",
    )
