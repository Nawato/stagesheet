//! Offline-first JSON storage rooted in the platform app-data directory.
//!
//! Layout (inside `<app_data_dir>/stagesheet/`):
//!
//! ```text
//! songs.json            reusable song library
//! setlists/<uuid>.json  one file per setlist
//! logos/<uuid>.<ext>    imported band logos
//! ```
//!
//! Writes go through a temporary file plus rename so a crash cannot leave a
//! half-written JSON document behind.

use std::borrow::Cow;
use std::io::Cursor;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use image::ImageFormat;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::{Setlist, Song, is_plain_file_name};

/// Maximum accepted logo file size (5 MiB).
pub const MAX_LOGO_BYTES: usize = 5 * 1024 * 1024;

/// Longest edge kept for imported raster logos, in pixels.
///
/// Logos print at up to 80 mm wide; 1024 px still gives roughly 325 dpi there,
/// while trimming multi-megapixel camera/design exports to a fraction of the
/// file size and decode memory.
pub const MAX_LOGO_DIMENSION: u32 = 1024;

/// JPEG quality used when a logo has to be re-encoded after downscaling.
const LOGO_JPEG_QUALITY: u8 = 85;

/// Filesystem-backed store. Cheap to clone only via shared `State`; it is
/// intentionally not `Clone` because it owns the per-process write lock.
pub struct Storage {
    root: PathBuf,
    write_lock: Mutex<()>,
}

