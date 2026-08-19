use serde::{Deserialize, Serialize};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, Emitter};
use reqwest;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Component, Path};
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const GITEE_KEYRING_SERVICE: &str = "Lecture Presenter";
const GITEE_KEYRING_USER: &str = "gitee-access-token";
const CAPTION_KEYRING_SERVICE: &str = "Lecture Presenter";
const CAPTION_KEYRING_USER: &str = "aliyun-bailian-caption-api-key";
const CAPTION_WS_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

#[derive(Clone, Default)]
struct LiveCaptionState {
    active: Arc<tokio::sync::Mutex<Option<ActiveCaptionSession>>>,
}

#[derive(Clone)]
struct ActiveCaptionSession {
    id: String,
    sender: mpsc::Sender<CaptionCommand>,
}

enum CaptionCommand {
    Audio(Vec<u8>),
    Stop,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptionStatusPayload {
    state: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptionResultPayload {
    text: String,
    is_final: bool,
    sentence_id: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptionModel {
    FunAsr,
    Paraformer,
}

impl CaptionModel {
    fn from_setting(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("fun-asr-realtime") {
            "fun-asr-realtime" => Ok(Self::FunAsr),
            "paraformer-realtime-v2" => Ok(Self::Paraformer),
            _ => Err("不支持的实时字幕识别模型".to_string()),
        }
    }

    fn model_id(self) -> &'static str {
        match self {
            Self::FunAsr => "fun-asr-realtime",
            Self::Paraformer => "paraformer-realtime-v2",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::FunAsr => "Fun-ASR",
            Self::Paraformer => "Paraformer（去语气词）",
        }
    }
}

fn caption_final_only(value: Option<&str>) -> Result<bool, String> {
    match value.unwrap_or("realtime") {
        "realtime" => Ok(false),
        "stable" => Ok(true),
        _ => Err("不支持的字幕显示方式".to_string()),
    }
}

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
    // Optional id of the group this course belongs to (None = ungrouped)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CourseGroup {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
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
    // Version the user chose to ignore; skipped in future update checks
    #[serde(default, rename = "ignoredUpdateVersion", skip_serializing_if = "Option::is_none")]
    pub ignored_update_version: Option<String>,
    #[serde(default, rename = "localPpteAgentEnabled", skip_serializing_if = "Option::is_none")]
    pub local_ppte_agent_enabled: Option<bool>,
    #[serde(default, rename = "localPpteAgentPath", skip_serializing_if = "Option::is_none")]
    pub local_ppte_agent_path: Option<String>,
    #[serde(default, rename = "captionModel", skip_serializing_if = "Option::is_none")]
    pub caption_model: Option<String>,
    #[serde(default, rename = "captionDisplayMode", skip_serializing_if = "Option::is_none")]
    pub caption_display_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<CourseGroup>>,
}

#[derive(Serialize)]
struct LocalPpteAgentStatus {
    enabled: bool,
    configured: bool,
    agent_path: Option<String>,
    node_path: Option<String>,
    ready: bool,
    message: String,
}

#[derive(Serialize)]
struct LocalPpteAgentLaunch {
    job_dir: String,
    output_dir: String,
    pid: u32,
    log_file: String,
}

#[derive(Serialize)]
struct AuthApiResponse {
    ok: bool,
    status: u16,
    data: serde_json::Value,
}

fn auth_api_spec(action: &str) -> Result<(reqwest::Method, &'static str), String> {
    match action {
        "captcha" => Ok((reqwest::Method::GET, "/api/web/auth/captcha")),
        "login" => Ok((reqwest::Method::POST, "/api/web/auth/login")),
        "register" => Ok((reqwest::Method::POST, "/api/web/auth/register")),
        "me" => Ok((reqwest::Method::GET, "/api/web/auth/me")),
        _ => Err("不支持的认证操作".to_string()),
    }
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

#[tauri::command]
async fn auth_api_request(
    app_handle: tauri::AppHandle,
    action: String,
    payload: Option<serde_json::Value>,
    token: Option<String>,
) -> Result<AuthApiResponse, String> {
    let config = read_app_config(app_handle)?;
    let server = config
        .auth_server
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://design.hz-study-system.com")
        .trim_end_matches('/');
    let (method, path) = auth_api_spec(&action)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("无法创建认证请求：{}", e))?;
    let mut request = client.request(method, format!("{}{}", server, path));

    if let Some(value) = payload {
        request = request.json(&value);
    }
    if let Some(value) = token.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(value);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("认证服务连接失败：{}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("认证服务响应读取失败：{}", e))?;
    let data = serde_json::from_str(&text).unwrap_or_else(|_| {
        serde_json::json!({
            "detail": if text.trim().is_empty() { "认证服务返回了空响应" } else { text.trim() }
        })
    });

    Ok(AuthApiResponse {
        ok: status.is_success(),
        status: status.as_u16(),
        data,
    })
}

#[cfg(test)]
mod auth_api_tests {
    use super::*;

    #[test]
    fn auth_actions_are_restricted_to_known_web_routes() {
        assert_eq!(
            auth_api_spec("login").unwrap(),
            (reqwest::Method::POST, "/api/web/auth/login")
        );
        assert_eq!(
            auth_api_spec("captcha").unwrap(),
            (reqwest::Method::GET, "/api/web/auth/captcha")
        );
        assert!(auth_api_spec("https://example.com").is_err());
    }
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
                    group: None,
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
                    group: None,
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

// ── Workbench skills ──────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PpteSkillInfo {
    id: String,
    name: String,
    description: String,
    source: String,
    source_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PpteSkillDocument {
    info: PpteSkillInfo,
    content: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PpteSkillImportResult {
    imported: Vec<PpteSkillInfo>,
    skipped: Vec<String>,
    destination: String,
}

fn valid_skill_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn parse_skill_frontmatter(content: &str) -> Result<(String, String), String> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return Err("SKILL.md 缺少 YAML frontmatter".to_string());
    }
    let mut name = String::new();
    let mut description = String::new();
    let mut closed = false;
    let mut index = 1;
    while index < lines.len() {
        let raw_line = lines[index];
        let line = raw_line.trim();
        if line == "---" {
            closed = true;
            break;
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = value.trim().trim_matches(['\'', '"']).to_string();
        } else if let Some(value) = line.strip_prefix("description:") {
            let value = value.trim();
            if matches!(value, "|" | ">") {
                let folded = value == ">";
                let mut parts = Vec::new();
                index += 1;
                while index < lines.len() {
                    let continuation = lines[index];
                    let indented = continuation.starts_with(' ') || continuation.starts_with('\t');
                    if continuation.trim() == "---" || (!continuation.trim().is_empty() && !indented) {
                        index = index.saturating_sub(1);
                        break;
                    }
                    if !continuation.trim().is_empty() {
                        parts.push(continuation.trim());
                    }
                    index += 1;
                }
                description = parts.join(if folded { " " } else { "\n" });
            } else {
                description = value.trim_matches(['\'', '"']).to_string();
            }
        }
        index += 1;
    }
    if !closed {
        return Err("SKILL.md frontmatter 未闭合".to_string());
    }
    if !valid_skill_name(&name) {
        return Err("skill name 只能使用小写字母、数字和连字符，最长 64 字符".to_string());
    }
    if description.is_empty() {
        return Err("SKILL.md 缺少 description".to_string());
    }
    Ok((name, description))
}

fn discover_skills_in_root(source: &str, source_label: &str, root: &Path) -> Vec<PpteSkillInfo> {
    let canonical_root = match root.canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => return Vec::new(),
    };
    let mut skills = Vec::new();
    let entries = match fs::read_dir(&canonical_root) {
        Ok(entries) => entries,
        Err(_) => return skills,
    };
    for entry in entries.flatten() {
        let folder_name = entry.file_name().to_string_lossy().to_string();
        if !valid_skill_name(&folder_name) {
            continue;
        }
        let folder = match entry.path().canonicalize() {
            Ok(path) if path.starts_with(&canonical_root) && path.is_dir() => path,
            _ => continue,
        };
        let skill_path = folder.join("SKILL.md");
        let content = match fs::read_to_string(&skill_path) {
            Ok(content) if content.len() <= 128 * 1024 => content,
            _ => continue,
        };
        let (name, description) = match parse_skill_frontmatter(&content) {
            Ok(metadata) if metadata.0 == folder_name => metadata,
            _ => continue,
        };
        skills.push(PpteSkillInfo {
            id: format!("{}:{}", source, name),
            name,
            description,
            source: source.to_string(),
            source_label: source_label.to_string(),
        });
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    skills
}

fn skill_roots(app_handle: &tauri::AppHandle, folder_path: Option<&str>) -> Result<Vec<(String, String, PathBuf)>, String> {
    let mut roots = Vec::new();
    if let Some(folder_path) = folder_path.filter(|value| !value.trim().is_empty()) {
        let deck = canonical_ppte_root(folder_path)?;
        if deck.join("manifest.json").is_file() {
            let deck_skills = deck.join(".lectureai").join("skills");
            if !deck_skills.exists() || deck_skills.canonicalize().map(|path| path.starts_with(&deck)).unwrap_or(false) {
                roots.push(("deck".to_string(), "外接 · 当前课件".to_string(), deck_skills));
            }
        }
    }
    let app_data = app_handle.path().app_data_dir().map_err(|error| error.to_string())?;
    roots.push(("user".to_string(), "外接 · 用户导入".to_string(), app_data.join("skills")));
    Ok(roots)
}

#[tauri::command]
fn ppte_skill_list(app_handle: tauri::AppHandle, folder_path: Option<String>) -> Result<Vec<PpteSkillInfo>, String> {
    let roots = skill_roots(&app_handle, folder_path.as_deref())?;
    let mut skills = Vec::new();
    let mut ids = HashSet::new();
    for (source, label, root) in roots {
        for skill in discover_skills_in_root(&source, &label, &root) {
            if ids.insert(skill.id.clone()) {
                skills.push(skill);
            }
        }
    }
    Ok(skills)
}

fn collect_skill_text_files(root: &Path, current: &Path, output: &mut Vec<String>, depth: usize) {
    if depth > 2 || output.len() >= 100 {
        return;
    }
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "SKILL.md" {
            continue;
        }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        if metadata.is_dir() {
            collect_skill_text_files(root, &path, output, depth + 1);
        } else if metadata.is_file() && metadata.len() <= 256 * 1024 {
            if let Ok(relative) = path.strip_prefix(root) {
                let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
                if matches!(extension.as_str(), "md" | "txt" | "json" | "yaml" | "yml" | "toml" | "html" | "css" | "js" | "ts" | "py" | "sh") {
                    output.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

fn resolve_skill_folder(
    app_handle: &tauri::AppHandle,
    folder_path: Option<&str>,
    skill_id: &str,
) -> Result<(PpteSkillInfo, PathBuf), String> {
    let (wanted_source, wanted_name) = skill_id.split_once(':').ok_or_else(|| "skillId 格式错误".to_string())?;
    if !valid_skill_name(wanted_name) || !matches!(wanted_source, "deck" | "user") {
        return Err("skillId 不安全".to_string());
    }
    for (source, label, root) in skill_roots(app_handle, folder_path)? {
        if source != wanted_source {
            continue;
        }
        let canonical_root = match root.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        let folder = match canonical_root.join(wanted_name).canonicalize() {
            Ok(path) if path.starts_with(&canonical_root) && path.is_dir() => path,
            _ => continue,
        };
        let content = fs::read_to_string(folder.join("SKILL.md")).map_err(|error| error.to_string())?;
        let (name, description) = parse_skill_frontmatter(&content)?;
        if name != wanted_name {
            return Err("skill 目录名与 frontmatter name 不一致".to_string());
        }
        return Ok((PpteSkillInfo {
            id: skill_id.to_string(),
            name,
            description,
            source,
            source_label: label,
        }, folder));
    }
    Err(format!("未找到 skill：{}", skill_id))
}

#[tauri::command]
fn ppte_skill_read(
    app_handle: tauri::AppHandle,
    folder_path: Option<String>,
    skill_id: String,
    relative_path: Option<String>,
) -> Result<PpteSkillDocument, String> {
    let (info, folder) = resolve_skill_folder(&app_handle, folder_path.as_deref(), &skill_id)?;
    let relative = relative_path.unwrap_or_else(|| "SKILL.md".to_string());
    let safe_relative = ppte_safe_relative_path(&relative)?;
    let target = folder.join(&safe_relative).canonicalize()
        .map_err(|error| format!("无法读取 skill 文件：{}", error))?;
    if !target.starts_with(&folder) || !target.is_file() {
        return Err("skill 文件路径越界".to_string());
    }
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.len() > 256 * 1024 {
        return Err("skill 文本文件不能超过 256KB".to_string());
    }
    let content = fs::read_to_string(&target).map_err(|_| "skill 资源必须是 UTF-8 文本".to_string())?;
    let mut files = Vec::new();
    collect_skill_text_files(&folder, &folder, &mut files, 0);
    files.sort();
    Ok(PpteSkillDocument { info, content, files })
}

fn skill_import_candidates(source_path: &Path) -> Result<Vec<PathBuf>, String> {
    if fs::symlink_metadata(source_path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("不能从符号链接目录导入 SKILL".to_string());
    }
    let source = source_path.canonicalize().map_err(|error| format!("无法读取所选目录：{}", error))?;
    if !source.is_dir() {
        return Err("请选择 SKILL 目录或 skills 根目录".to_string());
    }
    if source.join("SKILL.md").is_file() {
        return Ok(vec![source]);
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&source).map_err(|error| error.to_string())?.flatten() {
        if fs::symlink_metadata(entry.path())
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let path = match entry.path().canonicalize() {
            Ok(path) if path.is_dir() && path.join("SKILL.md").is_file() => path,
            _ => continue,
        };
        candidates.push(path);
    }
    candidates.sort();
    if candidates.is_empty() {
        return Err("所选目录中没有找到 SKILL.md；可选择单个技能目录，或包含多个技能目录的根目录".to_string());
    }
    Ok(candidates)
}

fn copy_imported_skill_tree(
    source: &Path,
    destination: &Path,
    depth: usize,
    file_count: &mut usize,
    total_bytes: &mut u64,
) -> Result<(), String> {
    if depth > 8 {
        return Err("SKILL 目录层级不能超过 8 层".to_string());
    }
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())?.flatten() {
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if matches!(name_text.as_ref(), ".git" | ".DS_Store" | "__pycache__") {
            continue;
        }
        let source_item = entry.path();
        let metadata = fs::symlink_metadata(&source_item).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!("SKILL 包含符号链接，已拒绝导入：{}", source_item.display()));
        }
        let destination_item = destination.join(name);
        if metadata.is_dir() {
            copy_imported_skill_tree(&source_item, &destination_item, depth + 1, file_count, total_bytes)?;
        } else if metadata.is_file() {
            *file_count += 1;
            *total_bytes = total_bytes.saturating_add(metadata.len());
            if *file_count > 2_000 {
                return Err("单个 SKILL 文件数不能超过 2000".to_string());
            }
            if metadata.len() > 20 * 1024 * 1024 {
                return Err(format!("SKILL 单个文件不能超过 20MB：{}", source_item.display()));
            }
            if *total_bytes > 50 * 1024 * 1024 {
                return Err("单个 SKILL 总大小不能超过 50MB".to_string());
            }
            fs::copy(&source_item, &destination_item).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn import_skills_into_root(source_path: &Path, destination_root: &Path) -> Result<PpteSkillImportResult, String> {
    let candidates = skill_import_candidates(source_path)?;
    fs::create_dir_all(destination_root).map_err(|error| error.to_string())?;
    let canonical_destination = destination_root.canonicalize().map_err(|error| error.to_string())?;
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    for candidate in candidates {
        let content = match fs::read_to_string(candidate.join("SKILL.md")) {
            Ok(content) if content.len() <= 128 * 1024 => content,
            Ok(_) => {
                skipped.push(format!("{}：SKILL.md 超过 128KB", candidate.display()));
                continue;
            }
            Err(error) => {
                skipped.push(format!("{}：{}", candidate.display(), error));
                continue;
            }
        };
        let (name, description) = match parse_skill_frontmatter(&content) {
            Ok(metadata) => metadata,
            Err(error) => {
                skipped.push(format!("{}：{}", candidate.display(), error));
                continue;
            }
        };
        let destination = canonical_destination.join(&name);
        if destination.exists() {
            skipped.push(format!("{}：同名技能已存在，未覆盖", name));
            continue;
        }
        let staging = canonical_destination.join(format!(".skill-import-{}-{}", name, uuid::Uuid::new_v4()));
        let mut file_count = 0;
        let mut total_bytes = 0;
        let copy_result = copy_imported_skill_tree(&candidate, &staging, 0, &mut file_count, &mut total_bytes)
            .and_then(|_| {
                let staged_content = fs::read_to_string(staging.join("SKILL.md")).map_err(|error| error.to_string())?;
                let staged_metadata = parse_skill_frontmatter(&staged_content)?;
                if staged_metadata.0 != name {
                    return Err("导入后的 SKILL 元数据不一致".to_string());
                }
                fs::rename(&staging, &destination).map_err(|error| error.to_string())
            });
        if let Err(error) = copy_result {
            let _ = fs::remove_dir_all(&staging);
            skipped.push(format!("{}：{}", name, error));
            continue;
        }
        imported.push(PpteSkillInfo {
            id: format!("user:{}", name),
            name,
            description,
            source: "user".to_string(),
            source_label: "外接 · 用户导入".to_string(),
        });
    }
    Ok(PpteSkillImportResult {
        imported,
        skipped,
        destination: canonical_destination.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn ppte_skill_import(app_handle: tauri::AppHandle, source_path: String) -> Result<PpteSkillImportResult, String> {
    let app_data = app_handle.path().app_data_dir().map_err(|error| error.to_string())?;
    import_skills_into_root(Path::new(&source_path), &app_data.join("skills"))
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

fn extract_html_script_body(content: &[u8], requested_index: usize) -> Option<Vec<u8>> {
    let source = String::from_utf8_lossy(content);
    let lower = source.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut script_index = 0usize;

    while let Some(relative_start) = lower[cursor..].find("<script") {
        let start = cursor + relative_start;
        let name_end = start + "<script".len();
        let boundary = lower.as_bytes().get(name_end).copied();
        if !matches!(boundary, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')) {
            cursor = name_end;
            continue;
        }
        let open_end = lower[name_end..].find('>')? + name_end;
        let body_start = open_end + 1;
        let close_start = lower[body_start..].find("</script")? + body_start;
        let close_end = lower[close_start..].find('>')? + close_start + 1;
        if script_index == requested_index {
            return Some(source.as_bytes()[body_start..close_start].to_vec());
        }
        script_index += 1;
        cursor = close_end;
    }
    None
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
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    fs::write(&file_path, &content).map_err(|e| format!("Failed to write {}: {}", file_path, e))
}

fn ppte_agent_revision(folder_path: &str) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|e| format!("无法读取 PPTE 目录：{}", e))?;
    let manifest_path = root.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|e| format!("无法读取 manifest.json：{}", e))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("manifest.json 格式错误：{}", e))?;
    let slides = manifest.get("slides").and_then(|value| value.as_array())
        .ok_or_else(|| "manifest.json 中 slides 必须是数组".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(b"lectureai-deck-revision-v1\0");
    hasher.update(manifest.get("title").and_then(|value| value.as_str()).unwrap_or("").as_bytes());
    hasher.update(b"\0");
    let mut slide_files = Vec::new();
    for (index, slide) in slides.iter().enumerate() {
        let relative = slide.as_str()
            .or_else(|| slide.get("file").and_then(|value| value.as_str()))
            .ok_or_else(|| format!("第 {} 页缺少 file", index + 1))?;
        let default_title = format!("第 {} 页", index + 1);
        let title = slide.get("title").and_then(|value| value.as_str()).unwrap_or(&default_title);
        let raw_type = slide.get("slide_type")
            .or_else(|| slide.get("type"))
            .and_then(|value| value.as_str())
            .unwrap_or(if index == 0 { "cover" } else { "content" });
        let slide_type = match raw_type {
            "toc" => "catalog",
            "finish" => "ending",
            value => value,
        };
        let path = root.join(relative);
        let canonical = path.canonicalize()
            .map_err(|e| format!("无法读取幻灯片 {}：{}", relative, e))?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err(format!("幻灯片路径不安全：{}", relative));
        }
        hasher.update(relative.as_bytes());
        hasher.update(b"\0");
        hasher.update(title.as_bytes());
        hasher.update(b"\0");
        hasher.update(slide_type.as_bytes());
        hasher.update(b"\0");
        hasher.update(fs::read(&canonical).map_err(|e| format!("无法读取幻灯片 {}：{}", relative, e))?);
        hasher.update(b"\0");
        slide_files.push(relative.to_string());
    }
    Ok(serde_json::json!({
        "deckHash": format!("sha256:{:x}", hasher.finalize()),
        "slideCount": slide_files.len(),
        "slideFiles": slide_files,
    }))
}

fn ppte_agent_plan_path(folder_path: &str) -> Result<PathBuf, String> {
    let root = canonical_ppte_root(folder_path)?;
    if !root.join("manifest.json").is_file() {
        return Err("所选目录不是有效 PPTE".to_string());
    }
    let plan_dir = ppte_safe_destination(&root, Path::new(".lectureai"))?;
    if plan_dir.exists() && !plan_dir.is_dir() {
        return Err(".lectureai 必须是课件内的普通目录".to_string());
    }
    Ok(plan_dir.join("deck-plan.json"))
}

fn validate_agent_plan_value(plan: &serde_json::Value) -> Result<(), String> {
    let object = plan.as_object().ok_or_else(|| "plan 必须是对象".to_string())?;
    let target = object.get("targetSlideCount").and_then(|value| value.as_u64())
        .ok_or_else(|| "targetSlideCount 必须是整数".to_string())?;
    if target == 0 || target > 60 {
        return Err("targetSlideCount 必须为 1 至 60".to_string());
    }
    if !object.get("visualSystem").map(|value| value.is_object()).unwrap_or(false) {
        return Err("visualSystem 必须是对象".to_string());
    }
    let slides = object.get("slides").and_then(|value| value.as_array())
        .ok_or_else(|| "plan.slides 必须是数组".to_string())?;
    if slides.len() != target as usize {
        return Err(format!("targetSlideCount={} 与 slides 数量 {} 不一致", target, slides.len()));
    }
    let section_policy = object.get("sectionPolicy").and_then(|value| value.as_object());
    let explicit_sections = section_policy.and_then(|policy| policy.get("explicit")).and_then(|value| value.as_bool());
    let section_mode = section_policy.and_then(|policy| policy.get("mode")).and_then(|value| value.as_str());
    let mut chapter_count = 0usize;
    let mut catalog_count = 0usize;
    let strict_quality = object.get("qualityPolicy")
        .and_then(|value| value.get("schemaVersion"))
        .and_then(|value| value.as_u64()) == Some(2);
    let mut content_templates: Vec<String> = Vec::new();
    let mut previous_leads_to: Option<(u64, String)> = None;
    for (index, slide) in slides.iter().enumerate() {
        let page = slide.get("page").and_then(|value| value.as_u64()).unwrap_or_default();
        if page != (index + 1) as u64 {
            return Err("plan.slides.page 必须从 1 连续编号".to_string());
        }
        if slide.get("title").and_then(|value| value.as_str()).unwrap_or("").trim().is_empty() {
            return Err(format!("第 {} 项缺少 title", index + 1));
        }
        let layout = slide.get("layoutFamily")
            .or_else(|| slide.get("layout_family"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if layout.trim().is_empty() {
            return Err(format!("第 {} 项缺少 layoutFamily", index + 1));
        }
        for field in ["role", "contentKind", "motion", "visualIntent"] {
            if slide.get(field).and_then(|value| value.as_str()).unwrap_or("").trim().is_empty() {
                return Err(format!("第 {} 项缺少 {}", index + 1, field));
            }
        }
        if !slide.get("componentIds").map(|value| value.is_array()).unwrap_or(false) {
            return Err(format!("第 {} 项的 componentIds 必须是数组", index + 1));
        }
        let role = slide.get("role").and_then(|value| value.as_str()).unwrap_or("").trim().to_lowercase();
        let layout = layout.trim().to_lowercase();
        if role == "chapter" || layout == "immersive-chapter" { chapter_count += 1; }
        if role == "catalog" || role == "toc" || layout == "catalog" || layout == "toc" { catalog_count += 1; }
        if strict_quality && role == "content" {
            let narrative = slide.get("narrative").and_then(|value| value.as_object())
                .ok_or_else(|| format!("第 {} 项缺少 narrative 教学叙事", index + 1))?;
            for field in ["buildsOn", "learningGoal", "keyTakeaway", "leadsTo"] {
                if narrative.get(field).and_then(|value| value.as_str()).unwrap_or("").trim().is_empty() {
                    return Err(format!("第 {} 项的 narrative 缺少 {}", index + 1, field));
                }
            }
            let builds_on = narrative.get("buildsOn").and_then(|value| value.as_str()).unwrap_or("").trim();
            if let Some((previous_page, expected)) = &previous_leads_to {
                if expected != builds_on {
                    return Err(format!("第 {} 页 leadsTo 必须与第 {} 页 buildsOn 完全一致", previous_page, page));
                }
            }
            previous_leads_to = Some((page, narrative.get("leadsTo").and_then(|value| value.as_str()).unwrap_or("").trim().to_string()));
            let template_id = slide.get("templateId").or_else(|| slide.get("template_id"))
                .and_then(|value| value.as_str()).unwrap_or("").trim().to_string();
            if template_id.is_empty() {
                let custom_mode = slide.get("renderMode").and_then(|value| value.as_str()).unwrap_or("").eq_ignore_ascii_case("custom");
                let custom_reason = slide.get("customLayoutReason").and_then(|value| value.as_str()).unwrap_or("").trim();
                if !custom_mode || custom_reason.is_empty() {
                    return Err(format!("第 {} 项正文页必须指定 templateId，或声明 renderMode=custom 及 customLayoutReason", index + 1));
                }
                content_templates.push(String::new());
                continue;
            }
            if content_templates.iter().rev().take(2).any(|existing| existing == &template_id) {
                return Err(format!("第 {} 页在三页窗口内重复使用模板 {}", page, template_id));
            }
            content_templates.push(template_id);
        }
    }
    if strict_quality {
        let template_limit = std::cmp::max(2, (content_templates.len() + 3) / 4);
        let mut counts = std::collections::HashMap::<&str, usize>::new();
        for template_id in &content_templates { if !template_id.is_empty() { *counts.entry(template_id.as_str()).or_default() += 1; } }
        if let Some((template_id, count)) = counts.into_iter().find(|(_, count)| *count > template_limit) {
            return Err(format!("模板 {} 使用 {} 次，超过本套正文上限 {} 次", template_id, count, template_limit));
        }
    }
    if section_mode == Some("continuous") && (chapter_count > 0 || catalog_count > 0) {
        return Err(format!("用户明确要求不分章，不能包含目录页或章节过渡页（当前目录 {} 页、章节过渡 {} 页）", catalog_count, chapter_count));
    }
    if section_mode != Some("continuous") && explicit_sections == Some(false) && target <= 30 && (chapter_count > 0 || catalog_count > 0) {
        return Err(format!("{} 页课件默认不分章，不能包含目录页或章节过渡页（当前目录 {} 页、章节过渡 {} 页）", target, catalog_count, chapter_count));
    }
    if section_mode != Some("continuous") && explicit_sections == Some(false) && target > 30 {
        if chapter_count != 2 {
            return Err(format!("{} 页课件默认必须恰好包含 2 个章节过渡页，当前为 {} 个", target, chapter_count));
        }
        if catalog_count > 1 {
            return Err(format!("{} 页课件默认最多包含 1 个目录页，当前为 {} 个", target, catalog_count));
        }
    }
    Ok(())
}

fn write_agent_plan_file(folder_path: &str, mut plan: serde_json::Value) -> Result<serde_json::Value, String> {
    validate_agent_plan_value(&plan)?;
    let revision = ppte_agent_revision(folder_path)?;
    let object = plan.as_object_mut().ok_or_else(|| "plan 必须是对象".to_string())?;
    object.insert("schemaVersion".to_string(), serde_json::json!(1));
    object.insert("baseRevision".to_string(), revision);
    object.insert("status".to_string(), serde_json::json!("active"));
    object.insert("updatedAt".to_string(), serde_json::json!(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()));
    let target = ppte_agent_plan_path(folder_path)?;
    let parent = target.parent().ok_or_else(|| "无法确定规划目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建规划目录：{}", e))?;
    let temporary = parent.join("deck-plan.json.tmp");
    let backup = parent.join("deck-plan.json.bak");
    let content = serde_json::to_string_pretty(&plan).map_err(|e| e.to_string())? + "\n";
    fs::write(&temporary, content).map_err(|e| format!("无法写入规划：{}", e))?;
    let _ = fs::remove_file(&backup);
    if target.exists() {
        fs::rename(&target, &backup).map_err(|e| format!("无法备份旧规划：{}", e))?;
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法保存规划：{}", error));
    }
    let _ = fs::remove_file(&backup);
    Ok(plan)
}

#[tauri::command]
fn ppte_agent_plan_read(folder_path: String) -> Result<serde_json::Value, String> {
    let path = ppte_agent_plan_path(&folder_path)?;
    if !path.exists() {
        return Ok(serde_json::json!({"plan": null, "status": "missing"}));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("无法读取规划：{}", e))?;
    let mut plan: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Ok(serde_json::json!({"plan": {"schemaVersion": 1, "status": "invalid", "error": "规划文件损坏，可安全重新规划"}, "status": "invalid"})),
    };
    if validate_agent_plan_value(&plan).is_err() {
        if let Some(object) = plan.as_object_mut() {
            object.insert("status".to_string(), serde_json::json!("invalid"));
            object.insert("error".to_string(), serde_json::json!("规划文件格式错误，可安全重新规划"));
        }
        return Ok(serde_json::json!({"plan": plan, "status": "invalid"}));
    }
    let current = ppte_agent_revision(&folder_path)?;
    let stored_hash = plan.pointer("/baseRevision/deckHash").and_then(|value| value.as_str());
    let current_hash = current.get("deckHash").and_then(|value| value.as_str());
    let status = if stored_hash == current_hash { "active" } else { "stale" };
    if let Some(object) = plan.as_object_mut() {
        object.insert("status".to_string(), serde_json::json!(status));
        if status == "stale" {
            object.insert("currentRevision".to_string(), current);
        }
    }
    Ok(serde_json::json!({"plan": plan, "status": status}))
}

#[tauri::command]
fn ppte_agent_plan_write(folder_path: String, plan: serde_json::Value) -> Result<serde_json::Value, String> {
    write_agent_plan_file(&folder_path, plan)
}

#[tauri::command]
fn ppte_agent_plan_refresh(folder_path: String) -> Result<bool, String> {
    let path = ppte_agent_plan_path(&folder_path)?;
    if !path.exists() {
        return Ok(false);
    }
    let plan: serde_json::Value = match serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    if validate_agent_plan_value(&plan).is_err() {
        return Ok(false);
    }
    write_agent_plan_file(&folder_path, plan)?;
    Ok(true)
}

#[tauri::command]
async fn lectureai_design_examples(auth_token: String, query: serde_json::Value) -> Result<serde_json::Value, String> {
    if auth_token.trim().is_empty() {
        return Err("检索 LectureAI 设计案例需要先登录".to_string());
    }
    let response = direct_client()
        .post("https://design.hz-study-system.com/api/web/ai/design-examples/search")
        .header("Content-Type", "application/json")
        .bearer_auth(auth_token)
        .json(&query)
        .send()
        .await
        .map_err(|e| format!("设计案例服务连接失败：{}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("设计案例响应读取失败：{}", e))?;
    if !status.is_success() {
        return Err(format!("设计案例服务错误（{}）：{}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| format!("设计案例响应格式错误：{}", e))
}

#[tauri::command]
async fn lectureai_render_template(
    app_handle: tauri::AppHandle,
    auth_token: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if auth_token.trim().is_empty() {
        return Err("使用 LectureAI 私有模板需要先登录".to_string());
    }
    let config = read_app_config(app_handle)?;
    let server = config
        .auth_server
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://design.hz-study-system.com")
        .trim_end_matches('/');
    let response = direct_client()
        .post(format!("{}/api/web/ai/templates/render", server))
        .header("Content-Type", "application/json")
        .bearer_auth(auth_token)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("模板渲染服务连接失败：{}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("模板渲染响应读取失败：{}", e))?;
    if !status.is_success() {
        return Err(format!("模板渲染服务错误（{}）：{}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| format!("模板渲染响应格式错误：{}", e))
}

fn auth_server_url(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let config = read_app_config(app_handle.clone())?;
    Ok(config
        .auth_server
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://design.hz-study-system.com")
        .trim_end_matches('/')
        .to_string())
}

#[tauri::command]
async fn lectureai_icon_search(
    app_handle: tauri::AppHandle,
    auth_token: String,
    query: String,
) -> Result<serde_json::Value, String> {
    if auth_token.trim().is_empty() {
        return Err("检索图标库需要先登录".to_string());
    }
    let server = auth_server_url(&app_handle)?;
    let response = direct_client()
        .get(format!("{}/api/web/desktop/icons", server))
        .query(&[("q", query)])
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|e| format!("图标库服务连接失败：{}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("图标库响应读取失败：{}", e))?;
    if !status.is_success() {
        return Err(format!("图标库服务错误（{}）：{}", status.as_u16(), response_detail(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("图标库响应格式错误：{}", e))
}

/// Validate the requested icon file name and resolve the destination inside
/// the deck's resources/ folder. Rejects anything with directory components.
fn ppte_icon_destination(base_dir: &Path, file: &str) -> Result<(PathBuf, String), String> {
    let name = Path::new(file)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.is_empty() || name != file {
        return Err("非法的图标文件名".to_string());
    }
    let relative = format!("resources/{}", name);
    let destination = ppte_safe_destination(base_dir, Path::new(&relative))?;
    Ok((destination, relative))
}

/// Download one icon from the server-side library into the current PPTE's
/// resources/ folder, keeping decks self-contained. Returns the deck-relative
/// path for slides to reference.
#[tauri::command]
async fn ppte_download_icon(
    app_handle: tauri::AppHandle,
    folder_path: String,
    file: String,
    auth_token: String,
) -> Result<String, String> {
    if auth_token.trim().is_empty() {
        return Err("下载图标需要先登录".to_string());
    }
    let base_dir = canonical_ppte_root(&folder_path)?;
    let (destination, relative) = ppte_icon_destination(&base_dir, &file)?;
    let server = auth_server_url(&app_handle)?;
    let response = direct_client()
        .get(format!("{}/api/web/desktop/icons/{}", server, file))
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|e| format!("图标下载连接失败：{}", e))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("图标下载失败（{}）：{}", status.as_u16(), response_detail(&text)));
    }
    let bytes = response.bytes().await.map_err(|e| format!("图标内容读取失败：{}", e))?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 resources 目录失败：{}", e))?;
    }
    fs::write(&destination, &bytes).map_err(|e| format!("图标写入失败：{}", e))?;
    Ok(relative)
}


#[tauri::command]
async fn save_pptx_file(
    app_handle: tauri::AppHandle,
    default_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    save_pptx_with_dialog(&app_handle, &default_name, bytes)
}

/// Shared "save .pptx via dialog" tail: normalizes the file name, shows the
/// save dialog and writes the bytes. User cancel returns Err("cancelled").
fn save_pptx_with_dialog(
    app_handle: &tauri::AppHandle,
    default_name: &str,
    bytes: Vec<u8>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_name = if default_name.trim().is_empty() {
        "PPTE导出.pptx".to_string()
    } else if default_name.to_lowercase().ends_with(".pptx") {
        default_name.to_string()
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

/// Packs a PPTE directory into an in-memory zip (excluding .DS_Store), keeping
/// relative paths with forward slashes on every platform.
fn zip_ppte_directory(dir_path: &str) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let root = std::path::Path::new(dir_path);
    if !root.is_dir() {
        return Err(format!("PPTE 目录不存在：{}", dir_path));
    }

    let mut buf = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut buf);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|e| format!("读取目录失败 {}：{}", dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let entry_name = entry.file_name().to_string_lossy().to_lowercase();
            // .lectureai holds local agent state (deck plan, workbench chat
            // session) that the cloud renderer does not need.
            if entry_name == ".ds_store" || entry_name == "outline.md" || entry_name == ".lectureai" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            writer.start_file(rel, options).map_err(|e| e.to_string())?;
            let data = fs::read(&path)
                .map_err(|e| format!("读取文件失败 {}：{}", path.display(), e))?;
            writer.write_all(&data).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

/// Pulls the {"detail": "..."} message out of an error response body, falling
/// back to the raw text when it is not JSON.
fn response_detail(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.get("detail").and_then(|d| d.as_str()).map(|s| s.to_string()))
        .filter(|detail| !detail.trim().is_empty())
        .unwrap_or_else(|| text.to_string())
}

/// Editable PPTX export: zip the PPTE directory, upload it to the server-side
/// renderer, and save the returned pptx through the shared save dialog.
/// 401 is reported with an "unauthorized: " prefix so the frontend can pop the
/// login modal instead of a generic error.
#[tauri::command]
async fn export_pptx_editable(
    app_handle: tauri::AppHandle,
    dir_path: String,
    mode: String,
    token: String,
    server_url: String,
    default_name: String,
) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("unauthorized: 导出可编辑 PPT 需要先登录".to_string());
    }
    let zip_bytes = zip_ppte_directory(&dir_path)?;

    let server = server_url.trim_end_matches('/');
    let file_part = reqwest::multipart::Part::bytes(zip_bytes)
        .file_name("deck.zip")
        .mime_str("application/zip")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("mode", mode);

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(format!("{}/api/web/desktop/pptx-export", server))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("导出服务连接失败：{}", e))?;

    let status = response.status();
    if status.as_u16() == 401 {
        let text = response.text().await.unwrap_or_default();
        let detail = response_detail(&text);
        return Err(format!(
            "unauthorized: {}",
            if detail.trim().is_empty() { "登录状态已失效，请重新登录".to_string() } else { detail }
        ));
    }
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let detail = response_detail(&text);
        return Err(if detail.trim().is_empty() {
            format!("导出服务错误（{}）", status.as_u16())
        } else {
            detail
        });
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("导出结果读取失败：{}", e))?;
    save_pptx_with_dialog(&app_handle, &default_name, bytes.to_vec())
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
async fn pick_reference_file(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .dialog()
        .file()
        .add_filter("课程大纲", &["md", "txt", "docx", "pdf"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });

    let file = rx.recv().map_err(|e| e.to_string())?.ok_or("cancelled")?;
    file.into_path()
        .map_err(|e| e.to_string())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_reference_files(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .dialog()
        .file()
        .add_filter(
            "Agent 参考资料",
            &[
                "md", "txt", "docx", "pdf", "html", "htm", "json", "jsonl", "yaml", "yml", "csv", "tsv",
                "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "py", "js", "mjs", "ts", "tsx", "css", "sql",
            ],
        )
        .pick_files(move |files| {
            let _ = tx.send(files);
        });

    let files = rx.recv().map_err(|e| e.to_string())?.ok_or("cancelled")?;
    Ok(files
        .iter()
        .filter_map(|file| file.clone().into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
async fn pick_folder(
    app_handle: tauri::AppHandle,
    show_hidden: Option<bool>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    // On macOS the native panel hides dot-directories (e.g. `.claude`,
    // `.agents`) unless showsHiddenFiles is set; rfd does not expose that
    // option, so use AppKit directly when the caller asks for it.
    #[cfg(target_os = "macos")]
    {
        if show_hidden.unwrap_or(false) {
            return pick_folder_macos_show_hidden(&app_handle);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = show_hidden;

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

// NSOpenPanel with showsHiddenFiles enabled, so hidden directories such as
// `.claude` / `.agents` are visible when picking SKILL folders.
#[cfg(target_os = "macos")]
fn pick_folder_macos_show_hidden(app_handle: &tauri::AppHandle) -> Result<String, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .run_on_main_thread(move || {
            // Safe: run_on_main_thread executes this closure on the main thread.
            let mtm = unsafe { MainThreadMarker::new_unchecked() };
            let panel = NSOpenPanel::openPanel(mtm);
            panel.setCanChooseFiles(false);
            panel.setCanChooseDirectories(true);
            panel.setAllowsMultipleSelection(false);
            panel.setShowsHiddenFiles(true);
            let picked = if panel.runModal() == NSModalResponseOK {
                panel
                    .URLs()
                    .firstObject()
                    .and_then(|url| url.path().map(|path| path.to_string()))
            } else {
                None
            };
            let _ = tx.send(picked);
        })
        .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "cancelled".to_string())
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

    let entry = CourseEntry { id: id.clone(), path: course_path, label, created_by_app: None, group: None };
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

#[derive(Clone)]
struct PpteSharedSourceSlide {
    id: String,
    file: String,
    title: String,
    slide_type: String,
}

#[derive(Serialize)]
struct PpteSharedSlideInfo {
    #[serde(rename = "sourceSlideId")]
    source_slide_id: String,
    file: String,
    title: String,
    #[serde(rename = "slideType")]
    slide_type: String,
}

#[derive(Serialize)]
struct PpteSharedSnapshotSlide {
    #[serde(rename = "sourceSlideId")]
    source_slide_id: String,
    #[serde(rename = "targetFile")]
    target_file: String,
    title: String,
    #[serde(rename = "slideType")]
    slide_type: String,
}

#[derive(Serialize)]
struct PpteSharedGroupInfo {
    #[serde(rename = "sourceDeckId")]
    source_deck_id: String,
    #[serde(rename = "groupId")]
    group_id: String,
    name: String,
    #[serde(rename = "contentHash")]
    content_hash: String,
    slides: Vec<PpteSharedSlideInfo>,
}

#[derive(Serialize)]
struct PpteSharedSnapshotResult {
    #[serde(rename = "sourceDeckId")]
    source_deck_id: String,
    #[serde(rename = "groupId")]
    group_id: String,
    name: String,
    #[serde(rename = "contentHash")]
    content_hash: String,
    #[serde(rename = "snapshotHash")]
    snapshot_hash: String,
    #[serde(rename = "snapshotRoot")]
    snapshot_root: String,
    slides: Vec<PpteSharedSnapshotSlide>,
}

#[derive(Serialize)]
struct PpteCopiedSlide {
    #[serde(rename = "sourceFile")]
    source_file: String,
    #[serde(rename = "targetFile")]
    target_file: String,
}

#[derive(Serialize)]
struct PpteCopySlidesResult {
    #[serde(rename = "copyId")]
    copy_id: String,
    #[serde(rename = "copyRoot")]
    copy_root: String,
    slides: Vec<PpteCopiedSlide>,
}

struct PpteSharedSourceData {
    root: PathBuf,
    source_deck_id: String,
    group_id: String,
    name: String,
    slides: Vec<PpteSharedSourceSlide>,
    files: Vec<PathBuf>,
    content_hash: String,
}

fn ppte_safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.trim().is_empty() || path.is_absolute() {
        return Err(format!("Unsafe PPTE relative path: {}", value));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!("Unsafe PPTE relative path: {}", value));
        }
    }
    Ok(path.to_path_buf())
}

fn ppte_safe_destination(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(format!("Unsafe PPTE destination: {}", relative.display()));
        };
        current.push(part);
        if current.exists() {
            let metadata = fs::symlink_metadata(&current)
                .map_err(|e| format!("Failed to inspect PPTE destination {}: {}", current.display(), e))?;
            if metadata.file_type().is_symlink() {
                return Err(format!("PPTE destination contains a symbolic link: {}", current.display()));
            }
        }
    }
    Ok(current)
}

fn canonical_ppte_root(folder_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(folder_path)
        .map_err(|e| format!("PPTE folder does not exist: {} ({})", folder_path, e))?;
    if !root.is_dir() || !root.join("manifest.json").is_file() {
        return Err(format!("PPTE folder is missing manifest.json: {}", folder_path));
    }
    Ok(root)
}

fn ppte_note_path_for_slide(slide: &serde_json::Value, file: &str) -> Result<PathBuf, String> {
    let explicit = ["note", "notes", "speakerNote", "speakerNotes"]
        .iter()
        .find_map(|key| slide.get(*key).and_then(|value| value.as_str()));
    if let Some(value) = explicit {
        return ppte_safe_relative_path(value);
    }
    let path = ppte_safe_relative_path(file)?;
    let mut note = path.clone();
    note.set_extension("note");
    Ok(note)
}

fn ppte_is_excluded_snapshot_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == ".ds_store"
        || lower.starts_with("._")
        || lower == ".gitignore"
        || lower == ".gitattributes"
        || lower == ".env"
        || lower.starts_with(".env.")
        || lower == "credentials.json"
        || lower == "app-config.json"
        || lower == "outline.md"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
}

fn collect_ppte_snapshot_files(root: &Path, current: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    collect_ppte_files_excluding(root, current, output, &[])
}

fn collect_ppte_files_excluding(
    root: &Path,
    current: &Path,
    output: &mut Vec<PathBuf>,
    extra_excluded_dirs: &[&str],
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|e| format!("Failed to read PPTE snapshot resources: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read PPTE snapshot entry: {}", e))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(root)
            .map_err(|e| format!("Failed to resolve PPTE snapshot path: {}", e))?
            .to_path_buf();
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| format!("Failed to inspect PPTE snapshot path {}: {}", path.display(), e))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("Symbolic links are not allowed in shared PPTE snapshots: {}", relative.display()));
        }
        if metadata.is_dir() {
            if name == ".git" || name == ".ppte-links" || extra_excluded_dirs.contains(&name.as_str()) {
                continue;
            }
            collect_ppte_files_excluding(root, &path, output, extra_excluded_dirs)?;
        } else if metadata.is_file() && !ppte_is_excluded_snapshot_name(&name) {
            output.push(relative);
        }
    }
    Ok(())
}

fn update_sha256_with_file(hasher: &mut Sha256, root: &Path, relative: &Path) -> Result<(), String> {
    let safe_relative = ppte_safe_relative_path(&relative.to_string_lossy().replace('\\', "/"))?;
    let path = root.join(&safe_relative);
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Shared PPTE file is missing {}: {}", safe_relative.display(), e))?;
    if !canonical.starts_with(root) {
        return Err(format!("Shared PPTE file escapes its root: {}", safe_relative.display()));
    }
    let bytes = fs::read(&canonical)
        .map_err(|e| format!("Failed to read shared PPTE file {}: {}", safe_relative.display(), e))?;
    hasher.update(safe_relative.to_string_lossy().replace('\\', "/").as_bytes());
    hasher.update([0]);
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(&bytes);
    hasher.update([0xff]);
    Ok(())
}

fn ppte_hash_file_tree(root: &Path, files: &[PathBuf]) -> Result<String, String> {
    let mut sorted = files.to_vec();
    sorted.sort_by_key(|path| path.to_string_lossy().replace('\\', "/"));
    let mut hasher = Sha256::new();
    for relative in sorted {
        update_sha256_with_file(&mut hasher, root, &relative)?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn ppte_filter_selected_files(
    discovered: Vec<PathBuf>,
    selected_files: &HashSet<PathBuf>,
    selected_notes: &HashSet<PathBuf>,
    all_slide_files: &HashSet<PathBuf>,
    all_note_files: &HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let manifest_path = PathBuf::from("manifest.json");
    let mut files: Vec<PathBuf> = discovered.into_iter()
        .filter(|relative| relative != &manifest_path)
        .filter(|relative| {
            !all_slide_files.contains(relative) || selected_files.contains(relative)
        })
        .filter(|relative| {
            !all_note_files.contains(relative) || selected_notes.contains(relative)
        })
        .collect();
    files.sort_by_key(|path| path.to_string_lossy().replace('\\', "/"));
    files.dedup();
    files
}

fn load_ppte_shared_source(source_path: &str, group_id: &str) -> Result<PpteSharedSourceData, String> {
    let root = canonical_ppte_root(source_path)?;
    let manifest_content = fs::read_to_string(root.join("manifest.json"))
        .map_err(|e| format!("Failed to read source PPTE manifest: {}", e))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("Failed to parse source PPTE manifest: {}", e))?;
    let source_deck_id = manifest.get("deckId").and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "SOURCE_NEEDS_STABLE_IDS: source PPTE has no deckId".to_string())?
        .to_string();
    let groups = manifest.get("sharedGroups").and_then(|value| value.as_array())
        .ok_or_else(|| "GROUP_NOT_FOUND: source PPTE has no shared groups".to_string())?;
    let group = groups.iter()
        .find(|group| group.get("id").and_then(|value| value.as_str()) == Some(group_id))
        .ok_or_else(|| format!("GROUP_NOT_FOUND: {}", group_id))?;
    let name = group.get("name").and_then(|value| value.as_str()).unwrap_or("未命名页面组").to_string();
    let slide_ids = group.get("slideIds").and_then(|value| value.as_array())
        .ok_or_else(|| format!("GROUP_INVALID: {} has no slideIds", group_id))?;
    if slide_ids.is_empty() {
        return Err(format!("GROUP_INVALID: {} has no pages", group_id));
    }
    let manifest_slides = manifest.get("slides").and_then(|value| value.as_array())
        .ok_or_else(|| "SOURCE_INVALID: source PPTE has no slides".to_string())?;

    let mut slides = Vec::new();
    let mut selected_files = HashSet::new();
    let mut selected_notes = HashSet::new();
    for slide_id_value in slide_ids {
        let slide_id = slide_id_value.as_str()
            .ok_or_else(|| format!("GROUP_INVALID: {} contains a non-string slideId", group_id))?;
        let slide = manifest_slides.iter()
            .find(|slide| slide.get("id").and_then(|value| value.as_str()) == Some(slide_id))
            .ok_or_else(|| format!("GROUP_INVALID: source slide is missing: {}", slide_id))?;
        let file = slide.get("file").and_then(|value| value.as_str())
            .ok_or_else(|| format!("SOURCE_INVALID: slide {} has no file", slide_id))?;
        let safe_file = ppte_safe_relative_path(file)?;
        if safe_file.starts_with(".ppte-links") {
            return Err(format!("GROUP_INVALID: linked snapshot page cannot become a source: {}", file));
        }
        if !root.join(&safe_file).is_file() {
            return Err(format!("SOURCE_INVALID: slide file is missing: {}", file));
        }
        selected_files.insert(safe_file.clone());
        let note = ppte_note_path_for_slide(slide, file)?;
        if root.join(&note).is_file() {
            selected_notes.insert(note);
        }
        slides.push(PpteSharedSourceSlide {
            id: slide_id.to_string(),
            file: safe_file.to_string_lossy().replace('\\', "/"),
            title: slide.get("title").and_then(|value| value.as_str()).unwrap_or("未命名").to_string(),
            slide_type: slide.get("slide_type").and_then(|value| value.as_str()).unwrap_or("content").to_string(),
        });
    }

    let mut all_slide_files = HashSet::new();
    let mut all_note_files = HashSet::new();
    for slide in manifest_slides {
        let Some(file) = slide.get("file").and_then(|value| value.as_str()) else { continue; };
        let safe_file = ppte_safe_relative_path(file)?;
        all_slide_files.insert(safe_file);
        all_note_files.insert(ppte_note_path_for_slide(slide, file)?);
    }

    let mut discovered = Vec::new();
    collect_ppte_snapshot_files(&root, &root, &mut discovered)?;
    let files = ppte_filter_selected_files(
        discovered,
        &selected_files,
        &selected_notes,
        &all_slide_files,
        &all_note_files,
    );

    let mut hasher = Sha256::new();
    hasher.update(group_id.as_bytes());
    hasher.update([0]);
    hasher.update(name.as_bytes());
    hasher.update([0]);
    for slide in &slides {
        hasher.update(slide.id.as_bytes());
        hasher.update([0]);
        hasher.update(slide.file.as_bytes());
        hasher.update([0]);
        hasher.update(slide.title.as_bytes());
        hasher.update([0]);
        hasher.update(slide.slide_type.as_bytes());
        hasher.update([0xff]);
    }
    for relative in &files {
        update_sha256_with_file(&mut hasher, &root, relative)?;
    }
    let content_hash = format!("{:x}", hasher.finalize());

    Ok(PpteSharedSourceData {
        root,
        source_deck_id,
        group_id: group_id.to_string(),
        name,
        slides,
        files,
        content_hash,
    })
}

fn ppte_validate_group_id(group_id: &str) -> Result<(), String> {
    if group_id.is_empty() || !group_id.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-')) {
        return Err(format!("Unsafe shared PPTE group id: {}", group_id));
    }
    Ok(())
}

fn ppte_shared_group_inspect_impl(source_path: String, group_id: String) -> Result<PpteSharedGroupInfo, String> {
    ppte_validate_group_id(&group_id)?;
    let source = load_ppte_shared_source(&source_path, &group_id)?;
    Ok(PpteSharedGroupInfo {
        source_deck_id: source.source_deck_id,
        group_id: source.group_id,
        name: source.name,
        content_hash: source.content_hash,
        slides: source.slides.into_iter().map(|slide| PpteSharedSlideInfo {
            source_slide_id: slide.id,
            file: slide.file,
            title: slide.title,
            slide_type: slide.slide_type,
        }).collect(),
    })
}

#[tauri::command]
async fn ppte_shared_group_inspect(source_path: String, group_id: String) -> Result<PpteSharedGroupInfo, String> {
    tauri::async_runtime::spawn_blocking(move || ppte_shared_group_inspect_impl(source_path, group_id))
        .await
        .map_err(|e| format!("Shared PPTE inspection task failed: {}", e))?
}

fn ppte_copy_files_preserving_layout(
    source_root: &Path,
    files: &[PathBuf],
    dest_dir: &Path,
) -> Result<(), String> {
    for relative in files {
        let source_file = source_root.join(relative);
        let destination = dest_dir.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create snapshot folder {}: {}", parent.display(), e))?;
        }
        fs::copy(&source_file, &destination)
            .map_err(|e| format!("Failed to copy shared PPTE file {}: {}", relative.display(), e))?;
    }
    Ok(())
}

fn ppte_shared_group_snapshot_impl(
    source_path: String,
    target_path: String,
    group_id: String,
) -> Result<PpteSharedSnapshotResult, String> {
    ppte_validate_group_id(&group_id)?;
    let source = load_ppte_shared_source(&source_path, &group_id)?;
    let target_root = canonical_ppte_root(&target_path)?;
    if source.root == target_root {
        return Err("A PPTE cannot link a shared group from itself".to_string());
    }

    let expected_snapshot_hash = ppte_hash_file_tree(&source.root, &source.files)?;
    let mut snapshot_root = PathBuf::from(".ppte-links")
        .join(&group_id)
        .join("snapshots")
        .join(&source.content_hash);
    let mut final_dir = target_root.join(&snapshot_root);
    if final_dir.is_dir() {
        let mut existing_files = Vec::new();
        collect_ppte_snapshot_files(&final_dir, &final_dir, &mut existing_files)?;
        let existing_hash = ppte_hash_file_tree(&final_dir, &existing_files)?;
        if existing_hash != expected_snapshot_hash {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)
                .unwrap_or_default().as_nanos();
            snapshot_root = PathBuf::from(".ppte-links")
                .join(&group_id)
                .join("snapshots")
                .join(format!("{}-restored-{}", source.content_hash, timestamp));
            final_dir = target_root.join(&snapshot_root);
        }
    }
    if !final_dir.is_dir() {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap_or_default().as_nanos();
        let temp_dir = target_root.join(".ppte-links")
            .join(&group_id)
            .join("snapshots")
            .join(format!(".tmp-{}-{}", std::process::id(), timestamp));
        fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create shared PPTE snapshot: {}", e))?;
        let copy_result = (|| -> Result<(), String> {
            ppte_copy_files_preserving_layout(&source.root, &source.files, &temp_dir)?;
            let copied_hash = ppte_hash_file_tree(&temp_dir, &source.files)?;
            if copied_hash.is_empty() {
                return Err("Shared PPTE snapshot hash is empty".to_string());
            }
            if let Some(parent) = final_dir.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create snapshot parent {}: {}", parent.display(), e))?;
            }
            fs::rename(&temp_dir, &final_dir)
                .map_err(|e| format!("Failed to publish shared PPTE snapshot: {}", e))?;
            Ok(())
        })();
        if copy_result.is_err() {
            let _ = fs::remove_dir_all(&temp_dir);
        }
        copy_result?;
    }

    let mut snapshot_files = Vec::new();
    collect_ppte_snapshot_files(&final_dir, &final_dir, &mut snapshot_files)?;
    let snapshot_hash = ppte_hash_file_tree(&final_dir, &snapshot_files)?;
    if snapshot_hash != expected_snapshot_hash {
        return Err("Shared PPTE snapshot verification failed after copy".to_string());
    }
    let snapshot_root_string = snapshot_root.to_string_lossy().replace('\\', "/");
    let slides = source.slides.into_iter().map(|slide| PpteSharedSnapshotSlide {
        source_slide_id: slide.id,
        target_file: format!("{}/{}", snapshot_root_string, slide.file),
        title: slide.title,
        slide_type: slide.slide_type,
    }).collect();

    Ok(PpteSharedSnapshotResult {
        source_deck_id: source.source_deck_id,
        group_id: source.group_id,
        name: source.name,
        content_hash: source.content_hash,
        snapshot_hash,
        snapshot_root: snapshot_root_string,
        slides,
    })
}

#[tauri::command]
async fn ppte_shared_group_snapshot(
    source_path: String,
    target_path: String,
    group_id: String,
) -> Result<PpteSharedSnapshotResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ppte_shared_group_snapshot_impl(source_path, target_path, group_id)
    })
    .await
    .map_err(|e| format!("Shared PPTE snapshot task failed: {}", e))?
}

// Formats a UTC timestamp like 20260724-153045 without pulling in a date crate.
fn ppte_copy_timestamp(now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    // Days since epoch to a civil date (Howard Hinnant's algorithm).
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_param = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_param + 2) / 5 + 1;
    let month = if month_param < 10 { month_param + 3 } else { month_param - 9 };
    if month <= 2 {
        year += 1;
    }
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year,
        month,
        day,
        secs_of_day / 3_600,
        (secs_of_day / 60) % 60,
        secs_of_day % 60,
    )
}

