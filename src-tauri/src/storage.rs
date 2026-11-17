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

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::{Setlist, Song, is_plain_file_name};

/// Maximum accepted logo file size (5 MiB).
pub const MAX_LOGO_BYTES: usize = 5 * 1024 * 1024;

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

    /// Validates and stores a logo, returning the generated file name.
    ///
    /// The extension is derived from the file contents rather than the client
    /// supplied name, so a mislabelled upload cannot smuggle a different format
    /// into the preview.
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

        let file_name = format!("{}.{extension}", Uuid::new_v4());
        let logos_dir = self.logos_dir();
        let _guard = self.write_lock.lock().await;

        tokio::fs::create_dir_all(&logos_dir).await?;
        tokio::fs::write(logos_dir.join(&file_name), bytes).await?;

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
    use crate::models::{LogoAlignment, SetlistItem};
    use tempfile::TempDir;

    fn storage() -> (TempDir, Storage) {
        let dir = tempfile::tempdir().expect("temp dir");
        let storage = Storage::new(dir.path().join("stagesheet"));
        (dir, storage)
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
                duration_mins: 10,
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
    async fn invalid_breaks_are_rejected_on_save_but_old_files_still_load() {
        let (_dir, storage) = storage();

        let mut setlist = Setlist::new("Gig");
        setlist.items.push(SetlistItem::Break {
            duration_mins: crate::models::MAX_BREAK_MINS + 1,
            note: None,
            label: None,
        });
        assert!(matches!(
            storage.save_setlist(&setlist).await,
            Err(AppError::InvalidInput(message)) if message.contains("break length")
        ));

        // Simulate a file written before validation hardening: it must load.
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
        assert!(loaded.validate().is_err(), "next save must fail");
        assert!(matches!(
            storage.save_setlist(&loaded).await,
            Err(AppError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn logo_import_is_content_checked_and_traversal_safe() {
        let (_dir, storage) = storage();
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];

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
        assert!(storage.remove_logo("../songs.json").await.is_err());
    }
}
