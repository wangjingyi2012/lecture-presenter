use serde::{Deserialize, Serialize};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, Emitter};
use reqwest;

const GITEE_KEYRING_SERVICE: &str = "Lecture Presenter";
const GITEE_KEYRING_USER: &str = "gitee-access-token";

#[derive(Default)]
struct PpteWatcherState {
    watchers: Mutex<HashMap<String, PpteWatcherEntry>>,
}

struct PpteWatcherEntry {
    _watcher: RecommendedWatcher,
    refs: usize,
}

#[derive(Serialize, Deserialize)]
struct UpdateInfo {
    has_update: bool,
    version: Option<String>,
    download_url: Option<String>,
    changelog: Option<String>,
    force_update: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct Notification {
    id: i32,
    title: String,
    content: String,
    #[serde(rename = "type")]
    notification_type: String,
    priority: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CourseEntry {
    pub id: String,
    pub path: String,
    pub label: String,
    #[serde(default, rename = "createdByApp", skip_serializing_if = "Option::is_none")]
    pub created_by_app: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RecentPpte {
    pub path: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub courses: Vec<CourseEntry>,
    #[serde(rename = "lastOpenedCourse")]
    pub last_opened_course: String,
    pub theme: String,
    #[serde(rename = "fontSize")]
    pub font_size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    #[serde(default, rename = "pythonPath", skip_serializing_if = "Option::is_none")]
    pub python_path: Option<String>,
    #[serde(default, rename = "recentPpte", skip_serializing_if = "Option::is_none")]
    pub recent_ppte: Option<Vec<RecentPpte>>,
    #[serde(default, rename = "aiProvider", skip_serializing_if = "Option::is_none")]
    pub ai_provider: Option<String>,
    #[serde(default, rename = "aiApiKey", skip_serializing_if = "Option::is_none")]
    pub ai_api_key: Option<String>,
    #[serde(default, rename = "aiBaseUrl", skip_serializing_if = "Option::is_none")]
    pub ai_base_url: Option<String>,
    #[serde(default, rename = "aiApiType", skip_serializing_if = "Option::is_none")]
    pub ai_api_type: Option<String>,
    #[serde(default, rename = "aiModel", skip_serializing_if = "Option::is_none")]
    pub ai_model: Option<String>,
    #[serde(default, rename = "updateServer", skip_serializing_if = "Option::is_none")]
    pub update_server: Option<String>,
    #[serde(default, rename = "authServer", skip_serializing_if = "Option::is_none")]
    pub auth_server: Option<String>,
    #[serde(default, rename = "notificationServer", skip_serializing_if = "Option::is_none")]
    pub notification_server: Option<String>,
    #[serde(default, rename = "membershipUrl", skip_serializing_if = "Option::is_none")]
    pub membership_url: Option<String>,
    #[serde(default, rename = "analyticsEndpoint", skip_serializing_if = "Option::is_none")]
    pub analytics_endpoint: Option<String>,
    #[serde(default, rename = "autoCheckUpdate", skip_serializing_if = "Option::is_none")]
    pub auto_check_update: Option<bool>,
}

fn get_config_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    Ok(app_data.join("app-config.json"))
}

#[tauri::command]
fn read_app_config(app_handle: tauri::AppHandle) -> Result<AppConfig, String> {
    let app_data_config = get_config_path(&app_handle)?;

    // 1. Already in app data dir
    if app_data_config.exists() {
        let content = fs::read_to_string(&app_data_config).map_err(|e| e.to_string())?;
        let mut config: AppConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        // Auto-inject built-in tutorial if not already present
        inject_builtin_course(&app_handle, &mut config);
        let updated = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        let _ = fs::write(&app_data_config, &updated);
        return Ok(config);
    }

    // 2. Bundled in resource dir
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let bundled = resource_dir.join("app-config.json");
        if bundled.exists() {
            let content = fs::read_to_string(&bundled).map_err(|e| e.to_string())?;
            let mut config: AppConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            inject_builtin_course(&app_handle, &mut config);
            let updated = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
            let _ = fs::write(&app_data_config, &updated);
            return Ok(config);
        }
    }

    // 3. Dev mode: next to project
    let dev_config = std::env::current_dir()
        .unwrap_or_default()
        .join("app-config.json");
    if dev_config.exists() {
        let content = fs::read_to_string(&dev_config).map_err(|e| e.to_string())?;
        let mut config: AppConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        inject_builtin_course(&app_handle, &mut config);
        let updated = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        let _ = fs::write(&app_data_config, &updated);
        return Ok(config);
    }

    Err("app-config.json not found".to_string())
}

/// Auto-inject the built-in tutorial course if it exists in resources and isn't already in config.
fn inject_builtin_course(app_handle: &tauri::AppHandle, config: &mut AppConfig) {
    let guide_id = "lecture-presenter-guide";

    // Check resource dir for bundled tutorial
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let guide_path = resource_dir.join("使用指南");
        if guide_path.join("course.json").exists() {
            // Always use forward slashes for cross-platform compatibility
            let path_str = guide_path.to_string_lossy().replace('\\', "/");
            if let Some(entry) = config.courses.iter_mut().find(|c| c.id == guide_id) {
                entry.path = path_str;
                entry.label = "演讲宝使用指南 — Lecture Presenter".to_string();
            } else {
                config.courses.insert(0, CourseEntry {
                    id: guide_id.to_string(),
                    path: path_str,
                    label: "演讲宝使用指南 — Lecture Presenter".to_string(),
                    created_by_app: None,
                });
            }
            // Set as default if no course is open
            if config.last_opened_course.is_empty() {
                config.last_opened_course = guide_id.to_string();
            }
            return;
        }
    }

    // Dev mode: check relative paths
    if !config.courses.iter().any(|c| c.id == guide_id) {
        let dev_paths = vec![
            std::env::current_dir().unwrap_or_default().join("../使用指南"),
            std::env::current_dir().unwrap_or_default().join("使用指南"),
        ];
        for p in dev_paths {
            if p.join("course.json").exists() {
                let resolved = p.canonicalize().unwrap_or(p.clone());
                let path_str = resolved.to_string_lossy().replace('\\', "/");
                // On Windows, canonicalize may add \\?\ prefix — strip it
                let path_str = path_str.strip_prefix("//?/").unwrap_or(&path_str).to_string();
                config.courses.insert(0, CourseEntry {
                    id: guide_id.to_string(),
                    path: path_str,
                    label: "演讲宝使用指南 — Lecture Presenter".to_string(),
                    created_by_app: None,
                });
                if config.last_opened_course.is_empty() {
                    config.last_opened_course = guide_id.to_string();
                }
                break;
            }
        }
    }
}

#[tauri::command]
fn read_course_config(course_path: String) -> Result<serde_json::Value, String> {
    // Normalize forward slashes to native separator for filesystem access
    let normalized = course_path.replace('/', std::path::MAIN_SEPARATOR_STR);
    let path = PathBuf::from(&normalized).join("course.json");
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))
}

#[tauri::command]
fn resolve_asset_path(course_path: String, relative_path: String) -> Result<String, String> {
    let normalized_course = course_path.replace('/', std::path::MAIN_SEPARATOR_STR);
    let normalized_rel = relative_path.replace('/', std::path::MAIN_SEPARATOR_STR);
    let full_path = PathBuf::from(&normalized_course).join(&normalized_rel);
    if full_path.exists() {
        // Return with forward slashes for cross-platform JS compatibility
        Ok(full_path.to_string_lossy().replace('\\', "/"))
    } else {
        Err(format!("File not found: {}", full_path.display()))
    }
}

#[tauri::command]
fn read_file_bytes(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| format!("Failed to read {}: {}", file_path, e))
}

#[tauri::command]
fn read_text_file(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path).map_err(|e| format!("Failed to read {}: {}", file_path, e))
}

fn normalize_protocol_path(decoded: &str) -> String {
    let path = decoded.replace('/', std::path::MAIN_SEPARATOR_STR);

    #[cfg(target_os = "windows")]
    {
        let trimmed = path.trim_start_matches(std::path::MAIN_SEPARATOR);
        if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
            return trimmed.to_string();
        }
    }

    if path.starts_with(std::path::MAIN_SEPARATOR) {
        path
    } else {
        format!("{}{}", std::path::MAIN_SEPARATOR, path)
    }
}

// Navigation/focus bridge injected into HTML served via slide://.
// Slide frames are cross-origin to the app window on macOS, so the frontend
// cannot install keyboard forwarding into them; this script runs inside the
// slide document instead and mirrors the same postMessage protocol.
const PPTE_SLIDE_BRIDGE: &str = include_str!("ppte-slide-bridge.js");

fn is_html_path(file_path: &str) -> bool {
    PathBuf::from(file_path)
        .extension()
        .map(|ext| {
            let ext = ext.to_string_lossy().to_lowercase();
            ext == "html" || ext == "htm"
        })
        .unwrap_or(false)
}

fn inject_slide_bridge(file_path: &str, mut content: Vec<u8>) -> Vec<u8> {
    if !is_html_path(file_path) {
        return content;
    }
    content.extend_from_slice(b"\n<script>");
    content.extend_from_slice(PPTE_SLIDE_BRIDGE.as_bytes());
    content.extend_from_slice(b"</script>\n");
    content
}

fn parse_range_header(range: &str, total_len: u64) -> Option<(u64, u64)> {
    let value = range.strip_prefix("bytes=")?;
    let (start_raw, end_raw) = value.split_once('-')?;

    if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<u64>().ok()?;
        if suffix_len == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix_len);
        let end = total_len.saturating_sub(1);
        return Some((start, end));
    }

    let start = start_raw.parse::<u64>().ok()?;
    if start >= total_len {
        return None;
    }

    let end = if end_raw.is_empty() {
        total_len.saturating_sub(1)
    } else {
        end_raw.parse::<u64>().ok()?.min(total_len.saturating_sub(1))
    };

    if end < start {
        None
    } else {
        Some((start, end))
    }
}