fn ppte_copy_slides_impl(
    source_path: String,
    target_path: String,
    slide_files: Vec<String>,
) -> Result<PpteCopySlidesResult, String> {
    if slide_files.is_empty() {
        return Err("PPTE copy requires at least one slide file".to_string());
    }
    let source_root = canonical_ppte_root(&source_path)?;
    let target_root = canonical_ppte_root(&target_path)?;
    if source_root == target_root {
        return Err("A PPTE cannot copy slides into itself".to_string());
    }

    // Validate the requested slides and remember their same-named .note companions.
    let mut selected_files = HashSet::new();
    let mut selected_notes = HashSet::new();
    let mut ordered_slides: Vec<PathBuf> = Vec::new();
    for file in &slide_files {
        let safe_file = ppte_safe_relative_path(file)?;
        if safe_file.starts_with(".ppte-links") || safe_file.starts_with(".ppte-copies") {
            return Err(format!("PPTE copy source cannot be a linked or copied page: {}", file));
        }
        let absolute = source_root.join(&safe_file);
        if !absolute.is_file() {
            return Err(format!("PPTE copy slide file is missing: {}", file));
        }
        let canonical = fs::canonicalize(&absolute)
            .map_err(|e| format!("Failed to inspect PPTE copy slide {}: {}", file, e))?;
        if !canonical.starts_with(&source_root) {
            return Err(format!("PPTE copy slide escapes the source PPTE: {}", file));
        }
        if selected_files.insert(safe_file.clone()) {
            let mut note = safe_file.clone();
            note.set_extension("note");
            if source_root.join(&note).is_file() {
                selected_notes.insert(note);
            }
            ordered_slides.push(safe_file);
        }
    }

    // Read the manifest so unselected pages and their notes stay behind.
    let manifest_content = fs::read_to_string(source_root.join("manifest.json"))
        .map_err(|e| format!("Failed to read source PPTE manifest: {}", e))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("Failed to parse source PPTE manifest: {}", e))?;
    let mut all_slide_files = HashSet::new();
    let mut all_note_files = HashSet::new();
    if let Some(manifest_slides) = manifest.get("slides").and_then(|value| value.as_array()) {
        for slide in manifest_slides {
            let Some(file) = slide.get("file").and_then(|value| value.as_str()) else { continue; };
            let safe_file = ppte_safe_relative_path(file)?;
            all_slide_files.insert(safe_file);
            all_note_files.insert(ppte_note_path_for_slide(slide, file)?);
        }
    }

    let mut discovered = Vec::new();
    collect_ppte_files_excluding(&source_root, &source_root, &mut discovered, &[".ppte-copies"])?;
    let files = ppte_filter_selected_files(
        discovered,
        &selected_files,
        &selected_notes,
        &all_slide_files,
        &all_note_files,
    );

    // Allocate a unique isolated copy folder under .ppte-copies/.
    let copies_root = target_root.join(".ppte-copies");
    let mut copy_id = String::new();
    let mut copy_dir = PathBuf::new();
    for _ in 0..8 {
        let random_suffix = &uuid::Uuid::new_v4().simple().to_string()[..4];
        let candidate = format!("copy-{}-{}", ppte_copy_timestamp(SystemTime::now()), random_suffix);
        let candidate_dir = copies_root.join(&candidate);
        if !candidate_dir.exists() {
            copy_id = candidate;
            copy_dir = candidate_dir;
            break;
        }
    }
    if copy_id.is_empty() {
        return Err("Failed to allocate a unique PPTE copy folder".to_string());
    }

    fs::create_dir_all(&copy_dir)
        .map_err(|e| format!("Failed to create PPTE copy folder: {}", e))?;
    let copy_result = ppte_copy_files_preserving_layout(&source_root, &files, &copy_dir);
    if copy_result.is_err() {
        let _ = fs::remove_dir_all(&copy_dir);
    }
    copy_result?;

    let copy_root = format!(".ppte-copies/{}", copy_id);
    let slides = ordered_slides.into_iter().map(|file| {
        let file_string = file.to_string_lossy().replace('\\', "/");
        PpteCopiedSlide {
            source_file: file_string.clone(),
            target_file: format!("{}/{}", copy_root, file_string),
        }
    }).collect();

    Ok(PpteCopySlidesResult { copy_id, copy_root, slides })
}

