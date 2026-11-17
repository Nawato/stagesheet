//! Tauri IPC commands.
//!
//! Every command is `async` and returns `Result<T, AppError>`; all blocking
//! filesystem work happens on tokio's thread pool inside [`Storage`]. Argument
//! names are camelCase on the JavaScript side (Tauri's default).

use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::{Setlist, Song};
use crate::storage::Storage;

#[tauri::command]
pub async fn list_songs(storage: State<'_, Storage>) -> Result<Vec<Song>, AppError> {
    storage.list_songs().await
}

#[tauri::command]
pub async fn save_song(song: Song, storage: State<'_, Storage>) -> Result<Song, AppError> {
    storage.save_song(&song).await?;
    Ok(song)
}

#[tauri::command]
pub async fn delete_song(id: Uuid, storage: State<'_, Storage>) -> Result<(), AppError> {
    storage.delete_song(id).await
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
    storage: State<'_, Storage>,
) -> Result<Setlist, AppError> {
    setlist.validate().map_err(AppError::InvalidInput)?;
    setlist.touch();
    storage.save_setlist(&setlist).await?;
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
    storage.save_setlist(&setlist).await?;
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
