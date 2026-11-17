//! Domain models shared by the desktop and mobile builds.
//!
//! The serialized shape of these types is the on-disk format (`songs.json`,
//! `setlists/*.json`) *and* the Tauri IPC contract. Keep `src/types.ts` in sync
//! when changing them.

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// Smallest allowed printed logo width, in millimetres.
pub const LOGO_MIN_WIDTH_MM: f32 = 10.0;
/// Largest allowed printed logo width, in millimetres.
pub const LOGO_MAX_WIDTH_MM: f32 = 80.0;
/// Width used when no logo width has been chosen yet.
pub const DEFAULT_LOGO_WIDTH_MM: f32 = 40.0;

/// Longest accepted tuning label, in characters after trimming.
///
/// The bound keeps a single tuning value from blowing up the A4 row width; the
/// printed column is sized for short labels such as `E Std` or `Drop D`.
pub const MAX_TUNING_CHARS: usize = 24;

/// Longest accepted break label, in characters after trimming.
///
/// Labels sit inline in the dashed break row, so they share the tuning bound.
pub const MAX_BREAK_LABEL_CHARS: usize = 24;

/// Longest accepted comment text, in characters after trimming.
///
/// Applies to `Song.notes` and `Break.note`: both render inside the sheet body,
/// so one verbose comment must not blow the single-A4 budget.
pub const MAX_COMMENT_CHARS: usize = 140;

/// Largest accepted break length, in minutes.
///
/// Enforced in `validate()` rather than by the integer type so old files with
/// oversized values still load and only fail on their next save.
pub const MAX_BREAK_MINS: u32 = 600;

/// Horizontal placement of the band logo in the printed sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub enum LogoAlignment {
    Left,
    #[default]
    Center,
    Right,
}

impl LogoAlignment {
    /// Parses an alignment case-insensitively.
    ///
    /// This also keeps older files working where the alignment was stored as a
    /// free-form string (`"left"`, `"Center"`, ...).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "left" => Some(Self::Left),
            "center" | "centre" => Some(Self::Center),
            "right" => Some(Self::Right),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for LogoAlignment {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).ok_or_else(|| {
            serde::de::Error::custom(format!(
                "unknown logo alignment `{raw}` (expected left, center, or right)"
            ))
        })
    }
}

/// Logo placement for a setlist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LogoConfig {
    /// File name relative to `<app_data_dir>/stagesheet/logos/`.
    ///
    /// Only a plain file name is stored, never an absolute path, so setlists
    /// stay portable between devices.
    pub file_name: Option<String>,
    /// Printed width in millimetres. The UI keeps the aspect ratio locked.
    pub width_mm: f32,
    pub alignment: LogoAlignment,
}

impl Default for LogoConfig {
    fn default() -> Self {
        Self {
            file_name: None,
            width_mm: DEFAULT_LOGO_WIDTH_MM,
            alignment: LogoAlignment::Center,
        }
    }
}

impl LogoConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !self.width_mm.is_finite()
            || !(LOGO_MIN_WIDTH_MM..=LOGO_MAX_WIDTH_MM).contains(&self.width_mm)
        {
            return Err(format!(
                "logo width must be between {LOGO_MIN_WIDTH_MM} and {LOGO_MAX_WIDTH_MM} mm"
            ));
        }

        if let Some(file_name) = &self.file_name {
            if !is_plain_file_name(file_name) {
                return Err(
                    "logo file name must be a plain file name without path segments".into(),
                );
            }
        }

        Ok(())
    }
}