#[tauri::command]
async fn ppte_copy_slides(
    source_path: String,
    target_path: String,
    slide_files: Vec<String>,
) -> Result<PpteCopySlidesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ppte_copy_slides_impl(source_path, target_path, slide_files)
    })
    .await
    .map_err(|e| format!("PPTE copy task failed: {}", e))?
}

fn ppte_shared_snapshot_hash_impl(target_path: String, snapshot_root: String) -> Result<String, String> {
    let target_root = canonical_ppte_root(&target_path)?;
    let safe_relative = ppte_safe_relative_path(&snapshot_root)?;
    if !safe_relative.starts_with(".ppte-links") {
        return Err("Shared PPTE snapshot must be inside .ppte-links".to_string());
    }
    let snapshot_dir = fs::canonicalize(target_root.join(&safe_relative))
        .map_err(|e| format!("Shared PPTE snapshot is missing: {}", e))?;
    if !snapshot_dir.starts_with(&target_root) || !snapshot_dir.is_dir() {
        return Err("Shared PPTE snapshot escapes the target PPTE".to_string());
    }
    let mut files = Vec::new();
    collect_ppte_snapshot_files(&snapshot_dir, &snapshot_dir, &mut files)?;
    ppte_hash_file_tree(&snapshot_dir, &files)
}

