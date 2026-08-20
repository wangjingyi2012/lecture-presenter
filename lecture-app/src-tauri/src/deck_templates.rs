use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use unicase::UniCase;
use unicode_normalization::UnicodeNormalization;

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ENTRIES: usize = 500;
const MAX_COMPRESSION_RATIO: u64 = 200;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentRole {
    #[serde(default)]
    id: String,
    file: String,
    #[serde(default)]
    title: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum ContentRoles {
    File(String),
    Items(Vec<ContentRole>),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TemplateRoles {
    cover: String,
    catalog: String,
    chapter: String,
    content: ContentRoles,
    finish: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemplateDefinition {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    tags: Vec<String>,
    roles: TemplateRoles,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltinTemplateItem {
    id: String,
    name: String,
    version: String,
    description: String,
    digest: String,
    has_preview: bool,
    source: String,
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || value.starts_with('-')
        || value.ends_with('-')
        || value
            .chars()
            .any(|ch| !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'))
    {
        return Err("模板 id 必须是 kebab-case 单段标识".to_string());
    }
    Ok(())
}

fn validate_remote_id(value: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(value).map_err(|_| "模板远端 id 格式错误".to_string())?;
    Ok(())
}

fn builtin_roots(app_handle: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.extend([
            cwd.join("../PPT-Template"),
            cwd.join("PPT-Template"),
            cwd.join("src-tauri/PPT-Template"),
            cwd.join("../../PPT-Template"),
        ]);
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            roots.push(dir.join("../Resources/PPT-Template"));
            roots.push(dir.join("../../Resources/PPT-Template"));
        }
    }
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        roots.push(resource_dir.join("PPT-Template"));
    }
    roots
}

fn builtin_root(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    builtin_roots(app_handle)
        .into_iter()
        .find(|path| path.is_dir())
        .ok_or_else(|| "未找到内置模板目录".to_string())
}

fn read_definition(root: &Path) -> Result<TemplateDefinition, String> {
    let bytes =
        fs::read(root.join("template.json")).map_err(|_| "模板缺少 template.json".to_string())?;
    let mut definition: TemplateDefinition = serde_json::from_slice(&bytes)
        .map_err(|error| format!("template.json 格式错误：{}", error))?;
    if definition.schema_version != 1 {
        return Err("template.json schemaVersion 必须为 1".to_string());
    }
    definition.id = definition.id.trim().to_string();
    validate_id(&definition.id)?;
    definition.name = definition.name.trim().to_string();
    definition.version = definition.version.trim().to_string();
    if definition.name.is_empty() || definition.name.chars().count() > 200 {
        return Err("模板名称不能为空且不能超过 200 字".to_string());
    }
    if definition.version.is_empty()
        || definition.version.len() > 40
        || !definition
            .version
            .bytes()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric())
        || !definition.version.bytes().all(|value| {
            value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'+' | b'-')
        })
    {
        return Err("模板 version 格式不合法".to_string());
    }
    definition.description = definition.description.trim().chars().take(2000).collect();
    let mut normalized_tags = Vec::new();
    for value in &definition.tags {
        let tag = value.trim().chars().take(30).collect::<String>();
        if !tag.is_empty() && !normalized_tags.contains(&tag) {
            normalized_tags.push(tag);
            if normalized_tags.len() == 12 {
                break;
            }
        }
    }
    definition.tags = normalized_tags;
    let contents = match &definition.roles.content {
        ContentRoles::File(file) => vec![ContentRole {
            id: "default".to_string(),
            file: file.clone(),
            title: "正文".to_string(),
        }],
        ContentRoles::Items(items) => items.clone(),
    };
    if contents.is_empty() {
        return Err("content 至少需要一个正文变体".to_string());
    }
    let mut ids = HashSet::new();
    let mut normalized = Vec::new();
    let content_count = contents.len();
    for (index, mut item) in contents.into_iter().enumerate() {
        item.id = item.id.trim().to_string();
        item.file = item.file.trim().to_string();
        if item.id.trim().is_empty() {
            item.id = if content_count == 1 {
                "default".to_string()
            } else {
                return Err("content 变体 id 必须是唯一 kebab-case".to_string());
            };
        }
        validate_id(&item.id)?;
        if !ids.insert(item.id.clone()) {
            return Err(format!("content 变体 id 重复：{}", item.id));
        }
        validate_role_file(&item.file, "content")?;
        item.title = item.title.trim().chars().take(100).collect();
        if item.title.is_empty() {
            item.title = format!("正文 {}", index + 1);
        }
        normalized.push(item);
    }
    definition.roles.cover = definition.roles.cover.trim().to_string();
    definition.roles.catalog = definition.roles.catalog.trim().to_string();
    definition.roles.chapter = definition.roles.chapter.trim().to_string();
    definition.roles.finish = definition.roles.finish.trim().to_string();
    for (role, file) in [
        ("cover", &definition.roles.cover),
        ("catalog", &definition.roles.catalog),
        ("chapter", &definition.roles.chapter),
        ("finish", &definition.roles.finish),
    ] {
        validate_role_file(file, role)?;
    }
    definition.roles.content = ContentRoles::Items(normalized);
    let mut role_paths = HashSet::new();
    for file in role_files(&definition) {
        if !role_paths.insert(platform_name_key(&file)) {
            return Err(format!("角色 HTML 重复：{}", file));
        }
    }
    Ok(definition)
}