/// A reusable song in the library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Song {
    pub id: Uuid,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub bpm: Option<u16>,
    /// Musical key, e.g. `Em`. Added after the first schema draft, hence the
    /// serde default so older files still load.
    #[serde(default)]
    pub key: Option<String>,
    /// Free-text tuning label, e.g. `E Std`, `Drop D`, or `Capo 2`.
    ///
    /// Stored trimmed, and whitespace-only values load as `None`, so older
    /// files without the field and empty form submissions compare equal.
    #[serde(
        default,
        deserialize_with = "deserialize_trimmed_text",
        serialize_with = "serialize_trimmed_text"
    )]
    pub tuning: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<u32>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl Song {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            title: title.into(),
            artist: None,
            bpm: None,
            key: None,
            tuning: None,
            duration_secs: None,
            notes: None,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.title.trim().is_empty() {
            return Err("song title must not be empty".into());
        }

        if let Some(tuning) = &self.tuning {
            // Count the trimmed value so stray padding cannot fail validation.
            let trimmed = tuning.trim();
            if trimmed.chars().count() > MAX_TUNING_CHARS {
                return Err(format!(
                    "song tuning must be at most {MAX_TUNING_CHARS} characters"
                ));
            }
        }

        if let Some(notes) = &self.notes {
            // Count the trimmed value so stray padding cannot fail validation.
            if notes.trim().chars().count() > MAX_COMMENT_CHARS {
                return Err(format!(
                    "song \"{}\" comment must be at most {MAX_COMMENT_CHARS} characters (shorten it and save again)",
                    self.title.trim()
                ));
            }
        }

        Ok(())
    }
}

/// Trims a free-text value and maps blank input to `None`.
fn normalize_trimmed_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn deserialize_trimmed_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(normalize_trimmed_text)
}

fn serialize_trimmed_text<S>(value: &Option<String>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    normalize_trimmed_text(value.clone()).serialize(serializer)
}

/// One entry in a setlist: either a song or a timed break.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SetlistItem {
    Song(Song),
    Break {
        /// Break length in minutes; `0..=MAX_BREAK_MINS`, checked in `validate()`.
        duration_mins: u32,
        /// Free-text comment shown inline after the length.
        #[serde(default)]
        note: Option<String>,
        /// Optional custom heading, e.g. `Intermission` or `Encore`.
        ///
        /// `None` renders as `Break` in the UI. Stored trimmed, and
        /// whitespace-only values load as `None`.
        #[serde(
            default,
            deserialize_with = "deserialize_trimmed_text",
            serialize_with = "serialize_trimmed_text"
        )]
        label: Option<String>,
    },
}

impl SetlistItem {
    /// Contribution to the setlist duration. Songs without a duration count as
    /// zero seconds; breaks are stored in minutes.
    pub fn duration_secs(&self) -> u64 {
        match self {
            Self::Song(song) => u64::from(song.duration_secs.unwrap_or(0)),
            Self::Break { duration_mins, .. } => u64::from(*duration_mins) * 60,
        }
    }

    pub fn as_song(&self) -> Option<&Song> {
        match self {
            Self::Song(song) => Some(song),
            Self::Break { .. } => None,
        }
    }

    pub fn is_break(&self) -> bool {
        matches!(self, Self::Break { .. })
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Song(song) => song.validate(),
            Self::Break {
                duration_mins,
                note,
                label,
            } => {
                if *duration_mins > MAX_BREAK_MINS {
                    return Err(format!(
                        "break length must be between 0 and {MAX_BREAK_MINS} minutes"
                    ));
                }

                if let Some(label) = label {
                    // Count the trimmed value so stray padding cannot fail.
                    if label.trim().chars().count() > MAX_BREAK_LABEL_CHARS {
                        return Err(format!(
                            "break label must be at most {MAX_BREAK_LABEL_CHARS} characters"
                        ));
                    }
                }

                if let Some(note) = note {
                    if note.trim().chars().count() > MAX_COMMENT_CHARS {
                        return Err(format!(
                            "break comment must be at most {MAX_COMMENT_CHARS} characters (shorten it and save again)"
                        ));
                    }
                }

                Ok(())
            }
        }
    }
}

/// Which optional blocks the printable sheet shows.
///
/// The container-level `#[serde(default)]` fills missing fields from the
/// all-`true` `Default`, so partial or pre-feature JSON renders exactly as it
/// did before the toggles existed. Do not add field-level defaults here: a
/// missing `bool` would then silently mean `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SheetOptions {
    pub show_key: bool,
    pub show_tuning: bool,
    /// Tempo (BPM) column.
    pub show_tempo: bool,
    /// Time (song duration) column.
    pub show_duration: bool,
    /// Song and break comments; also gates the break label.
    pub show_comment: bool,
}