#[tauri::command]
async fn ppte_shared_snapshot_hash(target_path: String, snapshot_root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ppte_shared_snapshot_hash_impl(target_path, snapshot_root)
    })
    .await
    .map_err(|e| format!("Shared PPTE snapshot hash task failed: {}", e))?
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
    let base_dir = canonical_ppte_root(&folder_path)?;
    let mut saved = Vec::new();

    if let Some(expected_files) = expected_mtimes {
        let mut conflicts = Vec::new();

        for expected in expected_files {
            let relative_path = ppte_safe_relative_path(&expected.path)?;
            let file_path = ppte_safe_destination(&base_dir, &relative_path)?;
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

    // Prepare and validate every payload before touching the live PPTE. This
    // prevents a bad base64 asset or unsafe path from leaving a partial save.
    let mut prepared: Vec<(String, PathBuf, Vec<u8>)> = Vec::new();
    for (filename, content) in slide_files {
        let relative = ppte_safe_relative_path(&filename)?;
        let file_path = ppte_safe_destination(&base_dir, &relative)?;
        let file_ext = file_path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let bytes = if matches!(file_ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp") {
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &content)
                .map_err(|e| format!("Failed to decode base64 for {}: {}", filename, e))?
        } else {
            content.into_bytes()
        };
        prepared.push((filename, file_path, bytes));
    }

    let transaction = base_dir.join(format!(".ppte-save-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()));
    let staged = transaction.join("staged");
    let backups = transaction.join("backups");
    fs::create_dir_all(&staged).map_err(|e| format!("Failed to prepare PPTE save: {}", e))?;
    let mut entries: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    let stage_manifest = staged.join("manifest.json");
    fs::write(&stage_manifest, manifest_json.as_bytes()).map_err(|e| format!("Failed to stage manifest: {}", e))?;
    entries.push(("manifest.json".to_string(), base_dir.join("manifest.json"), stage_manifest));
    for (filename, destination, bytes) in prepared {
        let stage_path = staged.join(ppte_safe_relative_path(&filename)?);
        if let Some(parent) = stage_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to stage folder for {}: {}", filename, e))?;
        }
        fs::write(&stage_path, bytes).map_err(|e| format!("Failed to stage {}: {}", filename, e))?;
        entries.push((filename, destination, stage_path));
    }

    let mut installed: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    let install_result: Result<(), String> = (|| {
        for (index, (name, destination, stage_path)) in entries.iter().enumerate() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Failed to create folder for {}: {}", name, e))?;
            }
            let backup = if destination.exists() {
                fs::create_dir_all(&backups).map_err(|e| format!("Failed to prepare backup: {}", e))?;
                let path = backups.join(index.to_string());
                fs::rename(destination, &path).map_err(|e| format!("Failed to back up {}: {}", name, e))?;
                Some(path)
            } else {
                None
            };
            if let Err(error) = fs::rename(stage_path, destination) {
                if let Some(ref path) = backup {
                    let _ = fs::rename(path, destination);
                }
                return Err(format!("Failed to install {}: {}", name, error));
            }
            installed.push((destination.clone(), backup));
        }
        Ok(())
    })();

    if let Err(error) = install_result {
        for (destination, backup) in installed.into_iter().rev() {
            let _ = fs::remove_file(&destination);
            if let Some(path) = backup {
                let _ = fs::rename(path, destination);
            }
        }
        let _ = fs::remove_dir_all(&transaction);
        return Err(error);
    }
    saved.extend(entries.iter().map(|(name, _, _)| name.clone()));
    let _ = fs::remove_dir_all(&transaction);

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

fn caption_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CAPTION_KEYRING_SERVICE, CAPTION_KEYRING_USER)
        .map_err(|e| format!("无法打开系统钥匙串：{}", e))
}