fn validate_role_file(file: &str, role: &str) -> Result<(), String> {
    let path = Path::new(file);
    if path.file_name().and_then(|name| name.to_str()) != Some(file)
        || !file.to_ascii_lowercase().ends_with(".html")
        || file.starts_with('.')
    {
        return Err(format!("{} 角色必须引用模板根目录 HTML 文件", role));
    }
    Ok(())
}

fn normalized_relative(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.split('/').any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || part == "__MACOSX"
            || part.starts_with('.')
    }) {
        return Err(format!("模板包含非法路径：{}", text));
    }
    Ok(text.nfc().collect())
}

fn platform_name_key(value: &str) -> String {
    UniCase::new(value.nfc().collect::<String>()).to_folded_case()
}

fn is_generated_slide_name(relative: &str) -> bool {
    if relative.contains('/') {
        return false;
    }
    let value = platform_name_key(relative);
    let Some(rest) = value.strip_prefix("slide") else {
        return false;
    };
    let number = rest
        .strip_suffix(".html")
        .or_else(|| rest.strip_suffix(".note"));
    number.is_some_and(|digits| {
        !digits.is_empty() && digits.chars().all(|item| item.is_ascii_digit())
    })
}

fn allowed_file(relative: &str) -> bool {
    if relative == "README.md" {
        return true;
    }
    matches!(
        Path::new(relative)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "html" | "css" | "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "json"
    )
}

fn validate_template_root(root: &Path) -> Result<TemplateDefinition, String> {
    let definition = read_definition(root)?;
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err(format!("模板包含符号链接：{}", path.display()));
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            let relative = normalized_relative(root, &path)?;
            let key = platform_name_key(&relative);
            if !seen.insert(key) {
                return Err(format!("模板包含跨平台重名文件：{}", relative));
            }
            if seen.len() > MAX_ENTRIES {
                return Err("模板文件数量超过 500 个".to_string());
            }
            if !allowed_file(&relative) {
                return Err(format!("模板文件类型不支持：{}", relative));
            }
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if relative == "README.md" || matches!(extension.as_str(), "html" | "css" | "json") {
                fs::read_to_string(&path)
                    .map_err(|_| format!("模板文本文件必须使用 UTF-8：{}", relative))?;
            }
            let first = platform_name_key(relative.split('/').next().unwrap_or(""));
            if matches!(
                first.as_str(),
                "manifest.json"
                    | "outline.md"
                    | ".lectureai"
                    | ".ppte-template"
                    | ".ppte-links"
                    | ".ppte-copies"
            ) || is_generated_slide_name(&relative)
            {
                return Err(format!("模板使用保留路径：{}", relative));
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err(format!("模板文件超过 10MB：{}", relative));
            }
            total += metadata.len();
            if total > MAX_TOTAL_BYTES {
                return Err("模板总大小超过 50MB".to_string());
            }
        }
    }
    for file in role_files(&definition) {
        if !root.join(&file).is_file() {
            return Err(format!("角色文件不存在：{}", file));
        }
    }
    Ok(definition)
}

