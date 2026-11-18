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
    mut song: Song,
    allow_unfiled: Option<bool>,
    storage: State<'_, Storage>,
) -> Result<Song, AppError> {
    // Store the title trimmed, like artist names; a whitespace-only title then
    // fails validation with the clear song error instead of persisting padding.
    song.trim_title();
    // `allow_unfiled` is a UX-convention trust, not a capability: any IPC
    // caller can pass it. The backend narrows *what* is skipped (only the
    // artist check) rather than *who* may skip it; every other validation rule
    // still applies. The frontend passes it only on the restore,
    // artist-deletion nulling, and stored-unfiled reorder paths.
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
    // Same title trim and `allow_unfiled` trust rule as `save_song` above.
    setlist.trim_title();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn song_and_setlist_titles_trim_like_artist_names() {
        let mut song = Song::new("  Opener  ");
        song.trim_title();
        assert_eq!(song.title, "Opener");

        let mut setlist = Setlist::new("  Gig  ");
        setlist.trim_title();
        assert_eq!(setlist.title, "Gig");

        // Whitespace-only titles collapse to empty and fail validation with
        // the clear field error instead of persisting padding.
        let mut blank_song = Song::new("   ");
        blank_song.trim_title();
        assert_eq!(blank_song.title, "");
        assert!(blank_song.validate_for_save(false).is_err());

        let mut blank_setlist = Setlist::new("   ");
        blank_setlist.trim_title();
        assert_eq!(blank_setlist.title, "");
        assert!(blank_setlist.validate_for_save(false).is_err());
    }
}