#[cfg(target_os = "macos")]
fn read_caption_token_macos_security() -> Result<String, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            CAPTION_KEYRING_SERVICE,
            "-a",
            CAPTION_KEYRING_USER,
            "-w",
        ])
        .output()
        .map_err(|e| format!("无法读取 macOS 钥匙串：{}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn read_caption_token_macos_security() -> Result<String, String> {
    Err("当前平台不支持 macOS 钥匙串回退".to_string())
}

#[cfg(target_os = "macos")]
fn store_caption_token_macos_security(token: &str) -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            CAPTION_KEYRING_SERVICE,
            "-a",
            CAPTION_KEYRING_USER,
            "-w",
            token,
        ])
        .output()
        .map_err(|e| format!("无法写入 macOS 钥匙串：{}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn store_caption_token_macos_security(_token: &str) -> Result<(), String> {
    Err("当前平台不支持 macOS 钥匙串回退".to_string())
}

#[cfg(target_os = "macos")]
fn clear_caption_token_macos_security() -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            CAPTION_KEYRING_SERVICE,
            "-a",
            CAPTION_KEYRING_USER,
        ])
        .output()
        .map_err(|e| format!("无法清除 macOS 钥匙串：{}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn clear_caption_token_macos_security() -> Result<(), String> {
    Err("当前平台不支持 macOS 钥匙串回退".to_string())
}

fn read_caption_token() -> Result<String, String> {
    if let Ok(entry) = caption_keyring_entry() {
        if let Ok(token) = entry.get_password() {
            if !token.trim().is_empty() {
                return Ok(token);
            }
        }
    }
    let token = read_caption_token_macos_security()
        .map_err(|_| "尚未配置阿里云百炼字幕 API Key".to_string())?;
    if token.trim().is_empty() {
        Err("尚未配置阿里云百炼字幕 API Key".to_string())
    } else {
        Ok(token)
    }
}

fn store_caption_token(token: &str) -> Result<(), String> {
    let keyring_result = caption_keyring_entry().and_then(|entry| {
        entry
            .set_password(token)
            .map_err(|e| format!("无法保存字幕 API Key：{}", e))
    });
    if caption_keyring_entry()
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
        .map(|stored| stored.trim() == token)
        .unwrap_or(false)
    {
        return Ok(());
    }

    store_caption_token_macos_security(token).map_err(|fallback_error| {
        if let Err(keyring_error) = keyring_result {
            format!("{}；macOS 钥匙串回退也失败：{}", keyring_error, fallback_error)
        } else {
            format!("字幕 API Key 校验失败；macOS 钥匙串回退也失败：{}", fallback_error)
        }
    })?;
    Ok(())
}

fn clear_caption_token() {
    if let Ok(entry) = caption_keyring_entry() {
        let _ = entry.delete_credential();
    }
    let _ = clear_caption_token_macos_security();
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
    let client = direct_client();
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

    #[test]
    fn extracts_inline_scripts_by_document_order() {
        let html = br#"<script>window.first = 1;</script>
            <script type="application/json">{"data":true}</script>
            <SCRIPT type="module">window.third = 3;</SCRIPT >"#;
        assert_eq!(
            extract_html_script_body(html, 0).unwrap(),
            b"window.first = 1;"
        );
        assert_eq!(
            extract_html_script_body(html, 1).unwrap(),
            br#"{"data":true}"#
        );
        assert_eq!(
            extract_html_script_body(html, 2).unwrap(),
            b"window.third = 3;"
        );
        assert!(extract_html_script_body(html, 3).is_none());
    }
}

#[cfg(test)]
mod ppte_outline_tests {
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
    fn outline_md_is_excluded_from_snapshot_names() {
        assert!(ppte_is_excluded_snapshot_name("outline.md"));
        assert!(ppte_is_excluded_snapshot_name("Outline.MD"));
        assert!(!ppte_is_excluded_snapshot_name("slide01.html"));
    }

    #[test]
    fn icon_destination_rejects_path_components() {
        let base = Path::new("/tmp/lecture-icon-dest-test");
        let (dest, rel) = ppte_icon_destination(base, "doubao-logo.png").unwrap();
        assert_eq!(rel, "resources/doubao-logo.png");
        assert!(dest.ends_with("resources/doubao-logo.png"));
        assert!(ppte_icon_destination(base, "../evil.png").is_err());
        assert!(ppte_icon_destination(base, "a/b.png").is_err());
        assert!(ppte_icon_destination(base, "").is_err());
    }

    #[test]
    fn zip_ppte_directory_skips_outline_md() {
        let dir = unique_temp_dir("zip-outline");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("slide01.html"), "<h1>One</h1>").unwrap();
        fs::write(dir.join("outline.md"), "# 章纲").unwrap();
        fs::write(dir.join(".DS_Store"), b"junk").unwrap();
        fs::create_dir_all(dir.join(".lectureai")).unwrap();
        fs::write(dir.join(".lectureai").join("workbench-session.json"), "{}").unwrap();

        let bytes = zip_ppte_directory(dir.to_string_lossy().as_ref()).unwrap();
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"slide01.html".to_string()));
        assert!(!names.iter().any(|n| n.ends_with("outline.md")));
        assert!(!names.iter().any(|n| n.ends_with(".DS_Store")));
        assert!(!names.iter().any(|n| n.contains(".lectureai")));

        fs::remove_dir_all(dir).unwrap();
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
    fn skill_frontmatter_requires_standard_name_and_description() {
        let valid = "---\nname: ppte-layout\ndescription: Layout workflow\n---\n\n# Rules";
        let (name, description) = parse_skill_frontmatter(valid).unwrap();
        assert_eq!(name, "ppte-layout");
        assert_eq!(description, "Layout workflow");
        assert!(parse_skill_frontmatter("# no metadata").is_err());
        assert!(parse_skill_frontmatter("---\nname: Bad_Name\ndescription: no\n---").is_err());
        assert!(parse_skill_frontmatter("---\nname: ok-name\n---").is_err());

        let multiline = "---\nname: multi-line\ndescription: >\n  Checks typography, layout,\n  and projection readability.\n---\n";
        assert_eq!(
            parse_skill_frontmatter(multiline).unwrap().1,
            "Checks typography, layout, and projection readability."
        );
    }

    #[test]
    fn skill_import_accepts_single_skill_and_skips_existing_name() {
        let source = unique_temp_dir("skill-import-source");
        let destination = unique_temp_dir("skill-import-destination");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: imported-skill\ndescription: Imported workflow\n---\n# Workflow\n",
        ).unwrap();
        fs::write(source.join("references").join("guide.md"), "# Guide").unwrap();

        let result = import_skills_into_root(&source, &destination).unwrap();
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].id, "user:imported-skill");
        assert!(destination.join("imported-skill").join("SKILL.md").is_file());
        assert!(destination.join("imported-skill").join("references").join("guide.md").is_file());

        let duplicate = import_skills_into_root(&source, &destination).unwrap();
        assert!(duplicate.imported.is_empty());
        assert!(duplicate.skipped.iter().any(|item| item.contains("未覆盖")));

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn skill_import_accepts_agent_skills_root_and_skips_invalid_child() {
        let source = unique_temp_dir("skills-root");
        let destination = unique_temp_dir("skills-destination");
        fs::create_dir_all(source.join("first-skill")).unwrap();
        fs::write(
            source.join("first-skill").join("SKILL.md"),
            "---\nname: first-skill\ndescription: First imported workflow\n---\n",
        ).unwrap();
        fs::create_dir_all(source.join("invalid-skill")).unwrap();
        fs::write(source.join("invalid-skill").join("SKILL.md"), "# Missing metadata").unwrap();

        let result = import_skills_into_root(&source, &destination).unwrap();
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].name, "first-skill");
        assert_eq!(result.skipped.len(), 1);

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn skill_resource_relative_paths_cannot_escape() {
        assert!(ppte_safe_relative_path("references/layout.md").is_ok());
        assert!(ppte_safe_relative_path("../outside.md").is_err());
        assert!(ppte_safe_relative_path("/tmp/outside.md").is_err());
    }

    #[test]
    fn skill_discovery_skips_invalid_and_mismatched_folders() {
        let root = unique_temp_dir("skill-discovery");
        fs::create_dir_all(root.join("good-skill")).unwrap();
        fs::write(
            root.join("good-skill").join("SKILL.md"),
            "---\nname: good-skill\ndescription: Good workflow\n---\n",
        ).unwrap();
        fs::create_dir_all(root.join("wrong-folder")).unwrap();
        fs::write(
            root.join("wrong-folder").join("SKILL.md"),
            "---\nname: another-name\ndescription: Wrong folder\n---\n",
        ).unwrap();
        fs::create_dir_all(root.join("Bad_Name")).unwrap();
        fs::write(
            root.join("Bad_Name").join("SKILL.md"),
            "---\nname: Bad_Name\ndescription: Invalid\n---\n",
        ).unwrap();

        let skills = discover_skills_in_root("user", "外接 · 用户导入", &root);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "user:good-skill");
        assert_eq!(skills[0].source_label, "外接 · 用户导入");

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skill_discovery_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = unique_temp_dir("skill-root");
        let outside = unique_temp_dir("skill-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(outside.join("outside-skill")).unwrap();
        fs::write(
            outside.join("outside-skill").join("SKILL.md"),
            "---\nname: outside-skill\ndescription: Must stay outside\n---\n",
        ).unwrap();
        symlink(outside.join("outside-skill"), root.join("outside-skill")).unwrap();

        assert!(discover_skills_in_root("user", "用户全局", &root).is_empty());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
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
    fn agent_plan_is_optional_and_preserves_legacy_manifest() {
        let dir = unique_temp_dir("agent-plan-legacy");
        fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"title":"Legacy","slides":["slide01.html"]}"#;
        fs::write(dir.join("manifest.json"), legacy).unwrap();
        fs::write(dir.join("slide01.html"), "<!doctype html><h1>Legacy</h1>").unwrap();

        let missing = ppte_agent_plan_read(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(missing.get("status").and_then(|value| value.as_str()), Some("missing"));
        assert!(!dir.join(".lectureai").exists());
        let revision = ppte_agent_revision(&dir.to_string_lossy()).unwrap();
        assert_eq!(
            revision.get("deckHash").and_then(|value| value.as_str()),
            Some("sha256:77c457f5e865f6c86ce00d12cb82090686efa1d2846baf688bef97a02903cec3")
        );

        let plan = serde_json::json!({
            "targetSlideCount": 1,
            "visualSystem": {"style": "editorial-tech"},
            "slides": [{
                "page": 1,
                "role": "cover",
                "title": "Legacy",
                "contentKind": "cover",
                "layoutFamily": "cover",
                "componentIds": [],
                "motion": "none",
                "visualIntent": "建立主题"
            }]
        });
        let saved = ppte_agent_plan_write(dir.to_string_lossy().to_string(), plan).unwrap();
        assert_eq!(saved.get("status").and_then(|value| value.as_str()), Some("active"));
        assert!(dir.join(".lectureai").join("deck-plan.json").is_file());
        assert_eq!(fs::read_to_string(dir.join("manifest.json")).unwrap(), legacy);

        fs::write(dir.join("slide01.html"), "<!doctype html><h1>External</h1>").unwrap();
        let stale = ppte_agent_plan_read(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(stale.get("status").and_then(|value| value.as_str()), Some("stale"));
        assert!(ppte_agent_plan_refresh(dir.to_string_lossy().to_string()).unwrap());
        let active = ppte_agent_plan_read(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(active.get("status").and_then(|value| value.as_str()), Some("active"));

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_agent_plan_never_breaks_legacy_ppte() {
        let dir = unique_temp_dir("agent-plan-corrupt");
        fs::create_dir_all(dir.join(".lectureai")).unwrap();
        fs::write(dir.join("manifest.json"), r#"{"title":"Legacy","slides":["slide01.html"]}"#).unwrap();
        fs::write(dir.join("slide01.html"), "<!doctype html><h1>Legacy</h1>").unwrap();
        fs::write(dir.join(".lectureai").join("deck-plan.json"), "{broken").unwrap();

        let result = ppte_agent_plan_read(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(result.get("status").and_then(|value| value.as_str()), Some("invalid"));
        assert!(dir.join("slide01.html").is_file());

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn agent_plan_rejects_symlinked_metadata_directory() {
        use std::os::unix::fs::symlink;

        let dir = unique_temp_dir("agent-plan-symlink");
        let outside = unique_temp_dir("agent-plan-outside");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(dir.join("manifest.json"), r#"{"title":"Demo","slides":["slide01.html"]}"#).unwrap();
        fs::write(dir.join("slide01.html"), "<h1>Demo</h1>").unwrap();
        symlink(&outside, dir.join(".lectureai")).unwrap();

        let plan = serde_json::json!({
            "targetSlideCount": 1,
            "visualSystem": {},
            "slides": [{"page":1,"role":"cover","title":"Demo","contentKind":"cover","layoutFamily":"cover","componentIds":[],"motion":"none","visualIntent":"title"}]
        });
        assert!(ppte_agent_plan_write(dir.to_string_lossy().to_string(), plan).is_err());
        assert!(!outside.join("deck-plan.json").exists());

        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn save_ppt_extra_rejects_bad_payload_before_any_disk_write() {
        let dir = unique_temp_dir("save-atomic-prepare");
        fs::create_dir_all(&dir).unwrap();
        let original_manifest = r#"{"title":"Original","slides":[{"file":"slide01.html","title":"One"}]}"#;
        fs::write(dir.join("manifest.json"), original_manifest).unwrap();
        fs::write(dir.join("slide01.html"), "original slide").unwrap();

        let result = save_ppt_extra(
            dir.to_string_lossy().to_string(),
            r#"{"title":"Changed","slides":[{"file":"slide01.html","title":"Changed"}]}"#.to_string(),
            vec![
                ("slide01.html".to_string(), "changed slide".to_string()),
                ("broken.png".to_string(), "not-base64".to_string()),
            ],
            None,
        );

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(dir.join("manifest.json")).unwrap(), original_manifest);
        assert_eq!(fs::read_to_string(dir.join("slide01.html")).unwrap(), "original slide");
        assert!(!dir.join("broken.png").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_ppt_extra_supports_safe_nested_slide_paths() {
        let dir = unique_temp_dir("save-nested");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), r#"{"title":"Demo","slides":[]}"#).unwrap();

        save_ppt_extra(
            dir.to_string_lossy().to_string(),
            r#"{"title":"Demo","slides":[{"file":"nested/slide.html","title":"One"}]}"#.to_string(),
            vec![("nested/slide.html".to_string(), "<html>nested</html>".to_string())],
            None,
        )
        .unwrap();

        assert_eq!(fs::read_to_string(dir.join("nested").join("slide.html")).unwrap(), "<html>nested</html>");
        assert!(save_ppt_extra(
            dir.to_string_lossy().to_string(),
            r#"{"title":"Demo","slides":[]}"#.to_string(),
            vec![("../escape.html".to_string(), "bad".to_string())],
            None,
        ).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shared_group_snapshot_is_versioned_and_detects_changes() {
        let source = unique_temp_dir("shared-source");
        let target = unique_temp_dir("shared-target");
        fs::create_dir_all(source.join("images")).unwrap();
        fs::create_dir_all(&target).unwrap();
        let source_manifest = serde_json::json!({
            "schemaVersion": 2,
            "deckId": "deck_source",
            "title": "Source",
            "slides": [
                {"id":"slide_a","file":"slide01.html","title":"A","slide_type":"content"},
                {"id":"slide_b","file":"slide02.html","title":"B","slide_type":"content"}
            ],
            "sharedGroups": [
                {"id":"group_demo","name":"Reusable","slideIds":["slide_a"]}
            ],
            "linkedGroups": []
        });
        fs::write(source.join("manifest.json"), serde_json::to_string_pretty(&source_manifest).unwrap()).unwrap();
        fs::write(source.join("slide01.html"), "<html><link href=\"style.css\">A</html>").unwrap();
        fs::write(source.join("slide01.note"), "note A").unwrap();
        fs::write(source.join("slide02.html"), "<html>B</html>").unwrap();
        fs::write(source.join("slide02.note"), "note B").unwrap();
        fs::write(source.join("style.css"), "body { color: red; }").unwrap();
        fs::write(source.join("images").join("cover.png"), "image").unwrap();
        fs::write(target.join("manifest.json"), r#"{"schemaVersion":2,"deckId":"deck_target","title":"Target","slides":[]}"#).unwrap();

        let first = ppte_shared_group_snapshot_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            "group_demo".to_string(),
        ).unwrap();
        assert_eq!(first.source_deck_id, "deck_source");
        assert_eq!(first.slides.len(), 1);
        assert!(target.join(&first.snapshot_root).join("slide01.html").is_file());
        assert!(target.join(&first.snapshot_root).join("slide01.note").is_file());
        assert!(target.join(&first.snapshot_root).join("style.css").is_file());
        assert!(target.join(&first.snapshot_root).join("images").join("cover.png").is_file());
        assert!(!target.join(&first.snapshot_root).join("slide02.html").exists());
        assert!(!target.join(&first.snapshot_root).join("slide02.note").exists());
        assert_eq!(
            ppte_shared_snapshot_hash_impl(
                target.to_string_lossy().to_string(),
                first.snapshot_root.clone(),
            ).unwrap(),
            first.snapshot_hash,
        );

        fs::write(source.join("slide01.html"), "<html><link href=\"style.css\">A updated</html>").unwrap();
        let inspected = ppte_shared_group_inspect_impl(
            source.to_string_lossy().to_string(),
            "group_demo".to_string(),
        ).unwrap();
        assert_ne!(inspected.content_hash, first.content_hash);
        let second = ppte_shared_group_snapshot_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            "group_demo".to_string(),
        ).unwrap();
        assert_ne!(second.snapshot_root, first.snapshot_root);
        assert!(target.join(&first.snapshot_root).is_dir());
        assert!(target.join(&second.snapshot_root).is_dir());

        fs::write(target.join(&second.snapshot_root).join("slide01.html"), "locally changed").unwrap();
        let changed_hash = ppte_shared_snapshot_hash_impl(
            target.to_string_lossy().to_string(),
            second.snapshot_root.clone(),
        ).unwrap();
        assert_ne!(changed_hash, second.snapshot_hash);

        let restored = ppte_shared_group_snapshot_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            "group_demo".to_string(),
        ).unwrap();
        assert_ne!(restored.snapshot_root, second.snapshot_root);
        assert!(restored.snapshot_root.contains("-restored-"));
        assert_eq!(
            fs::read_to_string(target.join(&restored.snapshot_root).join("slide01.html")).unwrap(),
            "<html><link href=\"style.css\">A updated</html>",
        );
        assert_eq!(
            ppte_shared_snapshot_hash_impl(
                target.to_string_lossy().to_string(),
                restored.snapshot_root.clone(),
            ).unwrap(),
            restored.snapshot_hash,
        );

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    fn write_copy_test_source(source: &Path) {
        fs::create_dir_all(source.join("images")).unwrap();
        let source_manifest = serde_json::json!({
            "schemaVersion": 2,
            "deckId": "deck_source",
            "title": "Source",
            "slides": [
                {"id":"slide_a","file":"slide01.html","title":"A"},
                {"id":"slide_b","file":"slide02.html","title":"B"}
            ]
        });
        fs::write(source.join("manifest.json"), serde_json::to_string_pretty(&source_manifest).unwrap()).unwrap();
        fs::write(source.join("slide01.html"), "<html>A</html>").unwrap();
        fs::write(source.join("slide01.note"), "note A").unwrap();
        fs::write(source.join("slide02.html"), "<html>B</html>").unwrap();
        fs::write(source.join("slide02.note"), "note B").unwrap();
        fs::write(source.join("style.css"), "body { color: red; }").unwrap();
        fs::write(source.join("images").join("cover.png"), "image").unwrap();
    }

    #[test]
    fn copy_slides_copies_selected_pages_and_shared_resources() {
        let source = unique_temp_dir("copy-source");
        let target = unique_temp_dir("copy-target");
        write_copy_test_source(&source);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("manifest.json"), r#"{"schemaVersion":2,"deckId":"deck_target","title":"Target","slides":[]}"#).unwrap();

        let result = ppte_copy_slides_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            vec!["slide01.html".to_string()],
        ).unwrap();

        assert!(result.copy_id.starts_with("copy-"));
        assert_eq!(result.copy_root, format!(".ppte-copies/{}", result.copy_id));
        let root = target.join(&result.copy_root);
        assert!(root.is_dir());
        assert!(root.join("slide01.html").is_file());
        assert!(root.join("slide01.note").is_file());
        assert!(root.join("style.css").is_file());
        assert!(root.join("images").join("cover.png").is_file());
        assert!(!root.join("slide02.html").exists());
        assert!(!root.join("slide02.note").exists());
        assert!(!root.join("manifest.json").exists());
        assert_eq!(result.slides.len(), 1);
        assert_eq!(result.slides[0].source_file, "slide01.html");
        assert_eq!(result.slides[0].target_file, format!("{}/slide01.html", result.copy_root));

        // A second copy lands in its own isolated folder.
        let second = ppte_copy_slides_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            vec!["slide01.html".to_string()],
        ).unwrap();
        assert_ne!(second.copy_root, result.copy_root);
        assert!(target.join(&second.copy_root).join("slide01.html").is_file());

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn copy_slides_excludes_sensitive_and_managed_paths() {
        let source = unique_temp_dir("copy-exclude-source");
        let target = unique_temp_dir("copy-exclude-target");
        write_copy_test_source(&source);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("manifest.json"), r#"{"schemaVersion":2,"deckId":"deck_target","title":"Target","slides":[]}"#).unwrap();
        fs::write(source.join(".env"), "SECRET=1").unwrap();
        fs::write(source.join("private.key"), "key").unwrap();
        fs::create_dir_all(source.join(".ppte-links").join("group_x")).unwrap();
        fs::write(source.join(".ppte-links").join("group_x").join("linked.html"), "linked").unwrap();
        fs::create_dir_all(source.join(".ppte-copies").join("copy-old")).unwrap();
        fs::write(source.join(".ppte-copies").join("copy-old").join("slide01.html"), "old copy").unwrap();

        let result = ppte_copy_slides_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            vec!["slide01.html".to_string()],
        ).unwrap();

        let root = target.join(&result.copy_root);
        assert!(root.join("slide01.html").is_file());
        assert!(root.join("style.css").is_file());
        assert!(!root.join(".env").exists());
        assert!(!root.join("private.key").exists());
        assert!(!root.join(".ppte-links").exists());
        assert!(!root.join(".ppte-copies").exists());

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn copy_slides_rejects_same_source_and_target() {
        let source = unique_temp_dir("copy-same");
        write_copy_test_source(&source);

        let result = ppte_copy_slides_impl(
            source.to_string_lossy().to_string(),
            source.to_string_lossy().to_string(),
            vec!["slide01.html".to_string()],
        );
        assert!(result.is_err());
        assert!(!source.join(".ppte-copies").exists());

        fs::remove_dir_all(source).unwrap();
    }

    #[test]
    fn copy_slides_rejects_empty_or_missing_slide_files() {
        let source = unique_temp_dir("copy-invalid-source");
        let target = unique_temp_dir("copy-invalid-target");
        write_copy_test_source(&source);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("manifest.json"), r#"{"schemaVersion":2,"deckId":"deck_target","title":"Target","slides":[]}"#).unwrap();

        assert!(ppte_copy_slides_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            vec![],
        ).is_err());
        assert!(ppte_copy_slides_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            vec!["missing.html".to_string()],
        ).is_err());
        assert!(ppte_copy_slides_impl(
            source.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            vec!["../escape.html".to_string()],
        ).is_err());
        assert!(!target.join(".ppte-copies").exists());

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(target).unwrap();
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

fn local_ppte_agent_node_path() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];
    if let Some(path) = candidates.into_iter().find(|path| path.is_file() && local_ppte_agent_node_supported(path)) {
        return Some(path);
    }
    let path = PathBuf::from("node");
    local_ppte_agent_node_supported(&path).then_some(path)
}

fn local_ppte_agent_node_supported(path: &std::path::Path) -> bool {
    Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|version| version.trim().trim_start_matches('v').split('.').next()?.parse::<u32>().ok())
        .map(|major| major >= 20)
        .unwrap_or(false)
}

fn configured_local_ppte_agent(app_handle: &tauri::AppHandle) -> Result<(AppConfig, PathBuf, PathBuf), String> {
    let config = read_app_config(app_handle.clone())?;
    if config.local_ppte_agent_enabled != Some(true) {
        return Err("本地 Agent 实验功能尚未启用".to_string());
    }
    let root = config
        .local_ppte_agent_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "请先配置本地 Agent 路径".to_string())?;
    let cli = root.join("src").join("cli.mjs");
    if !root.is_dir() || !cli.is_file() {
        return Err(format!("本地 Agent 目录无效：{}", root.display()));
    }
    let node = local_ppte_agent_node_path().ok_or_else(|| "未找到 Node.js 20+，请先安装或配置 PATH".to_string())?;
    Ok((config, root, node))
}

async fn verify_local_agent_admin(config: &AppConfig, auth_token: &str) -> Result<(), String> {
    if auth_token.trim().is_empty() {
        return Err("请先登录管理员账号".to_string());
    }
    let server = config
        .auth_server
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://design.hz-study-system.com")
        .trim_end_matches('/');
    let response = direct_client()
        .get(format!("{}/api/web/auth/me", server))
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|e| format!("无法验证管理员身份：{}", e))?;
    if !response.status().is_success() {
        return Err("管理员登录已失效，请重新登录".to_string());
    }
    let user: serde_json::Value = response.json().await.map_err(|e| format!("管理员身份响应无效：{}", e))?;
    if user.get("role").and_then(|value| value.as_str()) != Some("admin") {
        return Err("本地 Agent 实验室仅对管理员开放".to_string());
    }
    Ok(())
}

fn local_agent_job_dir(output_dir: &str) -> PathBuf {
    PathBuf::from(format!("{}.agent-job", output_dir.trim_end_matches(std::path::MAIN_SEPARATOR)))
}

fn local_agent_log_files(job_dir: &std::path::Path) -> Result<(fs::File, fs::File, PathBuf), String> {
    fs::create_dir_all(job_dir).map_err(|e| format!("无法创建任务目录：{}", e))?;
    let log_path = job_dir.join("desktop-agent.log");
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法创建 Agent 日志：{}", e))?;
    let stderr = stdout.try_clone().map_err(|e| format!("无法打开 Agent 日志：{}", e))?;
    Ok((stdout, stderr, log_path))
}

fn spawn_local_agent(
    node: &std::path::Path,
    agent_root: &std::path::Path,
    args: &[String],
    job_dir: &std::path::Path,
) -> Result<(u32, PathBuf), String> {
    let (stdout, stderr, log_path) = local_agent_log_files(job_dir)?;
    let child = Command::new(node)
        .current_dir(agent_root)
        .arg("src/cli.mjs")
        .args(args)
        .env("PPTE_AGENT_DESKTOP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| format!("无法启动本地 Agent：{}", e))?;
    Ok((child.id(), log_path))
}

#[tauri::command]
fn local_ppte_agent_status(app_handle: tauri::AppHandle) -> Result<LocalPpteAgentStatus, String> {
    let config = read_app_config(app_handle)?;
    let enabled = config.local_ppte_agent_enabled == Some(true);
    let agent_path = config.local_ppte_agent_path.clone();
    let configured = agent_path
        .as_deref()
        .map(|value| PathBuf::from(value).join("src").join("cli.mjs").is_file())
        .unwrap_or(false);
    let node_path = local_ppte_agent_node_path().map(|path| path.to_string_lossy().to_string());
    let ready = enabled && configured && node_path.is_some();
    let message = if ready {
        "本地 Agent 已就绪".to_string()
    } else if !enabled {
        "本地 Agent 实验功能未启用".to_string()
    } else if !configured {
        "本地 Agent 路径无效".to_string()
    } else {
        "未找到 Node.js 20+".to_string()
    };
    Ok(LocalPpteAgentStatus { enabled, configured, agent_path, node_path, ready, message })
}

#[tauri::command]
async fn local_ppte_agent_start(
    app_handle: tauri::AppHandle,
    brief: serde_json::Value,
    auth_token: String,
) -> Result<LocalPpteAgentLaunch, String> {
    let title = brief.get("title").and_then(|value| value.as_str()).unwrap_or_default().trim();
    let output_dir = brief.get("outputDir").and_then(|value| value.as_str()).unwrap_or_default().trim();
    let mode = brief.get("mode").and_then(|value| value.as_str()).unwrap_or("autopilot");
    let target_slide_count = brief.get("targetSlideCount").and_then(|value| value.as_u64()).unwrap_or(0);
    if title.is_empty() || output_dir.is_empty() {
        return Err("标题和输出目录不能为空".to_string());
    }
    let outline_source = brief.get("outlineSource").and_then(|value| value.as_object()).ok_or_else(|| "缺少页面大纲来源".to_string())?;
    let outline_kind = outline_source.get("kind").and_then(|value| value.as_str()).unwrap_or_default();
    let outline_ready = match outline_kind {
        "text" => outline_source.get("text").and_then(|value| value.as_str()).map(|value| !value.trim().is_empty()).unwrap_or(false),
        "file" => outline_source
            .get("path")
            .and_then(|value| value.as_str())
            .map(|value| PathBuf::from(value).is_file())
            .unwrap_or(false),
        _ => false,
    };
    if !outline_ready {
        return Err("页面大纲为空，或选择的大纲文件不存在".to_string());
    }
    if !(3..=60).contains(&target_slide_count) {
        return Err("目标页数必须是 3～60，并包含封面和总结".to_string());
    }
    if mode != "autopilot" && mode != "guided" {
        return Err("制作模式无效".to_string());
    }
    let references = brief.get("references").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    if references.len() > 20 {
        return Err("参考资料最多添加 20 项".to_string());
    }
    for reference in &references {
        let kind = reference.get("kind").and_then(|value| value.as_str()).unwrap_or_default();
        if kind == "text" {
            if reference.get("text").and_then(|value| value.as_str()).map(|value| value.trim().is_empty()).unwrap_or(true) {
                return Err("存在空的粘贴参考资料".to_string());
            }
            continue;
        }
        let source_path = reference.get("path").and_then(|value| value.as_str()).unwrap_or_default();
        let valid = match kind {
            "file" => PathBuf::from(source_path).is_file(),
            "folder" => PathBuf::from(source_path).is_dir(),
            "ppte-local" => PathBuf::from(source_path).join("manifest.json").is_file(),
            _ => false,
        };
        if !valid {
            return Err(format!("参考资料无效或已移动：{}", source_path));
        }
    }
    let (config, agent_root, node) = configured_local_ppte_agent(&app_handle)?;
    verify_local_agent_admin(&config, &auth_token).await?;

    let output = PathBuf::from(output_dir);
    if output.exists() && fs::read_dir(&output).map(|mut entries| entries.next().is_some()).unwrap_or(true) {
        return Err("输出目录已存在且非空，请选择新的课件目录".to_string());
    }
    let job_dir = local_agent_job_dir(output_dir);
    if job_dir.join("job.json").exists() {
        return Err("该输出位置已经存在 Agent 任务，请使用恢复功能".to_string());
    }
    fs::create_dir_all(&job_dir).map_err(|e| e.to_string())?;
    let brief_file = job_dir.join("desktop-brief.json");
    let brief_json = serde_json::to_string_pretty(&brief).map_err(|e| format!("无法序列化任务资料：{}", e))?;
    fs::write(&brief_file, format!("{}\n", brief_json)).map_err(|e| format!("无法保存任务资料：{}", e))?;

    let args = vec![
        "create".to_string(),
        "--brief".to_string(), brief_file.to_string_lossy().to_string(),
        "--use-app-config".to_string(),
    ];
    let (pid, log_path) = spawn_local_agent(&node, &agent_root, &args, &job_dir)?;
    Ok(LocalPpteAgentLaunch {
        job_dir: job_dir.to_string_lossy().to_string(),
        output_dir: output.to_string_lossy().to_string(),
        pid,
        log_file: log_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn local_ppte_agent_action(
    app_handle: tauri::AppHandle,
    job_dir: String,
    action: String,
    auth_token: String,
) -> Result<LocalPpteAgentLaunch, String> {
    let allowed = ["resume", "approve-plan", "approve-style"];
    if !allowed.contains(&action.as_str()) {
        return Err("不支持的 Agent 操作".to_string());
    }
    let (config, agent_root, node) = configured_local_ppte_agent(&app_handle)?;
    verify_local_agent_admin(&config, &auth_token).await?;
    let job = PathBuf::from(&job_dir);
    let job_json = job.join("job.json");
    if !job_json.is_file() {
        return Err("Agent 任务不存在".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&job_json).map_err(|e| e.to_string())?)
        .map_err(|e| format!("任务状态损坏：{}", e))?;
    let output_dir = value.get("outputDir").and_then(|item| item.as_str()).unwrap_or_default().to_string();
    let args = vec![action, "--job".to_string(), job.to_string_lossy().to_string(), "--use-app-config".to_string()];
    let (pid, log_path) = spawn_local_agent(&node, &agent_root, &args, &job)?;
    Ok(LocalPpteAgentLaunch {
        job_dir: job.to_string_lossy().to_string(),
        output_dir,
        pid,
        log_file: log_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn local_ppte_agent_read_job(job_dir: String) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(job_dir).join("job.json");
    let content = fs::read_to_string(&path).map_err(|e| format!("任务状态尚未生成：{}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("任务状态无效：{}", e))
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

/// reqwest client that bypasses the macOS system proxy. The desktop app talks
/// to domestic endpoints (the design server, DeepSeek, MiniMax, Gitee, update
/// server) which must NOT be routed through a local proxy (Clash/V2Ray)
/// configured for overseas access. Overseas custom AI providers (OpenAI /
/// Anthropic) keep using Client::new() so they still benefit from the proxy.
fn direct_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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
    let client = direct_client();
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
    let client = direct_client();
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
    // Legacy single-turn path (used by call_ai / test_ai_config). Converts to a
    // 2-message array and reuses the chat endpoint.
    if auth_token.is_empty() {
        return Err("请先登录后才能使用 LectureAI".to_string());
    }
    let messages = vec![
        serde_json::json!({"role": "system", "content": system_prompt}),
        serde_json::json!({"role": "user", "content": user_msg}),
    ];
    call_lectureai_chat_request(auth_token, messages).await
}

/// True multi-turn chat for the workbench agent: sends the full messages array.
async fn call_lectureai_chat(
    auth_token: String,
    messages: Vec<ChatMessage>,
    context_mode: Option<String>,
    context_template_ids: Option<Vec<String>>,
) -> Result<String, String> {
    if auth_token.is_empty() {
        return Err("请先登录后才能使用 LectureAI".to_string());
    }
    let messages = messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();
    call_lectureai_chat_request_with_mode(auth_token, messages, context_mode, context_template_ids).await
}

async fn call_lectureai_chat_request(
    auth_token: String,
    messages: Vec<serde_json::Value>,
) -> Result<String, String> {
    call_lectureai_chat_request_with_mode(auth_token, messages, None, None).await
}

async fn call_lectureai_chat_request_with_mode(
    auth_token: String,
    messages: Vec<serde_json::Value>,
    context_mode: Option<String>,
    context_template_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let client = direct_client();
    let body = serde_json::json!({
        "messages": messages,
        "context_mode": context_mode.unwrap_or_else(|| "full".to_string()),
        "context_template_ids": context_template_ids.unwrap_or_default(),
    });

    let response = client
        .post("https://design.hz-study-system.com/api/web/ai/chat")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", auth_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error_text = response.text().await.unwrap_or_default();
        return Err(lectureai_http_error(status, &error_text));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;

    data.get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "响应格式错误".to_string())
}

fn lectureai_http_error(status: u16, error_text: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(error_text)
        .ok()
        .and_then(|json| json.get("detail").and_then(|value| value.as_str()).map(str::to_string));
    if status >= 500 {
        return format!(
            "LectureAI 上游模型暂时不可用（HTTP {}）：{}",
            status,
            detail.unwrap_or_else(|| "服务器暂时无法完成模型请求".to_string())
        );
    }
    // Preserve actionable quota/auth/config messages for non-server failures.
    detail.unwrap_or_else(|| format!("AI 服务错误（HTTP {}）", status))
}

/// Streaming variant of the LectureAI chat call. The CDN edge in front of the
/// server drops responses that stay silent for ~15s (HTTP 524), which long
/// non-streaming generations hit easily; the SSE endpoint starts responding
/// within seconds. Falls back to the non-streaming endpoint when the server
/// has not deployed /chat/stream yet (404).
async fn call_lectureai_chat_stream(
    app_handle: tauri::AppHandle,
    auth_token: String,
    messages: Vec<ChatMessage>,
    context_mode: Option<String>,
    context_template_ids: Option<Vec<String>>,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let messages: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();
    let client = direct_client();
    let body = serde_json::json!({
        "messages": messages,
        "context_mode": context_mode.clone().unwrap_or_else(|| "full".to_string()),
        "context_template_ids": context_template_ids.clone().unwrap_or_default(),
    });

    let response = client
        .post("https://design.hz-study-system.com/api/web/ai/chat/stream")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", auth_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    if response.status().as_u16() == 404 {
        let result =
            call_lectureai_chat_request_with_mode(auth_token, messages, context_mode, context_template_ids).await?;
        app_handle.emit("ai-stream-chunk", result).map_err(|e| e.to_string())?;
        app_handle.emit("ai-stream-done", ()).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error_text = response.text().await.unwrap_or_default();
        return Err(lectureai_http_error(status, &error_text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    // Backstop read timeout: the server emits an explicit error after 90s of
    // upstream silence and heartbeats every 10s, so 180s without ANY byte
    // means the network path itself is dead. Without this the JS promise
    // never settles and the task hangs with a frozen status.
    loop {
        let next = tokio::time::timeout(std::time::Duration::from_secs(180), stream.next())
            .await
            .map_err(|_| "网络请求失败：模型响应长时间没有新数据，请重试".to_string())?;
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("读取流失败: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim_end_matches('\r').to_string();
            buffer = buffer[pos + 1..].to_string();
            let Some(payload) = line.strip_prefix("data: ") else { continue };
            if payload == "[DONE]" {
                continue;
            }
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(payload) {
                if let Some(error) = data.get("error").and_then(|v| v.as_str()) {
                    // Match the non-streaming failure shape so the workbench
                    // treats it as a retryable upstream error.
                    let detail = serde_json::json!({ "detail": error }).to_string();
                    return Err(lectureai_http_error(503, &detail));
                }
                if let Some(content) = data.get("content").and_then(|v| v.as_str()) {
                    let _ = app_handle.emit("ai-stream-chunk", content);
                }
                if let Some(thinking) = data.get("thinking").and_then(|v| v.as_str()) {
                    let _ = app_handle.emit("ai-stream-thinking", thinking);
                }
            }
        }
    }

    let _ = app_handle.emit("ai-stream-done", ());
    Ok(())
}

#[cfg(test)]
mod lectureai_error_tests {
    use super::lectureai_http_error;

    #[test]
    fn marks_server_failures_as_retryable_without_hiding_http_status() {
        assert_eq!(
            lectureai_http_error(503, r#"{"detail":"LLM 服务请求失败"}"#),
            "LectureAI 上游模型暂时不可用（HTTP 503）：LLM 服务请求失败"
        );
    }

    #[test]
    fn preserves_actionable_client_error_details() {
        assert_eq!(
            lectureai_http_error(429, r#"{"detail":"已超出本月 AI 配额"}"#),
            "已超出本月 AI 配额"
        );
    }
}

async fn call_minimax_stream(
    app_handle: tauri::AppHandle,
    api_key: String,
    system_prompt: String,
    user_msg: String,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = direct_client();
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

// ---------- Multi-turn AI (workbench agent) ----------
// ChatMessage carries the full conversation history to the model, enabling
// Claude-Code-style multi-turn tool loops. The single-turn call_ai / call_ai_stream
// stay untouched so the existing per-page chat keeps working unchanged.

#[derive(serde::Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

/// Build an OpenAI-style messages array [{role, content}, ...] from the history.
fn openai_style_messages(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect()
}

/// Split into (system, user/assistant messages) for Anthropic-style bodies,
/// where the system prompt is a top-level field and each message content is a
/// content-block array.
fn anthropic_split_messages(messages: &[ChatMessage]) -> (String, Vec<serde_json::Value>) {
    let system = messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let msgs = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            serde_json::json!({ "role": m.role, "content": [{ "type": "text", "text": m.content }] })
        })
        .collect();
    (system, msgs)
}

// ── PPTE prompt asset: rules + protocol + linter ───────────────────────────
//
// The workbench agent's tool-protocol prompt and the formatting-rule text live
// in a bundled asset rather than the frontend JS. At runtime the backend loads
// either the encrypted `prompts.enc` (release builds, key injected at compile
// time) or the plaintext `prompts.example.txt` (community builds / dev), parses
// it, and prepends the protocol prompt to the workbench agent's system message
// before dispatching to a non-LectureAI provider. The mechanical linter runs
// entirely here so its rules never reach the frontend.

#[derive(Clone, Default)]
struct PromptBundle {
    rules_prompt: String,
    protocol_prompt: String,
    oral_words: Vec<String>,
}

static PROMPT_BUNDLE: Mutex<Option<PromptBundle>> = Mutex::new(None);

/// Parse the `===SECTION:name===` plaintext format into a PromptBundle.
fn parse_prompt_bundle(text: &str) -> PromptBundle {
    let mut bundle = PromptBundle::default();
    let mut name: Option<String> = None;
    let mut buf = String::new();
    let assign = |bundle: &mut PromptBundle, n: &str, v: &str| {
        match n {
            "rules_prompt" => bundle.rules_prompt = v.to_string(),
            "protocol_prompt" => bundle.protocol_prompt = v.to_string(),
            "oral_words" => bundle.oral_words = v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            _ => {}
        }
    };
    for line in text.lines() {
        if let Some(rest) = line
            .strip_prefix("===SECTION:")
            .and_then(|r| r.strip_suffix("==="))
        {
            if let Some(n) = &name {
                assign(&mut bundle, n, buf.trim_end());
            }
            name = Some(rest.to_string());
            buf = String::new();
        } else {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if let Some(n) = &name {
        assign(&mut bundle, n, buf.trim_end());
    }
    bundle
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Decrypt `nonce(12) || ciphertext || tag(16)` with the compile-time key.
fn decrypt_prompts(data: &[u8]) -> Option<String> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Key, Nonce,
    };
    let key_hex = option_env!("PPTE_PROMPT_KEY")?;
    let key_bytes = hex_decode(key_hex)?;
    if key_bytes.len() != 32 || data.len() < 12 + 16 {
        return None;
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&data[..12]);
    cipher
        .decrypt(nonce, &data[12..])
        .ok()
        .and_then(|pt| String::from_utf8(pt).ok())
}

fn load_prompt_bundle_uncached(app_handle: &tauri::AppHandle) -> Option<PromptBundle> {
    // 1. Bundled resource (release): encrypted prompts.enc, then plaintext example.
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let enc_path = resource_dir.join("resources").join("prompts.enc");
        if let Ok(data) = fs::read(&enc_path) {
            if let Some(pt) = decrypt_prompts(&data) {
                return Some(parse_prompt_bundle(&pt));
            }
        }
        let ex_path = resource_dir.join("resources").join("prompts.example.txt");
        if let Ok(text) = fs::read_to_string(&ex_path) {
            return Some(parse_prompt_bundle(&text));
        }
    }
    // 2. Dev mode: read plaintext source/example from the crate's resources dir.
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    if let Ok(text) = fs::read_to_string(dev_dir.join("prompts.source.txt")) {
        return Some(parse_prompt_bundle(&text));
    }
    if let Ok(text) = fs::read_to_string(dev_dir.join("prompts.example.txt")) {
        return Some(parse_prompt_bundle(&text));
    }
    None
}

fn load_prompt_bundle(app_handle: &tauri::AppHandle) -> PromptBundle {
    if let Ok(cache) = PROMPT_BUNDLE.lock() {
        if let Some(b) = cache.clone() {
            return b;
        }
    }
    let bundle = load_prompt_bundle_uncached(app_handle).unwrap_or_default();
    if let Ok(mut cache) = PROMPT_BUNDLE.lock() {
        *cache = Some(bundle.clone());
    }
    bundle
}

/// Prepend the tool-protocol prompt to the first system message (non-LectureAI
/// only; LectureAI's server owns the SKILL and prepends it itself).
fn prepend_protocol_prompt(
    app_handle: &tauri::AppHandle,
    provider: &str,
    mut messages: Vec<ChatMessage>,
) -> Vec<ChatMessage> {
    if provider == "lectureai" {
        return messages;
    }
    let bundle = load_prompt_bundle(app_handle);
    if bundle.protocol_prompt.is_empty() {
        return messages;
    }
    if let Some(m) = messages.iter_mut().find(|m| m.role == "system") {
        let original = std::mem::take(&mut m.content);
        m.content = format!("{}\n\n{}", bundle.protocol_prompt, original);
    } else {
        messages.insert(
            0,
            ChatMessage {
                role: "system".to_string(),
                content: bundle.protocol_prompt,
            },
        );
    }
    messages
}

#[derive(serde::Serialize)]
struct LintIssue {
    rule: String,
    severity: String,
    message: String,
    sample: Option<String>,
}

#[tauri::command]
fn ppte_lint(app_handle: tauri::AppHandle, html: String) -> Result<Vec<LintIssue>, String> {
    let bundle = load_prompt_bundle(&app_handle);
    Ok(lint_html(&html, &bundle))
}

/// Extract `border-left:` / `border-top:` declarations from an inline style.
fn find_border_side_decls(style: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = style.to_lowercase();
    for key in ["border-left:", "border-top:"] {
        let mut start = 0;
        while let Some(rel) = lower[start..].find(key) {
            let abs = start + rel;
            let val_start = abs + key.len();
            let val_end = style[val_start..]
                .find(';')
                .map(|e| val_start + e)
                .unwrap_or(style.len());
            out.push(style[abs..val_end].trim().to_string());
            start = val_end;
        }
    }
    out
}

fn lint_html(html: &str, bundle: &PromptBundle) -> Vec<LintIssue> {
    use scraper::{node::Node, Html, Selector};
    let mut issues: Vec<LintIssue> = Vec::new();
    if html.trim().is_empty() {
        return issues;
    }
    let doc = Html::parse_document(html);

    let lecturer_words = ["开场", "动手实验", "附录", "课程回顾"];
    let emoji_chars = [
        '✓', '✗', '⚠', '✅', '❗', '⚡', '●', '★', '☆', '☑', '☒', '⭐', '✨',
    ];
    let color_keywords = [
        "rgb", "hsl", "red", "orange", "blue", "green", "yellow", "purple", "pink", "amber",
        "emerald",
    ];

    // 1. Title lecturer traces.
    if let Ok(sel) = Selector::parse("h1, h2, h3, title") {
        for el in doc.select(&sel) {
            let t: String = el.text().collect::<Vec<_>>().join("");
            let t: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
            if t.is_empty() {
                continue;
            }
            if lecturer_words.iter().any(|w| t.contains(w)) {
                let head: String = t.chars().take(40).collect();
                issues.push(LintIssue {
                    rule: "去讲师痕迹".into(),
                    severity: "warn".into(),
                    message: format!("标题含讲师痕迹词：{}", head),
                    sample: None,
                });
            }
        }
    }

    // 2. Walk text nodes (skip pre/code/script/style ancestors).
    let tree = &doc.tree;
    for node_ref in tree.root().descendants() {
        let raw: String = match node_ref.value() {
            Node::Text(t) => t.text.trim().to_string(),
            _ => continue,
        };
        if raw.is_empty() {
            continue;
        }
        let mut in_code = false;
        let mut p = node_ref.parent();
        while let Some(pr) = p {
            if let Node::Element(e) = pr.value() {
                if matches!(e.name(), "pre" | "code" | "script" | "style") {
                    in_code = true;
                    break;
                }
            }
            p = pr.parent();
        }
        if in_code {
            continue;
        }
        let text: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }

        for w in &bundle.oral_words {
            if text.contains(w) {
                let head: String = text.chars().take(60).collect();
                issues.push(LintIssue {
                    rule: "全面书面化".into(),
                    severity: "warn".into(),
                    message: format!("口语词\"{}\"", w),
                    sample: Some(head),
                });
            }
        }
        if text.chars().any(|c| emoji_chars.contains(&c)) {
            let head: String = text.chars().take(60).collect();
            issues.push(LintIssue {
                rule: "emoji 换 SVG".into(),
                severity: "error".into(),
                message: "图形 emoji 应用内联 SVG 实现".into(),
                sample: Some(head),
            });
        }
        if text.contains("--") {
            let head: String = text.chars().take(60).collect();
            issues.push(LintIssue {
                rule: "去破折号".into(),
                severity: "warn".into(),
                message: "正文含 --，应用逗号或句号替代".into(),
                sample: Some(head),
            });
        }
        if text.ends_with('。') {
            if let Some(pid) = node_ref.parent() {
                if let Node::Element(e) = pid.value() {
                    if matches!(e.name(), "p" | "li" | "div" | "span") {
                        let tail: String = text
                            .chars()
                            .rev()
                            .take(40)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect();
                        issues.push(LintIssue {
                            rule: "去句末句号".into(),
                            severity: "info".into(),
                            message: "段落末尾句号建议去掉".into(),
                            sample: Some(tail),
                        });
                    }
                }
            }
        }
    }

    // 3. Card side borders (border-left/border-top with a color).
    if let Ok(sel) =
        Selector::parse(".card, .kpi, .map-card, [class*='step-card'], [class*='step_card']")
    {
        for el in doc.select(&sel) {
            let style = el.value().attr("style").unwrap_or("");
            for decl in find_border_side_decls(style) {
                let lower = decl.to_lowercase();
                let has_color =
                    lower.contains('#') || color_keywords.iter().any(|k| lower.contains(k));
                if has_color {
                    issues.push(LintIssue {
                        rule: "卡片不要侧边彩条".into(),
                        severity: "error".into(),
                        message: format!("卡片有 {}，应用统一 4 边边框", decl),
                        sample: None,
                    });
                }
            }
        }
    }

    // 4. Card colored gradient backgrounds.
    if let Ok(sel) = Selector::parse(".card, .kpi, .map-card") {
        for el in doc.select(&sel) {
            let style = el.value().attr("style").unwrap_or("");
            if style.to_lowercase().contains("gradient") {
                issues.push(LintIssue {
                    rule: "卡片中性背景".into(),
                    severity: "warn".into(),
                    message: "卡片背景含彩色渐变，应改中性 #fff / #f8fafc".into(),
                    sample: None,
                });
            }
        }
    }

    issues
}

#[tauri::command]
async fn call_ai_messages(
    provider: String,
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    match provider.as_str() {
        "deepseek" => call_deepseek_messages(api_key, messages).await,
        "minimax" => call_minimax_messages(api_key, messages).await,
        "lectureai" => call_lectureai_chat(api_key, messages, None, None).await,
        "custom" => call_custom_messages(api_key, api_type, base_url, model, messages).await,
        _ => Err("不支持的AI提供商".to_string()),
    }
}

#[tauri::command]
async fn call_ai_messages_stream(
    app_handle: tauri::AppHandle,
    provider: String,
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    messages: Vec<ChatMessage>,
    context_mode: Option<String>,
    context_template_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let messages = prepend_protocol_prompt(&app_handle, &provider, messages);
    match provider.as_str() {
        "minimax" => call_minimax_messages_stream(app_handle, api_key, messages).await,
        "deepseek" => {
            let result = call_deepseek_messages(api_key, messages).await?;
            let _ = app_handle.emit("ai-stream-chunk", result);
            let _ = app_handle.emit("ai-stream-done", ());
            Ok(())
        }
        "lectureai" => {
            call_lectureai_chat_stream(app_handle, api_key, messages, context_mode, context_template_ids).await
        }
        "custom" => {
            let result = call_custom_messages(api_key, api_type, base_url, model, messages).await?;
            let _ = app_handle.emit("ai-stream-chunk", result);
            let _ = app_handle.emit("ai-stream-done", ());
            Ok(())
        }
        _ => Err("该提供商不支持流式输出".to_string()),
    }
}

async fn call_deepseek_messages(api_key: String, messages: Vec<ChatMessage>) -> Result<String, String> {
    let client = direct_client();
    let body = serde_json::json!({
        "model": "deepseek-chat",
        "messages": openai_style_messages(&messages),
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

async fn call_minimax_messages(api_key: String, messages: Vec<ChatMessage>) -> Result<String, String> {
    let (system, msgs) = anthropic_split_messages(&messages);
    let client = direct_client();
    let body = serde_json::json!({
        "model": "MiniMax-M2.5",
        "max_tokens": 4000,
        "system": system,
        "messages": msgs
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

async fn call_minimax_messages_stream(
    app_handle: tauri::AppHandle,
    api_key: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let (system, msgs) = anthropic_split_messages(&messages);
    let client = direct_client();
    let body = serde_json::json!({
        "model": "MiniMax-M2.5",
        "max_tokens": 4000,
        "system": system,
        "messages": msgs,
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

async fn call_custom_messages(
    api_key: String,
    api_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let (api_type, base_url, model) = normalize_custom_api_config(api_type, base_url, model)?;
    match api_type.as_str() {
        "openai-chat" => call_openai_chat_messages(api_key, base_url, model, messages).await,
        "openai-responses" => call_openai_responses_messages(api_key, base_url, model, messages).await,
        "anthropic-messages" => call_anthropic_messages_messages(api_key, base_url, model, messages).await,
        _ => Err("不支持的 API 类型".to_string()),
    }
}

async fn call_openai_chat_messages(
    api_key: String,
    base_url: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": openai_style_messages(&messages),
        "stream": false
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

async fn call_openai_responses_messages(
    api_key: String,
    base_url: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "input": openai_style_messages(&messages),
        "stream": false
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

async fn call_anthropic_messages_messages(
    api_key: String,
    base_url: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let (system, msgs) = anthropic_split_messages(&messages);
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4000,
        "system": system,
        "messages": msgs
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

#[tauri::command]
async fn check_update(current_version: String, server_url: String) -> Result<UpdateInfo, String> {
    // 独立 client + 短超时：断网或服务器无响应时快速失败，绝不拖住启动流程
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
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
    let client = direct_client();
    let url = format!("{}/api/notifications?version={}", server_url, current_version);

    let response = client.get(&url).send().await.map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("服务器错误: {}", response.status()));
    }

    let notifications: Vec<Notification> = response.json().await.map_err(|e| format!("解析失败: {}", e))?;
    Ok(notifications)
}

// === Live Caption Commands ===

type CaptionSocket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

enum CaptionServerEvent {
    Result(CaptionResultPayload),
    Finished,
    Failed(String),
    Ignore,
}

fn caption_run_task_message(task_id: &str, model: CaptionModel) -> String {
    let parameters = match model {
        CaptionModel::FunAsr => serde_json::json!({
            "format": "pcm",
            "sample_rate": 16000,
            "language_hints": ["zh"],
            "max_sentence_silence": 800,
            "heartbeat": true
        }),
        CaptionModel::Paraformer => serde_json::json!({
            "format": "pcm",
            "sample_rate": 16000,
            "language_hints": ["zh"],
            "disfluency_removal_enabled": true,
            "semantic_punctuation_enabled": false,
            "max_sentence_silence": 800,
            "heartbeat": true
        }),
    };
    serde_json::json!({
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": model.model_id(),
            "parameters": parameters,
            "input": {}
        }
    })
    .to_string()
}

fn caption_finish_task_message(task_id: &str) -> String {
    serde_json::json!({
        "header": {
            "action": "finish-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": { "input": {} }
    })
    .to_string()
}

fn parse_caption_server_event(text: &str) -> Result<CaptionServerEvent, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("字幕服务返回了无效数据：{}", e))?;
    let event = value["header"]["event"].as_str().unwrap_or_default();
    match event {
        "result-generated" => {
            let sentence = &value["payload"]["output"]["sentence"];
            if sentence["heartbeat"].as_bool().unwrap_or(false) {
                return Ok(CaptionServerEvent::Ignore);
            }
            let text = sentence["text"].as_str().unwrap_or_default().trim();
            if text.is_empty() {
                return Ok(CaptionServerEvent::Ignore);
            }
            Ok(CaptionServerEvent::Result(CaptionResultPayload {
                text: text.to_string(),
                is_final: sentence["sentence_end"].as_bool().unwrap_or(false),
                sentence_id: sentence["sentence_id"].as_i64().unwrap_or_default(),
            }))
        }
        "task-finished" => Ok(CaptionServerEvent::Finished),
        "task-failed" => {
            let code = value["header"]["error_code"].as_str().unwrap_or("UNKNOWN");
            let message = value["header"]["error_message"]
                .as_str()
                .unwrap_or("字幕识别任务失败");
            Ok(CaptionServerEvent::Failed(format!("{}：{}", code, message)))
        }
        _ => Ok(CaptionServerEvent::Ignore),
    }
}

fn caption_event_is_empty_audio(event: &CaptionServerEvent) -> bool {
    matches!(event, CaptionServerEvent::Failed(message)
        if message.starts_with("EmptyAudio")
            || message.starts_with("SUCCESS_WITH_NO_VALID_FRAGMENT")
            || message.starts_with("ASR_RESPONSE_HAVE_NO_WORDS"))
}

fn caption_result_should_emit(result: &CaptionResultPayload, final_only: bool) -> bool {
    !final_only || result.is_final
}

fn emit_caption_status(app_handle: &tauri::AppHandle, state: &str, message: &str) {
    let _ = app_handle.emit(
        "caption-status",
        CaptionStatusPayload {
            state: state.to_string(),
            message: message.to_string(),
        },
    );
}

fn emit_caption_server_event(
    app_handle: &tauri::AppHandle,
    event: CaptionServerEvent,
    final_only: bool,
) -> Result<bool, String> {
    match event {
        CaptionServerEvent::Result(result) => {
            if !caption_result_should_emit(&result, final_only) {
                return Ok(false);
            }
            app_handle
                .emit("caption-result", result)
                .map_err(|e| format!("无法广播字幕结果：{}", e))?;
            Ok(false)
        }
        CaptionServerEvent::Finished => Ok(true),
        CaptionServerEvent::Failed(message) => Err(message),
        CaptionServerEvent::Ignore => Ok(false),
    }
}

async fn connect_caption_socket(
    api_key: &str,
    model: CaptionModel,
) -> Result<(CaptionSocket, String), String> {
    let mut request = CAPTION_WS_URL
        .into_client_request()
        .map_err(|e| format!("无法创建字幕连接：{}", e))?;
    let authorization = format!("Bearer {}", api_key.trim())
        .parse()
        .map_err(|e| format!("字幕 API Key 格式无效：{}", e))?;
    request.headers_mut().insert("Authorization", authorization);
    request.headers_mut().insert(
        "user-agent",
        "lecture-presenter-live-caption/1.0"
            .parse()
            .map_err(|e| format!("无法设置字幕客户端标识：{}", e))?,
    );

    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "连接阿里云字幕服务超时".to_string())?
    .map_err(|e| format!("无法连接阿里云字幕服务：{}", e))?;

    let task_id = uuid::Uuid::new_v4().to_string();
    socket
        .send(Message::Text(caption_run_task_message(&task_id, model).into()))
        .await
        .map_err(|e| format!("无法启动字幕任务：{}", e))?;

    loop {
        let message = tokio::time::timeout(Duration::from_secs(20), socket.next())
            .await
            .map_err(|_| "等待字幕服务启动超时".to_string())?
            .ok_or_else(|| "字幕服务在启动前关闭了连接".to_string())?
            .map_err(|e| format!("字幕服务连接失败：{}", e))?;
        match message {
            Message::Text(text) => {
                let value: serde_json::Value = serde_json::from_str(text.as_str())
                    .map_err(|e| format!("字幕服务返回了无效数据：{}", e))?;
                match value["header"]["event"].as_str().unwrap_or_default() {
                    "task-started" => return Ok((socket, task_id)),
                    "task-failed" => {
                        let code = value["header"]["error_code"].as_str().unwrap_or("UNKNOWN");
                        let message = value["header"]["error_message"]
                            .as_str()
                            .unwrap_or("字幕识别任务启动失败");
                        return Err(format!("{}：{}", code, message));
                    }
                    _ => {}
                }
            }
            Message::Ping(data) => {
                socket
                    .send(Message::Pong(data))
                    .await
                    .map_err(|e| format!("字幕连接心跳失败：{}", e))?;
            }
            Message::Close(_) => return Err("字幕服务在启动前关闭了连接".to_string()),
            _ => {}
        }
    }
}

async fn finish_caption_socket(
    socket: &mut CaptionSocket,
    task_id: &str,
    app_handle: Option<&tauri::AppHandle>,
    final_only: bool,
) -> Result<(), String> {
    socket
        .send(Message::Text(caption_finish_task_message(task_id).into()))
        .await
        .map_err(|e| format!("无法结束字幕任务：{}", e))?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    loop {
        let message = tokio::time::timeout_at(deadline, socket.next())
            .await
            .map_err(|_| "等待字幕任务结束超时".to_string())?
            .ok_or_else(|| "字幕连接提前关闭".to_string())?
            .map_err(|e| format!("字幕连接关闭失败：{}", e))?;
        match message {
            Message::Text(text) => {
                let event = parse_caption_server_event(text.as_str())?;
                // Starting and stopping before the presenter speaks is a normal user action.
                // ASR models may report an empty session as a service error instead of task-finished.
                if caption_event_is_empty_audio(&event) {
                    return Ok(());
                }
                if let Some(handle) = app_handle {
                    if emit_caption_server_event(handle, event, final_only)? {
                        return Ok(());
                    }
                } else {
                    match event {
                        CaptionServerEvent::Finished => return Ok(()),
                        CaptionServerEvent::Failed(message) => return Err(message),
                        _ => {}
                    }
                }
            }
            Message::Ping(data) => {
                socket
                    .send(Message::Pong(data))
                    .await
                    .map_err(|e| format!("字幕连接心跳失败：{}", e))?;
            }
            Message::Close(_) => return Ok(()),
            _ => {}
        }
    }
}

#[tauri::command]
fn caption_token_status() -> Result<TokenStatus, String> {
    let configured = read_caption_token()
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false);
    Ok(TokenStatus { configured })
}

#[tauri::command]
fn caption_token_set(token: String) -> Result<TokenStatus, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("字幕 API Key 不能为空".to_string());
    }
    store_caption_token(token)?;
    Ok(TokenStatus { configured: true })
}

#[tauri::command]
fn caption_token_clear() -> Result<TokenStatus, String> {
    clear_caption_token();
    Ok(TokenStatus { configured: false })
}

#[tauri::command]
async fn caption_test(model: Option<String>) -> Result<String, String> {
    let model = CaptionModel::from_setting(model.as_deref())?;
    let api_key = read_caption_token()?;
    let (mut socket, task_id) = connect_caption_socket(&api_key, model).await?;
    socket
        .send(Message::Binary(vec![0_u8; 3200].into()))
        .await
        .map_err(|e| format!("无法发送字幕测试音频：{}", e))?;
    finish_caption_socket(&mut socket, &task_id, None, false).await?;
    let _ = socket.close(None).await;
    Ok(format!("阿里云 {} 实时字幕连接正常", model.display_name()))
}

#[tauri::command]
async fn caption_start(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LiveCaptionState>,
    model: Option<String>,
    display_mode: Option<String>,
) -> Result<(), String> {
    let model = CaptionModel::from_setting(model.as_deref())?;
    let final_only = caption_final_only(display_mode.as_deref())?;
    emit_caption_status(&app_handle, "starting", "正在连接实时字幕…");

    if let Some(previous) = state.active.lock().await.take() {
        let _ = previous.sender.send(CaptionCommand::Stop).await;
    }

    let api_key = read_caption_token()?;
    let (mut socket, task_id) = connect_caption_socket(&api_key, model).await.map_err(|error| {
        emit_caption_status(&app_handle, "error", &error);
        error
    })?;
    let (sender, mut receiver) = mpsc::channel::<CaptionCommand>(64);
    let session = ActiveCaptionSession {
        id: task_id.clone(),
        sender: sender.clone(),
    };
    *state.active.lock().await = Some(session);

    let active_state = state.active.clone();
    let session_id = task_id.clone();
    let task_app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut failed = None::<String>;
        emit_caption_status(&task_app, "listening", "字幕已开启");

        'session: loop {
            tokio::select! {
                command = receiver.recv() => {
                    match command {
                        Some(CaptionCommand::Audio(bytes)) => {
                            if let Err(error) = socket.send(Message::Binary(bytes.into())).await {
                                failed = Some(format!("发送麦克风音频失败：{}", error));
                                break 'session;
                            }
                        }
                        Some(CaptionCommand::Stop) | None => {
                            if let Err(error) = finish_caption_socket(&mut socket, &task_id, Some(&task_app), final_only).await {
                                failed = Some(error);
                            }
                            break 'session;
                        }
                    }
                }
                incoming = socket.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            match parse_caption_server_event(text.as_str())
                                .and_then(|event| emit_caption_server_event(&task_app, event, final_only)) {
                                Ok(true) => break 'session,
                                Ok(false) => {}
                                Err(error) => {
                                    failed = Some(error);
                                    break 'session;
                                }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            if let Err(error) = socket.send(Message::Pong(data)).await {
                                failed = Some(format!("字幕连接心跳失败：{}", error));
                                break 'session;
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            failed = Some("字幕服务连接已断开".to_string());
                            break 'session;
                        }
                        Some(Err(error)) => {
                            failed = Some(format!("字幕服务连接异常：{}", error));
                            break 'session;
                        }
                        _ => {}
                    }
                }
            }
        }

        let _ = socket.close(None).await;
        let mut active = active_state.lock().await;
        let was_current = active.as_ref().map(|item| item.id.as_str()) == Some(session_id.as_str());
        if was_current {
            *active = None;
        }
        drop(active);

        if was_current {
            if let Some(error) = failed {
                emit_caption_status(&task_app, "error", &error);
            } else {
                emit_caption_status(&task_app, "stopped", "字幕已关闭");
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn caption_audio_chunk(
    state: tauri::State<'_, LiveCaptionState>,
    audio_base64: String,
) -> Result<(), String> {
    if audio_base64.len() > 350_000 {
        return Err("字幕音频分片过大".to_string());
    }
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        audio_base64,
    )
    .map_err(|e| format!("字幕音频编码无效：{}", e))?;
    let sender = state
        .active
        .lock()
        .await
        .as_ref()
        .map(|session| session.sender.clone());
    if let Some(sender) = sender {
        sender
            .send(CaptionCommand::Audio(bytes))
            .await
            .map_err(|_| "字幕会话已经结束".to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn caption_stop(state: tauri::State<'_, LiveCaptionState>) -> Result<(), String> {
    let session = state.active.lock().await.as_ref().cloned();
    if let Some(session) = session {
        let _ = session.sender.send(CaptionCommand::Stop).await;
    }
    Ok(())
}

#[cfg(test)]
mod live_caption_tests {
    use super::*;

    #[test]
    fn run_task_uses_fun_asr_realtime_pcm16() {
        let value: serde_json::Value =
            serde_json::from_str(&caption_run_task_message("test-task", CaptionModel::FunAsr)).unwrap();
        assert_eq!(value["header"]["action"], "run-task");
        assert_eq!(value["payload"]["model"], "fun-asr-realtime");
        assert_eq!(value["payload"]["parameters"]["format"], "pcm");
        assert_eq!(value["payload"]["parameters"]["sample_rate"], 16000);
        assert_eq!(value["payload"]["parameters"]["language_hints"][0], "zh");
        assert!(value["payload"]["parameters"].get("disfluency_removal_enabled").is_none());
    }

    #[test]
    fn run_task_supports_paraformer_disfluency_removal() {
        let value: serde_json::Value = serde_json::from_str(&caption_run_task_message(
            "test-task",
            CaptionModel::Paraformer,
        ))
        .unwrap();
        assert_eq!(value["payload"]["model"], "paraformer-realtime-v2");
        assert_eq!(value["payload"]["parameters"]["format"], "pcm");
        assert_eq!(value["payload"]["parameters"]["sample_rate"], 16000);
        assert_eq!(
            value["payload"]["parameters"]["disfluency_removal_enabled"],
            true
        );
        assert_eq!(value["payload"]["parameters"]["max_sentence_silence"], 800);
        assert_eq!(value["payload"]["parameters"]["heartbeat"], true);
    }

    #[test]
    fn validates_caption_preferences() {
        assert_eq!(
            CaptionModel::from_setting(Some("paraformer-realtime-v2")).unwrap(),
            CaptionModel::Paraformer
        );
        assert!(CaptionModel::from_setting(Some("unknown")).is_err());
        assert!(caption_final_only(Some("stable")).unwrap());
        assert!(!caption_final_only(Some("realtime")).unwrap());
        assert!(caption_final_only(Some("unknown")).is_err());
    }

    #[test]
    fn stable_display_hides_interim_results() {
        let interim = CaptionResultPayload {
            text: "正在修改".to_string(),
            is_final: false,
            sentence_id: 1,
        };
        let final_result = CaptionResultPayload {
            text: "最终字幕。".to_string(),
            is_final: true,
            sentence_id: 1,
        };
        assert!(caption_result_should_emit(&interim, false));
        assert!(!caption_result_should_emit(&interim, true));
        assert!(caption_result_should_emit(&final_result, true));
    }

    #[test]
    fn macos_bundle_grants_microphone_audio_input() {
        let entitlements = include_str!("../Entitlements.plist");
        assert!(entitlements.contains("com.apple.security.device.audio-input"));
        assert!(entitlements.contains("<true/>"));

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["macOS"]["entitlements"],
            "./Entitlements.plist"
        );
    }

    #[test]
    fn parses_incremental_and_final_results() {
        let partial = r#"{
          "header":{"event":"result-generated"},
          "payload":{"output":{"sentence":{"text":"演讲","sentence_end":false,"sentence_id":7,"heartbeat":false}}}
        }"#;
        match parse_caption_server_event(partial).unwrap() {
            CaptionServerEvent::Result(result) => {
                assert_eq!(result.text, "演讲");
                assert!(!result.is_final);
                assert_eq!(result.sentence_id, 7);
            }
            _ => panic!("expected a partial caption result"),
        }

        let final_result = r#"{
          "header":{"event":"result-generated"},
          "payload":{"output":{"sentence":{"text":"演讲宝。","sentence_end":true,"sentence_id":7,"heartbeat":false}}}
        }"#;
        match parse_caption_server_event(final_result).unwrap() {
            CaptionServerEvent::Result(result) => {
                assert_eq!(result.text, "演讲宝。");
                assert!(result.is_final);
            }
            _ => panic!("expected a final caption result"),
        }
    }

    #[test]
    fn ignores_heartbeat_and_surfaces_service_failures() {
        let heartbeat = r#"{
          "header":{"event":"result-generated"},
          "payload":{"output":{"sentence":{"text":"","sentence_end":false,"sentence_id":0,"heartbeat":true}}}
        }"#;
        assert!(matches!(
            parse_caption_server_event(heartbeat).unwrap(),
            CaptionServerEvent::Ignore
        ));

        let failure = r#"{
          "header":{"event":"task-failed","error_code":"INVALID_API_KEY","error_message":"denied"},
          "payload":{}
        }"#;
        match parse_caption_server_event(failure).unwrap() {
            CaptionServerEvent::Failed(message) => {
                assert!(message.contains("INVALID_API_KEY"));
                assert!(message.contains("denied"));
            }
            _ => panic!("expected a caption service failure"),
        }
    }

    #[tokio::test]
    #[ignore = "requires DASHSCOPE_API_KEY and network access"]
    async fn live_fun_asr_connection_starts_and_finishes() {
        let api_key = std::env::var("DASHSCOPE_API_KEY")
            .expect("DASHSCOPE_API_KEY must be set for this ignored integration test");
        let (mut socket, task_id) = connect_caption_socket(&api_key, CaptionModel::FunAsr)
            .await
            .unwrap();
        socket
            .send(Message::Binary(vec![0_u8; 3200].into()))
            .await
            .unwrap();
        finish_caption_socket(&mut socket, &task_id, None, false)
            .await
            .unwrap();
        let _ = socket.close(None).await;
    }

    #[tokio::test]
    #[ignore = "requires DASHSCOPE_API_KEY and network access"]
    async fn live_paraformer_connection_starts_and_finishes() {
        let api_key = std::env::var("DASHSCOPE_API_KEY")
            .expect("DASHSCOPE_API_KEY must be set for this ignored integration test");
        let (mut socket, task_id) = connect_caption_socket(&api_key, CaptionModel::Paraformer)
            .await
            .unwrap();
        socket
            .send(Message::Binary(vec![0_u8; 3200].into()))
            .await
            .unwrap();
        finish_caption_socket(&mut socket, &task_id, None, false)
            .await
            .unwrap();
        let _ = socket.close(None).await;
    }
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

// Workbench Agent window - a separate chat window so the main editor can stay
// full-width for preview while the user talks to the agent side by side.
// Mirrors open_audience_window. Chat/AI/protocol live in workbench.html; tool
// execution is delegated back to the main window via events (see
// ppte-workbench-agent.js).
#[tauri::command]
async fn open_workbench_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    // If already open, just focus it.
    if let Some(window) = app_handle.get_webview_window("workbench") {
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app_handle,
        "workbench",
        WebviewUrl::App("workbench.html".into()),
    )
    .title("工作台助手")
    .inner_size(760.0, 780.0)
    .min_inner_size(600.0, 560.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;

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
        .manage(LiveCaptionState::default())
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
            let export_script_index = url.query().and_then(|query| {
                query.split('&').find_map(|pair| {
                    pair.strip_prefix("ppte-export-script=")
                        .and_then(|value| value.parse::<usize>().ok())
                })
            });

            match fs::read(&file_path) {
                Ok(content) => {
                    if let Some(index) = export_script_index {
                        return match extract_html_script_body(&content, index) {
                            Some(script) => http::Response::builder()
                                .status(200)
                                .header("Content-Type", "text/javascript; charset=utf-8")
                                .header("Access-Control-Allow-Origin", "*")
                                .body(script)
                                .unwrap(),
                            None => http::Response::builder()
                                .status(404)
                                .header("Content-Type", "text/plain")
                                .body(format!("Script {} not found in {}", index, file_path).into_bytes())
                                .unwrap(),
                        };
                    }
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
            auth_api_request,
            read_course_config,
            resolve_asset_path,
            read_file_bytes,
            read_text_file,
            ppte_skill_list,
            ppte_skill_read,
            ppte_skill_import,
            write_text_file,
            ppte_agent_plan_read,
            ppte_agent_plan_write,
            ppte_agent_plan_refresh,
            lectureai_design_examples,
            lectureai_render_template,
            lectureai_icon_search,
            ppte_download_icon,
            save_pptx_file,
            export_pptx_editable,
            list_ppt_templates,
            get_template_files,
            save_app_config,
            save_course_config,
            get_app_data_dir,
            pick_files,
            pick_reference_file,
            pick_reference_files,
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
            ppte_shared_group_inspect,
            ppte_shared_group_snapshot,
            ppte_shared_snapshot_hash,
            ppte_copy_slides,
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
            call_ai_messages,
            call_ai_messages_stream,
            ppte_lint,
            test_ai_config,
            local_ppte_agent_status,
            local_ppte_agent_start,
            local_ppte_agent_action,
            local_ppte_agent_read_job,
            check_update,
            fetch_notifications,
            caption_token_status,
            caption_token_set,
            caption_token_clear,
            caption_test,
            caption_start,
            caption_audio_chunk,
            caption_stop,
            open_audience_window,
            close_audience_window,
            open_workbench_window,
            emit_slide_change,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