impl Default for SheetOptions {
    fn default() -> Self {
        Self {
            show_key: true,
            show_tuning: true,
            show_tempo: true,
            show_duration: true,
            show_comment: true,
        }
    }
}

/// How the printable sheet paginates.
///
/// `Single` keeps the original single-A4 cap with auto-fit shrink; `Multiple`
/// lets the content flow across as many A4 pages as needed. Serialized as
/// `"Single"` / `"Multiple"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PageMode {
    #[default]
    Single,
    Multiple,
}

/// A printable setlist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Setlist {
    pub id: Uuid,
    pub title: String,
    #[serde(default)]
    pub venue: Option<String>,
    #[serde(default)]
    pub date: Option<NaiveDate>,
    #[serde(default)]
    pub items: Vec<SetlistItem>,
    /// `logo_config` was the field name in the first schema draft; the alias
    /// keeps old files loadable.
    #[serde(default, alias = "logo_config")]
    pub logo: LogoConfig,
    /// Missing in pre-Feature-4 files; defaults to the all-visible sheet.
    #[serde(default)]
    pub sheet_options: SheetOptions,
    /// Missing in pre-Feature-5 files; defaults to the single-page cap.
    #[serde(default)]
    pub page_mode: PageMode,
    #[serde(default = "Utc::now")]
    pub created_at: DateTime<Utc>,
    #[serde(default = "Utc::now")]
    pub updated_at: DateTime<Utc>,
}

impl Setlist {
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            title: title.into(),
            venue: None,
            date: None,
            items: Vec::new(),
            logo: LogoConfig::default(),
            sheet_options: SheetOptions::default(),
            page_mode: PageMode::default(),
            created_at: now,
            updated_at: now,
        }
    }

    /// Sum of song durations plus breaks. Songs without durations count as zero.
    pub fn total_duration_secs(&self) -> u64 {
        self.items.iter().map(SetlistItem::duration_secs).sum()
    }

    pub fn song_count(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.as_song().is_some())
            .count()
    }

    pub fn break_count(&self) -> usize {
        self.items.iter().filter(|item| item.is_break()).count()
    }

    /// Moves an item to another position. `from == to` is a no-op.
    pub fn move_item(&mut self, from: usize, to: usize) -> Result<(), AppError> {
        let len = self.items.len();
        if from >= len || to >= len {
            return Err(AppError::InvalidInput(format!(
                "cannot move item from index {from} to {to} in a setlist of {len} items"
            )));
        }

        if from != to {
            let item = self.items.remove(from);
            self.items.insert(to, item);
        }

        Ok(())
    }

    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.title.trim().is_empty() {
            return Err("setlist title must not be empty".into());
        }

        self.logo.validate()?;

        for item in &self.items {
            item.validate()?;
        }

        Ok(())
    }
}