fn media_response(file_path: &str, range: Option<&str>) -> http::Response<Vec<u8>> {
    let mut file = match fs::File::open(file_path) {
        Ok(file) => file,
        Err(e) => {
            eprintln!("[media://] File not found: {} (error: {})", file_path, e);
            return http::Response::builder()
                .status(404)
                .header("Content-Type", "text/plain")
                .body(format!("File not found: {}", file_path).into_bytes())
                .unwrap();
        }
    };

    let total_len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(e) => {
            return http::Response::builder()
                .status(500)
                .header("Content-Type", "text/plain")
                .body(format!("Failed to read metadata: {}", e).into_bytes())
                .unwrap();
        }
    };

    let mime = mime_guess::from_path(file_path)
        .first_or_octet_stream()
        .to_string();

    if total_len == 0 {
        return http::Response::builder()
            .status(200)
            .header("Content-Type", &mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", "0")
            .body(Vec::new())
            .unwrap();
    }

    if let Some(range_header) = range {
        if let Some((start, end)) = parse_range_header(range_header, total_len) {
            let len = end - start + 1;
            let mut buffer = vec![0; len as usize];
            if let Err(e) = file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buffer)) {
                return http::Response::builder()
                    .status(500)
                    .header("Content-Type", "text/plain")
                    .body(format!("Failed to read range: {}", e).into_bytes())
                    .unwrap();
            }

            return http::Response::builder()
                .status(206)
                .header("Content-Type", &mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", len.to_string())
                .header("Content-Range", format!("bytes {}-{}/{}", start, end, total_len))
                .body(buffer)
                .unwrap();
        }

        return http::Response::builder()
            .status(416)
            .header("Content-Range", format!("bytes */{}", total_len))
            .body(Vec::new())
            .unwrap();
    }

    let mut buffer = Vec::new();
    if let Err(e) = file.read_to_end(&mut buffer) {
        return http::Response::builder()
            .status(500)
            .header("Content-Type", "text/plain")
            .body(format!("Failed to read file: {}", e).into_bytes())
            .unwrap();
    }

    http::Response::builder()
        .status(200)
        .header("Content-Type", &mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", total_len.to_string())
        .body(buffer)
        .unwrap()
}

#[tauri::command]
fn write_text_file(file_path: String, content: String) -> Result<(), String> {
    fs::write(&file_path, &content).map_err(|e| format!("Failed to write {}: {}", file_path, e))
}

#[tauri::command]
async fn save_pptx_file(app_handle: tauri::AppHandle, default_name: String, bytes: Vec<u8>) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_name = if default_name.trim().is_empty() {
        "PPTE导出.pptx".to_string()
    } else if default_name.to_lowercase().ends_with(".pptx") {
        default_name
    } else {
        format!("{}.pptx", default_name)
    };

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .dialog()
        .file()
        .add_filter("PowerPoint", &["pptx"])
        .set_file_name(&file_name)
        .save_file(move |file| {
            let _ = tx.send(file);
        });

    let file = rx.recv().map_err(|e| e.to_string())?.ok_or("cancelled")?;
    let path = file
        .into_path()
        .map_err(|e| e.to_string())?;

    fs::write(&path, bytes).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_ppt_templates(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    // Find PPT-Template folder - check multiple possible locations
    let mut possible_paths = vec![];

    // Dev mode: next to project
    if let Ok(cwd) = std::env::current_dir() {
        possible_paths.push(cwd.join("../PPT-Template"));
        possible_paths.push(cwd.join("PPT-Template"));
        possible_paths.push(cwd.join("src-tauri/PPT-Template"));
    }

    // Check parent of lecture-app directory
    if let Ok(cwd) = std::env::current_dir() {
        possible_paths.push(cwd.join("../../PPT-Template"));
    }

    // Also try relative to the executable (for production)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            possible_paths.push(exe_dir.join("../Resources/PPT-Template"));
            possible_paths.push(exe_dir.join("../../Resources/PPT-Template"));
        }
    }

    // Try to get resource directory from Tauri
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        possible_paths.push(resource_dir.join("PPT-Template"));
    }

    let template_dir = possible_paths
        .iter()
        .find(|p| p.exists() && p.is_dir())
        .cloned();

    let template_dir = match template_dir {
        Some(dir) => dir,
        None => return Ok(vec![]),
    };

    let mut templates = vec![];
    if let Ok(entries) = fs::read_dir(&template_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name() {
                    let name_str = name.to_string_lossy().to_string();
                    if !name_str.starts_with('.') {
                        templates.push(name_str);
                    }
                }
            }
        }
    }

    templates.sort();
    Ok(templates)
}

#[tauri::command]
fn get_template_files(app_handle: tauri::AppHandle, template_name: String) -> Result<serde_json::Value, String> {
    // Find PPT-Template folder - check multiple possible locations
    let mut possible_paths = vec![];

    // Dev mode: next to project
    if let Ok(cwd) = std::env::current_dir() {
        possible_paths.push(cwd.join("../PPT-Template").join(&template_name));
        possible_paths.push(cwd.join("PPT-Template").join(&template_name));
        possible_paths.push(cwd.join("src-tauri/PPT-Template").join(&template_name));
    }

    // Check parent of lecture-app directory
    if let Ok(cwd) = std::env::current_dir() {
        possible_paths.push(cwd.join("../../PPT-Template").join(&template_name));
    }

    // Also try relative to the executable (for production)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            possible_paths.push(exe_dir.join("../Resources/PPT-Template").join(&template_name));
            possible_paths.push(exe_dir.join("../../Resources/PPT-Template").join(&template_name));
        }
    }

    // Try to get resource directory from Tauri
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        possible_paths.push(resource_dir.join("PPT-Template").join(&template_name));
    }

    let template_dir = possible_paths
        .iter()
        .find(|p| p.exists() && p.is_dir())
        .cloned()
        .ok_or_else(|| format!("Template not found: {}", template_name))?;

    // Read template files
    let mut files = serde_json::Map::new();

    let template_types = vec!["cover", "catalog", "chapter", "content", "finish"];

    for t in template_types {
        let html_path = template_dir.join(format!("{}.html", t));
        if html_path.exists() {
            let content = fs::read_to_string(&html_path).map_err(|e| e.to_string())?;
            files.insert(t.to_string(), serde_json::Value::String(content));
        }

        let css_path = template_dir.join(format!("{}.css", t));
        if css_path.exists() {
            let content = fs::read_to_string(&css_path).map_err(|e| e.to_string())?;
            files.insert(format!("{}_css", t), serde_json::Value::String(content));
        }
    }

    // Also read common style.css if exists
    let style_path = template_dir.join("style.css");
    if style_path.exists() {
        let content = fs::read_to_string(&style_path).map_err(|e| e.to_string())?;
        files.insert("style".to_string(), serde_json::Value::String(content));
    }

    // Read PNG image files (base64 encoded)
    let image_extensions = vec!["png", "jpg", "jpeg", "gif", "svg"];
    if let Ok(entries) = std::fs::read_dir(&template_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if image_extensions.contains(&ext.to_string_lossy().to_lowercase().as_str()) {
                    if let Ok(data) = std::fs::read(&path) {
                        let filename = path.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let base64_data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
                        files.insert(format!("img_{}", filename), serde_json::Value::String(base64_data));
                    }
                }
            }
        }
    }

    Ok(serde_json::Value::Object(files))
}

#[tauri::command]
fn save_course_config(course_path: String, config_json: String) -> Result<(), String> {
    let dir = PathBuf::from(&course_path);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir {}: {}", course_path, e))?;
    let path = dir.join("course.json");
    fs::write(&path, &config_json)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

#[tauri::command]
fn get_app_data_dir(app_handle: tauri::AppHandle) -> Result<String, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_files(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .dialog()
        .file()
        .add_filter("All Supported", &[
            "pdf", "ppt", "pptx",
            "mp4", "mov", "webm",
            "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp",
            "md", "html", "htm",
            "py", "js", "ts", "rs", "java", "go", "c", "cpp", "h", "css", "sh", "sql",
            "json", "yml", "yaml",
            "woff", "woff2", "ttf", "otf",
        ])
        .pick_files(move |files| {
            let _ = tx.send(files);
        });

    let files = rx.recv().map_err(|e| e.to_string())?.ok_or("cancelled")?;
    let paths: Vec<String> = files
        .iter()
        .filter_map(|f| f.clone().into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Ok(paths)
}

#[tauri::command]
async fn pick_folder(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .dialog()
        .file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });

    let folder = rx.recv().map_err(|e| e.to_string())?.ok_or("cancelled")?;
    let path = folder
        .into_path()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    Ok(path)
}