fn role_files(definition: &TemplateDefinition) -> Vec<String> {
    let mut files = vec![
        definition.roles.cover.clone(),
        definition.roles.catalog.clone(),
        definition.roles.chapter.clone(),
        definition.roles.finish.clone(),
    ];
    if let ContentRoles::Items(items) = &definition.roles.content {
        files.extend(items.iter().map(|item| item.file.clone()));
    }
    files
}

fn canonical_tree_digest(root: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                files.push((normalized_relative(root, &path)?, path));
            }
        }
    }
    files.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    let mut hasher = Sha256::new();
    for (relative, path) in files {
        let size = fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len();
        hasher.update(relative.as_bytes());
        hasher.update(b"\0");
        hasher.update(size.to_string().as_bytes());
        hasher.update(b"\0");
        let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn find_builtin(app_handle: &tauri::AppHandle, template_id: &str) -> Result<PathBuf, String> {
    validate_id(template_id)?;
    let root = builtin_root(app_handle)?;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            if let Ok(definition) = read_definition(&path) {
                if definition.id == template_id {
                    return Ok(path);
                }
            }
        }
    }
    Err("内置模板不存在".to_string())
}

#[tauri::command]
pub(crate) fn list_deck_templates_builtin(
    app_handle: tauri::AppHandle,
) -> Result<Vec<BuiltinTemplateItem>, String> {
    let root = builtin_root(&app_handle)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.is_dir() || !path.join("template.json").is_file() {
            continue;
        }
        let definition = validate_template_root(&path)?;
        items.push(BuiltinTemplateItem {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            description: definition.description,
            digest: format!("sha256:{}", canonical_tree_digest(&path)?),
            has_preview: path.join("preview.png").is_file(),
            source: "builtin".to_string(),
        });
    }
    items.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(items)
}

