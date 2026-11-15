//! Vector ink lives independently of PDF text annotations. Coordinates are in the
//! unrotated crop box; widths are fractions of the crop box's shorter dimension.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub pressure: Option<f64>,
}
impl Point {
    fn valid(&self) -> bool {
        [self.x, self.y]
            .iter()
            .all(|n| n.is_finite() && *n >= 0. && *n <= 1.)
            && self
                .pressure
                .is_none_or(|p| p.is_finite() && (0.0..=1.0).contains(&p))
    }
    fn lerp(self, b: Self, t: f64) -> Self {
        Self {
            x: self.x + (b.x - self.x) * t,
            y: self.y + (b.y - self.y) * t,
            pressure: match (self.pressure, b.pressure) {
                (Some(a), Some(b)) => Some(a + (b - a) * t),
                _ => None,
            },
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Stroke {
    pub version: u8,
    pub id: String,
    pub root_id: String,
    pub document_id: String,
    pub page: u32,
    pub kind: String,
    pub color: String,
    pub width: f64,
    pub opacity: f64,
    pub page_width: f64,
    pub page_height: f64,
    pub points: Vec<Point>,
    pub created_at: u64,
    pub updated_at: u64,
}
impl Stroke {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || [&self.id, &self.root_id, &self.document_id]
                .iter()
                .any(|s| s.is_empty() || s.len() > 128)
            || self.page == 0
            || self.page > 1_000_000
        {
            return Err("Invalid ink identity, page or version".into());
        }
        if !["pen", "marker"].contains(&self.kind.as_str())
            || self.color.len() != 7
            || !self.color.starts_with('#')
            || !self.color[1..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Invalid ink tool or color".into());
        }
        if !self.width.is_finite()
            || self.width <= 0.
            || self.width > 0.25
            || !self.opacity.is_finite()
            || self.opacity < 0.05
            || self.opacity > 1.
            || ![self.page_width, self.page_height]
                .iter()
                .all(|n| n.is_finite() && *n > 0. && *n <= 1e7)
        {
            return Err("Invalid ink dimensions, width or opacity".into());
        }
        if self.points.is_empty()
            || self.points.len() > 8192
            || self.points.iter().any(|p| !p.valid())
            || self.updated_at < self.created_at
            || self.updated_at > 9_007_199_254_740_991
        {
            return Err("Invalid ink points or timestamps".into());
        }
        Ok(())
    }
    fn radius(&self, a: Point, b: Point) -> f64 {
        let pressure = if self.kind == "pen" {
            a.pressure.unwrap_or(0.5).max(b.pressure.unwrap_or(0.5)) + 0.5
        } else {
            1.
        };
        self.width * self.page_width.min(self.page_height) * pressure / 2.
    }
}
pub fn parse(input: &str) -> Result<Vec<Stroke>, String> {
    let mut strokes: Vec<Stroke> = serde_json::from_str(input).map_err(|e| e.to_string())?;
    if strokes.len() > 100_000 || strokes.iter().map(|s| s.points.len()).sum::<usize>() > 2_000_000
    {
        return Err("Ink exceeds safety limits".into());
    }
    let mut ids = BTreeSet::new();
    for s in &strokes {
        s.validate()?;
        if !ids.insert(s.id.clone()) {
            return Err("Duplicate stroke ID".into());
        }
    }
    strokes.sort_by(|a, b| {
        (&a.document_id, a.page, a.created_at, &a.root_id, &a.id).cmp(&(
            &b.document_id,
            b.page,
            b.created_at,
            &b.root_id,
            &b.id,
        ))
    });
    Ok(strokes)
}
#[wasm_bindgen]
pub fn canonical_strokes(input: &str) -> Result<String, JsError> {
    Ok(serde_json::to_string(&parse(input).map_err(|e| JsError::new(&e))?).unwrap())
}

type XY = (f64, f64);
fn physical(p: Point, w: f64, h: f64) -> XY {
    (p.x * w, p.y * h)
}
fn dot(a: XY, b: XY) -> f64 {
    a.0 * b.0 + a.1 * b.1
}
fn sub(a: XY, b: XY) -> XY {
    (a.0 - b.0, a.1 - b.1)
}
fn slab(v: f64, d: f64, min: f64, max: f64) -> Option<(f64, f64)> {
    if d.abs() < 1e-12 {
        return if v >= min && v <= max {
            Some((0., 1.))
        } else {
            None
        };
    }
    let a = (min - v) / d;
    let b = (max - v) / d;
    let lo = a.min(b).max(0.);
    let hi = a.max(b).min(1.);
    if hi >= lo {
        Some((lo, hi))
    } else {
        None
    }
}
fn circle(a: XY, b: XY, c: XY, r: f64) -> Option<(f64, f64)> {
    let v = sub(a, c);
    let d = sub(b, a);
    let aa = dot(d, d);
    if aa < 1e-20 {
        return if dot(v, v) <= r * r {
            Some((0., 1.))
        } else {
            None
        };
    }
    let bb = 2. * dot(v, d);
    let cc = dot(v, v) - r * r;
    let disc = bb * bb - 4. * aa * cc;
    if disc < 0. {
        return None;
    }
    let root = disc.sqrt();
    let lo = ((-bb - root) / (2. * aa)).max(0.);
    let hi = ((-bb + root) / (2. * aa)).min(1.);
    if hi >= lo {
        Some((lo, hi))
    } else {
        None
    }
}
fn merge(mut ranges: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (lo, hi) in ranges {
        if let Some(last) = out.last_mut() {
            if lo <= last.1 + 1e-10 {
                last.1 = last.1.max(hi);
                continue;
            }
        }
        out.push((lo, hi));
    }
    out
}
/// Parameter intervals of AB inside a round capsule around QR. Analytic strip
/// and circle intersections also catch crossings between sparse pointer events.
fn capsule(a: XY, b: XY, q: XY, r: XY, radius: f64) -> Vec<(f64, f64)> {
    let mut ranges = Vec::new();
    if let Some(v) = circle(a, b, q, radius) {
        ranges.push(v);
    }
    if let Some(v) = circle(a, b, r, radius) {
        ranges.push(v);
    }
    let axis = sub(r, q);
    let len = dot(axis, axis).sqrt();
    if len > 1e-12 {
        let unit = (axis.0 / len, axis.1 / len);
        let normal = (-unit.1, unit.0);
        let offset = sub(a, q);
        let delta = sub(b, a);
        if let (Some(x), Some(y)) = (
            slab(dot(offset, unit), dot(delta, unit), 0., len),
            slab(dot(offset, normal), dot(delta, normal), -radius, radius),
        ) {
            let lo = x.0.max(y.0);
            let hi = x.1.min(y.1);
            if hi >= lo {
                ranges.push((lo, hi));
            }
        }
    }
    merge(ranges)
}
fn cut(
    stroke: &Stroke,
    points: &[Point],
    eraser: &[Point],
    radius: f64,
) -> (Vec<Vec<Point>>, bool) {
    if points.len() == 1 {
        let p = physical(points[0], stroke.page_width, stroke.page_height);
        let hit = eraser.windows(2).any(|e| {
            !capsule(
                p,
                p,
                physical(e[0], stroke.page_width, stroke.page_height),
                physical(e[1], stroke.page_width, stroke.page_height),
                radius + stroke.radius(points[0], points[0]),
            )
            .is_empty()
        });
        return (if hit { vec![] } else { vec![points.to_vec()] }, hit);
    }
    let mut out: Vec<Vec<Point>> = Vec::new();
    let mut current: Vec<Point> = Vec::new();
    let mut changed = false;
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let (ap, bp) = (
            physical(a, stroke.page_width, stroke.page_height),
            physical(b, stroke.page_width, stroke.page_height),
        );
        let intervals = merge(
            eraser
                .windows(2)
                .flat_map(|e| {
                    capsule(
                        ap,
                        bp,
                        physical(e[0], stroke.page_width, stroke.page_height),
                        physical(e[1], stroke.page_width, stroke.page_height),
                        radius + stroke.radius(a, b),
                    )
                })
                .collect(),
        );
        if intervals.is_empty() {
            if current.is_empty() {
                current.push(a);
            }
            current.push(b);
            continue;
        }
        changed = true;
        let mut cursor = 0.;
        for (lo, hi) in intervals {
            if lo > cursor + 1e-9 {
                let start = a.lerp(b, cursor);
                let end = a.lerp(b, lo);
                if current.is_empty() {
                    current.push(start);
                }
                current.push(end);
                out.push(std::mem::take(&mut current));
            } else if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            cursor = hi.max(cursor);
        }
        if cursor < 1. - 1e-9 {
            current.push(a.lerp(b, cursor));
            current.push(b);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    (out, changed)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Replacement {
    id: String,
    segments: Vec<Vec<Point>>,
}
#[derive(Serialize)]
struct EraseResult {
    replacements: Vec<Replacement>,
}
/// An eraser gesture owns an immutable page snapshot, a spatial index, and its
/// progressively cut fragments. Only candidates under new pointer batches run
/// geometry; no per-point WASM calls or full-document traversal is needed.
#[wasm_bindgen]
pub struct InkEraser {
    strokes: Vec<Stroke>,
    grid: BTreeMap<(i32, i32), Vec<usize>>,
    fragments: BTreeMap<usize, Vec<Vec<Point>>>,
    last: Option<Point>,
}
impl InkEraser {
    pub fn from_strokes(strokes: Vec<Stroke>) -> Result<Self, String> {
        let mut grid: BTreeMap<(i32, i32), Vec<usize>> = BTreeMap::new();
        if let Some(first) = strokes.first() {
            for s in &strokes {
                if s.document_id != first.document_id
                    || s.page != first.page
                    || (s.page_width - first.page_width).abs() > 0.001
                    || (s.page_height - first.page_height).abs() > 0.001
                {
                    return Err("Eraser requires a single page with consistent dimensions".into());
                }
            }
        }
        for (i, s) in strokes.iter().enumerate() {
            let pad = s.width * s.page_width.min(s.page_height) * 0.75;
            let minx = s.points.iter().map(|p| p.x).fold(1., f64::min) - pad / s.page_width;
            let maxx = s.points.iter().map(|p| p.x).fold(0., f64::max) + pad / s.page_width;
            let miny = s.points.iter().map(|p| p.y).fold(1., f64::min) - pad / s.page_height;
            let maxy = s.points.iter().map(|p| p.y).fold(0., f64::max) + pad / s.page_height;
            for x in cell(minx)..=cell(maxx) {
                for y in cell(miny)..=cell(maxy) {
                    grid.entry((x, y)).or_default().push(i);
                }
            }
        }
        Ok(Self {
            strokes,
            grid,
            fragments: BTreeMap::new(),
            last: None,
        })
    }
    pub fn apply(
        &mut self,
        mut path: Vec<Point>,
        radius: f64,
        mode: &str,
        target: &str,
    ) -> Result<String, String> {
        if path.is_empty()
            || path.len() > 8192
            || path.iter().any(|p| !p.valid())
            || !radius.is_finite()
            || radius <= 0.
            || radius > 1e5
            || !["stroke", "precision"].contains(&mode)
            || !["pen", "marker", "both"].contains(&target)
        {
            return Err("Invalid eraser path or settings".into());
        }
        if let Some(last) = self.last {
            path.insert(0, last);
        }
        self.last = path.last().copied();
        if path.len() == 1 {
            path.push(path[0]);
        }
        let mut candidates: BTreeSet<usize> = BTreeSet::new();
        if let Some(s) = self.strokes.first() {
            for pair in path.windows(2) {
                let minx = pair[0].x.min(pair[1].x) - radius / s.page_width;
                let maxx = pair[0].x.max(pair[1].x) + radius / s.page_width;
                let miny = pair[0].y.min(pair[1].y) - radius / s.page_height;
                let maxy = pair[0].y.max(pair[1].y) + radius / s.page_height;
                for x in cell(minx)..=cell(maxx) {
                    for y in cell(miny)..=cell(maxy) {
                        if let Some(ids) = self.grid.get(&(x, y)) {
                            candidates.extend(ids.iter().copied());
                        }
                    }
                }
            }
        }
        let mut roots = BTreeSet::new();
        for i in candidates {
            let stroke = &self.strokes[i];
            if target != "both" && stroke.kind != target {
                continue;
            }
            let old = self
                .fragments
                .get(&i)
                .cloned()
                .unwrap_or_else(|| vec![stroke.points.clone()]);
            if old.is_empty() {
                continue;
            }
            let mut next = Vec::new();
            let mut changed = false;
            for segment in &old {
                let (result, hit) = cut(stroke, segment, &path, radius);
                changed |= hit;
                next.extend(result);
            }
            if changed {
                if mode == "stroke" {
                    roots.insert(stroke.root_id.clone());
                } else {
                    self.fragments.insert(i, next);
                }
            }
        }
        if mode == "stroke" {
            for (i, s) in self.strokes.iter().enumerate() {
                if roots.contains(&s.root_id) && (target == "both" || target == s.kind) {
                    self.fragments.insert(i, vec![]);
                }
            }
        }
        let replacements = self
            .fragments
            .iter()
            .map(|(i, segments)| Replacement {
                id: self.strokes[*i].id.clone(),
                segments: segments.clone(),
            })
            .collect();
        Ok(serde_json::to_string(&EraseResult { replacements }).unwrap())
    }
}
fn cell(v: f64) -> i32 {
    ((v * 32.).floor() as i32).clamp(0, 31)
}
#[wasm_bindgen]
impl InkEraser {
    #[wasm_bindgen(constructor)]
    pub fn new(input: &str) -> Result<InkEraser, JsError> {
        Self::from_strokes(parse(input).map_err(|e| JsError::new(&e))?)
            .map_err(|e| JsError::new(&e))
    }
    pub fn erase(
        &mut self,
        path: &str,
        radius: f64,
        mode: &str,
        target: &str,
    ) -> Result<String, JsError> {
        let path = serde_json::from_str(path)
            .map_err(|e| JsError::new(&format!("Invalid eraser path: {e}")))?;
        self.apply(path, radius, mode, target)
            .map_err(|e| JsError::new(&e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(x: f64, y: f64) -> Point {
        Point {
            x,
            y,
            pressure: None,
        }
    }
    fn stroke() -> Stroke {
        Stroke {
            version: 1,
            id: "a".into(),
            root_id: "a".into(),
            document_id: "doc".into(),
            page: 1,
            kind: "pen".into(),
            color: "#123456".into(),
            width: 0.01,
            opacity: 1.,
            page_width: 100.,
            page_height: 200.,
            points: vec![p(0.1, 0.5), p(0.9, 0.5)],
            created_at: 1,
            updated_at: 2,
        }
    }
    fn replacements(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }
    #[test]
    fn stroke_roundtrip() {
        let s = stroke();
        assert_eq!(
            parse(&serde_json::to_string(&vec![s.clone()]).unwrap()).unwrap(),
            vec![s]
        );
    }
    #[test]
    fn malformed_ink() {
        for mutate in 0..8 {
            let mut s = stroke();
            match mutate {
                0 => s.width = f64::NAN,
                1 => s.points.clear(),
                2 => s.points[0].pressure = Some(1.1),
                3 => s.color = "red".into(),
                4 => s.points[0].x = -0.1,
                5 => s.version = 2,
                6 => s.opacity = 0.,
                _ => s.updated_at = 0,
            };
            assert!(s.validate().is_err());
        }
        assert!(parse("[{}]").is_err());
    }
    #[test]
    fn duplicate_and_sorting() {
        let s = stroke();
        assert!(parse(&serde_json::to_string(&vec![s.clone(), s.clone()]).unwrap()).is_err());
        let mut b = s.clone();
        b.id = "b".into();
        b.page = 2;
        assert_eq!(
            parse(&serde_json::to_string(&vec![b, s]).unwrap()).unwrap()[0].page,
            1
        );
    }
    #[test]
    fn sparse_crossing_splits_stroke() {
        let mut e = InkEraser::from_strokes(vec![stroke()]).unwrap();
        let result = replacements(
            &e.apply(vec![p(0.5, 0.1), p(0.5, 0.9)], 3., "precision", "both")
                .unwrap(),
        );
        let seg = result["replacements"][0]["segments"].as_array().unwrap();
        assert_eq!(seg.len(), 2);
        assert!((seg[0][1]["x"].as_f64().unwrap() - 0.465).abs() < 1e-8);
        assert!((seg[1][0]["x"].as_f64().unwrap() - 0.535).abs() < 1e-8);
    }
    #[test]
    fn erases_dots_and_tangent() {
        let mut s = stroke();
        s.points = vec![p(0.5, 0.5)];
        let mut e = InkEraser::from_strokes(vec![s]).unwrap();
        let result = replacements(&e.apply(vec![p(0.5, 0.5)], 2., "precision", "both").unwrap());
        assert_eq!(result["replacements"][0]["segments"], serde_json::json!([]));
        assert!(!capsule((0., 1.), (2., 1.), (1., 0.), (1., 0.), 1.).is_empty());
    }
    #[test]
    fn filter_separates_pen_and_marker() {
        let mut e = InkEraser::from_strokes(vec![stroke()]).unwrap();
        assert_eq!(
            replacements(&e.apply(vec![p(0.5, 0.5)], 3., "stroke", "marker").unwrap())
                ["replacements"],
            serde_json::json!([])
        );
    }
    #[test]
    fn stroke_mode_removes_root_fragments() {
        let a = stroke();
        let mut b = a.clone();
        b.id = "fragment".into();
        b.points = vec![p(0.1, 0.1), p(0.2, 0.1)];
        let mut e = InkEraser::from_strokes(vec![a, b]).unwrap();
        let result = replacements(&e.apply(vec![p(0.5, 0.5)], 3., "stroke", "both").unwrap());
        assert_eq!(result["replacements"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn repeated_batches_keep_previous_cuts() {
        let mut e = InkEraser::from_strokes(vec![stroke()]).unwrap();
        e.apply(vec![p(0.3, 0.5)], 1., "precision", "both").unwrap();
        let result = replacements(&e.apply(vec![p(0.7, 0.5)], 1., "precision", "both").unwrap());
        assert_eq!(
            result["replacements"][0]["segments"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn pressure_is_interpolated_at_cut() {
        let mut s = stroke();
        s.points[0].pressure = Some(0.);
        s.points[1].pressure = Some(1.);
        let mut e = InkEraser::from_strokes(vec![s]).unwrap();
        let result = replacements(&e.apply(vec![p(0.5, 0.5)], 1., "precision", "pen").unwrap());
        let pressure = result["replacements"][0]["segments"][0][1]["pressure"]
            .as_f64()
            .unwrap();
        assert!(pressure > 0.4 && pressure < 0.5);
    }
    #[test]
    fn aspect_ratio_uses_physical_space() {
        let mut e = InkEraser::from_strokes(vec![stroke()]).unwrap();
        let result = replacements(
            &e.apply(vec![p(0.5, 0.55)], 2., "precision", "both")
                .unwrap(),
        );
        assert_eq!(result["replacements"], serde_json::json!([]));
    }
    #[test]
    fn rejects_bad_requests_without_mutation() {
        let mut e = InkEraser::from_strokes(vec![stroke()]).unwrap();
        assert!(e
            .apply(vec![p(0.5, 0.5)], f64::NAN, "precision", "both")
            .is_err());
        assert!(e.apply(vec![p(0.5, 0.5)], 2., "fake", "both").is_err());
        assert!(e.fragments.is_empty());
    }
    #[test]
    fn no_hit_preserves_vector_exactly() {
        let mut e = InkEraser::from_strokes(vec![stroke()]).unwrap();
        let result = replacements(&e.apply(vec![p(0.1, 0.1)], 2., "precision", "both").unwrap());
        assert_eq!(result["replacements"], serde_json::json!([]));
    }
}