#[tauri::command]
async fn export_template(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    // Get the resource path (templates bundled with the app)
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?;
    let template_src = resource_dir.join("templates");

    // Ask user where to save
    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .dialog()
        .file()
        .set_file_name("PPT-EXTRA-Template")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });

    let dest_folder = rx.recv().map_err(|e| e.to_string())?.ok_or("cancelled")?;
    let dest_path = dest_folder
        .into_path()
        .map_err(|e| e.to_string())?;

    // Check if source template exists
    if !template_src.exists() {
        // Create a default template structure
        let default_template = dest_path.join("PPT-EXTRA-Template");
        fs::create_dir_all(&default_template).map_err(|e| e.to_string())?;

        // Create a simple README
        let readme_content = r#"# PPT-EXTRA 模板

这是一个 PPT-EXTRA 格式的幻灯片模板。

## 目录结构

```
PPT-EXTRA-Template/
├── manifest.json          # 幻灯片列表配置
├── slide01.html          # 封面页
├── slide02.html          # 目录页
├── slide03.html          # 章节页
├── slide04.html          # 内容页
└── slide05.html          # 结束页
```

## manifest.json 格式

```json
{
  "title": "演示标题",
  "slides": [
    "slide01.html",
    "slide02.html",
    "slide03.html",
    "slide04.html",
    "slide05.html"
  ]
}
```

## 使用方法

1. 编辑 manifest.json 设置幻灯片标题和列表
2. 修改各 slideXX.html 文件创建你的内容
3. 将整个文件夹添加到课程中

## 内容限制

- 单页文字不超过 15 行
- 代码块不超过 20 行
- 图片高度不超过容器 80%

更多信息请参考 COURSE_FORMAT.md
"#;
        fs::write(default_template.join("README.md"), readme_content).map_err(|e| e.to_string())?;

        // Create a sample manifest.json
        let manifest = r#"{
  "title": "演示幻灯片",
  "slides": [
    "slide01.html",
    "slide02.html",
    "slide03.html",
    "slide04.html",
    "slide05.html"
  ]
}
"#;
        fs::write(default_template.join("manifest.json"), manifest).map_err(|e| e.to_string())?;

        // Create sample slide HTML files
        let slide01 = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #1a1a2e; color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 40px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; text-align: center; }
    h1 { font-size: 3em; margin-bottom: 0.5em; }
    p { font-size: 1.5em; color: #aaa; }
  </style>
</head>
<body>
  <div class="slide">
    <h1>课程标题</h1>
    <p>副标题</p>
  </div>
</body>
</html>
"#;
        fs::write(default_template.join("slide01.html"), slide01).map_err(|e| e.to_string())?;

        let slide02 = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #fff; color: #333; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 40px; box-sizing: border-box; display: flex; flex-direction: column; }
    h2 { font-size: 2em; border-bottom: 2px solid #4a90d9; padding-bottom: 10px; margin-bottom: 30px; }
    ul { font-size: 1.3em; line-height: 1.8; }
    li { margin: 10px 0; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>目录</h2>
    <ul>
      <li>第一章：介绍</li>
      <li>第二章：基础知识</li>
      <li>第三章：核心概念</li>
      <li>第四章：实战演练</li>
      <li>第五章：总结</li>
    </ul>
  </div>
</body>
</html>
"#;
        fs::write(default_template.join("slide02.html"), slide02).map_err(|e| e.to_string())?;

        let slide03 = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #4a90d9; color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 40px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
    h2 { font-size: 3em; margin-bottom: 20px; }
    p { font-size: 1.5em; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>第 X 章</h2>
    <p>章节标题</p>
  </div>
</body>
</html>
"#;
        fs::write(default_template.join("slide03.html"), slide03).map_err(|e| e.to_string())?;

        let slide04 = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #fff; color: #333; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 40px; box-sizing: border-box; display: flex; flex-direction: column; }
    h3 { font-size: 1.8em; margin-bottom: 20px; }
    p { font-size: 1.3em; line-height: 1.6; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <div class="slide">
    <h3>主要内容</h3>
    <p>在这里添加你的内容...</p>
    <pre><code>// 代码示例</code></pre>
  </div>
</body>
</html>
"#;
        fs::write(default_template.join("slide04.html"), slide04).map_err(|e| e.to_string())?;

        let slide05 = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #1a1a2e; color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 40px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; text-align: center; }
    h2 { font-size: 2.5em; margin-bottom: 30px; }
    p { font-size: 1.3em; color: #aaa; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>谢谢！</h2>
    <p>Q&A</p>
  </div>
</body>
</html>
"#;
        fs::write(default_template.join("slide05.html"), slide05).map_err(|e| e.to_string())?;

        return Ok("ok".to_string());
    }

    // If template exists in resources, copy it
    let dest = dest_path.join("PPT-EXTRA-Template");
    copy_dir_all(&template_src, &dest).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn save_app_config(app_handle: tauri::AppHandle, config_json: String) -> Result<(), String> {
    let path = get_config_path(&app_handle)?;
    fs::write(&path, &config_json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn import_course(app_handle: tauri::AppHandle) -> Result<CourseEntry, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .dialog()
        .file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });

    let folder = rx.recv().map_err(|e| e.to_string())?.ok_or("cancelled")?;

    let course_path = folder
        .into_path()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();

    // Validate course.json
    let json_path = PathBuf::from(&course_path).join("course.json");
    let content = fs::read_to_string(&json_path)
        .map_err(|_| "所选目录中未找到 course.json".to_string())?;
    let data: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("course.json 格式错误: {}", e))?;

    let id = data["id"]
        .as_str()
        .ok_or("course.json 缺少 id 字段".to_string())?
        .to_string();
    let title = data["title"].as_str().unwrap_or(&id).to_string();
    let subtitle = data["subtitle"].as_str().unwrap_or("").to_string();
    let label = if subtitle.is_empty() {
        title
    } else {
        format!("{} — {}", title, subtitle)
    };

    // Update app config
    let config_path = get_config_path(&app_handle)?;
    let config_content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let mut config: AppConfig =
        serde_json::from_str(&config_content).map_err(|e| e.to_string())?;

    if config.courses.iter().any(|c| c.id == id) {
        return Err(format!("课程 ID '{}' 已存在", id));
    }

    let entry = CourseEntry { id: id.clone(), path: course_path, label, created_by_app: None };
    config.courses.push(entry.clone());
    config.last_opened_course = id;

    let updated = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_path, updated).map_err(|e| e.to_string())?;

    Ok(entry)
}

#[tauri::command]
fn open_external(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", path, e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", path, e))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", path, e))?;
    }

    Ok(())
}

#[tauri::command]
fn detect_terminal() -> String {
    // Priority: iTerm2 > Warp > Terminal.app
    let candidates = [
        ("iterm2", "/Applications/iTerm.app"),
        ("warp", "/Applications/Warp.app"),
    ];
    for (name, path) in &candidates {
        if PathBuf::from(path).exists() {
            return name.to_string();
        }
    }
    "terminal".to_string()
}

#[tauri::command]
fn detect_python() -> String {
    // Try conda first, then common paths
    if let Ok(output) = Command::new("which").arg("python3").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }
    let fallbacks = [
        "/usr/local/bin/python3",
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
    ];
    for p in &fallbacks {
        if PathBuf::from(p).exists() {
            return p.to_string();
        }
    }
    "python3".to_string()
}

#[tauri::command]
fn run_in_terminal(file_path: String, terminal: String, python_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    let dir = path.parent()
        .ok_or("Cannot determine parent directory")?
        .to_string_lossy()
        .to_string();
    let filename = path.file_name()
        .ok_or("Cannot determine filename")?
        .to_string_lossy()
        .to_string();

    // Build the command to execute
    let ext = path.extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();

    let run_cmd = match ext.as_str() {
        "py" => format!("cd '{}' && '{}' '{}'", dir, python_path, filename),
        "sh" => format!("cd '{}' && bash '{}'", dir, filename),
        _ => return Err(format!("Unsupported file type: .{}", ext)),
    };

    let script = match terminal.as_str() {
        "iterm2" => format!(
            r#"tell application "iTerm"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        write text "{}"
    end tell
end tell"#,
            run_cmd.replace('"', "\\\"")
        ),
        "warp" => format!(
            r#"tell application "Warp"
    activate
end tell
delay 0.5
tell application "System Events"
    tell process "Warp"
        keystroke "t" using command down
        delay 0.3
        keystroke "{}"
        key code 36
    end tell
end tell"#,
            run_cmd.replace('"', "\\\"")
        ),
        _ => format!(
            r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
            run_cmd.replace('"', "\\\"")
        ),
    };

    Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("Failed to run in terminal: {}", e))?;

    Ok(())
}

#[derive(Serialize, Deserialize)]
struct PptSlide {
    file: String,
    title: String,
    #[serde(default)]
    slide_type: String,
}

#[derive(Serialize, Deserialize)]
struct PptManifest {
    title: String,
    slides: Vec<PptSlide>,
}

#[derive(Serialize)]
struct FileStat {
    path: String,
    exists: bool,
    #[serde(rename = "mtimeMs")]
    mtime_ms: Option<i64>,
    size: Option<u64>,
    #[serde(rename = "contentHash")]
    content_hash: Option<String>,
}

#[derive(Deserialize)]
struct ExpectedFileStat {
    path: String,
    #[serde(default, rename = "mtimeMs")]
    mtime_ms: Option<i64>,
    #[serde(default)]
    exists: Option<bool>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default, rename = "contentHash")]
    content_hash: Option<String>,
}

#[derive(Serialize)]
struct SaveResult {
    saved: Vec<String>,
    conflicts: Vec<String>,
}

#[derive(Serialize)]
struct TokenStatus {
    configured: bool,
}

#[derive(Serialize)]
struct GiteeRepoInfo {
    name: String,
    #[serde(rename = "fullName")]
    full_name: Option<String>,
    #[serde(rename = "htmlUrl")]
    html_url: Option<String>,
    #[serde(rename = "cloneUrl")]
    clone_url: Option<String>,
    #[serde(rename = "sshUrl")]
    ssh_url: Option<String>,
}

#[derive(Deserialize)]
struct GiteeRepoResponse {
    name: Option<String>,
    #[serde(rename = "full_name")]
    full_name: Option<String>,
    #[serde(rename = "html_url")]
    html_url: Option<String>,
    #[serde(rename = "clone_url")]
    clone_url: Option<String>,
    #[serde(rename = "ssh_url")]
    ssh_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct GitSyncResult {
    committed: bool,
    pushed: bool,
    message: String,
}

#[derive(Serialize)]
struct GitInfo {
    #[serde(rename = "isRepo")]
    is_repo: bool,
    #[serde(rename = "originUrl")]
    origin_url: Option<String>,
}

#[derive(Serialize)]
struct PpteResourceEntry {
    path: String,
    kind: String,
    size: u64,
}

#[derive(Serialize, Clone)]
struct PpteFileChangedPayload {
    #[serde(rename = "folderPath")]
    folder_path: String,
    files: Vec<String>,
}

fn file_stat_for_path(path: &PathBuf, label: String) -> FileStat {
    match fs::metadata(path) {
        Ok(metadata) => {
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64);
            let content_hash = if metadata.is_file() {
                fs::read(path).ok().map(|bytes| {
                    let mut hasher = DefaultHasher::new();
                    bytes.hash(&mut hasher);
                    format!("{:016x}", hasher.finish())
                })
            } else {
                None
            };

            FileStat {
                path: label,
                exists: true,
                mtime_ms,
                size: Some(metadata.len()),
                content_hash,
            }
        }
        Err(_) => FileStat {
            path: label,
            exists: false,
            mtime_ms: None,
            size: None,
            content_hash: None,
        },
    }
}

#[tauri::command]
fn stat_files(paths: Vec<String>) -> Result<Vec<FileStat>, String> {
    Ok(paths
        .into_iter()
        .map(|path| file_stat_for_path(&PathBuf::from(&path), path))
        .collect())
}

fn ppte_resource_kind(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower == "manifest.json" {
        return "manifest".to_string();
    }
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        return "slide".to_string();
    }
    if lower.ends_with(".note") {
        return "note".to_string();
    }
    if lower.ends_with(".css") {
        return "style".to_string();
    }
    if matches!(
        PathBuf::from(&lower).extension().and_then(|e| e.to_str()),
        Some("png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp")
    ) {
        return "image".to_string();
    }
    if matches!(
        PathBuf::from(&lower).extension().and_then(|e| e.to_str()),
        Some("js" | "mjs" | "json")
    ) {
        return "script".to_string();
    }
    "other".to_string()
}