impl Storage {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            write_lock: Mutex::new(()),
        }
    }

    /// Creates storage rooted at `<app_data_dir>/stagesheet`.
    pub fn for_app(app: &AppHandle) -> Result<Self, AppError> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| AppError::AppDataDirUnavailable)?;
        Ok(Self::new(app_data_dir.join("stagesheet")))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn songs_path(&self) -> PathBuf {
        self.root.join("songs.json")
    }

    fn setlists_dir(&self) -> PathBuf {
        self.root.join("setlists")
    }

    fn setlist_path(&self, id: Uuid) -> PathBuf {
        self.setlists_dir().join(format!("{id}.json"))
    }

    fn logos_dir(&self) -> PathBuf {
        self.root.join("logos")
    }

    // ---------------------------------------------------------------------
    // Songs
    // ---------------------------------------------------------------------

    pub async fn list_songs(&self) -> Result<Vec<Song>, AppError> {
        Ok(self
            .read_json::<Vec<Song>>(&self.songs_path())
            .await?
            .unwrap_or_default())
    }

    pub async fn save_song(&self, song: &Song) -> Result<(), AppError> {
        song.validate().map_err(AppError::InvalidInput)?;

        let _guard = self.write_lock.lock().await;
        let mut songs = self
            .read_json::<Vec<Song>>(&self.songs_path())
            .await?
            .unwrap_or_default();

        match songs.iter_mut().find(|existing| existing.id == song.id) {
            Some(existing) => *existing = song.clone(),
            None => songs.push(song.clone()),
        }

        self.write_json(&self.songs_path(), &songs).await
    }

    pub async fn delete_song(&self, id: Uuid) -> Result<(), AppError> {
        let _guard = self.write_lock.lock().await;
        let mut songs = self
            .read_json::<Vec<Song>>(&self.songs_path())
            .await?
            .unwrap_or_default();

        let initial_len = songs.len();
        songs.retain(|song| song.id != id);
        if songs.len() == initial_len {
            return Err(AppError::SongNotFound(id));
        }

        self.write_json(&self.songs_path(), &songs).await
    }

    // ---------------------------------------------------------------------
    // Setlists
    // ---------------------------------------------------------------------

    /// Returns all setlists, most recently updated first.
    pub async fn list_setlists(&self) -> Result<Vec<Setlist>, AppError> {
        let mut entries = match tokio::fs::read_dir(self.setlists_dir()).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };

        let mut setlists = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }

            let Some(setlist) = self.read_json::<Setlist>(&path).await? else {
                continue;
            };
            setlists.push(setlist);
        }

        setlists.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.title.cmp(&right.title))
        });
        Ok(setlists)
    }

    pub async fn get_setlist(&self, id: Uuid) -> Result<Setlist, AppError> {
        self.read_json::<Setlist>(&self.setlist_path(id))
            .await?
            .ok_or(AppError::SetlistNotFound(id))
    }

    pub async fn save_setlist(&self, setlist: &Setlist) -> Result<(), AppError> {
        setlist.validate().map_err(AppError::InvalidInput)?;

        let _guard = self.write_lock.lock().await;
        self.write_json(&self.setlist_path(setlist.id), setlist)
            .await
    }

    pub async fn delete_setlist(&self, id: Uuid) -> Result<(), AppError> {
        let _guard = self.write_lock.lock().await;
        let path = self.setlist_path(id);

        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Err(AppError::SetlistNotFound(id)),
            Err(error) => Err(error.into()),
        }
    }

    /// Total runtime in seconds, computed in Rust so every client agrees.
    pub async fn setlist_duration(&self, id: Uuid) -> Result<u64, AppError> {
        Ok(self.get_setlist(id).await?.total_duration_secs())
    }

    // ---------------------------------------------------------------------
    // Logos
    // ---------------------------------------------------------------------

    /// Validates, optionally downscales, and stores a logo.
    ///
    /// The extension is derived from the file contents rather than the client
    /// supplied name, so a mislabelled upload cannot smuggle a different format
    /// into the preview. Raster logos larger than [`MAX_LOGO_DIMENSION`] are
    /// decoded and resized with their aspect ratio intact; small rasters are
    /// stored byte-for-byte and SVGs stay vector.
    pub async fn import_logo(&self, original_name: &str, bytes: &[u8]) -> Result<String, AppError> {
        if bytes.is_empty() {
            return Err(AppError::InvalidInput("logo file is empty".into()));
        }

        if bytes.len() > MAX_LOGO_BYTES {
            return Err(AppError::InvalidInput(format!(
                "logo must be at most {} MiB",
                MAX_LOGO_BYTES / (1024 * 1024)
            )));
        }

        let extension = detect_logo_extension(bytes).ok_or_else(|| {
            AppError::InvalidInput(format!(
                "`{original_name}` is not a PNG, JPEG, or SVG image"
            ))
        })?;

        let data = match extension {
            "svg" => Cow::Borrowed(bytes),
            _ => {
                let (format, label) = if extension == "png" {
                    (ImageFormat::Png, "PNG")
                } else {
                    (ImageFormat::Jpeg, "JPEG")
                };
                let downscaled = downscale_raster_logo(bytes, format).map_err(|_| {
                    AppError::InvalidInput(format!(
                        "`{original_name}` is not a valid {label} image"
                    ))
                })?;
                match downscaled {
                    Some(downscaled) => Cow::Owned(downscaled),
                    None => Cow::Borrowed(bytes),
                }
            }
        };

        // Re-check after downscaling: the cap also covers the written file, not
        // just the upload. PNG re-encoding can occasionally grow a file.
        if data.len() > MAX_LOGO_BYTES {
            return Err(AppError::InvalidInput(format!(
                "logo must be at most {} MiB",
                MAX_LOGO_BYTES / (1024 * 1024)
            )));
        }

        let file_name = format!("{}.{extension}", Uuid::new_v4());
        let logos_dir = self.logos_dir();
        let _guard = self.write_lock.lock().await;

        tokio::fs::create_dir_all(&logos_dir).await?;
        tokio::fs::write(logos_dir.join(&file_name), data.as_ref()).await?;

        Ok(file_name)
    }

    /// Removes a stored logo. Missing files are treated as success so callers
    /// can safely clear stale configuration.
    pub async fn remove_logo(&self, file_name: &str) -> Result<(), AppError> {
        if !is_plain_file_name(file_name) {
            return Err(AppError::InvalidInput(
                "logo file name must be a plain file name".into(),
            ));
        }

        let _guard = self.write_lock.lock().await;
        match tokio::fs::remove_file(self.logos_dir().join(file_name)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    async fn read_json<T: DeserializeOwned>(&self, path: &Path) -> Result<Option<T>, AppError> {
        match tokio::fs::read(path).await {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Caller must hold `write_lock`.
    async fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let data = serde_json::to_vec_pretty(value)?;
        let temp_path = path.with_extension("json.tmp");
        tokio::fs::write(&temp_path, &data).await?;

        #[cfg(windows)]
        if tokio::fs::try_exists(path).await.unwrap_or(false) {
            // Windows cannot rename over an existing file.
            tokio::fs::remove_file(path).await?;
        }

        tokio::fs::rename(&temp_path, path).await?;
        Ok(())
    }
}

/// Returns re-encoded bytes when the longest edge exceeds
/// [`MAX_LOGO_DIMENSION`], or `None` when the source already fits and should be
/// stored untouched.
fn downscale_raster_logo(
    bytes: &[u8],
    format: ImageFormat,
) -> Result<Option<Vec<u8>>, image::ImageError> {
    let image = image::load_from_memory_with_format(bytes, format)?;
    if image.width().max(image.height()) <= MAX_LOGO_DIMENSION {
        return Ok(None);
    }

    let resized = image.resize(
        MAX_LOGO_DIMENSION,
        MAX_LOGO_DIMENSION,
        image::imageops::FilterType::Lanczos3,
    );

    let mut encoded = Vec::new();
    let mut cursor = Cursor::new(&mut encoded);
    match format {
        ImageFormat::Png => resized.write_to(&mut cursor, ImageFormat::Png)?,
        ImageFormat::Jpeg => {
            // JPEG has no alpha channel; the incoming JPEG is RGB anyway.
            let rgb = resized.to_rgb8();
            let mut encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, LOGO_JPEG_QUALITY);
            encoder.encode_image(&rgb)?;
        }
        _ => unreachable!("only PNG and JPEG reach the logo downscaler"),
    }

    Ok(Some(encoded))
}

fn detect_logo_extension(bytes: &[u8]) -> Option<&'static str> {
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    if bytes.starts_with(&PNG_MAGIC) {
        return Some("png");
    }

    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }

    if looks_like_svg(bytes) {
        return Some("svg");
    }

    None
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };

    let text = text.trim_start_matches('\u{feff}').trim_start();
    if !text.starts_with('<') {
        return false;
    }

    // Look only at the beginning so a huge SVG without an early `<svg` tag is
    // not scanned entirely.
    let head = &text[..text.len().min(2048)];
    head.contains("<svg")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{LogoAlignment, PageMode, SetlistItem};
    use tempfile::TempDir;

    fn storage() -> (TempDir, Storage) {
        let dir = tempfile::tempdir().expect("temp dir");
        let storage = Storage::new(dir.path().join("stagesheet"));
        (dir, storage)
    }

    fn raster_bytes(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8])
        });
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut bytes), format)
            .expect("encode fixture image");
        bytes
    }

    async fn stored_logo_bytes(storage: &Storage, file_name: &str) -> Vec<u8> {
        tokio::fs::read(storage.logos_dir().join(file_name))
            .await
            .expect("read stored logo")
    }

    #[test]
    fn detects_supported_logo_formats() {
        assert_eq!(
            detect_logo_extension(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
            Some("png")
        );
        assert_eq!(
            detect_logo_extension(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("jpg")
        );
        assert_eq!(
            detect_logo_extension(
                br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>"#
            ),
            Some("svg")
        );
        assert_eq!(detect_logo_extension(b"GIF89a"), None);
        assert_eq!(detect_logo_extension(b""), None);
    }

    #[tokio::test]
    async fn song_crud_round_trips() {
        let (_dir, storage) = storage();
        let mut song = Song::new("Opener");
        song.artist = Some("The Band".into());
        song.bpm = Some(128);
        song.key = Some("Em".into());
        song.duration_secs = Some(240);
        song.notes = Some("Count in from the drums".into());

        storage.save_song(&song).await.expect("create");
        assert_eq!(
            storage.list_songs().await.expect("list"),
            vec![song.clone()]
        );

        song.title = "Opener (alt)".into();
        storage.save_song(&song).await.expect("update");
        let songs = storage.list_songs().await.expect("list");
        assert_eq!(songs.len(), 1, "upsert must not duplicate rows");
        assert_eq!(songs[0].title, "Opener (alt)");

        storage.delete_song(song.id).await.expect("delete");
        assert!(storage.list_songs().await.expect("list").is_empty());
        assert!(matches!(
            storage.delete_song(song.id).await,
            Err(AppError::SongNotFound(id)) if id == song.id
        ));
    }

    #[tokio::test]
    async fn setlist_crud_reorder_and_duration() {
        let (_dir, storage) = storage();
        let mut setlist = Setlist::new("Release Show");
        setlist.venue = Some("Matrix, Bochum".into());
        setlist.date = chrono::NaiveDate::from_ymd_opt(2026, 11, 20);
        setlist.logo.alignment = LogoAlignment::Right;
        setlist.logo.width_mm = 30.0;

        let mut opener = Song::new("Opener");
        opener.duration_secs = Some(180);
        let mut closer = Song::new("Closer");
        closer.duration_secs = Some(240);
        setlist.items = vec![
            SetlistItem::Song(opener),
            SetlistItem::Break {
                duration_secs: 600,
                note: Some("Tune down".into()),
                label: Some("Intermission".into()),
            },
            SetlistItem::Song(closer),
        ];

        storage.save_setlist(&setlist).await.expect("create");
        assert_eq!(storage.get_setlist(setlist.id).await.expect("get"), setlist);
        assert_eq!(
            storage
                .setlist_duration(setlist.id)
                .await
                .expect("duration"),
            180 + 600 + 240
        );

        let mut loaded = storage.get_setlist(setlist.id).await.expect("get");
        loaded.move_item(2, 0).expect("reorder");
        loaded.touch();
        storage.save_setlist(&loaded).await.expect("update");

        let reloaded = storage.get_setlist(setlist.id).await.expect("get");
        assert_eq!(
            reloaded.items[0].as_song().map(|song| song.title.as_str()),
            Some("Closer")
        );

        let summaries = storage.list_setlists().await.expect("list");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, setlist.id);

        storage.delete_setlist(setlist.id).await.expect("delete");
        assert!(storage.list_setlists().await.expect("list").is_empty());
        assert!(matches!(
            storage.get_setlist(setlist.id).await,
            Err(AppError::SetlistNotFound(id)) if id == setlist.id
        ));
    }

    #[tokio::test]
    async fn page_mode_round_trips_through_storage() {
        let (_dir, storage) = storage();
        let mut setlist = Setlist::new("Two Pages");
        setlist.page_mode = PageMode::Multiple;

        storage.save_setlist(&setlist).await.expect("create");
        let loaded = storage.get_setlist(setlist.id).await.expect("get");
        assert_eq!(loaded.page_mode, PageMode::Multiple);

        setlist.page_mode = PageMode::Single;
        storage.save_setlist(&setlist).await.expect("update");
        let loaded = storage.get_setlist(setlist.id).await.expect("get");
        assert_eq!(loaded.page_mode, PageMode::Single);
    }

    #[tokio::test]
    async fn invalid_breaks_are_rejected_on_save_but_old_files_still_load() {
        let (_dir, storage) = storage();

        let mut setlist = Setlist::new("Gig");
        setlist.items.push(SetlistItem::Break {
            duration_secs: crate::models::MAX_BREAK_SECS + 1,
            note: None,
            label: None,
        });
        assert!(matches!(
            storage.save_setlist(&setlist).await,
            Err(AppError::InvalidInput(message)) if message.contains("break length")
        ));

        // Simulate a file written before validation hardening and Feature 17:
        // a legacy minute-only break must still load.
        let id = Uuid::new_v4();
        let legacy = serde_json::json!({
            "id": id,
            "title": "Legacy gig",
            "items": [{
                "Break": {
                    "duration_mins": 4_000_000_000_u32,
                    "note": "x".repeat(crate::models::MAX_COMMENT_CHARS + 1),
                }
            }],
            "logo": {
                "file_name": null,
                "width_mm": 40.0,
                "alignment": "Center",
            },
        });
        let path = storage.setlist_path(id);
        tokio::fs::create_dir_all(storage.setlists_dir())
            .await
            .expect("create setlists dir");
        tokio::fs::write(
            &path,
            serde_json::to_vec(&legacy).expect("serialize legacy"),
        )
        .await
        .expect("write legacy setlist");

        let loaded = storage.get_setlist(id).await.expect("legacy setlist loads");
        assert_eq!(loaded.total_duration_secs(), u64::from(u32::MAX));
        assert!(loaded.validate().is_err(), "next save must fail");
        assert!(matches!(
            storage.save_setlist(&loaded).await,
            Err(AppError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn legacy_minute_break_loads_and_saves_as_seconds() {
        let (_dir, storage) = storage();
        let id = Uuid::new_v4();
        let legacy = serde_json::json!({
            "id": id,
            "title": "Legacy gig",
            "items": [{
                "Break": {
                    "duration_mins": 10,
                    "note": "Tune down",
                    "label": "Intermission",
                }
            }],
            "logo": {
                "file_name": null,
                "width_mm": 40.0,
                "alignment": "Center",
            },
        });

        let path = storage.setlist_path(id);
        tokio::fs::create_dir_all(storage.setlists_dir())
            .await
            .expect("create setlists dir");
        tokio::fs::write(
            &path,
            serde_json::to_vec(&legacy).expect("serialize legacy"),
        )
        .await
        .expect("write legacy setlist");

        let loaded = storage.get_setlist(id).await.expect("legacy setlist loads");
        assert_eq!(loaded.total_duration_secs(), 600);
        assert_eq!(storage.setlist_duration(id).await.expect("duration"), 600);

        storage.save_setlist(&loaded).await.expect("resave");
        let raw = tokio::fs::read_to_string(&path)
            .await
            .expect("read resaved setlist");
        assert!(raw.contains("\"duration_secs\": 600"));
        assert!(
            !raw.contains("duration_mins"),
            "the legacy field must not be persisted again"
        );
    }

    #[tokio::test]
    async fn logo_import_is_content_checked_and_traversal_safe() {
        let (_dir, storage) = storage();
        let png = raster_bytes(16, 16, ImageFormat::Png);

        let file_name = storage
            .import_logo("band logo.png", &png)
            .await
            .expect("import png");
        assert!(file_name.ends_with(".png"));
        assert!(is_plain_file_name(&file_name));
        assert!(storage.logos_dir().join(&file_name).exists());

        storage.remove_logo(&file_name).await.expect("remove");
        assert!(!storage.logos_dir().join(&file_name).exists());
        storage
            .remove_logo(&file_name)
            .await
            .expect("remove is idempotent");

        assert!(
            storage
                .import_logo("fake.png", b"not an image")
                .await
                .is_err()
        );
        assert!(storage.import_logo("empty.png", &[]).await.is_err());
        assert!(
            storage
                .import_logo("huge.png", &vec![0; MAX_LOGO_BYTES + 1])
                .await
                .is_err()
        );

        // A valid magic prefix with a broken body is still not an image.
        let broken_png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
        assert!(
            storage
                .import_logo("broken.png", &broken_png)
                .await
                .is_err()
        );

        assert!(storage.remove_logo("../songs.json").await.is_err());
    }

    #[tokio::test]
    async fn large_png_is_downscaled_before_storage() {
        let (_dir, storage) = storage();
        let source = raster_bytes(2000, 1000, ImageFormat::Png);

        let file_name = storage
            .import_logo("wide.png", &source)
            .await
            .expect("import large png");
        let stored = stored_logo_bytes(&storage, &file_name).await;
        let decoded = image::load_from_memory_with_format(&stored, ImageFormat::Png)
            .expect("stored png decodes");

        assert_eq!((decoded.width(), decoded.height()), (1024, 512));
        assert!(
            stored.len() < source.len(),
            "downscaling should trim the file size"
        );
        assert!(file_name.ends_with(".png"));
    }

    #[tokio::test]
    async fn large_jpeg_keeps_format_and_aspect_ratio() {
        let (_dir, storage) = storage();
        let source = raster_bytes(1600, 900, ImageFormat::Jpeg);

        let file_name = storage
            .import_logo("photo.jpg", &source)
            .await
            .expect("import large jpeg");
        let stored = stored_logo_bytes(&storage, &file_name).await;

        assert!(file_name.ends_with(".jpg"));
        assert!(stored.starts_with(&[0xff, 0xd8, 0xff]));
        let decoded = image::load_from_memory_with_format(&stored, ImageFormat::Jpeg)
            .expect("stored jpeg decodes");
        assert_eq!((decoded.width(), decoded.height()), (1024, 576));
    }

    #[tokio::test]
    async fn logos_within_the_limit_are_stored_untouched() {
        let (_dir, storage) = storage();
        let png = raster_bytes(320, 180, ImageFormat::Png);
        let jpeg = raster_bytes(640, 640, ImageFormat::Jpeg);

        let png_name = storage
            .import_logo("small.png", &png)
            .await
            .expect("import small png");
        assert_eq!(stored_logo_bytes(&storage, &png_name).await, png);

        let jpeg_name = storage
            .import_logo("small.jpg", &jpeg)
            .await
            .expect("import small jpeg");
        assert_eq!(stored_logo_bytes(&storage, &jpeg_name).await, jpeg);
    }

    #[tokio::test]
    async fn svg_logos_stay_vector_and_untouched() {
        let (_dir, storage) = storage();
        let svg = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="1" height="1"/></svg>"#;

        let file_name = storage
            .import_logo("logo.svg", svg)
            .await
            .expect("import svg");

        assert!(file_name.ends_with(".svg"));
        assert_eq!(stored_logo_bytes(&storage, &file_name).await, svg);
    }
}