#[tauri::command]
pub(crate) async fn deck_templates_fetch_list(
    server_url: String,
    token: String,
) -> Result<Value, String> {
    if token.trim().is_empty() {
        return Err("unauthorized: 请先登录".to_string());
    }
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get(format!(
            "{}/api/web/deck-templates",
            server_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("模板中心连接失败：{}", error))?;
    if response.status().as_u16() == 401 {
        return Err("unauthorized: 登录已过期，请重新登录".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "模板中心返回错误（{}）：{}",
            response.status().as_u16(),
            response.text().await.unwrap_or_default()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("模板列表格式错误：{}", error))
}

#[tauri::command]
pub(crate) async fn get_deck_template_preview(
    app_handle: tauri::AppHandle,
    source: String,
    template_id: String,
    server_url: Option<String>,
    token: Option<String>,
    expected_digest: Option<String>,
) -> Result<Option<String>, String> {
    if !matches!(source.as_str(), "builtin" | "custom" | "cloud") {
        return Err("模板来源不合法".to_string());
    }
    let bytes = if source == "builtin" {
        let path = find_builtin(&app_handle, &template_id)?.join("preview.png");
        if !path.is_file() {
            return Ok(None);
        }
        fs::read(path).map_err(|error| error.to_string())?
    } else {
        validate_remote_id(&template_id)?;
        let preview_cache = if let Some(value) = expected_digest {
            let digest = value
                .strip_prefix("sha256:")
                .unwrap_or(&value)
                .to_ascii_lowercase();
            if digest.len() != 64 || !digest.chars().all(|item| item.is_ascii_hexdigit()) {
                return Err("模板预览摘要格式错误".to_string());
            }
            Some(
                app_handle
                    .path()
                    .app_data_dir()
                    .map_err(|error| error.to_string())?
                    .join("deck-template-previews")
                    .join(&template_id)
                    .join(format!("{}.png", digest)),
            )
        } else {
            None
        };
        if let Some(path) = &preview_cache {
            if path.is_file() {
                return fs::read(path)
                    .map(|value| Some(base64::engine::general_purpose::STANDARD.encode(value)))
                    .map_err(|error| error.to_string());
            }
        }
        let token = token
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "unauthorized: 请先登录".to_string())?;
        let server = server_url.unwrap_or_else(|| "https://design.hz-study-system.com".to_string());
        let response = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?
            .get(format!(
                "{}/api/web/deck-templates/{}/preview",
                server.trim_end_matches('/'),
                template_id
            ))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| format!("预览图下载失败：{}", error))?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if response.status().as_u16() == 401 {
            return Err("unauthorized: 登录已过期，请重新登录".to_string());
        }
        if !response.status().is_success() {
            return Err(format!("预览图下载失败（{}）", response.status().as_u16()));
        }
        let value = response
            .bytes()
            .await
            .map_err(|error| error.to_string())?
            .to_vec();
        if value.len() > 5 * 1024 * 1024 {
            return Err("模板预览图超过 5MB".to_string());
        }
        if let Some(path) = preview_cache {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let staged = path.with_extension(format!("staged-{}.png", uuid::Uuid::new_v4()));
            fs::write(&staged, &value).map_err(|error| error.to_string())?;
            fs::rename(&staged, &path).map_err(|error| error.to_string())?;
        }
        value
    };
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

fn safe_zip_path(name: &str) -> Result<PathBuf, String> {
    let bytes = name.as_bytes();
    let has_windows_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if name.contains('\\') || name.contains('\0') || has_windows_drive {
        return Err(format!("模板 ZIP 包含非法路径：{}", name));
    }
    let path = Path::new(name);
    if path.is_absolute() {
        return Err(format!("模板 ZIP 包含非法路径：{}", name));
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) if !part.to_string_lossy().starts_with('.') => {
                result.push(part)
            }
            _ => return Err(format!("模板 ZIP 包含非法路径：{}", name)),
        }
    }
    Ok(result)
}

fn extract_template_zip(bytes: &[u8], destination: &Path) -> Result<PathBuf, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|_| "模板 ZIP 已损坏".to_string())?;
    if archive.len() == 0 {
        return Err("模板 ZIP 文件数量不合法".to_string());
    }
    let mut total = 0_u64;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        if let Some(mode) = file.unix_mode() {
            let file_type = mode & 0o170000;
            if file_type != 0 && file_type != 0o100000 && file_type != 0o040000 {
                return Err(format!("模板 ZIP 包含链接或特殊文件：{}", file.name()));
            }
        }
        if file.is_dir() {
            continue;
        }
        if files.len() >= MAX_ENTRIES {
            return Err("模板 ZIP 文件数量不合法".to_string());
        }
        let relative = safe_zip_path(file.name())?;
        let normalized = relative
            .to_string_lossy()
            .replace('\\', "/")
            .nfc()
            .collect::<String>();
        if !seen.insert(platform_name_key(&normalized)) {
            return Err(format!("模板 ZIP 包含跨平台重名文件：{}", normalized));
        }
        if file.size() > MAX_FILE_BYTES {
            return Err(format!("模板文件超过 10MB：{}", normalized));
        }
        if file.size() > 0 && file.compressed_size() == 0 {
            return Err(format!("模板 ZIP 压缩信息异常：{}", normalized));
        }
        if file.compressed_size() > 0
            && file.size() / file.compressed_size() > MAX_COMPRESSION_RATIO
        {
            return Err(format!("模板 ZIP 压缩比异常：{}", normalized));
        }
        total += file.size();
        if total > MAX_TOTAL_BYTES {
            return Err("模板解压后超过 50MB".to_string());
        }
        files.push((index, relative));
    }
    for (index, relative) in files {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = fs::File::create(target).map_err(|error| error.to_string())?;
        std::io::copy(&mut file, &mut output).map_err(|error| error.to_string())?;
    }
    if destination.join("template.json").is_file() {
        return Ok(destination.to_path_buf());
    }
    let dirs = fs::read_dir(destination)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    if dirs.len() == 1 && dirs[0].is_dir() && dirs[0].join("template.json").is_file() {
        return Ok(dirs[0].clone());
    }
    Err("模板 ZIP 根目录必须包含 template.json，或仅有一个外层目录".to_string())
}