fn collect_ppte_resources(
    base_dir: &PathBuf,
    current_dir: &PathBuf,
    output: &mut Vec<PpteResourceEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(current_dir)
        .map_err(|e| format!("Failed to read PPTE resources: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read PPTE resource entry: {}", e))?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == ".git" || file_name == ".DS_Store" || file_name.starts_with("._") {
            continue;
        }

        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to stat PPTE resource {}: {}", file_name, e))?;
        if metadata.is_dir() {
            collect_ppte_resources(base_dir, &path, output)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

        let relative = path
            .strip_prefix(base_dir)
            .map_err(|e| format!("Failed to resolve PPTE resource path: {}", e))?
            .to_string_lossy()
            .replace('\\', "/");

        output.push(PpteResourceEntry {
            kind: ppte_resource_kind(&relative),
            path: relative,
            size: metadata.len(),
        });
    }

    Ok(())
}

#[tauri::command]
fn list_ppte_resources(folder_path: String) -> Result<Vec<PpteResourceEntry>, String> {
    let base_dir = PathBuf::from(folder_path);
    if !base_dir.is_dir() {
        return Err("PPTE folder does not exist".to_string());
    }

    let mut resources = Vec::new();
    collect_ppte_resources(&base_dir, &base_dir, &mut resources)?;
    resources.sort_by(|a, b| {
        let kind_order = |kind: &str| match kind {
            "manifest" => 0,
            "slide" => 1,
            "note" => 2,
            "style" => 3,
            "image" => 4,
            "script" => 5,
            _ => 6,
        };
        kind_order(&a.kind)
            .cmp(&kind_order(&b.kind))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(resources)
}

fn unique_resource_destination(dest_dir: &PathBuf, file_name: &str) -> PathBuf {
    let original = PathBuf::from(file_name);
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "resource".to_string());
    let extension = original
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .filter(|e| !e.trim().is_empty());

    let mut candidate = dest_dir.join(file_name);
    let mut index = 1;
    while candidate.exists() {
        let next_name = if let Some(extension) = &extension {
            format!("{}-{}.{}", stem, index, extension)
        } else {
            format!("{}-{}", stem, index)
        };
        candidate = dest_dir.join(next_name);
        index += 1;
    }
    candidate
}

#[tauri::command]
fn import_ppte_resources(folder_path: String, source_paths: Vec<String>) -> Result<Vec<PpteResourceEntry>, String> {
    let base_dir = PathBuf::from(folder_path);
    if !base_dir.is_dir() {
        return Err("PPTE folder does not exist".to_string());
    }
    let dest_dir = base_dir.join("resources");
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create resources folder: {}", e))?;

    let mut imported = Vec::new();
    for source_path in source_paths {
        let source = PathBuf::from(&source_path);
        if !source.is_file() {
            continue;
        }
        let Some(file_name) = source.file_name().map(|name| name.to_string_lossy().to_string()) else {
            continue;
        };
        if file_name == ".DS_Store" || file_name.starts_with("._") {
            continue;
        }

        let destination = unique_resource_destination(&dest_dir, &file_name);
        fs::copy(&source, &destination)
            .map_err(|e| format!("Failed to import {}: {}", source.display(), e))?;

        let relative = destination
            .strip_prefix(&base_dir)
            .map_err(|e| format!("Failed to resolve imported resource path: {}", e))?
            .to_string_lossy()
            .replace('\\', "/");
        let size = fs::metadata(&destination)
            .map_err(|e| format!("Failed to stat imported resource: {}", e))?
            .len();
        imported.push(PpteResourceEntry {
            kind: ppte_resource_kind(&relative),
            path: relative,
            size,
        });
    }

    Ok(imported)
}

#[tauri::command]
fn watch_ppte_folder(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, PpteWatcherState>,
    folder_path: String,
) -> Result<(), String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("PPTE folder does not exist: {}", folder_path));
    }

    let folder_key = folder.to_string_lossy().to_string();
    {
        let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = watchers.get_mut(&folder_key) {
            entry.refs += 1;
            return Ok(());
        }
    }

    let watch_root = folder.clone();
    let event_root = folder.clone();
    let event_folder_key = folder_key.clone();
    let app = app_handle.clone();

    let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        match result {
            Ok(event) => {
                let mut files: Vec<String> = event
                    .paths
                    .into_iter()
                    .filter_map(|path| {
                        let rel = path
                            .strip_prefix(&event_root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        if rel.is_empty() || rel.starts_with(".git/") || rel == ".git" {
                            None
                        } else {
                            Some(rel)
                        }
                    })
                    .collect();

                files.sort();
                files.dedup();

                if !files.is_empty() {
                    let _ = app.emit("ppte-file-changed", PpteFileChangedPayload {
                        folder_path: event_folder_key.clone(),
                        files,
                    });
                }
            }
            Err(error) => {
                eprintln!("[ppte-watch] watch error: {}", error);
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(&watch_root, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch PPTE folder: {}", e))?;

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.insert(folder_key, PpteWatcherEntry { _watcher: watcher, refs: 1 });
    Ok(())
}

#[tauri::command]
fn unwatch_ppte_folder(
    state: tauri::State<'_, PpteWatcherState>,
    folder_path: String,
) -> Result<(), String> {
    let folder_key = PathBuf::from(&folder_path).to_string_lossy().to_string();
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = watchers.get_mut(&folder_key) {
        if entry.refs > 1 {
            entry.refs -= 1;
            return Ok(());
        }
    }
    watchers.remove(&folder_key);
    Ok(())
}

#[tauri::command]
fn create_ppt_extra_folder(
    app_handle: tauri::AppHandle,
    folder_name: String,
    target_path: Option<String>,
    template_css: Option<Vec<(String, String)>>,
    template_images: Option<Vec<(String, String)>>,
    template_html: Option<Vec<(String, String)>>,
) -> Result<String, String> {
    let ppt_dir = if let Some(target) = target_path {
        PathBuf::from(target).join(&folder_name)
    } else {
        let app_data = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        app_data.join("ppt-extra").join(&folder_name)
    };
    fs::create_dir_all(&ppt_dir).map_err(|e| format!("Failed to create folder: {}", e))?;

    // Save template CSS files if provided
    if let Some(css_files) = template_css {
        for (filename, content) in css_files {
            let css_path = ppt_dir.join(&filename);
            fs::write(&css_path, &content).map_err(|e| format!("Failed to save {}: {}", filename, e))?;
        }
    }

    // Save template image files if provided (base64 encoded)
    if let Some(image_files) = template_images {
        for (filename, base64_data) in image_files {
            let image_path = ppt_dir.join(&filename);
            let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &base64_data)
                .map_err(|e| format!("Failed to decode image {}: {}", filename, e))?;
            fs::write(&image_path, decoded).map_err(|e| format!("Failed to save image {}: {}", filename, e))?;
        }
    }

    // Use template HTML if provided, otherwise use defaults
    let (slides, html_contents) = if let Some(html_files) = template_html {
        let slide_defs: Vec<(String, String, String)> = html_files.into_iter().map(|(slide_type, html)| {
            let filename = match slide_type.as_str() {
                "cover" => "slide01.html",
                "catalog" => "slide02.html",
                "chapter" => "slide03.html",
                "content" => "slide04.html",
                "finish" => "slide05.html",
                _ => "slide01.html",
            }.to_string();
            let title = match slide_type.as_str() {
                "cover" => "封面",
                "catalog" => "目录",
                "chapter" => "章节 1",
                "content" => "内容",
                "finish" => "总结",
                _ => "未命名",
            }.to_string();
            (filename, title, html)
        }).collect();

        let slide_vec: Vec<PptSlide> = slide_defs.iter().map(|(filename, title, _)| {
            PptSlide {
                file: filename.clone(),
                title: title.clone(),
                slide_type: match filename.as_str() {
                    "slide01.html" => "cover".to_string(),
                    "slide02.html" => "catalog".to_string(),
                    "slide03.html" => "chapter".to_string(),
                    "slide04.html" => "content".to_string(),
                    "slide05.html" => "finish".to_string(),
                    _ => "content".to_string(),
                }.to_string(),
            }
        }).collect();

        (slide_vec, slide_defs)
    } else {
        let defaults = vec![
            ("slide01.html".to_string(), "封面".to_string(), r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; text-align: center; }
    h1 { font-size: 3.5em; margin-bottom: 0.3em; font-weight: 300; letter-spacing: 2px; }
    p { font-size: 1.5em; color: #aaa; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="slide">
    <h1>课程标题</h1>
    <p>副标题 | 作者</p>
  </div>
</body>
</html>"#.to_string()),
            ("slide02.html".to_string(), "目录".to_string(), r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #fff; color: #333; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; }
    h2 { font-size: 2.5em; border-bottom: 3px solid #4a90d9; padding-bottom: 15px; margin-bottom: 40px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { font-size: 1.4em; padding: 12px 0; border-bottom: 1px solid #eee; }
    li:before { content: "▶"; color: #4a90d9; margin-right: 15px; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>目录</h2>
    <ul>
      <li>第一章：介绍</li>
      <li>第二章：基础知识</li>
      <li>第三章：核心内容</li>
      <li>第四章：实践应用</li>
      <li>第五章：总结</li>
    </ul>
  </div>
</body>
</html>"#.to_string()),
            ("slide03.html".to_string(), "章节 1".to_string(), r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #4a90d9 0%, #357abd 100%); color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
    h2 { font-size: 3em; margin-bottom: 20px; }
    p { font-size: 1.5em; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>第 X 章</h2>
    <p>章节标题</p>
  </div>
</body>
</html>"#.to_string()),
            ("slide04.html".to_string(), "内容".to_string(), r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #f5f7fa; color: #333; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; }
    h3 { font-size: 2em; margin-bottom: 30px; color: #4a90d9; }
    p { font-size: 1.3em; line-height: 1.8; margin: 10px 0; }
    code { background: #e8eef5; padding: 3px 8px; border-radius: 4px; font-family: monospace; color: #e74c3c; }
  </style>
</head>
<body>
  <div class="slide">
    <h3>内容标题</h3>
    <p>在这里添加您的内容...</p>
  </div>
</body>
</html>"#.to_string()),
            ("slide05.html".to_string(), "总结".to_string(), r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #2d3436 0%, #636e72 100%); color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; text-align: center; }
    h2 { font-size: 3em; margin-bottom: 30px; }
    p { font-size: 1.5em; color: #aaa; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>谢谢观看</h2>
    <p>Q&A</p>
  </div>
</body>
</html>"#.to_string()),
        ];

        let slide_vec: Vec<PptSlide> = defaults.iter().map(|(filename, title, _)| {
            PptSlide {
                file: filename.clone(),
                title: title.clone(),
                slide_type: match filename.as_str() {
                    "slide01.html" => "cover".to_string(),
                    "slide02.html" => "catalog".to_string(),
                    "slide03.html" => "chapter".to_string(),
                    "slide04.html" => "content".to_string(),
                    "slide05.html" => "finish".to_string(),
                    _ => "content".to_string(),
                }.to_string(),
            }
        }).collect();

        (slide_vec, defaults)
    };

    let manifest = PptManifest {
        title: folder_name.clone(),
        slides,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(ppt_dir.join("manifest.json"), manifest_json).map_err(|e| e.to_string())?;

    // Write slide HTML files
    for (filename, _, html) in html_contents {
        fs::write(ppt_dir.join(&filename), html).map_err(|e| format!("Failed to save {}: {}", filename, e))?;
        if filename.to_lowercase().ends_with(".html") {
            let note_filename = filename.trim_end_matches(".html").to_string() + ".note";
            fs::write(ppt_dir.join(&note_filename), "")
                .map_err(|e| format!("Failed to save {}: {}", note_filename, e))?;
        }
    }

    Ok(ppt_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn save_ppt_extra(
    folder_path: String,
    manifest_json: String,
    slide_files: Vec<(String, String)>,
    expected_mtimes: Option<Vec<ExpectedFileStat>>,
) -> Result<SaveResult, String> {
    let base_dir = PathBuf::from(&folder_path);
    let mut saved = Vec::new();

    if let Some(expected_files) = expected_mtimes {
        let mut conflicts = Vec::new();

        for expected in expected_files {
            let relative_path = expected.path.trim_start_matches('/').trim_start_matches('\\');
            let file_path = base_dir.join(relative_path);
            let current = file_stat_for_path(&file_path, expected.path.clone());
            let expected_exists = expected.exists.unwrap_or(expected.mtime_ms.is_some() || expected.size.is_some());
            let changed = if expected_exists != current.exists {
                true
            } else if !expected_exists {
                false
            } else {
                current.mtime_ms != expected.mtime_ms
                    || current.size != expected.size
                    || current.content_hash != expected.content_hash
            };

            if changed {
                conflicts.push(expected.path);
            }
        }

        if !conflicts.is_empty() {
            return Ok(SaveResult {
                saved: Vec::new(),
                conflicts,
            });
        }
    }

    // Save manifest
    fs::write(base_dir.join("manifest.json"), &manifest_json).map_err(|e| format!("Failed to save manifest: {}", e))?;
    saved.push("manifest.json".to_string());

    // Save each slide file
    for (filename, content) in slide_files {
        let file_path = base_dir.join(&filename);
        let file_ext = file_path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        // Check if this is an image file that needs base64 decoding
        if matches!(file_ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp") {
            // Decode base64 to binary
            let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &content)
                .map_err(|e| format!("Failed to decode base64 for {}: {}", filename, e))?;
            fs::write(&file_path, decoded).map_err(|e| format!("Failed to save {}: {}", filename, e))?;
        } else {
            // Save as-is (HTML, CSS, manifest)
            fs::write(&file_path, &content).map_err(|e| format!("Failed to save {}: {}", filename, e))?;
        }
        saved.push(filename);
    }

    Ok(SaveResult {
        saved,
        conflicts: Vec::new(),
    })
}

fn gitee_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(GITEE_KEYRING_SERVICE, GITEE_KEYRING_USER)
        .map_err(|e| format!("Failed to open system keyring: {}", e))
}

fn read_gitee_token_keyring() -> Result<String, String> {
    gitee_keyring_entry()?
        .get_password()
        .map_err(|e| format!("Gitee token is not configured: {}", e))
}

#[cfg(target_os = "macos")]
fn read_gitee_token_macos_security() -> Result<String, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            GITEE_KEYRING_SERVICE,
            "-a",
            GITEE_KEYRING_USER,
            "-w",
        ])
        .output()
        .map_err(|e| format!("Failed to read macOS Keychain: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn read_gitee_token_macos_security() -> Result<String, String> {
    Err("macOS Keychain fallback is not available on this platform".to_string())
}

#[cfg(target_os = "macos")]
fn store_gitee_token_macos_security(token: &str) -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            GITEE_KEYRING_SERVICE,
            "-a",
            GITEE_KEYRING_USER,
            "-w",
            token,
        ])
        .output()
        .map_err(|e| format!("Failed to write macOS Keychain: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn store_gitee_token_macos_security(_token: &str) -> Result<(), String> {
    Err("macOS Keychain fallback is not available on this platform".to_string())
}

#[cfg(target_os = "macos")]
fn clear_gitee_token_macos_security() -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            GITEE_KEYRING_SERVICE,
            "-a",
            GITEE_KEYRING_USER,
        ])
        .output()
        .map_err(|e| format!("Failed to clear macOS Keychain: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn clear_gitee_token_macos_security() -> Result<(), String> {
    Err("macOS Keychain fallback is not available on this platform".to_string())
}

fn read_gitee_token() -> Result<String, String> {
    if let Ok(token) = read_gitee_token_keyring() {
        if !token.trim().is_empty() {
            return Ok(token);
        }
    }
    let token = read_gitee_token_macos_security()
        .map_err(|e| format!("Gitee token is not configured: {}", e))?;
    if token.trim().is_empty() {
        Err("Gitee token is not configured".to_string())
    } else {
        Ok(token)
    }
}

fn store_gitee_token(token: &str) -> Result<(), String> {
    let keyring_result = gitee_keyring_entry()
        .and_then(|entry| entry.set_password(token).map_err(|e| format!("Failed to save Gitee token: {}", e)));
    if read_gitee_token_keyring()
        .map(|stored| stored.trim() == token)
        .unwrap_or(false)
    {
        return Ok(());
    }

    store_gitee_token_macos_security(token)
        .map_err(|fallback_error| {
            if let Err(keyring_error) = keyring_result {
                format!("Failed to save Gitee token: {}; fallback failed: {}", keyring_error, fallback_error)
            } else {
                format!("Failed to verify keyring token; fallback failed: {}", fallback_error)
            }
        })?;

    let stored = read_gitee_token_macos_security()
        .map_err(|e| format!("Saved Gitee token but failed to verify it: {}", e))?;
    if stored.trim() == token {
        Ok(())
    } else {
        Err("Saved Gitee token but verification returned a different value".to_string())
    }
}

fn clear_gitee_token() {
    if let Ok(entry) = gitee_keyring_entry() {
        let _ = entry.delete_credential();
    }
    let _ = clear_gitee_token_macos_security();
}

fn sanitize_gitee_repo_name(name: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;

    for ch in name.trim().chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
            Some(ch.to_ascii_lowercase())
        } else if ch.is_whitespace() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            Some('-')
        } else {
            Some('-')
        };

        if let Some(ch) = normalized {
            if ch == '-' {
                if !last_dash {
                    output.push(ch);
                    last_dash = true;
                }
            } else {
                output.push(ch);
                last_dash = false;
            }
        }
    }

    let trimmed = output.trim_matches(|ch| ch == '-' || ch == '.').to_string();
    if trimmed.is_empty() {
        let mut hasher = DefaultHasher::new();
        name.hash(&mut hasher);
        format!("ppte-{:08x}", (hasher.finish() & 0xffff_ffff) as u32)
    } else {
        trimmed.chars().take(100).collect()
    }
}

fn ppte_gitignore_content() -> &'static str {
    ".DS_Store\n._*\n__MACOSX/\n*.tmp\n*.temp\n*.swp\n*.swo\n~$*\n"
}

fn ensure_ppte_gitignore(folder_path: &PathBuf) -> Result<(), String> {
    let gitignore_path = folder_path.join(".gitignore");
    if !gitignore_path.exists() {
        fs::write(&gitignore_path, ppte_gitignore_content())
            .map_err(|e| format!("Failed to write .gitignore: {}", e))?;
        return Ok(());
    }

    let existing = fs::read_to_string(&gitignore_path)
        .map_err(|e| format!("Failed to read .gitignore: {}", e))?;
    let mut updated = existing.clone();
    let mut changed = false;
    for line in ppte_gitignore_content().lines() {
        if !existing.lines().any(|existing_line| existing_line.trim() == line) {
            if !updated.ends_with('\n') {
                updated.push('\n');
            }
            updated.push_str(line);
            updated.push('\n');
            changed = true;
        }
    }
    if changed {
        fs::write(&gitignore_path, updated)
            .map_err(|e| format!("Failed to update .gitignore: {}", e))?;
    }
    Ok(())
}

fn run_git(folder_path: &PathBuf, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(folder_path)
        .output()
        .map_err(|e| format!("Failed to run git {:?}: {}", args, e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(format!(
            "git {:?} failed: {}{}{}",
            args,
            stderr,
            if stderr.is_empty() || stdout.is_empty() { "" } else { "\n" },
            stdout
        ))
    }
}

fn git_remote_url(folder_path: &PathBuf, remote: &str) -> Option<String> {
    Command::new("git")
        .args(["remote", "get-url", remote])
        .current_dir(folder_path)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|url| !url.is_empty())
}

fn gitee_username_from_remote(remote_url: &str) -> Option<String> {
    let marker = "gitee.com/";
    let start = remote_url.find(marker)? + marker.len();
    let rest = &remote_url[start..];
    let username = rest.split('/').next()?.trim();
    if username.is_empty() || username.contains('@') {
        None
    } else {
        Some(username.to_string())
    }
}

fn strip_url_credentials(remote_url: &str) -> String {
    let trimmed = remote_url.trim();
    let Some(scheme_pos) = trimmed.find("://") else {
        return trimmed.to_string();
    };
    let authority_start = scheme_pos + 3;
    let path_start = trimmed[authority_start..]
        .find('/')
        .map(|offset| authority_start + offset)
        .unwrap_or(trimmed.len());
    let authority = &trimmed[authority_start..path_start];
    let Some(at_pos) = authority.rfind('@') else {
        return trimmed.to_string();
    };
    format!(
        "{}{}{}",
        &trimmed[..authority_start],
        &authority[at_pos + 1..],
        &trimmed[path_start..]
    )
}

fn normalize_gitee_remote_url(remote_url: &str) -> String {
    let stripped = strip_url_credentials(remote_url);
    let value = stripped.trim();
    if let Some(rest) = value.strip_prefix("git@gitee.com:") {
        return format!("https://gitee.com/{}", rest);
    }
    if let Some(rest) = value.strip_prefix("ssh://git@gitee.com/") {
        return format!("https://gitee.com/{}", rest);
    }
    value.to_string()
}

fn ensure_gitee_https_origin(folder_path: &PathBuf) -> Result<(), String> {
    let Some(origin_url) = git_remote_url(folder_path, "origin") else {
        return Ok(());
    };
    let normalized = normalize_gitee_remote_url(&origin_url);
    if normalized != origin_url && normalized.starts_with("https://gitee.com/") {
        run_git(folder_path, &["remote", "set-url", "origin", &normalized])?;
    }
    Ok(())
}

fn write_askpass_script() -> Result<PathBuf, String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("lecture-presenter-git-askpass-{}", unique));

    #[cfg(windows)]
    let content = "@echo off\r\necho %1 | findstr /I \"Username\" >NUL\r\nif %ERRORLEVEL%==0 (echo %GITEE_GIT_USERNAME%) else (echo %GITEE_GIT_SECRET%)\r\n";

    #[cfg(not(windows))]
    let content = "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf \"%s\" \"$GITEE_GIT_USERNAME\" ;;\n  *) printf \"%s\" \"$GITEE_GIT_SECRET\" ;;\nesac\n";

    fs::write(&path, content).map_err(|e| format!("Failed to write askpass script: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path)
            .map_err(|e| format!("Failed to stat askpass script: {}", e))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions)
            .map_err(|e| format!("Failed to chmod askpass script: {}", e))?;
    }

    Ok(path)
}

fn run_git_push(folder_path: &PathBuf, args: &[&str]) -> Result<String, String> {
    let remote_url = git_remote_url(folder_path, "origin").unwrap_or_default();
    if !(remote_url.starts_with("https://") && remote_url.contains("gitee.com/")) {
        return run_git(folder_path, args);
    }

    let token = match read_gitee_token() {
        Ok(token) if !token.trim().is_empty() => token,
        _ => return run_git(folder_path, args),
    };
    let username = gitee_username_from_remote(&remote_url).unwrap_or_else(|| "oauth2".to_string());
    let askpass_path = write_askpass_script()?;
    let output = Command::new("git")
        .args(args)
        .current_dir(folder_path)
        .env("GIT_ASKPASS", &askpass_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GITEE_GIT_USERNAME", username)
        .env("GITEE_GIT_SECRET", token)
        .output()
        .map_err(|e| format!("Failed to run git {:?}: {}", args, e));
    let _ = fs::remove_file(&askpass_path);
    let output = output?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(format!(
            "git {:?} failed: {}{}{}",
            args,
            stderr,
            if stderr.is_empty() || stdout.is_empty() { "" } else { "\n" },
            stdout
        ))
    }
}

fn git_has_commits(folder_path: &PathBuf) -> bool {
    Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(folder_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn git_has_remote(folder_path: &PathBuf, remote: &str) -> bool {
    Command::new("git")
        .args(["remote", "get-url", remote])
        .current_dir(folder_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn git_is_repo(folder_path: &PathBuf) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(folder_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn git_config_exists(folder_path: &PathBuf, key: &str) -> bool {
    Command::new("git")
        .args(["config", "--get", key])
        .current_dir(folder_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn ensure_git_identity(folder_path: &PathBuf) -> Result<(), String> {
    if !git_config_exists(folder_path, "user.name") {
        run_git(folder_path, &["config", "user.name", "Lecture Presenter"])?;
    }
    if !git_config_exists(folder_path, "user.email") {
        run_git(folder_path, &["config", "user.email", "lecture-presenter@example.invalid"])?;
    }
    Ok(())
}

fn git_has_changes(folder_path: &PathBuf) -> Result<bool, String> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(folder_path)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

#[tauri::command]
fn gitee_token_status() -> Result<TokenStatus, String> {
    let configured = read_gitee_token()
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false);
    Ok(TokenStatus { configured })
}

#[tauri::command]
fn gitee_token_set(token: String) -> Result<TokenStatus, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Gitee token cannot be empty".to_string());
    }
    store_gitee_token(token)?;
    Ok(TokenStatus { configured: true })
}

#[tauri::command]
fn gitee_token_clear() -> Result<TokenStatus, String> {
    clear_gitee_token();
    Ok(TokenStatus { configured: false })
}

#[tauri::command]
async fn gitee_create_repo(name: String, description: Option<String>) -> Result<GiteeRepoInfo, String> {
    let token = read_gitee_token()?;
    let repo_name = sanitize_gitee_repo_name(&name);
    let client = reqwest::Client::new();
    let mut form = vec![
        ("access_token".to_string(), token),
        ("name".to_string(), repo_name.clone()),
        ("private".to_string(), "true".to_string()),
        ("has_issues".to_string(), "false".to_string()),
        ("has_wiki".to_string(), "false".to_string()),
    ];
    if let Some(description) = description {
        let description = description.trim();
        if !description.is_empty() {
            form.push(("description".to_string(), description.to_string()));
        }
    }

    let response = client
        .post("https://gitee.com/api/v5/user/repos")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Failed to create Gitee repo: {}", e))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Gitee response: {}", e))?;

    if !status.is_success() {
        return Err(format!("Gitee repo creation failed ({}): {}", status, body));
    }

    let parsed: GiteeRepoResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Gitee response: {}", e))?;
    Ok(GiteeRepoInfo {
        name: parsed.name.unwrap_or(repo_name),
        full_name: parsed.full_name,
        html_url: parsed.html_url.map(|url| strip_url_credentials(&url)),
        clone_url: parsed.clone_url.map(|url| normalize_gitee_remote_url(&url)),
        ssh_url: parsed.ssh_url.map(|url| normalize_gitee_remote_url(&url)),
    })
}

#[tauri::command]
fn ppte_git_info(folder_path: String) -> Result<GitInfo, String> {
    let folder = PathBuf::from(folder_path);
    if !folder.is_dir() {
        return Err("PPTE folder does not exist".to_string());
    }
    let is_repo = git_is_repo(&folder);
    let origin_url = if is_repo {
        git_remote_url(&folder, "origin").map(|url| normalize_gitee_remote_url(&url))
    } else {
        None
    };
    Ok(GitInfo { is_repo, origin_url })
}

#[tauri::command]
fn ppte_git_init(folder_path: String, remote_url: Option<String>) -> Result<GitSyncResult, String> {
    let folder = PathBuf::from(folder_path);
    if !folder.is_dir() {
        return Err("PPTE folder does not exist".to_string());
    }
    ensure_ppte_gitignore(&folder)?;
    if !folder.join(".git").exists() {
        run_git(&folder, &["init"])?;
    }
    ensure_git_identity(&folder)?;
    if let Some(remote_url) = remote_url {
        let sanitized_remote_url = normalize_gitee_remote_url(&remote_url);
        let remote_url = sanitized_remote_url.trim();
        if !remote_url.is_empty() {
            if git_has_remote(&folder, "origin") {
                run_git(&folder, &["remote", "set-url", "origin", remote_url])?;
            } else {
                run_git(&folder, &["remote", "add", "origin", remote_url])?;
            }
        }
    }
    Ok(GitSyncResult {
        committed: false,
        pushed: false,
        message: "Git repository initialized".to_string(),
    })
}

#[tauri::command]
fn ppte_git_sync(folder_path: String, message: Option<String>) -> Result<GitSyncResult, String> {
    let folder = PathBuf::from(folder_path);
    if !folder.is_dir() {
        return Err("PPTE folder does not exist".to_string());
    }
    ensure_ppte_gitignore(&folder)?;
    if !folder.join(".git").exists() {
        run_git(&folder, &["init"])?;
    }
    ensure_git_identity(&folder)?;
    ensure_gitee_https_origin(&folder)?;

    run_git(&folder, &["add", "-A"])?;
    if !git_has_changes(&folder)? {
        if git_has_remote(&folder, "origin") {
            run_git_push(&folder, &["push", "-u", "origin", "HEAD"])?;
            return Ok(GitSyncResult {
                committed: false,
                pushed: true,
                message: "No local changes; pushed current branch".to_string(),
            });
        }
        return Ok(GitSyncResult {
            committed: false,
            pushed: false,
            message: "No local changes".to_string(),
        });
    }

    let default_message = "Backup PPTE changes".to_string();
    let commit_message = message
        .map(|message| message.trim().to_string())
        .filter(|message| !message.is_empty())
        .unwrap_or(default_message);
    run_git(&folder, &["commit", "-m", &commit_message])?;

    let pushed = if git_has_remote(&folder, "origin") {
        if git_has_commits(&folder) {
            run_git_push(&folder, &["push", "-u", "origin", "HEAD"])?;
        }
        true
    } else {
        false
    };

    Ok(GitSyncResult {
        committed: true,
        pushed,
        message: if pushed {
            "Committed and pushed PPTE backup".to_string()
        } else {
            "Committed locally; no origin remote configured".to_string()
        },
    })
}

#[cfg(test)]
mod slide_bridge_tests {
    use super::*;

    #[test]
    fn injects_bridge_into_html_files() {
        let html = b"<!doctype html><html><body>Slide</body></html>".to_vec();
        let out = inject_slide_bridge("/Users/demo/slide01.html", html);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("__ppteSlideBridgeInstalled"));
        assert!(out.contains("slide-edit-focus"));
        assert!(out.ends_with("</script>\n"));
    }

    #[test]
    fn skips_non_html_files() {
        let png = vec![0x89, 0x50, 0x4E, 0x47];
        let out = inject_slide_bridge("/Users/demo/图片.png", png.clone());
        assert_eq!(out, png);

        let css = b"body { color: red; }".to_vec();
        let out = inject_slide_bridge("/Users/demo/style.css", css.clone());
        assert_eq!(out, css);
    }

    #[test]
    fn handles_htm_extension_case_insensitively() {
        let html = b"<html></html>".to_vec();
        let out = inject_slide_bridge("C:\\课件\\slide.HTM", html);
        assert!(String::from_utf8(out).unwrap().contains("__ppteSlideBridgeInstalled"));
    }
}

#[cfg(test)]
mod ppte_save_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("lecture-app-{}-{}", name, suffix))
    }

    #[test]
    fn save_ppt_extra_rejects_conflict_without_partial_write() {
        let dir = unique_temp_dir("save-conflict");
        fs::create_dir_all(&dir).unwrap();

        let manifest = r#"{"title":"Demo","slides":[{"file":"slide01.html","title":"One"}]}"#;
        fs::write(dir.join("manifest.json"), manifest).unwrap();
        fs::write(dir.join("slide01.html"), "original").unwrap();

        let manifest_stat = file_stat_for_path(&dir.join("manifest.json"), "manifest.json".to_string());
        let slide_stat = file_stat_for_path(&dir.join("slide01.html"), "slide01.html".to_string());

        fs::write(dir.join("slide01.html"), "external").unwrap();

        let result = save_ppt_extra(
            dir.to_string_lossy().to_string(),
            r#"{"title":"Changed","slides":[{"file":"slide01.html","title":"One"}]}"#.to_string(),
            vec![("slide01.html".to_string(), "editor".to_string())],
            Some(vec![
                ExpectedFileStat {
                    path: "manifest.json".to_string(),
                    exists: Some(manifest_stat.exists),
                    mtime_ms: manifest_stat.mtime_ms,
                    size: manifest_stat.size,
                    content_hash: manifest_stat.content_hash,
                },
                ExpectedFileStat {
                    path: "slide01.html".to_string(),
                    exists: Some(slide_stat.exists),
                    mtime_ms: slide_stat.mtime_ms,
                    size: slide_stat.size,
                    content_hash: slide_stat.content_hash,
                },
            ]),
        )
        .unwrap();

        assert_eq!(result.conflicts, vec!["slide01.html"]);
        assert_eq!(fs::read_to_string(dir.join("slide01.html")).unwrap(), "external");
        assert_eq!(fs::read_to_string(dir.join("manifest.json")).unwrap(), manifest);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn gitee_repo_name_is_filesystem_and_remote_safe() {
        assert_eq!(sanitize_gitee_repo_name("  My PPTE: Demo/2026  "), "my-ppte-demo-2026");
        assert!(sanitize_gitee_repo_name("...").starts_with("ppte-"));
        assert!(sanitize_gitee_repo_name("中文课件").starts_with("ppte-"));
        assert_ne!(sanitize_gitee_repo_name("中文课件"), sanitize_gitee_repo_name("另一个课件"));
    }

    #[test]
    fn ppte_gitignore_is_created_and_preserves_existing_rules() {
        let dir = unique_temp_dir("gitignore");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".gitignore"), "custom-secret.txt\n").unwrap();

        ensure_ppte_gitignore(&dir).unwrap();
        let content = fs::read_to_string(dir.join(".gitignore")).unwrap();

        assert!(content.contains("custom-secret.txt"));
        assert!(content.contains(".DS_Store"));
        assert!(content.contains("__MACOSX/"));
        assert!(content.contains("*.tmp"));

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_ppte_resources_skips_git_and_system_files() {
        let dir = unique_temp_dir("resources");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("images")).unwrap();
        fs::write(dir.join("manifest.json"), "{}").unwrap();
        fs::write(dir.join("slide01.html"), "<html></html>").unwrap();
        fs::write(dir.join("slide01.note"), "").unwrap();
        fs::write(dir.join("images").join("cover.png"), "png").unwrap();
        fs::write(dir.join(".DS_Store"), "noise").unwrap();
        fs::write(dir.join(".git").join("config"), "secret").unwrap();

        let resources = list_ppte_resources(dir.to_string_lossy().to_string()).unwrap();
        let paths: Vec<String> = resources.into_iter().map(|entry| entry.path).collect();

        assert!(paths.contains(&"manifest.json".to_string()));
        assert!(paths.contains(&"slide01.html".to_string()));
        assert!(paths.contains(&"slide01.note".to_string()));
        assert!(paths.contains(&"images/cover.png".to_string()));
        assert!(!paths.iter().any(|path| path.contains(".git")));
        assert!(!paths.contains(&".DS_Store".to_string()));

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_ppte_resources_copies_into_resources_without_overwrite() {
        let dir = unique_temp_dir("resource-import");
        let source_dir = unique_temp_dir("resource-source");
        fs::create_dir_all(dir.join("resources")).unwrap();
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(dir.join("resources").join("cover.png"), "existing").unwrap();
        fs::write(source_dir.join("cover.png"), "new").unwrap();

        let imported = import_ppte_resources(
            dir.to_string_lossy().to_string(),
            vec![source_dir.join("cover.png").to_string_lossy().to_string()],
        )
        .unwrap();

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].path, "resources/cover-1.png");
        assert_eq!(fs::read_to_string(dir.join("resources").join("cover.png")).unwrap(), "existing");
        assert_eq!(fs::read_to_string(dir.join("resources").join("cover-1.png")).unwrap(), "new");

        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(source_dir).unwrap();
    }

    #[test]
    fn ppte_git_init_strips_credential_remote_urls() {
        let dir = unique_temp_dir("git-remote");
        fs::create_dir_all(&dir).unwrap();

        ppte_git_init(
            dir.to_string_lossy().to_string(),
            Some("https://oauth2:token@gitee.com/user/repo.git".to_string()),
        )
        .unwrap();

        let remote = run_git(&dir, &["remote", "get-url", "origin"]).unwrap();
        assert_eq!(remote, "https://gitee.com/user/repo.git");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ppte_git_init_converts_gitee_ssh_remote_to_https() {
        let dir = unique_temp_dir("git-ssh-remote");
        fs::create_dir_all(&dir).unwrap();

        ppte_git_init(
            dir.to_string_lossy().to_string(),
            Some("git@gitee.com:user/repo.git".to_string()),
        )
        .unwrap();

        let remote = run_git(&dir, &["remote", "get-url", "origin"]).unwrap();
        assert_eq!(remote, "https://gitee.com/user/repo.git");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ppte_git_sync_converts_existing_gitee_ssh_origin_to_https() {
        let dir = unique_temp_dir("git-existing-ssh-origin");
        fs::create_dir_all(&dir).unwrap();
        run_git(&dir, &["init"]).unwrap();
        run_git(&dir, &["config", "user.name", "Test User"]).unwrap();
        run_git(&dir, &["config", "user.email", "test@example.invalid"]).unwrap();
        run_git(&dir, &["remote", "add", "origin", "git@gitee.com:user/repo.git"]).unwrap();

        let result = ppte_git_sync(dir.to_string_lossy().to_string(), Some("backup".to_string()));
        assert!(result.is_err());

        let remote = run_git(&dir, &["remote", "get-url", "origin"]).unwrap();
        assert_eq!(remote, "https://gitee.com/user/repo.git");

        fs::remove_dir_all(dir).unwrap();
    }
}

#[tauri::command]
async fn test_ai_config(
    provider: String,
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let result = call_ai_with_config(
        provider,
        api_key,
        api_type,
        base_url,
        model,
        "你是一个连通性测试助手。".to_string(),
        "请只回复 OK".to_string(),
    ).await?;

    if result.trim().is_empty() {
        Err("AI 响应为空".to_string())
    } else {
        Ok(result)
    }
}

#[tauri::command]
async fn call_ai(
    provider: String,
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    system_prompt: String,
    user_msg: String,
) -> Result<String, String> {
    call_ai_with_config(provider, api_key, api_type, base_url, model, system_prompt, user_msg).await
}

async fn call_ai_with_config(
    provider: String,
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    system_prompt: String,
    user_msg: String,
) -> Result<String, String> {
    match provider.as_str() {
        "deepseek" => call_deepseek(api_key, system_prompt, user_msg).await,
        "minimax" => call_minimax(api_key, system_prompt, user_msg).await,
        "lectureai" => call_lectureai(api_key, system_prompt, user_msg).await,
        "custom" => call_custom_ai(api_key, api_type, base_url, model, system_prompt, user_msg).await,
        _ => Err("不支持的AI提供商".to_string()),
    }
}

#[tauri::command]
async fn call_ai_stream(
    app_handle: tauri::AppHandle,
    provider: String,
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    system_prompt: String,
    user_msg: String,
) -> Result<(), String> {
    match provider.as_str() {
        "minimax" => call_minimax_stream(app_handle, api_key, system_prompt, user_msg).await,
        "custom" => call_custom_ai_stream(app_handle, api_key, api_type, base_url, model, system_prompt, user_msg).await,
        "deepseek" => {
            let result = call_deepseek(api_key, system_prompt, user_msg).await?;
            app_handle.emit("ai-stream-chunk", result).map_err(|e| e.to_string())?;
            app_handle.emit("ai-stream-done", "").map_err(|e| e.to_string())?;
            Ok(())
        },
        "lectureai" => {
            // LectureAI: use non-streaming, then emit complete result
            let result = call_lectureai(api_key, system_prompt, user_msg).await?;
            app_handle.emit("ai-stream-chunk", result).map_err(|e| e.to_string())?;
            app_handle.emit("ai-stream-done", "").map_err(|e| e.to_string())?;
            Ok(())
        },
        _ => Err("该提供商不支持流式输出".to_string()),
    }
}

fn join_api_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let suffix = path.trim_start_matches('/');
    if trimmed.ends_with(suffix) {
        trimmed.to_string()
    } else if let Some(rest) = suffix.strip_prefix("v1/") {
        if trimmed.ends_with("/v1") || trimmed.ends_with("/v1/") {
            format!("{}/{}", trimmed.trim_end_matches('/'), rest)
        } else {
            format!("{}/{}", trimmed, suffix)
        }
    } else {
        format!("{}/{}", trimmed, suffix)
    }
}

fn normalize_custom_api_config(
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<(String, String, String), String> {
    let api_type = api_type.unwrap_or_else(|| "openai-chat".to_string());
    let base_url = base_url
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "请配置 AI Base URL".to_string())?;
    let model = model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "gpt-5.5".to_string());
    Ok((api_type, base_url, model))
}

async fn call_custom_ai(
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    system_prompt: String,
    user_msg: String,
) -> Result<String, String> {
    let (api_type, base_url, model) = normalize_custom_api_config(api_type, base_url, model)?;
    match api_type.as_str() {
        "openai-chat" => call_openai_chat(api_key, base_url, model, system_prompt, user_msg, false).await,
        "openai-responses" => call_openai_responses(api_key, base_url, model, system_prompt, user_msg, false).await,
        "anthropic-messages" => call_anthropic_messages(api_key, base_url, model, system_prompt, user_msg, false).await,
        _ => Err("不支持的 API 类型".to_string()),
    }
}

async fn call_custom_ai_stream(
    app_handle: tauri::AppHandle,
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    system_prompt: String,
    user_msg: String,
) -> Result<(), String> {
    let result = call_custom_ai(api_key, api_type, base_url, model, system_prompt, user_msg).await?;
    app_handle.emit("ai-stream-chunk", result).map_err(|e| e.to_string())?;
    app_handle.emit("ai-stream-done", "").map_err(|e| e.to_string())?;
    Ok(())
}

async fn call_openai_chat(
    api_key: String,
    base_url: String,
    model: String,
    system_prompt: String,
    user_msg: String,
    stream: bool,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg}
        ],
        "stream": stream
    });

    let response = client
        .post(join_api_url(&base_url, "/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    parse_openai_chat_response(response).await
}

async fn call_openai_responses(
    api_key: String,
    base_url: String,
    model: String,
    system_prompt: String,
    user_msg: String,
    stream: bool,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg}
        ],
        "stream": stream
    });

    let response = client
        .post(join_api_url(&base_url, "/v1/responses"))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    parse_openai_responses_response(response).await
}

