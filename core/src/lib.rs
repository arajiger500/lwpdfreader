use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

/// Coordinates are normalized in the unrotated PDF crop box, origin bottom-left.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
impl Rect {
    pub fn validate(&self) -> Result<(), String> {
        if ![self.x, self.y, self.w, self.h]
            .iter()
            .all(|n| n.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.w <= 0.0
            || self.h <= 0.0
            || self.x + self.w > 1.000001
            || self.y + self.h > 1.000001
        {
            return Err("Invalid normalized rectangle".into());
        }
        Ok(())
    }
    pub fn intersects(&self, b: &Self) -> bool {
        self.x < b.x + b.w && self.x + self.w > b.x && self.y < b.y + b.h && self.y + self.h > b.y
    }
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Annotation {
    pub version: u8,
    pub id: String,
    pub document_id: String,
    pub page: u32,
    pub kind: String,
    pub color: String,
    pub rects: Vec<Rect>,
    pub text: String,
    pub note: String,
    pub created_at: u64,
    pub updated_at: u64,
}
impl Annotation {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported annotation version".into());
        }
        if self.id.is_empty()
            || self.id.len() > 128
            || self.document_id.is_empty()
            || self.document_id.len() > 128
            || self.page == 0
            || self.page > 1_000_000
        {
            return Err("Invalid annotation identity or page".into());
        }
        if !["highlight", "note", "bookmark"].contains(&self.kind.as_str())
            || !["yellow", "green", "blue", "pink"].contains(&self.color.as_str())
        {
            return Err("Invalid annotation kind or color".into());
        }
        if self.rects.len() > 4096
            || self.text.len() > 100_000
            || self.note.len() > 100_000
            || self.updated_at < self.created_at
            || self.updated_at > 9_007_199_254_740_991
        {
            return Err("Annotation exceeds limits or has invalid timestamps".into());
        }
        if self.kind == "highlight" && self.rects.is_empty() {
            return Err("A highlight requires geometry".into());
        }
        if self.kind != "highlight" && !self.rects.is_empty() {
            return Err("Only highlights have geometry".into());
        }
        for r in &self.rects {
            r.validate()?;
        }
        Ok(())
    }
}
pub fn parse_annotations(input: &str) -> Result<Vec<Annotation>, String> {
    let mut items: Vec<Annotation> = serde_json::from_str(input).map_err(|e| e.to_string())?;
    if items.len() > 100_000 {
        return Err("Too many annotations".into());
    }
    let mut ids = BTreeSet::new();
    for a in &items {
        a.validate()?;
        if !ids.insert(&a.id) {
            return Err("Duplicate annotation ID".into());
        }
    }
    items.sort_by(|a, b| (&a.document_id, a.page, &a.id).cmp(&(&b.document_id, b.page, &b.id)));
    Ok(items)
}
#[wasm_bindgen]
pub fn canonical_annotations(input: &str) -> Result<String, JsError> {
    let a = parse_annotations(input).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::to_string(&a).unwrap())
}
#[wasm_bindgen]
pub fn normalize_rect(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    width: f64,
    height: f64,
) -> Result<String, JsError> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(JsError::new("Invalid page dimensions"));
    }
    let r = Rect {
        x: x / width,
        y: y / height,
        w: w / width,
        h: h / height,
    };
    r.validate().map_err(|e| JsError::new(&e))?;
    Ok(serde_json::to_string(&r).unwrap())
}
/// Reusable index; construction and lookup are batched across the WASM boundary.
#[wasm_bindgen]
pub struct AnnotationIndex {
    pages: BTreeMap<u32, Vec<Annotation>>,
}
#[wasm_bindgen]
impl AnnotationIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(input: &str) -> Result<AnnotationIndex, JsError> {
        let items = parse_annotations(input).map_err(|e| JsError::new(&e))?;
        let mut pages: BTreeMap<u32, Vec<Annotation>> = BTreeMap::new();
        let mut doc: Option<String> = None;
        for a in items {
            if let Some(ref id) = doc {
                if id != &a.document_id {
                    return Err(JsError::new("Index must contain one document"));
                }
            } else {
                doc = Some(a.document_id.clone());
            }
            pages.entry(a.page).or_default().push(a);
        }
        Ok(Self { pages })
    }
    pub fn page(&self, page: u32) -> String {
        serde_json::to_string(self.pages.get(&page).map(Vec::as_slice).unwrap_or(&[])).unwrap()
    }
    pub fn hit_test(&self, page: u32, x: f64, y: f64) -> String {
        let hits: Vec<&Annotation> = self
            .pages
            .get(&page)
            .into_iter()
            .flatten()
            .filter(|a| a.rects.iter().any(|r| r.contains(x, y)))
            .collect();
        serde_json::to_string(&hits).unwrap()
    }
    pub fn intersect(&self, page: u32, x: f64, y: f64, w: f64, h: f64) -> String {
        let r = Rect { x, y, w, h };
        let hits: Vec<&Annotation> = self
            .pages
            .get(&page)
            .into_iter()
            .flatten()
            .filter(|a| a.rects.iter().any(|q| q.intersects(&r)))
            .collect();
        serde_json::to_string(&hits).unwrap()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn a() -> Annotation {
        Annotation {
            version: 1,
            id: "a".into(),
            document_id: "doc".into(),
            page: 2,
            kind: "highlight".into(),
            color: "yellow".into(),
            rects: vec![
                Rect {
                    x: 0.1,
                    y: 0.2,
                    w: 0.3,
                    h: 0.02,
                },
                Rect {
                    x: 0.1,
                    y: 0.1,
                    w: 0.2,
                    h: 0.02,
                },
            ],
            text: "multiple lines".into(),
            note: "".into(),
            created_at: 1,
            updated_at: 2,
        }
    }
    #[test]
    fn valid_multi_line() {
        assert!(a().validate().is_ok());
    }
    #[test]
    fn reject_bad_rects() {
        for r in [
            Rect {
                x: f64::NAN,
                y: 0.,
                w: 1.,
                h: 1.,
            },
            Rect {
                x: 0.,
                y: 0.,
                w: 0.,
                h: 1.,
            },
            Rect {
                x: -0.1,
                y: 0.,
                w: 1.,
                h: 1.,
            },
            Rect {
                x: 0.9,
                y: 0.,
                w: 0.2,
                h: 1.,
            },
        ] {
            assert!(r.validate().is_err());
        }
    }
    #[test]
    fn boundary() {
        assert!(Rect {
            x: 0.,
            y: 0.,
            w: 1.,
            h: 1.
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn intersection_and_contains() {
        let r = a().rects[0];
        assert!(r.contains(0.1, 0.2));
        assert!(!r.contains(0.5, 0.5));
        assert!(r.intersects(&r));
        assert!(!r.intersects(&Rect {
            x: 0.4,
            y: 0.2,
            w: 0.1,
            h: 0.1
        }));
    }
    #[test]
    fn zoom_invariant() {
        for s in [0.5, 1., 2., 4.] {
            let json =
                normalize_rect(60. * s, 80. * s, 120. * s, 16. * s, 600. * s, 800. * s).unwrap();
            let r: Rect = serde_json::from_str(&json).unwrap();
            assert_eq!(
                r,
                Rect {
                    x: 0.1,
                    y: 0.1,
                    w: 0.2,
                    h: 0.02
                }
            );
        }
    }
    #[test]
    fn deterministic_roundtrip() {
        let mut b = a();
        b.id = "b".into();
        b.page = 1;
        let src = serde_json::to_string(&vec![a(), b.clone()]).unwrap();
        let parsed = parse_annotations(&src).unwrap();
        assert_eq!(parsed[0], b);
        assert_eq!(
            parse_annotations(&serde_json::to_string(&parsed).unwrap()).unwrap(),
            parsed
        );
    }
    #[test]
    fn reject_duplicate() {
        let src = serde_json::to_string(&vec![a(), a()]).unwrap();
        assert!(parse_annotations(&src).is_err());
    }
    #[test]
    fn reject_malformed() {
        for s in ["{}", "null", "[{}]", "[NaN]", "not json"] {
            assert!(parse_annotations(s).is_err());
        }
    }
    #[test]
    fn reject_versions_and_missing_geometry() {
        let mut b = a();
        b.version = 2;
        assert!(b.validate().is_err());
        b.version = 1;
        b.rects.clear();
        assert!(b.validate().is_err());
        b.kind = "note".into();
        assert!(b.validate().is_ok());
    }
    #[test]
    fn group_pages() {
        let idx = AnnotationIndex::new(&serde_json::to_string(&vec![a()]).unwrap()).unwrap();
        assert_eq!(idx.page(1), "[]");
        assert_eq!(
            serde_json::from_str::<Vec<Annotation>>(&idx.page(2))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            serde_json::from_str::<Vec<Annotation>>(&idx.hit_test(2, 0.2, 0.21))
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn reject_invalid_fields() {
        let mut b = a();
        b.color = "red".into();
        assert!(b.validate().is_err());
        b = a();
        b.page = 0;
        assert!(b.validate().is_err());
        b = a();
        b.updated_at = 0;
        assert!(b.validate().is_err());
        b = a();
        b.kind = "bookmark".into();
        assert!(b.validate().is_err());
    }
    #[test]
    fn strict_json_rejects_unknown_fields() {
        let mut item = serde_json::to_value(a()).unwrap();
        item["futureField"] = serde_json::json!(true);
        assert!(parse_annotations(&serde_json::to_string(&vec![item]).unwrap()).is_err());
    }
    #[test]
    fn intersection_of_multiple_rectangles_returns_one_annotation() {
        let idx = AnnotationIndex::new(&serde_json::to_string(&vec![a()]).unwrap()).unwrap();
        let matches: Vec<Annotation> =
            serde_json::from_str(&idx.intersect(2, 0., 0., 1., 1.)).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(idx.intersect(1, 0., 0., 1., 1.), "[]");
        assert_eq!(idx.hit_test(2, f64::NAN, 0.), "[]");
    }
    #[test]
    fn limits_and_unicode_roundtrip() {
        let mut item = a();
        item.note = "Biología · 細胞 🧬".into();
        let parsed =
            parse_annotations(&serde_json::to_string(&vec![item.clone()]).unwrap()).unwrap();
        assert_eq!(parsed[0].note, item.note);
        item.text = "x".repeat(100_001);
        assert!(item.validate().is_err());
        item = a();
        item.rects = vec![item.rects[0]; 4097];
        assert!(item.validate().is_err());
    }
}