/// Accepts only a plain file name: no directory separators, no `..`, and no
/// platform-specific escape hatches such as Windows drive/stream syntax.
pub(crate) fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':', '\0'])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_time() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-17T10:00:00Z")
            .expect("valid timestamp")
            .with_timezone(&Utc)
    }

    fn song(title: &str, duration_secs: Option<u32>) -> Song {
        Song {
            id: Uuid::new_v4(),
            title: title.into(),
            artist: Some("The Band".into()),
            bpm: Some(128),
            key: Some("Em".into()),
            tuning: Some("Drop D".into()),
            duration_secs,
            notes: None,
        }
    }

    fn sample_setlist() -> Setlist {
        let mut setlist = Setlist::new("Release Show");
        setlist.venue = Some("Matrix, Bochum".into());
        setlist.date = NaiveDate::from_ymd_opt(2026, 11, 20);
        setlist.created_at = fixed_time();
        setlist.updated_at = fixed_time();
        setlist.logo = LogoConfig {
            file_name: Some("logo.png".into()),
            width_mm: 35.0,
            alignment: LogoAlignment::Left,
        };
        setlist.items = vec![
            SetlistItem::Song(song("Opener", Some(180))),
            SetlistItem::Break {
                duration_mins: 10,
                note: Some("Tune down".into()),
                label: Some("Intermission".into()),
            },
            SetlistItem::Song(song("Closer", Some(240))),
        ];
        setlist
    }

    #[test]
    fn total_duration_includes_songs_and_breaks() {
        let setlist = sample_setlist();

        assert_eq!(setlist.total_duration_secs(), 180 + 600 + 240);
        assert_eq!(setlist.song_count(), 2);
        assert_eq!(setlist.break_count(), 1);
    }

    #[test]
    fn songs_without_duration_count_as_zero() {
        let mut setlist = Setlist::new("Short");
        setlist.items.push(SetlistItem::Song(song("Intro", None)));

        assert_eq!(setlist.total_duration_secs(), 0);
    }

    #[test]
    fn reorder_moves_items_in_both_directions() {
        let mut setlist = sample_setlist();

        setlist.move_item(0, 2).expect("move to the end");
        assert_eq!(
            setlist
                .items
                .iter()
                .filter_map(SetlistItem::as_song)
                .map(|song| song.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Closer", "Opener"]
        );
        assert!(setlist.items[0].is_break());

        setlist.move_item(2, 0).expect("move back to the front");
        assert_eq!(
            setlist.items[0].as_song().map(|s| s.title.as_str()),
            Some("Opener")
        );

        setlist.move_item(1, 1).expect("no-op move");
        assert!(setlist.items[1].is_break());
    }

    #[test]
    fn reorder_rejects_out_of_bounds_indexes() {
        let mut setlist = sample_setlist();

        assert!(setlist.move_item(3, 0).is_err());
        assert!(setlist.move_item(0, 3).is_err());
        assert_eq!(setlist.items.len(), 3, "failed moves must not mutate");
    }

    #[test]
    fn setlist_round_trips_through_json() {
        let setlist = sample_setlist();

        let json = serde_json::to_string_pretty(&setlist).expect("serialize");
        let decoded: Setlist = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(decoded, setlist);
    }

    #[test]
    fn sheet_options_default_to_all_visible() {
        let options = SheetOptions::default();

        assert!(options.show_key);
        assert!(options.show_tuning);
        assert!(options.show_tempo);
        assert!(options.show_duration);
        assert!(options.show_comment);
        assert_eq!(options, Setlist::new("Gig").sheet_options);
    }

    #[test]
    fn legacy_setlist_without_sheet_options_gets_all_true() {
        let legacy = serde_json::json!({
            "id": Uuid::new_v4(),
            "title": "Old Gig",
            "venue": null,
            "date": null,
            "items": [],
            "logo": {
                "file_name": null,
                "width_mm": 40.0,
                "alignment": "Center"
            }
        });

        let setlist: Setlist = serde_json::from_value(legacy).expect("pre-feature setlist parses");
        assert_eq!(setlist.sheet_options, SheetOptions::default());
    }

    #[test]
    fn partial_sheet_options_keep_missing_fields_true() {
        // Only one field is present. A field-level serde default would turn the
        // absent booleans into `false`; the container-level default must keep
        // them `true`.
        let setlist: Setlist = serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4(),
            "title": "Partial options",
            "sheet_options": { "show_duration": false }
        }))
        .expect("partial sheet options parse");

        assert_eq!(
            setlist.sheet_options,
            SheetOptions {
                show_key: true,
                show_tuning: true,
                show_tempo: true,
                show_duration: false,
                show_comment: true,
            }
        );
    }

    #[test]
    fn sheet_options_round_trip_with_disabled_blocks() {
        let mut setlist = sample_setlist();
        setlist.sheet_options = SheetOptions {
            show_key: false,
            show_tuning: true,
            show_tempo: false,
            show_duration: false,
            show_comment: false,
        };

        let json = serde_json::to_string(&setlist).expect("serialize sheet options");
        assert!(json.contains("\"show_duration\":false"));
        assert_eq!(
            serde_json::from_str::<Setlist>(&json).expect("deserialize sheet options"),
            setlist
        );
    }

    #[test]
    fn page_mode_defaults_to_single() {
        assert_eq!(PageMode::default(), PageMode::Single);
        assert_eq!(Setlist::new("Gig").page_mode, PageMode::Single);
    }

    #[test]
    fn page_mode_serializes_as_variant_names() {
        assert_eq!(
            serde_json::to_value(PageMode::Single).expect("serialize Single"),
            serde_json::json!("Single")
        );
        assert_eq!(
            serde_json::to_value(PageMode::Multiple).expect("serialize Multiple"),
            serde_json::json!("Multiple")
        );

        let multiple: PageMode = serde_json::from_str("\"Multiple\"").expect("parse Multiple");
        assert_eq!(multiple, PageMode::Multiple);
        assert!(
            serde_json::from_str::<PageMode>("\"multiple\"").is_err(),
            "variant names are case-sensitive"
        );
        assert!(
            serde_json::from_str::<PageMode>("\"Stacked\"").is_err(),
            "unknown modes must be rejected"
        );
    }

    #[test]
    fn setlist_round_trips_multiple_page_mode() {
        let mut setlist = sample_setlist();
        setlist.page_mode = PageMode::Multiple;

        let json = serde_json::to_string(&setlist).expect("serialize multiple page mode");
        assert!(json.contains("\"page_mode\":\"Multiple\""));
        assert_eq!(
            serde_json::from_str::<Setlist>(&json).expect("deserialize multiple page mode"),
            setlist
        );
    }

    #[test]
    fn legacy_setlist_without_page_mode_defaults_to_single() {
        let legacy = serde_json::json!({
            "id": Uuid::new_v4(),
            "title": "Old Gig",
            "venue": null,
            "date": null,
            "items": [],
            "logo": {
                "file_name": null,
                "width_mm": 40.0,
                "alignment": "Center"
            }
        });

        let setlist: Setlist = serde_json::from_value(legacy).expect("pre-feature setlist parses");
        assert_eq!(setlist.page_mode, PageMode::Single);
    }

    #[test]
    fn song_round_trips_with_and_without_tuning() {
        let with_tuning = Song {
            tuning: Some("E Std".into()),
            ..Song::new("Opener")
        };
        let json = serde_json::to_string(&with_tuning).expect("serialize with tuning");
        assert!(json.contains("\"tuning\":\"E Std\""));
        assert_eq!(
            serde_json::from_str::<Song>(&json).expect("deserialize with tuning"),
            with_tuning
        );

        let without_tuning = Song::new("Closer");
        let json = serde_json::to_string(&without_tuning).expect("serialize without tuning");
        assert!(json.contains("\"tuning\":null"));
        assert_eq!(
            serde_json::from_str::<Song>(&json).expect("deserialize without tuning"),
            without_tuning
        );
    }

    #[test]
    fn legacy_song_json_without_tuning_loads_as_none() {
        let legacy = r#"{
            "id": "0f8c7a6e-2b3d-4c5e-8f90-1a2b3c4d5e6f",
            "title": "Old Song",
            "artist": "The Band",
            "bpm": 120,
            "key": "Em",
            "duration_secs": 240,
            "notes": null
        }"#;

        let song: Song = serde_json::from_str(legacy).expect("legacy song parses");
        assert_eq!(song.tuning, None);
        assert!(song.validate().is_ok());
    }

    #[test]
    fn tuning_is_trimmed_and_blank_becomes_none() {
        let song: Song = serde_json::from_str(
            r#"{
                "id": "0f8c7a6e-2b3d-4c5e-8f90-1a2b3c4d5e6f",
                "title": "Opener",
                "tuning": "  Drop D  "
            }"#,
        )
        .expect("song parses");
        assert_eq!(song.tuning.as_deref(), Some("Drop D"));

        let blank: Song = serde_json::from_str(
            r#"{
                "id": "0f8c7a6e-2b3d-4c5e-8f90-1a2b3c4d5e6f",
                "title": "Opener",
                "tuning": "   "
            }"#,
        )
        .expect("blank tuning parses");
        assert_eq!(blank.tuning, None);

        let padded = serde_json::to_value(Song {
            tuning: Some("  E Std  ".into()),
            ..Song::new("Opener")
        })
        .expect("serialize padded tuning");
        assert_eq!(padded["tuning"], serde_json::json!("E Std"));

        let empty = serde_json::to_value(Song {
            tuning: Some(String::new()),
            ..Song::new("Opener")
        })
        .expect("serialize empty tuning");
        assert_eq!(empty["tuning"], serde_json::Value::Null);
    }

    #[test]
    fn validation_bounds_tuning_length_after_trimming() {
        let mut song = Song::new("Opener");

        song.tuning = Some("  E Std  ".into());
        assert!(song.validate().is_ok(), "padding must not count");

        song.tuning = Some("   ".into());
        assert!(song.validate().is_ok(), "blank is treated as no tuning");

        song.tuning = Some("x".repeat(MAX_TUNING_CHARS));
        assert!(song.validate().is_ok(), "the limit itself is allowed");

        song.tuning = Some(format!("  {}  ", "x".repeat(MAX_TUNING_CHARS)));
        assert!(song.validate().is_ok(), "trimmed value is at the limit");

        song.tuning = Some("x".repeat(MAX_TUNING_CHARS + 1));
        assert!(song.validate().is_err(), "one char over the limit fails");

        let mut setlist = Setlist::new("Gig");
        setlist.items.push(SetlistItem::Song(Song {
            tuning: Some("y".repeat(MAX_TUNING_CHARS + 1)),
            ..Song::new("Too long")
        }));
        assert!(
            setlist.validate().is_err(),
            "setlist validation delegates to song validation"
        );
    }

    #[test]
    fn break_label_round_trips_and_old_json_defaults_to_none() {
        let with_label = SetlistItem::Break {
            duration_mins: 15,
            note: Some("Change strings".into()),
            label: Some("Encore".into()),
        };
        let json = serde_json::to_string(&with_label).expect("serialize with label");
        assert!(json.contains("\"label\":\"Encore\""));
        assert_eq!(
            serde_json::from_str::<SetlistItem>(&json).expect("deserialize with label"),
            with_label
        );

        // Old break JSON written before the label field existed.
        let legacy: SetlistItem =
            serde_json::from_str(r#"{"Break":{"duration_mins":10,"note":null}}"#)
                .expect("legacy break parses");
        match &legacy {
            SetlistItem::Break { label, .. } => assert_eq!(*label, None),
            SetlistItem::Song(_) => panic!("expected a break"),
        }
        assert!(legacy.validate().is_ok());
    }

    #[test]
    fn break_label_is_trimmed_and_blank_becomes_none() {
        let padded: SetlistItem = serde_json::from_str(
            r#"{"Break":{"duration_mins":10,"note":null,"label":"  Encore  "}}"#,
        )
        .expect("padded label parses");
        match &padded {
            SetlistItem::Break { label, .. } => assert_eq!(label.as_deref(), Some("Encore")),
            SetlistItem::Song(_) => panic!("expected a break"),
        }

        let blank: SetlistItem =
            serde_json::from_str(r#"{"Break":{"duration_mins":10,"note":null,"label":"   "}}"#)
                .expect("blank label parses");
        match &blank {
            SetlistItem::Break { label, .. } => assert_eq!(*label, None),
            SetlistItem::Song(_) => panic!("expected a break"),
        }

        let serialized = serde_json::to_value(SetlistItem::Break {
            duration_mins: 10,
            note: None,
            label: Some("  Intermission  ".into()),
        })
        .expect("serialize padded label");
        assert_eq!(
            serialized["Break"]["label"],
            serde_json::json!("Intermission")
        );

        let empty = serde_json::to_value(SetlistItem::Break {
            duration_mins: 10,
            note: None,
            label: Some(String::new()),
        })
        .expect("serialize empty label");
        assert_eq!(empty["Break"]["label"], serde_json::Value::Null);
    }

    #[test]
    fn validation_bounds_break_label_after_trimming() {
        let valid = SetlistItem::Break {
            duration_mins: 10,
            note: None,
            label: Some("x".repeat(MAX_BREAK_LABEL_CHARS)),
        };
        assert!(valid.validate().is_ok(), "the limit itself is allowed");

        let padded = SetlistItem::Break {
            duration_mins: 10,
            note: None,
            label: Some(format!("  {}  ", "x".repeat(MAX_BREAK_LABEL_CHARS))),
        };
        assert!(padded.validate().is_ok(), "padding must not count");

        let too_long = SetlistItem::Break {
            duration_mins: 10,
            note: None,
            label: Some("x".repeat(MAX_BREAK_LABEL_CHARS + 1)),
        };
        assert!(too_long.validate().is_err());

        let mut setlist = Setlist::new("Gig");
        setlist.items.push(too_long);
        assert!(
            setlist.validate().is_err(),
            "setlist validation delegates to item validation"
        );
    }

    #[test]
    fn validation_bounds_break_duration() {
        for minutes in [0, 1, MAX_BREAK_MINS] {
            let item = SetlistItem::Break {
                duration_mins: minutes,
                note: None,
                label: None,
            };
            assert!(item.validate().is_ok(), "{minutes} minutes is allowed");
        }

        for minutes in [MAX_BREAK_MINS + 1, u32::MAX] {
            let item = SetlistItem::Break {
                duration_mins: minutes,
                note: None,
                label: None,
            };
            assert!(item.validate().is_err(), "{minutes} minutes is too long");
        }

        // The old IPC hole: a u32-sized value arrives as valid JSON, loads,
        // and is only rejected when the setlist is validated on save.
        let huge: SetlistItem =
            serde_json::from_str(r#"{"Break":{"duration_mins":4000000000,"note":null}}"#)
                .expect("u32-sized duration parses");
        assert_eq!(huge.duration_secs(), 4_000_000_000 * 60);
        assert!(huge.validate().is_err());

        let mut setlist = Setlist::new("Gig");
        setlist.items.push(huge);
        assert!(setlist.validate().is_err());
    }

    #[test]
    fn validation_bounds_comments_on_songs_and_breaks() {
        let mut song = Song::new("Opener");

        song.notes = Some("x".repeat(MAX_COMMENT_CHARS));
        assert!(song.validate().is_ok(), "the limit itself is allowed");

        song.notes = Some(format!("  {}  ", "x".repeat(MAX_COMMENT_CHARS)));
        assert!(song.validate().is_ok(), "padding must not count");

        song.notes = Some("x".repeat(MAX_COMMENT_CHARS + 1));
        let error = song.validate().expect_err("one char over the limit fails");
        assert!(error.contains("Opener"), "error names the song: {error}");
        assert!(
            error.contains("shorten it"),
            "error explains the next step: {error}"
        );

        let mut setlist = Setlist::new("Gig");
        setlist.items.push(SetlistItem::Song(song));
        assert!(
            setlist.validate().is_err(),
            "setlist validation delegates to song validation"
        );

        let mut break_item = SetlistItem::Break {
            duration_mins: 10,
            note: Some("x".repeat(MAX_COMMENT_CHARS)),
            label: None,
        };
        assert!(break_item.validate().is_ok(), "the limit itself is allowed");

        if let SetlistItem::Break { note, .. } = &mut break_item {
            *note = Some(format!("  {}  ", "x".repeat(MAX_COMMENT_CHARS)));
        }
        assert!(break_item.validate().is_ok(), "padding must not count");

        if let SetlistItem::Break { note, .. } = &mut break_item {
            *note = Some("x".repeat(MAX_COMMENT_CHARS + 1));
        }
        let error = break_item
            .validate()
            .expect_err("one char over the limit fails");
        assert!(
            error.contains("break comment") && error.contains("shorten it"),
            "break error explains the problem: {error}"
        );

        let mut setlist = Setlist::new("Gig");
        setlist.items.push(break_item);
        assert!(
            setlist.validate().is_err(),
            "setlist validation delegates to item validation"
        );
    }

    #[test]
    fn over_long_comments_still_load_but_fail_validation() {
        let notes = "n".repeat(MAX_COMMENT_CHARS + 1);
        let song: Song = serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4(),
            "title": "Legacy verbose song",
            "notes": notes,
        }))
        .expect("over-long song comment still loads");
        assert_eq!(
            song.notes.as_deref().map(str::len),
            Some(MAX_COMMENT_CHARS + 1)
        );
        assert!(song.validate().is_err(), "next save must fail");

        let break_item: SetlistItem = serde_json::from_value(serde_json::json!({
            "Break": {
                "duration_mins": 10,
                "note": "b".repeat(MAX_COMMENT_CHARS + 1),
            }
        }))
        .expect("over-long break comment still loads");
        assert!(break_item.validate().is_err(), "next save must fail");
    }

    #[test]
    fn logo_alignment_accepts_any_case() {
        for (raw, expected) in [
            ("Left", LogoAlignment::Left),
            ("left", LogoAlignment::Left),
            ("CENTER", LogoAlignment::Center),
            ("centre", LogoAlignment::Center),
            ("Right", LogoAlignment::Right),
        ] {
            let alignment: LogoAlignment = serde_json::from_str(&format!("\"{raw}\""))
                .unwrap_or_else(|error| panic!("{raw} should parse: {error}"));
            assert_eq!(alignment, expected);
        }

        assert!(serde_json::from_str::<LogoAlignment>("\"middle\"").is_err());
    }

    #[test]
    fn migrates_first_draft_json() {
        // Shape of the first draft: date as a plain string, `logo_config`
        // instead of `logo`, lowercase alignment, no song key, no timestamps.
        // Unknown legacy logo fields (`file_path`, `width`, `height`) must be
        // ignored rather than rejected.
        let legacy = r#"{
            "id": "9b2f1b3e-1c9a-4d55-9f21-3f0e2f5f7a10",
            "title": "Old Gig",
            "venue": "Matrix, Bochum",
            "date": "2026-11-20",
            "items": [
                {
                    "Song": {
                        "id": "0f8c7a6e-2b3d-4c5e-8f90-1a2b3c4d5e6f",
                        "title": "Opener",
                        "artist": null,
                        "bpm": 120,
                        "duration_secs": 240,
                        "notes": null
                    }
                },
                { "Break": { "duration_mins": 10, "note": "Tune down" } }
            ],
            "logo_config": {
                "file_path": "/home/band/logo.png",
                "width": 300,
                "height": 120,
                "alignment": "left"
            }
        }"#;

        let setlist: Setlist = serde_json::from_str(legacy).expect("legacy setlist parses");

        assert_eq!(setlist.date, NaiveDate::from_ymd_opt(2026, 11, 20));
        assert_eq!(setlist.logo.alignment, LogoAlignment::Left);
        assert_eq!(setlist.logo.file_name, None);
        assert_eq!(setlist.logo.width_mm, DEFAULT_LOGO_WIDTH_MM);
        assert_eq!(setlist.sheet_options, SheetOptions::default());
        assert_eq!(setlist.page_mode, PageMode::Single);
        assert_eq!(setlist.items.len(), 2);
        assert_eq!(setlist.total_duration_secs(), 240 + 600);
        assert_eq!(
            setlist.items[0]
                .as_song()
                .map(|song| song.tuning.as_deref()),
            Some(None),
            "missing tuning deserializes to None"
        );
        assert!(setlist.created_at <= Utc::now());
    }

    #[test]
    fn validation_rejects_bad_titles_and_logo_widths() {
        let mut setlist = Setlist::new("   ");
        assert!(setlist.validate().is_err());

        setlist.title = "Valid".into();
        assert!(setlist.validate().is_ok());

        setlist.logo.width_mm = 9.0;
        assert!(setlist.validate().is_err());

        setlist.logo.width_mm = 81.0;
        assert!(setlist.validate().is_err());

        setlist.logo.width_mm = 40.0;
        assert!(setlist.validate().is_ok());

        setlist.logo.file_name = Some("../escape.png".into());
        assert!(setlist.validate().is_err());
    }

    #[test]
    fn plain_file_name_rejects_traversal() {
        assert!(is_plain_file_name("logo.png"));
        assert!(!is_plain_file_name("../logo.png"));
        assert!(!is_plain_file_name("nested/logo.png"));
        assert!(!is_plain_file_name("nested\\logo.png"));
        assert!(!is_plain_file_name(""));
        assert!(!is_plain_file_name(".."));
    }
}