async fn call_anthropic_messages(
    api_key: String,
    base_url: String,
    model: String,
    system_prompt: String,
    user_msg: String,
    stream: bool,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4000,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": user_msg}]}
        ],
        "stream": stream
    });

    let response = client
        .post(join_api_url(&base_url, "/v1/messages"))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    parse_anthropic_messages_response(response).await
}

async fn parse_openai_chat_response(response: reqwest::Response) -> Result<String, String> {
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误 {}: {}", status, error_text));
    }
    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
    data["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "响应格式错误".to_string())
}

async fn parse_openai_responses_response(response: reqwest::Response) -> Result<String, String> {
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误 {}: {}", status, error_text));
    }
    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
    if let Some(text) = data["output_text"].as_str() {
        return Ok(text.to_string());
    }
    if let Some(output) = data["output"].as_array() {
        let mut text = String::new();
        for item in output {
            if let Some(content) = item["content"].as_array() {
                for part in content {
                    if let Some(value) = part["text"].as_str() {
                        text.push_str(value);
                    }
                }
            }
        }
        if !text.is_empty() {
            return Ok(text);
        }
    }
    Err("响应格式错误".to_string())
}

async fn parse_anthropic_messages_response(response: reqwest::Response) -> Result<String, String> {
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误 {}: {}", status, error_text));
    }
    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
    if let Some(content_array) = data["content"].as_array() {
        let mut text = String::new();
        for item in content_array {
            if item["type"] == "text" {
                if let Some(value) = item["text"].as_str() {
                    text.push_str(value);
                }
            }
        }
        if !text.is_empty() {
            return Ok(text);
        }
    }
    Err("响应格式错误".to_string())
}

