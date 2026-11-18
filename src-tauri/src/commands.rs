//! Tauri IPC commands.
//!
//! Every command is `async` and returns `Result<T, AppError>`; all blocking
//! filesystem work happens on tokio's thread pool inside [`Storage`]. Argument
//! names are camelCase on the JavaScript side (Tauri's default).

use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::{Artist, Setlist, Song};
use crate::storage::Storage;

#[tauri::command]
pub async fn list_songs(storage: State<'_, Storage>) -> Result<Vec<Song>, AppError> {
    storage.list_songs().await
}

#[tauri::command]
pub async fn save_song(
    song: Song,
    allow_unfiled: Option<bool>,
    storage: State<'_, Storage>,
) -> Result<Song, AppError> {
    storage
        .save_song(&song, allow_unfiled.unwrap_or(false))
        .await?;
    Ok(song)
}

#[tauri::command]
pub async fn delete_song(id: Uuid, storage: State<'_, Storage>) -> Result<(), AppError> {
    storage.delete_song(id).await
}

#[tauri::command]
pub async fn list_artists(storage: State<'_, Storage>) -> Result<Vec<Artist>, AppError> {
    storage.list_artists().await
}

#[tauri::command]
pub async fn save_artist(
    mut artist: Artist,
    storage: State<'_, Storage>,
) -> Result<Artist, AppError> {
    // Store the display name trimmed; blank names then fail validation with the
    // clear artist error instead of persisting padding.
    artist.name = artist.name.trim().to_string();
    storage.save_artist(&artist).await?;
    Ok(artist)
}

#[tauri::command]
pub async fn delete_artist(id: Uuid, storage: State<'_, Storage>) -> Result<(), AppError> {
    storage.delete_artist(id).await
}

#[tauri::command]
pub async fn list_setlists(storage: State<'_, Storage>) -> Result<Vec<Setlist>, AppError> {
    storage.list_setlists().await
}

#[tauri::command]
pub async fn get_setlist(id: Uuid, storage: State<'_, Storage>) -> Result<Setlist, AppError> {
    storage.get_setlist(id).await
}

#[tauri::command]
pub async fn save_setlist(
    mut setlist: Setlist,
    allow_unfiled: Option<bool>,
    storage: State<'_, Storage>,
) -> Result<Setlist, AppError> {
    setlist
        .validate_for_save(allow_unfiled.unwrap_or(false))
        .map_err(AppError::InvalidInput)?;
    setlist.touch();
    storage
        .save_setlist(&setlist, allow_unfiled.unwrap_or(false))
        .await?;
    Ok(setlist)
}

#[tauri::command]
pub async fn delete_setlist(id: Uuid, storage: State<'_, Storage>) -> Result<(), AppError> {
    storage.delete_setlist(id).await
}

#[tauri::command]
pub async fn reorder_items(
    setlist_id: Uuid,
    from: usize,
    to: usize,
    storage: State<'_, Storage>,
) -> Result<Setlist, AppError> {
    let mut setlist = storage.get_setlist(setlist_id).await?;
    setlist.move_item(from, to)?;
    setlist.touch();
    // Re-saving an already-stored record must never fail on filing state:
    // reorder keeps whatever the setlist had, filed or unfiled.
    storage.save_setlist(&setlist, true).await?;
    Ok(setlist)
}

#[tauri::command]
pub async fn setlist_duration(
    setlist_id: Uuid,
    storage: State<'_, Storage>,
) -> Result<u64, AppError> {
    storage.setlist_duration(setlist_id).await
}

#[tauri::command]
pub async fn import_logo(
    bytes: Vec<u8>,
    file_name: String,
    storage: State<'_, Storage>,
) -> Result<String, AppError> {
    storage.import_logo(&file_name, &bytes).await
}

#[tauri::command]
pub async fn remove_logo(file_name: String, storage: State<'_, Storage>) -> Result<(), AppError> {
    storage.remove_logo(&file_name).await
}