#[tauri::command]
pub(crate) async fn deck_template_download(
    app_handle: tauri::AppHandle,
    server_url: String,
    token: String,
    remote_id: String,
    expected_digest: String,
) -> Result<String, String> {
    validate_remote_id(&remote_id)?;
    if token.trim().is_empty() {
        return Err("unauthorized: 请先登录".to_string());
    }
    let digest = expected_digest
        .strip_prefix("sha256:")
        .unwrap_or(&expected_digest)
        .to_ascii_lowercase();
    if digest.len() != 64 || !digest.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err("模板摘要格式错误".to_string());
    }
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let cache_base = app_data.join("deck-templates");
    fs::create_dir_all(&cache_base).map_err(|error| error.to_string())?;
    let cache_base = fs::canonicalize(&cache_base).map_err(|error| error.to_string())?;
    let remote_cache = cache_base.join(&remote_id);
    fs::create_dir_all(&remote_cache).map_err(|error| error.to_string())?;
    let remote_cache = fs::canonicalize(&remote_cache).map_err(|error| error.to_string())?;
    if !remote_cache.starts_with(&cache_base) {
        return Err("模板缓存路径不安全".to_string());
    }
    let cache = remote_cache.join(&digest);
    if cache.exists() {
        let metadata = fs::symlink_metadata(&cache).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("模板缓存路径不安全".to_string());
        }
    }
    if cache.join("template.json").is_file()
        && validate_template_root(&cache).is_ok()
        && canonical_tree_digest(&cache)? == digest
    {
        return Ok(cache.to_string_lossy().to_string());
    }
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?
        .get(format!(
            "{}/api/web/deck-templates/{}/download",
            server_url.trim_end_matches('/'),
            remote_id
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("模板下载失败：{}", error))?;
    if response.status().as_u16() == 401 {
        return Err("unauthorized: 登录已过期，请重新登录".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("模板下载失败（{}）", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_TOTAL_BYTES {
        return Err("模板压缩包超过 50MB，已拒绝下载".to_string());
    }
    let temp = tempfile::tempdir_in(&remote_cache).map_err(|error| error.to_string())?;
    let extracted = extract_template_zip(&bytes, temp.path())?;
    validate_template_root(&extracted)?;
    let actual = canonical_tree_digest(&extracted)?;
    if actual != digest {
        return Err("模板摘要校验失败，已拒绝写入缓存".to_string());
    }
    if cache.exists() {
        fs::remove_dir_all(&cache).map_err(|error| error.to_string())?;
    }
    fs::rename(&extracted, &cache).map_err(|error| format!("模板缓存写入失败：{}", error))?;
    Ok(cache.to_string_lossy().to_string())
}

fn copy_assets(source: &Path, target: &Path, role_files: &HashSet<String>) -> Result<(), String> {
    let mut stack = vec![source.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            let relative = normalized_relative(source, &path)?;
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if role_files.contains(&relative)
                || matches!(
                    relative.as_str(),
                    "template.json" | "preview.png" | "README.md"
                )
            {
                continue;
            }
            let destination = target.join(&relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(path, destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn instantiate_template(
    source: &Path,
    target: &Path,
    title: &str,
    source_kind: &str,
    remote_id: Option<&str>,
) -> Result<Value, String> {
    let definition = validate_template_root(source)?;
    let digest = canonical_tree_digest(source)?;
    let role_set = role_files(&definition).into_iter().collect::<HashSet<_>>();
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    copy_assets(source, target, &role_set)?;
    let blueprint_dir = target.join(".ppte-template/roles");
    fs::create_dir_all(&blueprint_dir).map_err(|error| error.to_string())?;
    let contents = match &definition.roles.content {
        ContentRoles::Items(items) => items.clone(),
        _ => unreachable!(),
    };
    let mut ordered = vec![
        (
            "cover",
            None,
            definition.roles.cover.clone(),
            "封面".to_string(),
        ),
        (
            "catalog",
            None,
            definition.roles.catalog.clone(),
            "目录".to_string(),
        ),
        (
            "chapter",
            None,
            definition.roles.chapter.clone(),
            "章节 1".to_string(),
        ),
    ];
    ordered.extend(contents.iter().map(|item| {
        (
            "content",
            Some(item.id.clone()),
            item.file.clone(),
            item.title.clone(),
        )
    }));
    ordered.push((
        "finish",
        None,
        definition.roles.finish.clone(),
        "总结".to_string(),
    ));
    let mut slides = Vec::new();
    let mut roles = serde_json::Map::new();
    let mut content_roles = Vec::new();
    for (index, (role, variant, file, slide_title)) in ordered.into_iter().enumerate() {
        let number = index + 1;
        let slide_file = format!("slide{:02}.html", number);
        let blueprint_name = variant
            .as_ref()
            .map(|id| format!("content-{}", id))
            .unwrap_or_else(|| role.to_string());
        let blueprint_file = format!(".ppte-template/roles/{}.html", blueprint_name);
        let html = fs::read_to_string(source.join(file)).map_err(|error| error.to_string())?;
        fs::write(target.join(&blueprint_file), &html).map_err(|error| error.to_string())?;
        fs::write(target.join(&slide_file), &html).map_err(|error| error.to_string())?;
        fs::write(target.join(format!("slide{:02}.note", number)), "")
            .map_err(|error| error.to_string())?;
        slides.push(json!({"file": slide_file, "title": slide_title, "slide_type": role}));
        let base = json!({"blueprintFile": blueprint_file, "starterFile": slide_file});
        if let Some(id) = variant {
            content_roles.push(json!({"id": id, "title": slide_title, "blueprintFile": blueprint_file, "starterFile": slide_file}));
        } else {
            roles.insert(role.to_string(), base);
        }
    }
    roles.insert("content".to_string(), Value::Array(content_roles));
    let normalized =
        serde_json::to_string_pretty(&definition).map_err(|error| error.to_string())?;
    fs::write(
        target.join(".ppte-template/template.json"),
        format!("{}\n", normalized),
    )
    .map_err(|error| error.to_string())?;
    let manifest = json!({
        "title": title,
        "slides": slides,
        "agentTemplate": {
            "schemaVersion": 2,
            "template": {"id": definition.id, "remoteId": remote_id, "name": definition.name, "version": definition.version, "source": source_kind, "digest": format!("sha256:{}", digest)},
            "state": "starter",
            "roles": Value::Object(roles),
        }
    });
    fs::write(
        target.join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
    .map_err(|error| error.to_string())?;
    Ok(manifest)
}

#[tauri::command]
pub(crate) fn create_ppt_extra_from_template(
    app_handle: tauri::AppHandle,
    folder_name: String,
    target_path: Option<String>,
    title: String,
    template_source: String,
    template_id: String,
    digest: Option<String>,
) -> Result<String, String> {
    if folder_name.trim().is_empty()
        || folder_name.starts_with('.')
        || folder_name
            .chars()
            .any(|value| matches!(value, '/' | '\\' | ':' | '\0'))
        || Path::new(&folder_name)
            .file_name()
            .and_then(|value| value.to_str())
            != Some(folder_name.as_str())
    {
        return Err("课件文件夹名称不合法".to_string());
    }
    if !matches!(template_source.as_str(), "builtin" | "custom" | "cloud") {
        return Err("模板来源不合法".to_string());
    }
    let source = if template_source == "builtin" {
        find_builtin(&app_handle, &template_id)?
    } else {
        validate_remote_id(&template_id)?;
        let digest = digest.ok_or_else(|| "云端模板缺少摘要".to_string())?;
        let digest = digest
            .strip_prefix("sha256:")
            .unwrap_or(&digest)
            .to_ascii_lowercase();
        if digest.len() != 64 || !digest.chars().all(|value| value.is_ascii_hexdigit()) {
            return Err("云端模板摘要格式错误".to_string());
        }
        let cache_root = app_handle
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("deck-templates")
            .join(&template_id);
        let source = fs::canonicalize(cache_root.join(digest))
            .map_err(|_| "模板尚未下载或缓存已丢失".to_string())?;
        let canonical_cache =
            fs::canonicalize(&cache_root).map_err(|_| "模板缓存目录无效".to_string())?;
        if !source.starts_with(canonical_cache) {
            return Err("模板缓存路径不安全".to_string());
        }
        source
    };
    if !source.is_dir() {
        return Err("模板尚未下载或缓存已丢失".to_string());
    }
    let parent = if let Some(path) = target_path {
        PathBuf::from(path)
    } else {
        app_handle
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("ppt-extra")
    };
    fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    let target = parent.join(&folder_name);
    if target.exists() {
        return Err("同名课件文件夹已存在".to_string());
    }
    let staged = parent.join(format!(".{}.staging-{}", folder_name, uuid::Uuid::new_v4()));
    let result = instantiate_template(
        &source,
        &staged,
        &title,
        &template_source,
        if template_source == "builtin" {
            None
        } else {
            Some(&template_id)
        },
    );
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staged);
        return Err(error);
    }
    fs::rename(&staged, &target).map_err(|error| {
        let _ = fs::remove_dir_all(&staged);
        format!("课件创建失败：{}", error)
    })?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn read_ppte_template_blueprints(folder_path: String) -> Result<Value, String> {
    let root =
        fs::canonicalize(&folder_path).map_err(|error| format!("无法读取 PPTE：{}", error))?;
    let meta_path = fs::canonicalize(root.join(".ppte-template/template.json"))
        .map_err(|_| "课件没有 v2 母版元数据".to_string())?;
    let roles_root = fs::canonicalize(root.join(".ppte-template/roles"))
        .map_err(|_| "课件没有 v2 母版快照".to_string())?;
    if !roles_root.starts_with(&root) || !meta_path.starts_with(&root) {
        return Err("母版快照路径不安全".to_string());
    }
    let metadata: Value =
        serde_json::from_slice(&fs::read(meta_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let mut roles = HashMap::new();
    for entry in fs::read_dir(&roles_root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if !canonical.starts_with(&roles_root)
            || !canonical.is_file()
            || canonical.extension().and_then(|value| value.to_str()) != Some("html")
        {
            continue;
        }
        roles.insert(
            path.file_name().unwrap().to_string_lossy().to_string(),
            fs::read_to_string(canonical).map_err(|error| error.to_string())?,
        );
    }
    Ok(json!({"metadata": metadata, "roles": roles}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_template(root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("template.json"), r#"{"schemaVersion":1,"id":"test-blue","name":"测试蓝","version":"1.0.0","roles":{"cover":"cover.html","catalog":"catalog.html","chapter":"chapter.html","content":[{"id":"text","file":"content.html","title":"正文"},{"id":"image","file":"content-image.html","title":"图文"}],"finish":"finish.html"}}"#).unwrap();
        for name in [
            "cover",
            "catalog",
            "chapter",
            "content",
            "content-image",
            "finish",
        ] {
            fs::write(
                root.join(format!("{}.html", name)),
                format!("<main>{}</main>", name),
            )
            .unwrap();
        }
        fs::write(root.join("theme.css"), "body{}").unwrap();
    }

    #[test]
    fn instantiates_multi_content_and_keeps_blueprints() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        write_template(&source);
        let manifest = instantiate_template(&source, &target, "测试", "builtin", None).unwrap();
        assert_eq!(manifest["slides"].as_array().unwrap().len(), 6);
        fs::write(target.join("slide04.html"), "changed").unwrap();
        assert_eq!(
            fs::read_to_string(target.join(".ppte-template/roles/content-text.html")).unwrap(),
            "<main>content</main>"
        );
    }

    #[test]
    fn rejects_reserved_generated_file() {
        let temp = tempfile::tempdir().unwrap();
        write_template(temp.path());
        fs::write(temp.path().join("slide01.html"), "bad").unwrap();
        assert!(validate_template_root(temp.path())
            .unwrap_err()
            .contains("保留路径"));
    }

    #[test]
    fn full_unicode_casefold_keys_match_python_contract() {
        assert_eq!(
            platform_name_key("Maße.svg"),
            platform_name_key("MASSE.svg")
        );
        assert_eq!(
            platform_name_key("στιγμας.svg"),
            platform_name_key("στιγμασ.svg")
        );
    }

    #[test]
    fn bundled_templates_match_cross_repo_contract_digests() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("PPT-Template");
        for (directory, package_id, digest) in [
            (
                "安恒",
                "anheng-classic",
                "f37885205a1934f7d1c1a35ca841d9ece8305be5d4a8206738fc9f25b9680a04",
            ),
            (
                "学术蓝",
                "scholar-blue",
                "42ce75a7122c39b55e84c2061ec4e73b686cf2e0de155db10fccebd58d5a8d35",
            ),
            (
                "墨绿",
                "ink-green",
                "68369b0fdc615349fdb59f3b93e9401827f58b7fdf1f9834a0cf2673d5ca08a4",
            ),
            (
                "极简黑白",
                "minimal-mono",
                "17a777e8c28ed34ff9c58e763cdc0ced254baa3d9e9d38818d230d56c6a623fc",
            ),
            (
                "暖砂人文",
                "warm-sand",
                "65381ef5571a09a1a30b93201f0851c78a4448250f436e37b51852d4b0547df2",
            ),
            (
                "科技青",
                "tech-cyan",
                "0ff540512cfdcdcb72eaef344b28874153d95e6a9dc3b2a31d1801260e4ff440",
            ),
            (
                "珊瑚活力",
                "coral-energy",
                "49298b961e0c68411f9aa6b9af88b0b90444ae97ee760fe36f8df478fb9fafce",
            ),
            (
                "琥珀石墨",
                "amber-charcoal",
                "88542ed81d29cc5edc45f73c92dcfe7dfbca5108df19ec19c7347f853b90a45d",
            ),
            (
                "天青白瓷",
                "porcelain-cyan",
                "bf403b6a6e078b1b1c1f35549bddc80ba1fd1dde58ecd13f64173423c1778623",
            ),
        ] {
            let path = root.join(directory);
            let definition = validate_template_root(&path).unwrap();
            assert_eq!(definition.id, package_id);
            assert!(path.join("preview.png").is_file());
            assert_eq!(canonical_tree_digest(&path).unwrap(), digest);
        }
    }
}