async fn call_deepseek(api_key: String, system_prompt: String, user_msg: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg}
        ],
        "stream": false
    });

    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误 {}: {}", status, error_text));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;

    data["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "响应格式错误".to_string())
}

async fn call_minimax(api_key: String, system_prompt: String, user_msg: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "MiniMax-M2.5",
        "max_tokens": 4000,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": user_msg}]}
        ]
    });

    let response = client
        .post("https://api.minimaxi.com/anthropic/v1/messages")
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误 {}: {}", status, error_text));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;

    // MINIMAX返回格式: content是数组,包含type为text的对象
    if let Some(content_array) = data["content"].as_array() {
        for item in content_array {
            if item["type"] == "text" {
                if let Some(text) = item["text"].as_str() {
                    return Ok(text.to_string());
                }
            }
        }
    }

    Err("响应格式错误".to_string())
}

async fn call_lectureai(auth_token: String, system_prompt: String, user_msg: String) -> Result<String, String> {
    // Check login before making request
    if auth_token.is_empty() {
        return Err("请先登录后才能使用 LectureAI".to_string());
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "system_prompt": system_prompt,
        "user_msg": user_msg
    });

    let response = client
        .post("https://design.hz-study-system.com/api/ai/chat")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", auth_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error_text = response.text().await.unwrap_or_default();
        return match status {
            401 => Err("请先登录后才能使用 LectureAI".to_string()),
            403 => Err("账号已被禁用，请联系管理员".to_string()),
            429 => {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&error_text) {
                    if let Some(detail) = json.get("detail").and_then(|d| d.as_str()) {
                        return Err(detail.to_string());
                    }
                }
                Err("今日 AI 使用次数已达上限，请明天再试或升级会员".to_string())
            },
            503 => Err("AI 服务暂未配置，请联系管理员".to_string()),
            _ => Err(format!("AI 服务错误 ({})", status)),
        };
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;

    data.get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "响应格式错误".to_string())
}

