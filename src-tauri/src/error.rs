//! Error type shared by storage and the Tauri IPC layer.

use serde::Serialize;
use uuid::Uuid;

/// Every fallible operation in the backend returns this type.
///
/// Tauri commands can only return errors that implement [`Serialize`], so the
/// error is rendered as a human-readable message for the frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("could not read or write app data: {0}")]
    Io(#[from] std::io::Error),

    #[error("app data contains invalid JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("song {0} was not found")]
    SongNotFound(Uuid),

    #[error("setlist {0} was not found")]
    SetlistNotFound(Uuid),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("the application data directory is unavailable")]
    AppDataDirUnavailable,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
