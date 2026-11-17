//! StageSheet backend library.
//!
//! `main.rs` (desktop) and the mobile entry points both call [`run`], which is
//! why this lives in `lib.rs` rather than next to `main`.

mod commands;
mod error;
mod models;
mod storage;

pub use error::AppError;
pub use models::{
    DEFAULT_LOGO_WIDTH_MM, LOGO_MAX_WIDTH_MM, LOGO_MIN_WIDTH_MM, LogoAlignment, LogoConfig,
    Setlist, SetlistItem, Song,
};
pub use storage::Storage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let storage = Storage::for_app(app.handle())?;
            app.manage(storage);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_songs,
            commands::save_song,
            commands::delete_song,
            commands::list_setlists,
            commands::get_setlist,
            commands::save_setlist,
            commands::delete_setlist,
            commands::reorder_items,
            commands::setlist_duration,
            commands::import_logo,
            commands::remove_logo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StageSheet");
}