async fn call_minimax_stream(
    app_handle: tauri::AppHandle,
    api_key: String,
    system_prompt: String,
    user_msg: String,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "MiniMax-M2.5",
        "max_tokens": 4000,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": user_msg}]}
        ],
        "stream": true
    });

    let response = client
        .post("https://api.minimaxi.com/anthropic/v1/messages")
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("API错误: {}", response.status()));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);

        buffer.push_str(&text);

        for line in buffer.lines() {
            if line.starts_with("data: ") {
                let json_str = &line[6..];
                if json_str == "[DONE]" {
                    continue;
                }

                if let Ok(data) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if data["type"] == "content_block_delta" {
                        if let Some(delta_text) = data["delta"]["text"].as_str() {
                            let _ = app_handle.emit("ai-stream-chunk", delta_text);
                        }
                    }
                }
            }
        }

        if let Some(last_newline) = buffer.rfind('\n') {
            buffer = buffer[last_newline + 1..].to_string();
        }
    }

    let _ = app_handle.emit("ai-stream-done", ());
    Ok(())
}

#[tauri::command]
async fn check_update(current_version: String, server_url: String) -> Result<UpdateInfo, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/version/check?current={}", server_url, current_version);

    let response = client.get(&url).send().await.map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("服务器错误: {}", response.status()));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析失败: {}", e))?;

    Ok(UpdateInfo {
        has_update: data["has_update"].as_bool().unwrap_or(false),
        version: data["version"].as_str().map(|s| s.to_string()),
        download_url: data["download_url"].as_str().map(|s| s.to_string()),
        changelog: data["changelog"].as_str().map(|s| s.to_string()),
        force_update: data["force_update"].as_bool(),
    })
}

#[tauri::command]
async fn fetch_notifications(current_version: String, server_url: String) -> Result<Vec<Notification>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/notifications?version={}", server_url, current_version);

    let response = client.get(&url).send().await.map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("服务器错误: {}", response.status()));
    }

    let notifications: Vec<Notification> = response.json().await.map_err(|e| format!("解析失败: {}", e))?;
    Ok(notifications)
}

// === Speaker Mode Commands ===

#[tauri::command]
async fn open_audience_window(app_handle: tauri::AppHandle, slide_url: String, title: String) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    // Close existing audience window if any
    if let Some(window) = app_handle.get_webview_window("audience") {
        let _ = window.close();
    }

    // Create new audience window — audience.html is in frontendDist (src/)
    WebviewWindowBuilder::new(
        &app_handle,
        "audience",
        WebviewUrl::App("audience.html".into()),
    )
    .title(&title)
    .inner_size(1280.0, 720.0)
    .build()
    .map_err(|e| e.to_string())?;

    // Send initial slide URL after a short delay to let the window load
    let app_handle_clone = app_handle.clone();
    let slide_url_clone = slide_url.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = app_handle_clone.emit("slide-change", slide_url_clone);
    });

    Ok(())
}

#[tauri::command]
async fn close_audience_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("audience") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn emit_slide_change(app_handle: tauri::AppHandle, slide_url: String) -> Result<(), String> {
    app_handle
        .emit("slide-change", slide_url)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(PpteWatcherState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .register_uri_scheme_protocol("slide", |_app, request| {
            // Custom protocol that preserves path separators for correct relative URL resolution.
            // Unlike the built-in asset protocol (convertFileSrc), this handles /Users/.../dir/file.html
            // so that relative resources like style.css resolve to /Users/.../dir/style.css.
            let url = request.uri();
            let url_path = url.path();
            // URL path: /absolute/path/to/slide.html (with real slashes)
            // Decode each segment but preserve path structure
            let decoded = percent_encoding::percent_decode_str(url_path)
                .decode_utf8_lossy()
                .to_string();

            let file_path = normalize_protocol_path(&decoded);

            match fs::read(&file_path) {
                Ok(content) => {
                    let mime = mime_guess::from_path(&file_path)
                        .first_or_octet_stream()
                        .to_string();
                    let body = inject_slide_bridge(&file_path, content);
                    http::Response::builder()
                        .status(200)
                        .header("Content-Type", &mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(body)
                        .unwrap()
                }
                Err(e) => {
                    eprintln!("[slide://] File not found: {} (error: {})", file_path, e);
                    http::Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain")
                        .body(format!("File not found: {}", file_path).into_bytes())
                        .unwrap()
                }
            }
        })
        .register_uri_scheme_protocol("media", |_app, request| {
            let url_path = request.uri().path();
            let decoded = percent_encoding::percent_decode_str(url_path)
                .decode_utf8_lossy()
                .to_string();
            let file_path = normalize_protocol_path(&decoded);
            let range = request
                .headers()
                .get("range")
                .and_then(|value| value.to_str().ok());
            media_response(&file_path, range)
        })
        .invoke_handler(tauri::generate_handler![
            read_app_config,
            read_course_config,
            resolve_asset_path,
            read_file_bytes,
            read_text_file,
            write_text_file,
            save_pptx_file,
            list_ppt_templates,
            get_template_files,
            save_app_config,
            save_course_config,
            get_app_data_dir,
            pick_files,
            pick_folder,
            import_course,
            export_template,
            open_external,
            detect_terminal,
            detect_python,
            run_in_terminal,
            create_ppt_extra_folder,
            stat_files,
            list_ppte_resources,
            import_ppte_resources,
            watch_ppte_folder,
            unwatch_ppte_folder,
            save_ppt_extra,
            gitee_token_status,
            gitee_token_set,
            gitee_token_clear,
            gitee_create_repo,
            ppte_git_info,
            ppte_git_init,
            ppte_git_sync,
            call_ai,
            call_ai_stream,
            test_ai_config,
            check_update,
            fetch_notifications,
            open_audience_window,
            close_audience_window,
            emit_slide_change,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
